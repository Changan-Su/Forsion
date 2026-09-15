/**
 * delegate 子代理的**续轮载体**与**后台台账**(Codex 评审三轮 #2/#3/#8):
 *   ① 工具轮的 assistant 消息必须经 assistantTurnOf 构造 —— reasoning_content + providerItems 一起挂,
 *      否则 DeepSeek/ZAI/带思考的 Qwen 在工具轮之后的下一请求可能直接 400(此前这里是手搓的)。
 *   ② publishBackgroundUsage 必须 await:它内部先异步算费再 publish,fire-and-forget 会在
 *      runSubAgent 已经返回之后才落地,父 run 收尾时台账缺项。故意把 calculateCost 拖一个宏任务,
 *      `void` 版本的最后一条 usage 必然赶不上(这条断言就是它的负对照)。
 *   ③ reasoning_tokens=0 属于「上游报了 0」,必须出 reasoningTokens:0,不能被真值判断吞掉。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { createRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { runSubAgent } from './subAgent.js';
import type { ToolContext } from '../tools/registry.js';

const USER = 'u1';
let home: string;
let subPayloads: any[];
let script: Array<() => any>;
let events: Array<{ type: string; payload: any }>;
let unsubscribe: () => void;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-subturns-'));
  process.env.TANGU_HOME = home;
  subPayloads = [];
  script = [];
  events = [];

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
    streamProviderCompletion: async (o: any) => {
      subPayloads.push(o.payload);
      const step = script.shift();
      if (!step) throw new Error(`脚本耗尽:第 ${subPayloads.length} 次 LLM 调用没有出招`);
      return step();
    },
  };
  const fakeBrain: any = {
    llm: fakeLlm,
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    // 拖一个宏任务:`void publishBackgroundUsage(...)` 的最后一条 usage 必然赶不上 runSubAgent 返回。
    calculateCost: async () => { await new Promise((r) => setTimeout(r, 20)); return 0; },
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`,
    [USER],
  );
  await createRun({
    id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: '干活', userMessageId: 'U1', attachments: [], agentConfig: {} },
  });
  unsubscribe = subscribe('R1', (ev) => events.push({ type: ev.type, payload: ev.payload }));
});

afterEach(() => {
  unsubscribe?.();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

// execMode='sandbox':gateToolCall 对非 mcp 工具直接放行,测试不依赖审批订阅者。
const parentCtx = (): ToolContext => ({
  userId: USER, sessionId: 'S', appId: 'tangu', runId: 'R1',
  profile: createTanguProfile({ sandboxMode: 'none' }),
  execMode: 'sandbox', thinkingLevel: 'medium',
} as unknown as ToolContext);

describe('子代理的续轮载体与后台台账', () => {
  it('工具轮的 assistant 消息挂 reasoning_content + providerItems(与主循环同一个构造器)', async () => {
    script = [
      () => ({
        content: '先看看时间。', reasoning: 'SUB-COT',
        outputItems: [{ type: 'reasoning', id: 'rs_1' }],
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
      }),
      () => ({ content: '子任务完成。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
    ];
    const out = await runSubAgent({ task: '看一下现在几点', parentCtx: parentCtx(), modelId: 'm1' });
    expect(out).toContain('子任务完成。');
    expect(subPayloads.length).toBe(2);
    const assistants = (subPayloads[1].messages as any[]).filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0].reasoning_content).toBe('SUB-COT');
    expect(assistants[0].providerItems).toEqual([{ type: 'reasoning', id: 'rs_1' }]);
    expect(assistants[0].tool_calls?.[0]?.function?.name).toBe('get_datetime');
    // 模型没吐思考的那轮不挂(与主循环同口径)——这里第二轮是收尾轮,本来就不进 messages,故只反证首轮。
    expect((subPayloads[0].messages as any[]).some((m) => m.reasoning_content)).toBe(false);
  }, 20_000);

  it('每轮 usage 都 await 落地:runSubAgent 返回时两条 phase=delegate 的台账都已发出', async () => {
    script = [
      () => ({
        content: '', reasoning: '',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, reasoning_tokens: 0 }, finishReason: 'stop',
      }),
      () => ({ content: '好了。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4, reasoning_tokens: 7 }, finishReason: 'stop' }),
    ];
    await runSubAgent({ task: '看一下现在几点', parentCtx: parentCtx(), modelId: 'm1' });
    const usages = events.filter((e) => e.type === 'usage' && e.payload?.phase === 'delegate');
    expect(usages.length).toBe(2); // ← void 版本在这里只有 1 条(最后一轮的还卡在算费里)
    // 「上游报了 0」必须出 0,不能被真值判断吞成「没报」。
    expect(usages[0].payload.reasoningTokens).toBe(0);
    expect(usages[0].payload.reasoning).toBe(0);
    expect(usages[1].payload.reasoningTokens).toBe(7);
  }, 20_000);

  it('上游根本没报 reasoning_tokens 时,两个键都不出现(「没报」≠「报了 0」)', async () => {
    script = [() => ({ content: '好了。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' })];
    await runSubAgent({ task: '随便', parentCtx: parentCtx(), modelId: 'm1' });
    const u = events.find((e) => e.type === 'usage' && e.payload?.phase === 'delegate')!;
    expect(u).toBeTruthy();
    expect(u.payload).not.toHaveProperty('reasoningTokens');
    expect(u.payload).not.toHaveProperty('reasoning');
  }, 20_000);
});
