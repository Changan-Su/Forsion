/**
 * 中断任务续跑(2026-11-20 方案 B)的引擎半边:真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 agentLoop.inflightPersist.test.ts)。
 *   E1 引擎被停(drainRunsForExit 带原因)→ interrupted(<原因>),不写「用户打断」标记,半截正文照落库;没原因 / 用户先按停 / 非恢复宿主 → 照旧 aborted。
 *   E3 回放:没开始 / 只读断在半截 / 有副作用断在半截 / 挂起作废 各一句;本进程还在写的段不套用;升级前的缺项照旧。
 *   E4 启动恢复:持有者已死的 running → interrupted(意图对上 pid 用意图的原因,否则 crash);过门控 → 续跑 run(trigger: recovery),
 *      否则只补一条中断说明;每道门各一例;两个恢复同时跑只续一次;答完的一轮(done 先落库)永不被续。
 *   E2 工具边界把当前段写进库:执行中的调用 started、还没轮到的 pending;用户按停 / 正常收尾落的那一行与没有进度写时一样
 *      (收尾时间戳也重盖成收尾那一刻);被停时带着这一批的进度;done 先落库、done 事件后发。
 * 负对照(实跑过):runLoop catch 里 interruptReason 恒取 undefined → E1 第一例红;
 *   去掉执行前的 requestProgress / markCallStarted → E2 第一例红;finalizeSegment 不传 restamp → E2 收尾那例红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
import { enqueueRun, abortRun, drainRunsForExit, recoverQueuedRuns, __resetExitForTests, TURN_INTERRUPTED_MARKER } from './agentLoop.js';
import { autoResumeMarker, interruptedNoticeMarker } from '../contracts/turnResume.js';
import { SHUTDOWN_INTENT_FILE } from '../contracts/shutdownIntent.js';
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
  it('mid-tool the row already holds the calls, the running one as started and the next as pending; a user stop keeps that progress (review #11)', async () => {
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
    const after = parsed((await modelRow(`${runId}-a`)).tool_results);
    // 评审 #11:用户按停也带着这一批的进度落最后一笔 —— 被停掉的那条命令的真结局照留,没轮到的记 pending,不再整行抹成「缺项」
    expect(String(after.find((r: any) => r.tool_call_id === 'c1')?.content)).toContain('aborted');
    expect(after.find((r: any) => r.tool_call_id === 'c2')?.inflight).toEqual({ state: 'pending', sideEffect: expect.any(String) });
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
    const origComplete = st0.completeRun!.bind(st0);
    (st0 as any).updateRunStatus = async (id: string, status: string, extra?: any) => { if (status === 'done') order.push('status:done'); return origUpdate(id, status, extra); };
    (st0 as any).completeRun = async (m: any, done: any) => { order.push('status:done'); order.push('tx'); return origComplete(m, done); };
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
      expect(order, '终稿与 done 同一事务(评审 #5),不再另调 updateRunStatus').toEqual(['status:done', 'tx', 'event:done']);
    } finally {
      (st0 as any).updateRunStatus = origUpdate;
      (st0 as any).completeRun = origComplete;
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

// ── E4 启动恢复 + 自动续跑 ──
const DEAD_PID = spawnSync(process.execPath, ['-e', '0']).pid as number;
const DEAD = `${DEAD_PID}:1700000000`; // 已退出的进程当持有者

async function seedSession(id: string, kind = 'user'): Promise<void> {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', ?)`, [id, USER, kind]);
}
/** 直接写库造一条被停下 / 停在 running 的 run(带本轮用户消息行)。tui = 模拟 TUI 建的(不带 hostRecovery 戳)。 */
async function seedRun(o: { id: string; session: string; status: 'running' | 'interrupted'; reason?: string; owner?: string; ageMin?: number; input?: any; tui?: boolean }): Promise<void> {
  if (o.tui) markRecoveryHost(false);
  try {
    await createRun({
      id: o.id, sessionId: o.session, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${o.id}-a`,
      input: { message: `task of ${o.id}`, userMessageId: `${o.id}-u`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home }, origin: 'client', ...(o.input || {}) },
    });
  } finally { markRecoveryHost(true); }
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error) VALUES (?, ?, 'user', ?, ?, 'm1', FALSE)`,
    [`${o.id}-u`, o.session, `task of ${o.id}`, Date.now() - (o.ageMin ?? 0) * 60_000 - 1000]);
  await query(`UPDATE agent_runs SET status = ?, error = ?, owner = ?, updated_at = datetime('now', ?) WHERE id = ?`,
    [o.status, o.status === 'interrupted' ? `interrupted:${o.reason || 'app_quit'}` : null, o.owner ?? DEAD, `-${o.ageMin ?? 0} minutes`, o.id]);
}
const runRow = async (id: string): Promise<any> => (await query<any[]>(`SELECT status, error, resumed_by FROM agent_runs WHERE id = ?`, [id]))[0];
const resumesOf = async (id: string): Promise<any[]> =>
  (await query<any[]>(`SELECT id, status, input FROM agent_runs WHERE json_extract(input, '$.resumeOf') = ?`, [id])).map((r) => ({ ...r, input: parsed(r.input) }));
const sessionUserRows = async (sid: string): Promise<string[]> =>
  (await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp ASC`, [sid])).map((r) => String(r.content));
async function settledResume(oldId: string): Promise<any> {
  await waitUntil(async () => { const r = await resumesOf(oldId); return r.length > 0 && !['queued', 'running'].includes(r[0].status); }, `续跑 ${oldId} 跑完`);
  return (await resumesOf(oldId))[0];
}

describe('E4 startup recovery and gated auto-resume', () => {
  afterEach(() => { delete process.env.TANGU_AUTO_RESUME; });

  it('crash mid-tool: the next start marks interrupted:crash, resumes once, and the model sees "outcome unknown" / "not run" instead of a rerun', async () => {
    // 先让真 loop 跑到工具执行中,拿到它边跑边落库的那一行(崩溃时库里就是这个样子)
    script = [toolTurn([bashCall('c1', 'sleep 30'), bashCall('c2', 'echo second')], 'Running two commands.')];
    const live = await startRun(HOST);
    await waitMidTool(live.runId);
    const progress = await modelRow(`${live.runId}-a`);
    const liveInput = parsed((await query<any[]>(`SELECT input FROM agent_runs WHERE id = ?`, [live.runId]))[0].input);
    abortRun(live.runId, { byUser: true });
    await settled(live.runId);
    live.off();
    // 照原样搬进另一个会话,持有者换成已死的进程 = 引擎在这一刻被强杀
    await seedSession('S2');
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error) VALUES ('K-u', 'S2', 'user', 'go', ?, 'm1', FALSE)`, [Date.now() - 5000]);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error, tool_calls, tool_results) VALUES ('K-a', 'S2', 'model', ?, ?, 'm1', FALSE, ?, ?)`,
      [progress.content, Date.now() - 4000, typeof progress.tool_calls === 'string' ? progress.tool_calls : JSON.stringify(progress.tool_calls), typeof progress.tool_results === 'string' ? progress.tool_results : JSON.stringify(progress.tool_results)]);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, app_id, status, model_id, assistant_message_id, input, owner) VALUES ('K', 'S2', ?, 'tangu', 'running', 'm1', 'K-a', ?, ?)`,
      [USER, JSON.stringify({ ...liveInput, userMessageId: 'K-u' }), DEAD]);

    let seen: any[] = [];
    script = [async (o) => { seen = o.payload?.messages ?? []; return finalTurn('Checked the state; continuing.')(o); }];
    await recoverQueuedRuns();
    expect(await runRow('K')).toMatchObject({ status: 'interrupted', error: 'interrupted:crash' });
    const resume = await settledResume('K');
    expect((await runRow('K')).resumed_by).toBe(resume.id);
    expect(resume.status).toBe('done');
    expect(resume.input).toMatchObject({ trigger: 'recovery', resumeOf: 'K', resumeAttempt: 1, message: autoResumeMarker('crash'), attachments: [] });
    const tools = Object.fromEntries(seen.filter((m: any) => m.role === 'tool').map((m: any) => [m.tool_call_id, String(m.content)]));
    expect(tools.c1, 'run_bash 开始了没结果:结局不明').toBe(OUTCOME_UNKNOWN_RESULT);
    expect(tools.c2, '排在后面没轮到:没跑过').toBe(NOT_RUN_RESULT);
    const userTexts = seen.filter((m: any) => m.role === 'user').map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    expect(userTexts.some((t: string) => t.includes('[auto-resume: crash]')), '续跑行进了这一轮的上下文').toBe(true);
    expect(userTexts.findIndex((t: string) => t.includes('[auto-resume: crash]')), '续跑行排在被续那一轮之后')
      .toBeGreaterThan(userTexts.findIndex((t: string) => t === 'go'));
    expect(await sessionUserRows('S2')).not.toContain(TURN_INTERRUPTED_MARKER);
    expect(streamCalls, '续跑只发一轮,工具没有被引擎重跑').toBe(2);
  }, 40_000);

  it('planned shutdown with an intent → continuation run; a stop without intent (engine_stop) only gets the notice', async () => {
    script = [streamThenHang('Halfway there')];
    const a = await startRun();
    await waitUntil(() => streamCalls === 1, '第一次模型调用');
    await new Promise((r) => setTimeout(r, 50));
    await drainRunsForExit(3000, 'app_quit');
    await settled(a.runId);
    a.off();
    __resetExitForTests();
    script = [finalTurn('Resumed and finished.')];
    await recoverQueuedRuns();
    const resume = await settledResume(a.runId);
    expect(resume.status).toBe('done');
    expect(resume.input.message).toBe(autoResumeMarker('app_quit'));
    expect(await userRows()).toContain(autoResumeMarker('app_quit'));

    script = [streamThenHang('Another one')];
    const b = await startRun();
    await waitUntil(() => streamCalls === 3, '第三次模型调用');
    await new Promise((r) => setTimeout(r, 50));
    await drainRunsForExit(3000, 'engine_stop');
    await settled(b.runId);
    b.off();
    __resetExitForTests();
    await recoverQueuedRuns();
    expect(await resumesOf(b.runId)).toHaveLength(0);
    expect((await runRow(b.runId)).resumed_by).toBe('-');
    expect(await userRows()).toContain(interruptedNoticeMarker('engine_stop'));
  }, 30_000);

  it('a 2-hour-old planned interruption is not eaten by the 30-minute stale sweep: matched by the owner pid in the intent file', async () => {
    await seedSession('S3');
    await seedRun({ id: 'P', session: 'S3', status: 'running', ageMin: 120 });
    writeFileSync(join(home, SHUTDOWN_INTENT_FILE), JSON.stringify({ reason: 'app_update', pid: DEAD_PID, at: Date.now() - 120 * 60_000 }));
    script = [finalTurn('Done after update.')];
    await recoverQueuedRuns();
    expect(await runRow('P')).toMatchObject({ status: 'interrupted', error: 'interrupted:app_update' });
    expect((await settledResume('P')).input.message).toBe(autoResumeMarker('app_update'));
    expect(existsSync(join(home, SHUTDOWN_INTENT_FILE)), '处理完删掉意图文件').toBe(false);
  }, 20_000);

  const blocked = async (id: string, session: string, reason: string): Promise<void> => {
    await recoverQueuedRuns();
    expect(await resumesOf(id), `${id} 不该自动续`).toHaveLength(0);
    expect((await runRow(id)).resumed_by).toBe('-');
    expect((await sessionUserRows(session)).filter((c) => c === interruptedNoticeMarker(reason as any)), '只补一条中断说明').toHaveLength(1);
  };

  it('gate: a reason that is not auto-resumable (account change)', async () => {
    await seedSession('G1'); await seedRun({ id: 'g1', session: 'G1', status: 'interrupted', reason: 'account_change' });
    await blocked('g1', 'G1', 'account_change');
  });
  it('gate: the setting is off (TANGU_AUTO_RESUME=0)', async () => {
    process.env.TANGU_AUTO_RESUME = '0';
    await seedSession('G2'); await seedRun({ id: 'g2', session: 'G2', status: 'interrupted', reason: 'app_quit' });
    await blocked('g2', 'G2', 'app_quit');
  });
  it('gate: too old (planned > 24h, crash > 2h)', async () => {
    await seedSession('G3'); await seedRun({ id: 'g3', session: 'G3', status: 'interrupted', reason: 'app_quit', ageMin: 25 * 60 });
    await seedSession('G3b'); await seedRun({ id: 'g3b', session: 'G3b', status: 'running', ageMin: 3 * 60 });
    await recoverQueuedRuns();
    for (const [id, sid, why] of [['g3', 'G3', 'app_quit'], ['g3b', 'G3b', 'crash']] as const) {
      expect(await resumesOf(id)).toHaveLength(0);
      expect(await sessionUserRows(sid)).toContain(interruptedNoticeMarker(why));
    }
  });
  it('gate: the chain already auto-resumed twice', async () => {
    await seedSession('G4'); await seedRun({ id: 'g4', session: 'G4', status: 'interrupted', reason: 'app_quit', input: { resumeAttempt: 2, trigger: 'recovery' } });
    await blocked('g4', 'G4', 'app_quit');
  });
  it('gate: crash loop (3 crashes in this session within the hour)', async () => {
    await seedSession('G5');
    await seedRun({ id: 'g5a', session: 'G5', status: 'interrupted', reason: 'crash', ageMin: 20 });
    await seedRun({ id: 'g5b', session: 'G5', status: 'interrupted', reason: 'crash', ageMin: 10 });
    await query(`UPDATE agent_runs SET resumed_by = '-' WHERE id IN ('g5a', 'g5b')`);
    await seedRun({ id: 'g5', session: 'G5', status: 'running' });
    await blocked('g5', 'G5', 'crash');
  });
  it('gate: not a user-facing session (teamwork is claimed silently; a delegate child gets the notice)', async () => {
    await seedSession('G6', 'teamwork'); await seedRun({ id: 'g6', session: 'G6', status: 'interrupted', reason: 'app_quit' });
    await seedSession('G6b', 'delegate'); await seedRun({ id: 'g6b', session: 'G6b', status: 'interrupted', reason: 'app_quit' });
    await recoverQueuedRuns();
    expect(await resumesOf('g6')).toHaveLength(0);
    expect((await runRow('g6')).resumed_by).toBe('-');
    expect(await sessionUserRows('G6')).not.toContain(interruptedNoticeMarker('app_quit'));
    expect(await resumesOf('g6b')).toHaveLength(0);
    expect(await sessionUserRows('G6b')).toContain(interruptedNoticeMarker('app_quit'));
  });
  it('gate: group chat runs are not resumed', async () => {
    await seedSession('G6c'); await seedRun({ id: 'g6c', session: 'G6c', status: 'interrupted', reason: 'app_quit', input: { agentConfig: { groupChat: true } } });
    await blocked('g6c', 'G6c', 'app_quit');
  });
  it('gate: the user already said something newer in that session', async () => {
    await seedSession('G7'); await seedRun({ id: 'g7', session: 'G7', status: 'interrupted', reason: 'app_quit', ageMin: 5 });
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error) VALUES ('g7-new', 'G7', 'user', 'actually do something else', ?, 'm1', FALSE)`, [Date.now()]);
    await blocked('g7', 'G7', 'app_quit');
  });
  it('gate: a queued run in that session runs instead (and sees the notice first)', async () => {
    await seedSession('G7b'); await seedRun({ id: 'g7b', session: 'G7b', status: 'interrupted', reason: 'app_quit', ageMin: 5 });
    await createRun({ id: 'g7q', sessionId: 'G7b', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'g7q-a', input: { message: 'next', userMessageId: 'g7q-u', attachments: [], agentConfig: { execMode: 'sandbox', cwd: home } } });
    await query(`UPDATE agent_runs SET owner = ? WHERE id = 'g7q'`, [DEAD]);
    let sawNotice = false;
    script = [async (o) => { sawNotice = (o.payload?.messages ?? []).some((m: any) => String(m.content).includes('[reason: app_quit]')); return finalTurn('Next done.')(o); }];
    await blocked('g7b', 'G7b', 'app_quit');
    await waitUntil(async () => (await runRow('g7q'))?.status === 'done', '排队的那条跑完');
    expect(sawNotice, '排队的那一轮看得到中断说明').toBe(true);
  }, 20_000);
  it('gate: a TUI-owned run (no hostRecovery stamp) is never auto-resumed', async () => {
    await seedSession('G8'); await seedRun({ id: 'g8', session: 'G8', status: 'running', tui: true });
    await blocked('g8', 'G8', 'crash');
  });

  it('two recoveries racing resume only once', async () => {
    await seedSession('R1'); await seedRun({ id: 'r1', session: 'R1', status: 'interrupted', reason: 'app_update' });
    script = [finalTurn('Once.'), finalTurn('Twice?!')];
    await Promise.all([recoverQueuedRuns(), recoverQueuedRuns()]);
    await settledResume('r1');
    expect(await resumesOf('r1')).toHaveLength(1);
    expect((await sessionUserRows('R1')).filter((c) => c.startsWith('<turn_resume>') || c.startsWith('<turn_interrupted>'))).toHaveLength(1);
  }, 20_000);

  it('non-SQLite store (no owner recorded): the resume run created in step ④ is not claimed and enqueued a second time in step ⑤', async () => {
    const { deps } = await import('../seams/runtime.js');
    const st: any = deps().state;
    const orig = { createRun: st.createRun, updateRunStatus: st.updateRunStatus, list: st.listPendingRunsForRecovery };
    // 照外部 PG / PGlite 的形态:建 run 不记持有者,恢复列表里 owner 一律为空
    st.createRun = async (run: any) => { const r = await orig.createRun.call(st, run); await query(`UPDATE agent_runs SET owner = NULL WHERE id = ?`, [run.id]); return r; };
    st.listPendingRunsForRecovery = async () => (await orig.list.call(st)).map((r: any) => ({ ...r, owner: null }));
    // 续跑晚一点才转 running(真库有网络延迟时就是这样):⑤ 列行时它还是 queued
    st.updateRunStatus = async (id: string, status: string, extra?: any) => {
      if (status === 'running') await new Promise((r) => setTimeout(r, 300));
      return orig.updateRunStatus.call(st, id, status, extra);
    };
    try {
      await seedSession('NP'); await seedRun({ id: 'np', session: 'NP', status: 'interrupted', reason: 'app_update' });
      script = [finalTurn('Once.'), finalTurn('Twice?!')];
      expect(await recoverQueuedRuns()).toBe(1);
      expect((await settledResume('np')).status).toBe('done');
      await new Promise((r) => setTimeout(r, 1000));
      expect(streamCalls, '续跑只跑一遍').toBe(1);
    } finally {
      st.createRun = orig.createRun; st.updateRunStatus = orig.updateRunStatus; st.listPendingRunsForRecovery = orig.list;
    }
  }, 20_000);

  it('a finished turn is never resumed: done is recorded right after the final answer, before the slow side work', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { deps } = await import('../seams/runtime.js');
    const st0 = deps().state;
    const origAppend = st0.appendEvent.bind(st0);
    // done 事件发不出去(= 进程死在收尾旁务里):这一刻库里必须已经是 done
    (st0 as any).appendEvent = async (id: string, type: string, payload: any) => { if (type === 'done') await hold; return origAppend(id, type, payload); };
    try {
      script = [finalTurn('The full answer.')];
      const { runId, off } = await startRun();
      await waitUntil(async () => String((await query<any[]>(`SELECT content FROM chat_messages WHERE id = ?`, [`${runId}-a`]))[0]?.content || '') === 'The full answer.', '终稿落库');
      await new Promise((r) => setTimeout(r, 100));
      expect((await runRow(runId)).status, '终稿落库之后立刻是 done').toBe('done');
      await query(`UPDATE agent_runs SET owner = ? WHERE id = ?`, [DEAD, runId]); // 当它的进程已经死了
      await recoverQueuedRuns();
      expect(await resumesOf(runId)).toHaveLength(0);
      expect((await runRow(runId)).status).toBe('done');
      release();
      off();
    } finally {
      release?.();
      (st0 as any).appendEvent = origAppend;
    }
  }, 20_000);
});
