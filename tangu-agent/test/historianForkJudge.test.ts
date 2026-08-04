/**
 * Historian fork 判官(mode='fork')+ 会话摘要:真 SQLite(内存)+ fake llm。
 * 覆盖:fork 补全的缓存契约(cacheKey=sessionId/同工具面/同思考档/逐请求深拷贝)、
 * 快照缺席/空产出/截断/超窗的 independent 回落、summary 的判读与落库(fork 与 independent 两路)。
 * 缓存三铁律同 self_brainstorm(test/selfBrainstorm.test.ts);此处钉的是 Historian 侧的复用不走样。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, updateRunStatus } from '../src/services/runStore.js';
import { onUserRunDone, resetHistorianConsolidationState, type HistorianForkSeed } from '../src/services/localHistorian.js';

const USER = 'u1';

let home: string;
let llmScript: (string | { content: string; finishReason?: string; toolCalls?: any[] })[];
let builds: any[]; // buildProviderPayload 的完整入参(cacheKey/tools/thinkingLevel 契约都钉在这)
let resolveCalls: string[];
let mutateBuilder = false; // 模拟 openaiCompat 原地改消息(structuredClone 防线)

function seedTools(): unknown[] {
  return [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
}

function makeSeed(over: Partial<HistorianForkSeed> = {}): { seed: HistorianForkSeed; original: any[] } {
  const original: any[] = [
    { role: 'system', content: 'SYS 提示词' },
    { role: 'user', content: '帮我修一下渐变页面的 bug,这段上下文足够长足够长足够长。'.repeat(6) },
    { role: 'assistant', content: '我先看下文件', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', content: 'file content here', tool_call_id: 't1' },
    { role: 'assistant', content: '修好了,改动在 grad.ts' },
  ];
  return {
    original,
    seed: {
      getMessages: () => original.map((m) => ({ ...m })),
      tools: seedTools(),
      thinkingLevel: 'high',
      modelId: 'm-sess',
      ...over,
    },
  };
}

const judgeJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ title: '渐变页修复', summary: '排查渐变页渲染 bug;定位到 grad.ts 并已修复。', log: '', memory_candidates: [], ...over });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-hist-fork-'));
  process.env.TANGU_HOME = home;
  llmScript = [];
  builds = [];
  resolveCalls = [];
  mutateBuilder = false;
  resetHistorianConsolidationState();

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async (id: string) => {
        resolveCalls.push(id);
        // m-small:小窗模型(≥4000 才被 modelContextWindow 认),钉超窗回落。
        const model: any = { provider: 'test', name: 'test' };
        if (id === 'm-small') model.contextWindow = 4000;
        return { model, apiKey: 'k', baseUrl: 'b', apiModelId: id };
      },
      buildProviderPayload: async (o: any) => {
        builds.push(o);
        if (mutateBuilder && Array.isArray(o.messages) && o.messages[0]) {
          o.messages[0].content = '!!MUTATED ' + o.messages[0].content; // prefix-thinking 式原地改
        }
        return { messages: o.messages };
      },
      streamProviderCompletion: async () => {
        const next = llmScript.shift() || '';
        const r = typeof next === 'string' ? { content: next } : next;
        return { content: r.content, finishReason: r.finishReason, toolCalls: r.toolCalls, usage: { prompt_tokens: 5, completion_tokens: 5 } };
      },
    },
    users: { getUserById: async () => ({ username: 'u' }) },
    memory: {
      getMemory: async () => ({ content: '' }),
      getLog: async () => ({ date: 'today', content: '' }),
      appendLogEntry: async () => ({ date: 'd', time: 't' }),
      setMemory: async () => ({}),
    },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();

  writeFileSync(join(home, 'config.json'), JSON.stringify({
    specialAgents: { historian: { enabled: true, modelId: 'm1', everyRounds: 3, firstRoundTrigger: true, mode: 'fork' } },
  }), 'utf8');

  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', '旧标题', 'm-sess', 'user')`, [USER]);
  const long = '这是一段足够长的实质对话内容,用来越过 120 字的实质增量地板。'.repeat(4);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m1', 'S', 'user', ?, 1000)`, [long]);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m2', 'S', 'model', ?, 2000)`, [long]);
  await createRun({
    id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm-sess', assistantMessageId: 'A1',
    input: { message: 'x', userMessageId: 'U1', attachments: [], agentConfig: {} },
  });
  await updateRunStatus('R1', 'done');
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function sessionRow(): Promise<any> {
  return (await query<any[]>(`SELECT title, summary FROM chat_sessions WHERE id = 'S'`))[0];
}

describe('Historian fork 判官', () => {
  it('缓存契约:cacheKey=sessionId、带 seed 工具面、同思考档、用会话模型;判读落标题+摘要', async () => {
    const { seed } = makeSeed();
    llmScript = [judgeJson()];
    await onUserRunDone('S', USER, undefined, seed);

    expect(builds.length).toBe(1); // fork 一次成功,不再走 independent
    const b = builds[0];
    expect(b.cacheKey).toBe('S'); // 同前缀必须同键(与 delegate 分键方向相反)
    expect(b.tools).toEqual(seedTools()); // 工具 schema 参与前缀缓存,必须与父一致
    expect(b.thinkingLevel).toBe('high'); // 思考档随父(无原生思考的模型档位=system 文本)
    expect(b.toolChoice).toBe('auto'); // 禁执行靠指令+结果侧丢弃,不用 toolChoice:'none'
    expect(resolveCalls).toEqual(['m-sess']); // 会话模型,不是 historian 的轻量模型 m1

    // 消息 = 快照原样前缀 + 一条判官指令(user);配对的 tool 批次保留。
    const msgs = b.messages;
    expect(msgs[msgs.length - 1].role).toBe('user');
    expect(String(msgs[msgs.length - 1].content)).toContain('Historian fork');
    expect(msgs.some((m: any) => m.role === 'tool')).toBe(true);

    const row = await sessionRow();
    expect(row.title).toBe('渐变页修复');
    expect(row.summary).toContain('grad.ts');
    const act = await query<any[]>(`SELECT action FROM special_agent_log WHERE action = 'summary_updated'`);
    expect(act.length).toBe(1);
  });

  it('逐请求深拷贝:构建器原地改消息不污染快照来源', async () => {
    const { seed, original } = makeSeed();
    mutateBuilder = true;
    llmScript = [judgeJson()];
    await onUserRunDone('S', USER, undefined, seed);
    expect(String(original[0].content)).toBe('SYS 提示词'); // 原始数组未被构建器摸到
  });

  it('快照缺席(群聊/外部引擎路径):回落 independent 判断(transcript+cfg 模型),照常落地', async () => {
    llmScript = [judgeJson({ title: '回落标题' })];
    await onUserRunDone('S', USER); // 不传 seed
    expect(builds.length).toBe(1);
    expect(builds[0].cacheKey).toBeUndefined(); // independent 判断不带 cacheKey
    expect(resolveCalls).toEqual(['m1']);
    expect(String(builds[0].messages[0].content)).toContain('Read the conversation below');
    expect((await sessionRow()).title).toBe('回落标题');
  });

  it('fork 产出非空但非法 JSON → 回落 independent,本轮判读不丢', async () => {
    const { seed } = makeSeed();
    llmScript = ['这不是 JSON,判官跑偏写了一段长文……', judgeJson({ title: '回落丙' })];
    await onUserRunDone('S', USER, undefined, seed);
    expect(builds.length).toBe(2);
    expect(builds[1].cacheKey).toBeUndefined();
    expect((await sessionRow()).title).toBe('回落丙');
  });

  it('会话级互斥:并发 done 只有一个 Historian 进场(锁忙不落 independent 双跑)', async () => {
    const { seed } = makeSeed();
    llmScript = [judgeJson(), judgeJson({ title: '不该出现' })];
    await Promise.all([
      onUserRunDone('S', USER, undefined, seed),
      onUserRunDone('S', USER, undefined, seed),
    ]);
    expect(builds.length).toBe(1); // 第二个调用在会话锁处直接跳过,零模型调用
    const acts = await query<any[]>(`SELECT id FROM special_agent_log WHERE action = 'title_updated'`);
    expect(acts.length).toBe(1);
  });

  it('fork 空产出 → 回落 independent(两次调用,第二次是 transcript 判断)', async () => {
    const { seed } = makeSeed();
    llmScript = ['', judgeJson({ title: '回落标题' })];
    await onUserRunDone('S', USER, undefined, seed);
    expect(builds.length).toBe(2);
    expect(builds[0].cacheKey).toBe('S');
    expect(builds[1].cacheKey).toBeUndefined();
    expect((await sessionRow()).title).toBe('回落标题');
  });

  it('fork 只回工具调用(丢弃)/被截断 → 都回落 independent', async () => {
    const { seed } = makeSeed();
    llmScript = [{ content: '', toolCalls: [{ id: 'x' }] }, judgeJson({ title: '回落甲' })];
    await onUserRunDone('S', USER, undefined, seed);
    expect(builds.length).toBe(2);
    expect((await sessionRow()).title).toBe('回落甲');

    builds = []; resolveCalls = [];
    await query(`UPDATE special_agent_log SET created_at = '2020-01-01 00:00:00'`);
    for (const id of ['R2', 'R3']) {
      await createRun({ id, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm-sess', assistantMessageId: `${id}-a`, input: { message: 'x', userMessageId: `${id}-u`, attachments: [], agentConfig: {} } });
      await updateRunStatus(id, 'done');
    }
    const { seed: seed2 } = makeSeed();
    llmScript = [{ content: judgeJson(), finishReason: 'length' }, judgeJson({ title: '回落乙' })];
    await onUserRunDone('S', USER, undefined, seed2);
    expect(builds.length).toBe(2);
    expect((await sessionRow()).title).toBe('回落乙');
  });

  it('上下文超窗(75% 护栏):不发 fork 请求,直接回落 independent', async () => {
    const { seed } = makeSeed({
      modelId: 'm-small', // 窗口 4000
      getMessages: () => [
        { role: 'system', content: '长'.repeat(3500) } as any, // CJK≈1字/token,>3000=75%×4000
        { role: 'user', content: '问题' } as any,
      ],
    });
    llmScript = [judgeJson({ title: '超窗回落' })];
    await onUserRunDone('S', USER, undefined, seed);
    expect(builds.length).toBe(1); // fork 在护栏处止步,没有发出请求
    expect(builds[0].cacheKey).toBeUndefined();
    expect(resolveCalls).toEqual(['m-small', 'm1']); // fork 只解析了模型(算窗口),判断走 cfg 模型
    expect((await sessionRow()).title).toBe('超窗回落');
  });
});

describe('会话摘要(independent 路)', () => {
  it('已有摘要随 [Previous summary] 进判断输入;新摘要落库,空摘要不动旧值', async () => {
    await query(`UPDATE chat_sessions SET summary = '旧摘要:讨论渐变页方案。' WHERE id = 'S'`);
    llmScript = [judgeJson({ summary: '新摘要:方案定稿并落地。' })];
    await onUserRunDone('S', USER);
    expect(String(builds[0].messages[1].content)).toContain('[Previous summary]');
    expect(String(builds[0].messages[1].content)).toContain('旧摘要:讨论渐变页方案。');
    expect((await sessionRow()).summary).toBe('新摘要:方案定稿并落地。');

    // 第二个到点轮:summary 给空串 = 旧摘要仍适用,不覆盖。
    await query(`UPDATE special_agent_log SET created_at = '2020-01-01 00:00:00'`);
    for (const id of ['R2', 'R3']) {
      await createRun({ id, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm-sess', assistantMessageId: `${id}-a`, input: { message: 'x', userMessageId: `${id}-u`, attachments: [], agentConfig: {} } });
      await updateRunStatus(id, 'done');
    }
    llmScript = [judgeJson({ summary: '' })];
    await onUserRunDone('S', USER);
    expect((await sessionRow()).summary).toBe('新摘要:方案定稿并落地。');
  });
});
