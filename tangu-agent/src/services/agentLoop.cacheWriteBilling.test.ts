/**
 * 缓存写入量透传给计费接缝(server #209 的可选「缓存写入单价」):
 *   ① 主循环:usage 带 cache_write_tokens / cache_write_long_tokens → calculateCost 收到第六参
 *      { tokens, longTokens },logApiUsage 第 16 个位置参数是同一份(13–15 位占位 undefined)。
 *   ② 没有写入量 → 调用形状与旧版一致(calculateCost 5 个参数、logApiUsage 12 个),老 server / 按位置比对不受影响。
 *   ③ 失败重试前的已知用量(partialUsage)同样带写入量计进本 run 成本。
 * 真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 agentLoop.inflightPersist.test.ts)。
 * 负对照:把 agentLoop 主循环里 `cacheWriteOf(res.usage)` 换成 undefined → ① 红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { cacheWriteOf } from '../seams/billing.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { LlmError } from '../core/types.js';
import { createRun, getRun } from './runStore.js';
import { enqueueRun } from './agentLoop.js';

const USER = 'u1';
let home: string;
let script: Array<(o: any) => Promise<any>>;
let calculateCost: ReturnType<typeof vi.fn>;
let logApiUsage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-cachewrite-'));
  process.env.TANGU_HOME = home;
  script = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
      streamProviderCompletion: async (o: any) => {
        // 旁路调用(标题等,不带 onToken)不消耗脚本
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        const step = script.shift();
        if (!step) throw new Error('脚本耗尽');
        return step(o);
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  calculateCost = vi.fn(async () => 0);
  logApiUsage = vi.fn(async () => {});
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost, logApiUsage };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

let runSeq = 0;
async function runToEnd(): Promise<string> {
  const runId = `CW${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home } },
  });
  enqueueRun('S', runId);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return String(r.status);
    if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

const reply = (usage: any) => async (o: any) => {
  o.onToken('done');
  return { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop', usage };
};

/** 主循环那一次计费(按本测试的 prompt_tokens 认出来;旁路 / 预检调用的 prompt 不同)。 */
const callsWithPrompt = (fn: ReturnType<typeof vi.fn>, idx: number, prompt: number) =>
  fn.mock.calls.filter((c: any[]) => c[idx] === prompt);

describe('cache-write usage reaches the billing seam', () => {
  it('cacheWriteOf: no writes → undefined; writes → tokens + longTokens', () => {
    expect(cacheWriteOf(undefined)).toBeUndefined();
    expect(cacheWriteOf({ cache_write_tokens: 0 })).toBeUndefined();
    expect(cacheWriteOf({ cache_write_tokens: 300 })).toEqual({ tokens: 300, longTokens: 0 });
    expect(cacheWriteOf({ cache_write_tokens: 300, cache_write_long_tokens: 120 })).toEqual({ tokens: 300, longTokens: 120 });
  });

  it('main loop: usage with writes → calculateCost gets the 6th arg and logApiUsage the 16th', async () => {
    script = [reply({ prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 400, cache_write_tokens: 500, cache_write_long_tokens: 200 })];
    expect(await runToEnd()).toBe('done');
    const cost = callsWithPrompt(calculateCost, 1, 1000);
    expect(cost).toHaveLength(1);
    expect(cost[0][4]).toBe(400);
    expect(cost[0][5]).toEqual({ tokens: 500, longTokens: 200 });
    const logs = callsWithPrompt(logApiUsage, 4, 1000);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toHaveLength(16);
    expect(logs[0].slice(12, 15)).toEqual([undefined, undefined, undefined]);
    expect(logs[0][15]).toEqual({ tokens: 500, longTokens: 200 });
  }, 20_000);

  it('main loop: no writes → call shapes unchanged (5 / 12 args)', async () => {
    script = [reply({ prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 400 })];
    expect(await runToEnd()).toBe('done');
    const cost = callsWithPrompt(calculateCost, 1, 1000);
    expect(cost).toHaveLength(1);
    expect(cost[0]).toHaveLength(5);
    const logs = callsWithPrompt(logApiUsage, 4, 1000);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toHaveLength(12);
  }, 20_000);

  it('retry: partial usage of the failed attempt carries its writes into the run cost', async () => {
    const outage = new LlmError(502, 'upstream disconnected');
    outage.partialUsage = { prompt_tokens: 777, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 600, cache_write_long_tokens: 600 };
    script = [async () => { throw outage; }, reply({ prompt_tokens: 1000, completion_tokens: 20 })];
    expect(await runToEnd()).toBe('done');
    const failed = callsWithPrompt(calculateCost, 1, 777);
    expect(failed).toHaveLength(1);
    expect(failed[0][5]).toEqual({ tokens: 600, longTokens: 600 });
  }, 20_000);
});
