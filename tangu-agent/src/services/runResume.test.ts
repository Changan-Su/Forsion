/**
 * 中断任务续跑(2026-11-20 方案 B)的引擎半边:真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 agentLoop.inflightPersist.test.ts)。
 *   E1 引擎被停(drainRunsForExit 带原因)→ interrupted(<原因>),不写「用户打断」标记,半截正文照落库;没原因 / 用户先按停 / 非恢复宿主 → 照旧 aborted。
 * 负对照(实跑过):runLoop catch 里 interruptReason 恒取 undefined → E1 第一例红。
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
import { createRun, getRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { enqueueRun, abortRun, drainRunsForExit, __resetExitForTests, TURN_INTERRUPTED_MARKER } from './agentLoop.js';
import { markRecoveryHost } from './runProgress.js';

const USER = 'u1';
let home: string;
/** 主 loop 的流式调用脚本(带 onToken 的那种);旁路调用(标题等,不带 onToken)不消耗脚本。 */
let script: Array<(o: any) => Promise<any>>;
let streamCalls: number;

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });
/** 吐一截正文后挂住,直到这次调用被中止。 */
const streamThenHang = (text: string) => async (o: any): Promise<any> => {
  o.onToken(text);
  await new Promise<void>((_, reject) => {
    if (o.signal?.aborted) return reject(abortError());
    o.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-resume-'));
  process.env.TANGU_HOME = home;
  script = [];
  streamCalls = 0;
  __resetExitForTests();
  markRecoveryHost(true);
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
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  markRecoveryHost(false);
  __resetExitForTests();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

let runSeq = 0;
async function startRun(agentConfig: any = { execMode: 'sandbox', cwd: '' }): Promise<{ runId: string; errors: any[]; off: () => void }> {
  const runId = `RR${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { ...agentConfig, cwd: agentConfig.cwd || home } },
  });
  const errors: any[] = [];
  const off = subscribe(runId, (ev) => { if (ev.type === 'error') errors.push(ev.payload); });
  enqueueRun('S', runId);
  return { runId, errors, off };
}

async function waitUntil(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时:${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function settled(runId: string): Promise<{ status: string; error: string | null }> {
  await waitUntil(async () => !['queued', 'running'].includes(String((await getRun(runId))?.status)), `run ${runId} 收尾`);
  const r = await getRun(runId);
  return { status: String(r?.status), error: r?.error ?? null };
}

const userRows = async (): Promise<string[]> =>
  (await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'user' ORDER BY timestamp ASC`)).map((r) => String(r.content));
const modelRow = async (id: string): Promise<any> =>
  (await query<any[]>(`SELECT content, tool_calls, tool_results FROM chat_messages WHERE id = ?`, [id]))[0];

describe('E1 planned shutdown → interrupted, not a user stop', () => {
  it('drain with a reason: status interrupted:<reason>, no user-interrupt marker, partial answer kept, error event carries the reason', async () => {
    script = [streamThenHang('Half of the answer')];
    const { runId, errors, off } = await startRun();
    await waitUntil(() => streamCalls === 1, '第一次模型调用');
    await new Promise((r) => setTimeout(r, 50));
    await drainRunsForExit(3000, 'app_quit');
    const st = await settled(runId);
    off();
    expect(st).toEqual({ status: 'interrupted', error: 'interrupted:app_quit' });
    expect(await userRows()).not.toContain(TURN_INTERRUPTED_MARKER);
    expect(String((await modelRow(`${runId}-a`))?.content)).toContain('Half of the answer');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ error: 'interrupted', aborted: true, interrupted: 'app_quit' });
    expect(String(errors[0].content)).toContain('Half of the answer');
  }, 20_000);

  it('drain without a reason (TUI exit) stays a plain abort with the marker', async () => {
    script = [streamThenHang('Some text')];
    const { runId, off } = await startRun();
    await waitUntil(() => streamCalls === 1, '第一次模型调用');
    await new Promise((r) => setTimeout(r, 50));
    await drainRunsForExit(3000);
    const st = await settled(runId);
    off();
    expect(st.status).toBe('aborted');
    expect(await userRows()).toContain(TURN_INTERRUPTED_MARKER);
  }, 20_000);

  it('not a recovery host (cloud worker shape): a reason is ignored, behaviour identical to today', async () => {
    markRecoveryHost(false);
    script = [streamThenHang('Some text')];
    const { runId, errors, off } = await startRun();
    await waitUntil(() => streamCalls === 1, '第一次模型调用');
    await new Promise((r) => setTimeout(r, 50));
    await drainRunsForExit(3000, 'app_update');
    const st = await settled(runId);
    off();
    expect(st).toEqual({ status: 'aborted', error: 'aborted' });
    expect(errors[0]).toMatchObject({ error: 'aborted', aborted: true });
    expect(errors[0].interrupted).toBeUndefined();
  }, 20_000);

  it('a run the user already stopped stays a user stop even if the engine quits right after', async () => {
    script = [streamThenHang('Some text')];
    const { runId, off } = await startRun();
    await waitUntil(() => streamCalls === 1, '第一次模型调用');
    await new Promise((r) => setTimeout(r, 50));
    abortRun(runId, { byUser: true });
    await drainRunsForExit(3000, 'app_quit');
    const st = await settled(runId);
    off();
    expect(st.status).toBe('aborted');
    expect(await userRows()).toContain(TURN_INTERRUPTED_MARKER);
  }, 20_000);
});
