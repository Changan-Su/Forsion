/**
 * 中断任务续跑(2026-11-20 方案 B)的引擎半边:真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 agentLoop.inflightPersist.test.ts)。
 *   E1 引擎被停(drainRunsForExit 带原因)→ interrupted(<原因>),不写「用户打断」标记,半截正文照落库;没原因 / 用户先按停 / 非恢复宿主 → 照旧 aborted。
 *   E3 回放:没开始 / 只读断在半截 / 有副作用断在半截 / 挂起作废 各一句;本进程还在写的段不套用;升级前的缺项照旧。
 *   E2 工具边界把当前段写进库:执行中的调用 started、还没轮到的 pending;用户按停 / 正常收尾落的那一行与没有进度写时一样
 *      (收尾时间戳也重盖成收尾那一刻);被停时带着这一批的进度;done 先落库、done 事件后发。
 * 负对照(实跑过):runLoop catch 里 interruptReason 恒取 undefined → E1 第一例红;
 *   去掉执行前的 requestProgress / markCallStarted → E2 第一例红;finalizeSegment 不传 restamp → E2 收尾那例红。
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
import { markRecoveryHost, markLiveRow, unmarkLiveRow, NOT_RUN_RESULT, INTERRUPTED_READ_RESULT, OUTCOME_UNKNOWN_RESULT, APPROVAL_EXPIRED_RESULT, QUESTION_EXPIRED_RESULT } from './runProgress.js';
import { replayAssistantHistory } from './historyReplay.js';

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

// ── E2 边跑边落库 ──
const bashCall = (id: string, command: string) => ({ id, type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command }) } });
const toolTurn = (calls: any[], text = '') => async (o: any): Promise<any> => {
  if (text) o.onToken(text);
  return { content: text, reasoning: '', finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5 }, toolCalls: calls };
};
const finalTurn = (text: string) => async (o: any): Promise<any> => {
  o.onToken(text);
  return { content: text, reasoning: '', finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 }, toolCalls: [] };
};
const HOST = { execMode: 'host', approvalMode: 'full-auto' };
const parsed = (v: any): any => (typeof v === 'string' ? JSON.parse(v) : v);
/** 正在跑的那条 sleep 被记成 started、排在它后面的被记成 pending 的那一刻。 */
async function waitMidTool(runId: string): Promise<any[]> {
  let results: any[] = [];
  await waitUntil(async () => {
    const row = await modelRow(`${runId}-a`);
    results = row?.tool_results ? parsed(row.tool_results) : [];
    return results.some((r) => r?.tool_call_id === 'c1' && r?.inflight?.state === 'started');
  }, '工具执行中的进度行');
  return results;
}

describe('E2 write-ahead persistence of the current assistant segment', () => {
  it('mid-tool the row already holds the calls, the running one as started and the next as pending; a user stop then writes today’s row', async () => {
    script = [toolTurn([bashCall('c1', 'sleep 30'), bashCall('c2', 'echo second')], 'Running two commands.')];
    const { runId, off } = await startRun(HOST);
    const mid = await waitMidTool(runId);
    const row = await modelRow(`${runId}-a`);
    expect(String(row.content)).toContain('Running two commands.');
    expect(parsed(row.tool_calls).map((c: any) => c.id)).toEqual(['c1', 'c2']);
    expect(mid.find((r) => r.tool_call_id === 'c1')).toMatchObject({ name: 'run_bash', inflight: { state: 'started' } });
    expect(mid.find((r) => r.tool_call_id === 'c2')).toMatchObject({ name: 'run_bash', inflight: { state: 'pending' } });
    expect(mid.find((r) => r.tool_call_id === 'c1').content).toBeUndefined();
    abortRun(runId, { byUser: true });
    const st = await settled(runId);
    off();
    expect(st.status).toBe('aborted');
    const after = await modelRow(`${runId}-a`);
    expect(after.tool_results, '用户按停的落库与今天一样:没结果的调用缺项,不留在飞记录').toBeNull();
    expect(await userRows()).toContain(TURN_INTERRUPTED_MARKER);
  }, 30_000);

  it('a planned shutdown mid-tool keeps the batch progress in the final row (the killed command’s own result, the next call pending)', async () => {
    script = [toolTurn([bashCall('c1', 'sleep 30'), bashCall('c2', 'echo second')])];
    const { runId, off } = await startRun(HOST);
    await waitMidTool(runId);
    await drainRunsForExit(3000, 'app_update');
    const st = await settled(runId);
    off();
    expect(st).toEqual({ status: 'interrupted', error: 'interrupted:app_update' });
    const results = parsed((await modelRow(`${runId}-a`)).tool_results);
    // run_bash 被中止时自己会返回(exit -1 aborted):那是它真实的结局,照记;后面那个还没轮到的记 pending。
    // 用户按停的同一时刻(上一例)这一批的两项都不落 —— 只有 interrupted 才带进度。
    const c1 = results.find((r: any) => r.tool_call_id === 'c1');
    expect(c1?.inflight).toBeUndefined();
    expect(String(c1?.content)).toContain('aborted');
    expect(results.find((r: any) => r.tool_call_id === 'c2')?.inflight).toEqual({ state: 'pending', sideEffect: expect.any(String) });
  }, 30_000);

  it('done path: the final row has only real results and is re-stamped at the final write; status done is recorded before the done event', async () => {
    let progressTs = 0;
    script = [
      toolTurn([bashCall('c1', 'echo first')], 'Step one.'),
      async (o) => {
        await new Promise((r) => setTimeout(r, 30)); // 让「进度写插入的时间」与「收尾落库的时间」拉开
        return finalTurn('All done.')(o);
      },
    ];
    const order: string[] = [];
    const { deps } = await import('../seams/runtime.js');
    const st0 = deps().state;
    const origUpdate = st0.updateRunStatus.bind(st0);
    const origAppend = st0.appendEvent.bind(st0);
    (st0 as any).updateRunStatus = async (id: string, status: string, extra?: any) => { if (status === 'done') order.push('status:done'); return origUpdate(id, status, extra); };
    (st0 as any).appendEvent = (id: string, type: string, payload: any) => { if (type === 'done') order.push('event:done'); return origAppend(id, type, payload); };
    try {
      const { runId, off } = await startRun(HOST);
      await waitUntil(async () => { const r = (await query<any[]>(`SELECT timestamp FROM chat_messages WHERE id = ?`, [`${runId}-a`]))[0]; if (r) progressTs = Number(r.timestamp); return !!r; }, '进度写插入的行');
      const st = await settled(runId);
      off();
      expect(st.status).toBe('done');
      const row = (await query<any[]>(`SELECT timestamp, content, tool_results FROM chat_messages WHERE id = ?`, [`${runId}-a`]))[0];
      const results = parsed(row.tool_results);
      expect(results).toHaveLength(1);
      expect(results[0].inflight).toBeUndefined();
      expect(String(results[0].content)).toContain('first');
      expect(String(row.content)).toContain('All done.');
      expect(Number(row.timestamp), '正式落库时把进度写插入时的时间戳改成收尾那一刻').toBeGreaterThan(progressTs);
      await waitUntil(() => order.includes('event:done'), 'done 事件');
      expect(order.indexOf('status:done')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('status:done'), 'done 先落库、事件后发').toBeLessThan(order.indexOf('event:done'));
    } finally {
      (st0 as any).updateRunStatus = origUpdate;
      (st0 as any).appendEvent = origAppend;
    }
  }, 30_000);
});

// ── E3 回放三分法 ──
describe('E3 replay of calls the engine never finished', () => {
  const call = (id: string, name: string) => ({ id, type: 'function', function: { name, arguments: '{}' } });
  const row = (id: string) => ({
    id, content: 'Working on it.',
    tool_calls: [call('p1', 'run_bash'), call('s1', 'read_file'), call('s2', 'write_file'), call('s3', 'mcp_x'), call('k1', 'delete_path'), call('k2', 'ask_user'), call('d1', 'list_dir'), call('m1', 'run_bash')],
    tool_results: [
      { tool_call_id: 'p1', name: 'run_bash', inflight: { state: 'pending', sideEffect: 'system' } },
      { tool_call_id: 's1', name: 'read_file', inflight: { state: 'started', sideEffect: 'read' } },
      { tool_call_id: 's2', name: 'write_file', inflight: { state: 'started', sideEffect: 'write' } },
      { tool_call_id: 's3', name: 'mcp_x', inflight: { state: 'started', sideEffect: 'unknown' } },
      { tool_call_id: 'k1', name: 'delete_path', content: '⏸ Waiting for the user\'s approval: delete x', parked: true },
      { tool_call_id: 'k2', name: 'ask_user', content: '⏸ Waiting for the user\'s answer: which one?', parked: true },
      { tool_call_id: 'd1', name: 'list_dir', content: 'a.txt\nb.txt' },
      // m1:升级前的行 / 没记下的 —— 缺项
    ],
  });
  const toolTexts = (msgs: any[]): Record<string, string> => Object.fromEntries(msgs.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, String(m.content)]));

  it('a row whose run is over: pending / started read-only / started with side effects / expired approval and question / real result / legacy gap', () => {
    const t = toolTexts(replayAssistantHistory(row('X1')));
    expect(t.p1).toBe(NOT_RUN_RESULT);
    expect(t.s1).toBe(INTERRUPTED_READ_RESULT);
    expect(t.s2).toBe(OUTCOME_UNKNOWN_RESULT);
    expect(t.s3, '没声明副作用的按有副作用说').toBe(OUTCOME_UNKNOWN_RESULT);
    expect(t.k1).toBe(APPROVAL_EXPIRED_RESULT);
    expect(t.k2).toBe(QUESTION_EXPIRED_RESULT);
    expect(t.d1).toBe('a.txt\nb.txt');
    expect(t.m1).toMatch(/^Tool outcome unknown: no result was saved/);
  });

  it('a row still being written by a live run in this process: in-flight records count as missing, parked placeholders stay', () => {
    markLiveRow('X2');
    try {
      const t = toolTexts(replayAssistantHistory(row('X2')));
      expect(t.p1).toMatch(/^Tool outcome unknown: no result was saved/);
      expect(t.s2).toMatch(/^Tool outcome unknown: no result was saved/);
      expect(t.k1).toContain('Waiting for the user');
    } finally { unmarkLiveRow('X2'); }
  });
});
