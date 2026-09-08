/**
 * 首帧计时仪器(2026-09-06「卡住」取证后加):每次模型调用发 status:llm_call sending/accepted,
 * usage 事件带 ttftMs/uploadMs/llmMs/requestBytes。仪器同 agentLoopTruncation:真内存 SQLite + 真 loop + fake llm。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-timing-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
    streamProviderCompletion: async (o: any) => {
      await sleep(10);
      o.onResponseStart?.(); // 响应头到达(上传完毕)
      await sleep(40);
      o.onToken?.('hi'); // 首帧
      await sleep(10);
      return { content: 'hi', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2 }, finishReason: 'stop' };
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
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function waitRunSettled(runId: string, ms = 8000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > ms) throw new Error(`run 未在 ${ms}ms 内结束(status=${r?.status})`);
    await sleep(25);
  }
}

describe('模型调用首帧计时', () => {
  it('status:llm_call sending→accepted 成对出现;usage 带 ttftMs/uploadMs/llmMs/requestBytes 且量级正确', async () => {
    await createRun({
      id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
      input: { message: '你好', userMessageId: 'U1', attachments: [], agentConfig: {} },
    });
    enqueueRun('S', 'R1');
    const run = await waitRunSettled('R1');
    expect(run.status).toBe('done');

    const rows = await query<any[]>(`SELECT type, payload FROM agent_run_events WHERE run_id = 'R1' ORDER BY seq`);
    const evs = rows.map((r) => ({ type: r.type, p: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
    const calls = evs.filter((e) => e.type === 'status' && e.p?.phase === 'llm_call');
    expect(calls.map((e) => e.p.stage)).toEqual(['sending', 'accepted']);
    expect(calls[0].p.bytes).toBeGreaterThan(0);
    expect(calls[1].p.uploadMs).toBeGreaterThanOrEqual(5);

    const usage = evs.find((e) => e.type === 'usage')?.p;
    expect(usage.requestBytes).toBe(calls[0].p.bytes);
    expect(usage.uploadMs).toBeGreaterThanOrEqual(5);
    expect(usage.ttftMs).toBeGreaterThanOrEqual(usage.uploadMs + 30); // 首帧在响应头之后 ≥40ms
    expect(usage.llmMs).toBeGreaterThanOrEqual(usage.ttftMs);

    // 事件顺序:sending 在任何 token 之前,accepted 也在首 token 之前
    const idx = (pred: (e: any) => boolean) => evs.findIndex(pred);
    expect(idx((e) => e.type === 'status' && e.p?.stage === 'accepted')).toBeLessThan(idx((e) => e.type === 'token'));
  });
});
