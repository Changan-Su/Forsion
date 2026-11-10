/**
 * 在飞正文随失败收尾落库(inflightText):模型已经流给用户的正文,在这次调用以**不可重试**的错误收尾时
 * (吐过帧之后的 400 之类),run 进外层 catch 落库「失败」的半截助手消息 —— 屏上看过的那截必须并进去:
 *   ① 单迭代:只流了一截就 400 → 之前 finalContent 为空、没有工具调用,整条什么都不落库;
 *      现在 finalizeAssistantMessage 被调用,content 含已流出的正文;error 事件的 content 同样带上。
 *   ② 两迭代:第 1 轮正文 + 工具调用成功,第 2 轮流了「partial tail」后 400 → 之前落库只有第 1 轮正文,
 *      最后一截丢了;现在两段都在。
 * 真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 remoteLock.dispatch.test.ts)。
 * 负对照:注释掉 catch 里的 `if (inflightText.trim()) { appendFinal(inflightText); ... }` → 两例都红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu, deps } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { LlmError } from '../core/types.js';
import { isRetryableLlmError } from '../llm/retry.js';
import { createRun, getRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { enqueueRun } from './agentLoop.js';

const USER = 'u1';
let home: string;
/** 主 loop 的流式调用脚本(带 onToken 的那种);旁路调用(标题等,不带 onToken)不消耗脚本。 */
let script: Array<(o: any) => Promise<any>>;
let streamCalls: number;
let finalizeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-inflight-'));
  process.env.TANGU_HOME = home;
  script = [];
  streamCalls = 0;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        streamCalls++;
        const step = script.shift();
        if (!step) throw new Error(`脚本耗尽:第 ${streamCalls} 次流式调用没有出招`);
        return step(o);
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  // 透传探针:量「落库时带的 content」,不替换行为
  finalizeSpy = vi.spyOn(deps().state, 'finalizeAssistantMessage');
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 吐过帧之后才来的不可重试错误(400):不走中流续写、不走重试,直接进 run 的外层 catch。 */
const fatal = (): LlmError => new LlmError(400, 'invalid request: upstream rejected the stream');

let runSeq = 0;
async function runToEnd(): Promise<{ runId: string; status: string; errors: any[] }> {
  const runId = `IF${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    // sandbox:gateToolCall 对非 mcp 工具直接放行,不依赖审批订阅者
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home } },
  });
  const errors: any[] = [];
  const off = subscribe(runId, (ev) => { if (ev.type === 'error') errors.push(ev.payload); });
  enqueueRun('S', runId);
  try {
    const t0 = Date.now();
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return { runId, status: String(r.status), errors };
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 20));
    }
  } finally { off(); }
}

const persistedContents = (): string[] => finalizeSpy.mock.calls.map((c: any[]) => String(c[0]?.content ?? ''));

describe('inflight text is persisted when the run fails mid-stream', () => {
  it('precondition: the scripted error is non-retryable', () => {
    expect(isRetryableLlmError(fatal())).toBe(false);
  });

  it('single iteration: tokens streamed then a non-retryable error → finalize and error event carry the streamed text', async () => {
    script = [
      async (o) => {
        o.onToken('Hello, this is the ');
        o.onToken('streamed partial answer');
        throw fatal();
      },
    ];
    const r = await runToEnd();
    expect(r.status).toBe('failed');
    expect(streamCalls, '不可重试错误不该触发重发 / 续写').toBe(1);

    const contents = persistedContents();
    expect(contents.length, '失败收尾必须落库已流出的半截正文').toBeGreaterThan(0);
    expect(contents.at(-1)).toContain('Hello, this is the streamed partial answer');
    expect(finalizeSpy.mock.calls.at(-1)?.[0]).toMatchObject({ messageId: `${r.runId}-a`, sessionId: 'S' });

    // 真落进库里(不只是调用过)
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE id = ?`, [`${r.runId}-a`]);
    expect(String(rows[0]?.content ?? '')).toContain('Hello, this is the streamed partial answer');

    // error 事件的 content 会原地替换在线气泡正文:必须带上屏上那截
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ aborted: false });
    expect(String(r.errors[0].content)).toContain('Hello, this is the streamed partial answer');
  }, 20_000);

  it('two iterations: iteration-1 text + tool call succeed, iteration-2 streams a tail then fails → both parts persisted', async () => {
    let iter2ToolMsg = '';
    script = [
      async (o) => {
        o.onToken('First I will note the plan.');
        return {
          content: 'First I will note the plan.', reasoning: '', finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5 },
          toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'step one', status: 'in_progress' }] }) } }],
        };
      },
      async (o) => {
        iter2ToolMsg = String(((o.payload?.messages ?? []) as any[]).filter((m) => m.role === 'tool').pop()?.content ?? '');
        o.onToken('partial tail');
        throw fatal();
      },
    ];
    const r = await runToEnd();
    expect(r.status).toBe('failed');
    expect(streamCalls).toBe(2);
    // 第 2 轮请求里带着第 1 轮工具的成功结果(证工具真跑了、loop 真进了第 2 轮)
    expect(iter2ToolMsg).toContain('todo list updated');

    const last = finalizeSpy.mock.calls.at(-1)?.[0] as any;
    expect(last, '失败收尾必须落库').toBeTruthy();
    expect(String(last.content)).toContain('First I will note the plan.');
    expect(String(last.content)).toContain('partial tail');
    expect(String(last.content).indexOf('First I will note the plan.')).toBeLessThan(String(last.content).indexOf('partial tail'));
    expect((last.toolCalls ?? []).map((t: any) => t?.function?.name)).toContain('todo_write');

    expect(r.errors).toHaveLength(1);
    expect(String(r.errors[0].content)).toContain('First I will note the plan.');
    expect(String(r.errors[0].content)).toContain('partial tail');
  }, 20_000);
});
