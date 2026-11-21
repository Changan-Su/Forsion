/**
 * 中断任务续跑方案 B 的 Codex 评审(11-20)返修:真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 runResume.test.ts)。
 *   #1  同一个 run 入队两次只跑一次;执行入口原子认领 queued → running,已经不是 queued 的不再执行、同会话队列照常推进。
 *   #2  按停当场把取消请求落库;强杀后重启先认取消 → aborted,不续(哪怕有可续的停引擎意图)。
 *   #3  建 run 记当时的云端账号;换了账号:被停下的不续(说明行 = account_change)、排队的不跑;意图文件在写它的进程还活着时留着。
 *   #4  「已开始」没落上库:有副作用的调用不执行,结果如实说没跑;只读的照常执行。
 *   #5  终稿与 done 同一事务(done 那半写失败 → 终稿也不落)。#6 先回写工作区再提交。#7 非恢复宿主照原来的顺序(先发 done 事件再记)。
 *   #8  认领 + 写行 + 建续跑 run 同一事务(建 run 失败 → 整段回滚、改补说明行);没有事务的库认领后崩了 → 下次照同一个 id 补齐。
 *   #9  门控 7 用 rowid 判先后(同一秒建的更新的 run 也挡住);提交前在事务里再验一遍。
 *   #10 interrupted_at 是被停下那一刻:补标 / 认领不挪它,过期按它算。
 * 负对照(实跑过,见日志):各条撤掉修复后对应的例子变红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu, deps } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { createRun, getRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { enqueueRun, abortRun, recoverQueuedRuns, __resetExitForTests, TURN_INTERRUPTED_MARKER, ownRunIds, wouldAutoResume } from './agentLoop.js';
import { autoResumeMarker, interruptedNoticeMarker } from '../contracts/turnResume.js';
import { SHUTDOWN_INTENT_FILE, parseShutdownIntent } from '../contracts/shutdownIntent.js';
import { markRecoveryHost, CALL_NOT_STARTED_RESULT } from './runProgress.js';
import { setCloudTokenSource, accountOfToken } from './cloudAccount.js';
import { derivedId } from './runResume.js';

// #6:回写工作区(flush → snapshotSession)排在终稿 + done 的事务之前。其余原样。
const order: string[] = [];
vi.mock('../sandbox/sessionSandbox.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../sandbox/sessionSandbox.js')>();
  return { ...orig, snapshotSession: async (...a: Parameters<typeof orig.snapshotSession>) => { order.push('flush'); return orig.snapshotSession(...a); } };
});

const USER = 'u1';
let home: string;
let script: Array<(o: any) => Promise<any>>;
let streamCalls: number;
let probe: ((model: string) => Promise<void>) | null;

const DEAD_PID = spawnSync(process.execPath, ['-e', '0']).pid as number;
const DEAD = `${DEAD_PID}:1700000000`;
const jwt = (userId: string): string => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-resume-review-'));
  process.env.TANGU_HOME = home;
  script = [];
  streamCalls = 0;
  probe = null;
  order.length = 0;
  __resetExitForTests();
  markRecoveryHost(true);
  setCloudTokenSource(null);
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async (model: string) => { await probe?.(model); return { model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }; },
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
  await seedSession('S');
});

afterEach(() => {
  markRecoveryHost(false);
  setCloudTokenSource(null);
  __resetExitForTests();
  delete process.env.TANGU_HOME;
  delete process.env.TANGU_AUTO_RESUME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function seedSession(id: string, kind = 'user', model = 'm1'): Promise<void> {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', ?, ?)`, [id, USER, model, kind]);
}
let seq = 0;
async function startRun(agentConfig: any = { execMode: 'sandbox', cwd: '' }, session = 'S'): Promise<{ runId: string; off: () => void }> {
  const runId = `V${++seq}`;
  await createRun({
    id: runId, sessionId: session, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { ...agentConfig, cwd: agentConfig.cwd || home } },
  });
  const off = subscribe(runId, (ev) => { if (ev.type === 'done') order.push('event:done'); });
  enqueueRun(session, runId);
  return { runId, off };
}
async function waitUntil(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时:${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function settled(runId: string): Promise<any> {
  await waitUntil(async () => !['queued', 'running'].includes(String((await getRun(runId))?.status)), `run ${runId} 收尾`);
  return getRun(runId);
}
/** 直接写库造一条被停下 / 停在 running / 排队的 run(带本轮用户消息行)。 */
async function seedRun(o: { id: string; session: string; status: 'running' | 'interrupted' | 'queued'; reason?: string; input?: any; ageMin?: number; owner?: string | null }): Promise<void> {
  await createRun({
    id: o.id, sessionId: o.session, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${o.id}-a`,
    input: { message: `task of ${o.id}`, userMessageId: `${o.id}-u`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home }, origin: 'client', ...(o.input || {}) },
  });
  if (o.status !== 'queued') {
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error) VALUES (?, ?, 'user', ?, ?, 'm1', FALSE)`,
      [`${o.id}-u`, o.session, `task of ${o.id}`, Date.now() - (o.ageMin ?? 0) * 60_000 - 1000]);
  }
  await query(`UPDATE agent_runs SET status = ?, error = ?, owner = ?, updated_at = datetime('now', ?) WHERE id = ?`,
    [o.status, o.status === 'interrupted' ? `interrupted:${o.reason || 'app_quit'}` : null, o.owner === undefined ? DEAD : o.owner, `-${o.ageMin ?? 0} minutes`, o.id]);
}
const runRow = async (id: string): Promise<any> => (await query<any[]>(`SELECT * FROM agent_runs WHERE id = ?`, [id]))[0];
const resumesOf = async (id: string): Promise<any[]> =>
  (await query<any[]>(`SELECT id, status, input FROM agent_runs WHERE json_extract(input, '$.resumeOf') = ?`, [id])).map((r) => ({ ...r, input: JSON.parse(r.input) }));
const userRowsOf = async (sid: string): Promise<string[]> =>
  (await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY rowid ASC`, [sid])).map((r) => String(r.content));
const finalTurn = (text: string) => async (o: any): Promise<any> => {
  o.onToken(text);
  return { content: text, reasoning: '', finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 }, toolCalls: [] };
};
const hang = (text = 'Working') => async (o: any): Promise<any> => {
  o.onToken(text);
  await new Promise<void>((_, reject) => {
    const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (o.signal?.aborted) return fail();
    o.signal?.addEventListener('abort', fail, { once: true });
  });
};
const bashCall = (id: string, command: string) => ({ id, type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command }) } });
const toolTurn = (calls: any[]) => async (): Promise<any> => ({ content: '', reasoning: '', finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5 }, toolCalls: calls });
const HOST = { execMode: 'host', approvalMode: 'full-auto' };

describe('#1 a run is executed once', () => {
  it('enqueueing the same run twice runs it once', async () => {
    script = [finalTurn('Once.'), finalTurn('Twice?!')];
    const { runId, off } = await startRun();
    enqueueRun('S', runId);
    expect((await settled(runId)).status).toBe('done');
    await new Promise((r) => setTimeout(r, 300));
    off();
    expect(streamCalls).toBe(1);
  });

  it('a row that is no longer queued when it is dispatched is not run again; the session queue still moves on', async () => {
    script = [finalTurn('Second ran.')];
    await createRun({ id: 'X1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'X1-a', input: { message: 'go', userMessageId: 'X1-u', attachments: [], agentConfig: { execMode: 'sandbox', cwd: home } } });
    await query(`UPDATE agent_runs SET status = 'running' WHERE id = 'X1'`); // 另一个队列项 / 另一个引擎已经认领执行了
    await createRun({ id: 'X2', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'X2-a', input: { message: 'next', userMessageId: 'X2-u', attachments: [], agentConfig: { execMode: 'sandbox', cwd: home } } });
    enqueueRun('S', 'X1');
    enqueueRun('S', 'X2');
    expect((await settled('X2')).status).toBe('done');
    expect(streamCalls, 'X1 没被再执行一遍').toBe(1);
    expect((await runRow('X1')).status).toBe('running');
  });
});

describe('#2 a stop request survives a hard kill', () => {
  it('pressing stop writes the request at once; a restart settles it as aborted even with a resumable intent, and leaves the stop marker', async () => {
    script = [hang()];
    const { runId, off } = await startRun();
    await waitUntil(() => streamCalls === 1, '在跑');
    abortRun(runId, { byUser: true });
    expect((await runRow(runId)).cancel_requested, '调用返回时已落库').toBe('user');
    await settled(runId);
    off();
    // 模拟「按停后进程立刻被强杀」:终态没写成,行还是 running、持有者已死,还留着一份可续的意图
    await seedSession('C1');
    await seedRun({ id: 'c1', session: 'C1', status: 'running' });
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error) VALUES ('c1-a', 'C1', 'model', 'half', ?, 'm1', FALSE)`, [Date.now()]);
    await query(`UPDATE agent_runs SET cancel_requested = 'user' WHERE id = 'c1'`);
    writeFileSync(join(home, SHUTDOWN_INTENT_FILE), JSON.stringify({ reason: 'app_quit', pid: DEAD_PID, at: Date.now() }));
    script = [finalTurn('Should not run.')];
    await recoverQueuedRuns();
    expect(await runRow('c1')).toMatchObject({ status: 'aborted', error: 'aborted' });
    expect(await resumesOf('c1')).toHaveLength(0);
    expect(await userRowsOf('C1')).toContain(TURN_INTERRUPTED_MARKER);
    expect((await userRowsOf('C1')).some((c) => c.startsWith('<turn_resume>') || c.startsWith('<turn_interrupted>\n[reason'))).toBe(false);
  });

  it('a cancelled queued run is not picked up; an interrupted row with a stop request is closed as aborted', async () => {
    await seedSession('C2');
    await seedRun({ id: 'c2q', session: 'C2', status: 'queued' });
    await query(`UPDATE agent_runs SET cancel_requested = 'remote_estop' WHERE id = 'c2q'`);
    await seedSession('C3');
    await seedRun({ id: 'c3', session: 'C3', status: 'interrupted', reason: 'app_update' });
    await query(`UPDATE agent_runs SET cancel_requested = 'cancel' WHERE id = 'c3'`);
    script = [finalTurn('Should not run.')];
    await recoverQueuedRuns();
    await new Promise((r) => setTimeout(r, 200));
    expect(streamCalls).toBe(0);
    expect((await runRow('c2q')).status).toBe('aborted');
    expect(await runRow('c3')).toMatchObject({ status: 'aborted', resumed_by: '-' });
    expect(await resumesOf('c3')).toHaveLength(0);
  });
});

describe('#3 account binding', () => {
  it('a run records the account it was created under', async () => {
    setCloudTokenSource(() => jwt('acct-A'));
    expect(accountOfToken(jwt('acct-A'))).toBe('acct-A');
    expect(accountOfToken('')).toBe('');
    expect(accountOfToken('opaque-token')).toBeNull();
    await seedSession('A0');
    await seedRun({ id: 'a0', session: 'A0', status: 'queued' });
    expect(JSON.parse((await runRow('a0')).input).cloudAccount).toBe('acct-A');
  });

  it('after an account switch: the interrupted run is not resumed (notice says account_change), the queued one is not run', async () => {
    setCloudTokenSource(() => jwt('acct-A'));
    await seedSession('A1'); await seedRun({ id: 'a1', session: 'A1', status: 'interrupted', reason: 'app_update' });
    await seedSession('A2'); await seedRun({ id: 'a2', session: 'A2', status: 'queued' });
    setCloudTokenSource(() => jwt('acct-B'));
    script = [finalTurn('Should not run.')];
    await recoverQueuedRuns();
    await new Promise((r) => setTimeout(r, 200));
    expect(streamCalls).toBe(0);
    expect(await resumesOf('a1')).toHaveLength(0);
    expect(await runRow('a1')).toMatchObject({ resumed_by: '-', error: 'interrupted:account_change' });
    expect(await userRowsOf('A1')).toContain(interruptedNoticeMarker('account_change'));
    expect(await runRow('a2')).toMatchObject({ status: 'interrupted', error: 'interrupted:account_change', resumed_by: '-' });
    expect(await userRowsOf('A2')).toEqual(['task of a2', interruptedNoticeMarker('account_change')]);
  });

  it('same account: resumed as before', async () => {
    setCloudTokenSource(() => jwt('acct-A'));
    await seedSession('A3'); await seedRun({ id: 'a3', session: 'A3', status: 'interrupted', reason: 'app_update' });
    script = [finalTurn('Resumed.')];
    await recoverQueuedRuns();
    await waitUntil(async () => (await resumesOf('a3'))[0]?.status === 'done', '续跑跑完');
  });

  it('the intent file stays while the engine that wrote it is still alive; it is removed once that engine is gone', async () => {
    const file = join(home, SHUTDOWN_INTENT_FILE);
    writeFileSync(file, JSON.stringify({ reason: 'account_change', pid: process.ppid, at: Date.now() }));
    await recoverQueuedRuns();
    expect(existsSync(file), '写它的进程还活着').toBe(true);
    writeFileSync(file, JSON.stringify({ reason: 'account_change', pid: DEAD_PID, at: Date.now() }));
    await recoverQueuedRuns();
    expect(existsSync(file)).toBe(false);
  });

  it('D3: engine_stop is a valid intent reason and is not resumed', async () => {
    expect(parseShutdownIntent(JSON.stringify({ reason: 'engine_stop', pid: 5, at: 1 }))).toEqual({ reason: 'engine_stop', pid: 5, at: 1 });
    await seedSession('A4'); await seedRun({ id: 'a4', session: 'A4', status: 'running' });
    writeFileSync(join(home, SHUTDOWN_INTENT_FILE), JSON.stringify({ reason: 'engine_stop', pid: DEAD_PID, at: Date.now() }));
    await recoverQueuedRuns();
    expect(await runRow('a4')).toMatchObject({ status: 'interrupted', error: 'interrupted:engine_stop', resumed_by: '-' });
    expect(await userRowsOf('A4')).toContain(interruptedNoticeMarker('engine_stop'));
  });
});

describe('#4 a call with side effects does not start unless "started" is on disk', () => {
  it('the started write fails → run_bash is not executed and the model is told it did not run', async () => {
    const marker = join(home, 'touched.txt');
    const st: any = deps().state;
    const orig = st.persistAssistantProgress;
    st.persistAssistantProgress = async (m: any) => {
      if ((m.toolResults || []).some((r: any) => r?.inflight?.state === 'started')) throw new Error('disk full');
      return orig.call(st, m);
    };
    let seen = '';
    script = [toolTurn([bashCall('b1', `echo hi > ${marker}`)]), async (o: any) => { seen = (o.payload?.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)).join('\n'); return finalTurn('ok')(o); }];
    try {
      const { runId, off } = await startRun(HOST);
      expect((await settled(runId)).status).toBe('done');
      off();
    } finally { st.persistAssistantProgress = orig; }
    expect(existsSync(marker), '有副作用的调用没执行').toBe(false);
    expect(seen).toContain(CALL_NOT_STARTED_RESULT);
  });

  it('a read-only call still runs when the started write fails', async () => {
    writeFileSync(join(home, 'note.txt'), 'READ-ME-123');
    const st: any = deps().state;
    const orig = st.persistAssistantProgress;
    st.persistAssistantProgress = async (m: any) => {
      if ((m.toolResults || []).some((r: any) => r?.inflight?.state === 'started')) throw new Error('disk full');
      return orig.call(st, m);
    };
    let seen = '';
    script = [toolTurn([{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: join(home, 'note.txt') }) } }]),
      async (o: any) => { seen = (o.payload?.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)).join('\n'); return finalTurn('ok')(o); }];
    try {
      const { runId, off } = await startRun(HOST);
      expect((await settled(runId)).status).toBe('done');
      off();
    } finally { st.persistAssistantProgress = orig; }
    expect(seen).toContain('READ-ME-123');
  });
});

describe('#5 #6 #7 how a finished turn is committed', () => {
  it('#5 the final row and done are one transaction: if done cannot be written, the final row is not there either', async () => {
    await seedSession('T1');
    await seedRun({ id: 't1', session: 'T1', status: 'running', owner: null });
    const raw = (deps().host as any);
    // 让 done 那半在事务里失败
    raw.transactionSync((run: any) => run(`CREATE TRIGGER no_done BEFORE UPDATE OF status ON agent_runs WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'boom'); END`));
    const m = { messageId: 't1-a', sessionId: 'T1', content: 'Final answer', reasoning: '', toolCalls: [], toolResults: [], modelId: 'm1' };
    await expect(deps().state.completeRun!(m as any, { runId: 't1', result: { content: 'Final answer' } })).rejects.toThrow(/boom/);
    expect((await query<any[]>(`SELECT 1 FROM chat_messages WHERE id = 't1-a'`)).length, '终稿随 done 一起回滚').toBe(0);
    expect((await runRow('t1')).status).toBe('running');
  });

  it('#6 the workspace is written back before the final row + done are committed; the done event comes after', async () => {
    const st: any = deps().state;
    const orig = st.completeRun;
    st.completeRun = async (m: any, d: any) => { order.push('commit'); return orig.call(st, m, d); };
    script = [finalTurn('All done.')];
    try {
      const { runId, off } = await startRun();
      await settled(runId);
      await waitUntil(() => order.includes('event:done'), 'done 事件');
      off();
    } finally { st.completeRun = orig; }
    const seen = order.filter((x) => x === 'flush' || x === 'commit' || x === 'event:done');
    expect(seen.indexOf('flush')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('flush'), '先回写').toBeLessThan(seen.indexOf('commit'));
    expect(seen.indexOf('commit')).toBeLessThan(seen.indexOf('event:done'));
  });

  it('#7 not a recovery host (cloud worker / TUI): the done event is published before done is recorded, as before', async () => {
    markRecoveryHost(false);
    const st: any = deps().state;
    const origUpdate = st.updateRunStatus;
    const origComplete = st.completeRun;
    st.updateRunStatus = async (id: string, status: string, extra?: any) => { if (status === 'done') order.push('status:done'); return origUpdate.call(st, id, status, extra); };
    st.completeRun = async (...a: any[]) => { order.push('commit'); return origComplete.apply(st, a); };
    script = [finalTurn('All done.')];
    try {
      const { runId, off } = await startRun();
      await settled(runId);
      off();
    } finally { st.updateRunStatus = origUpdate; st.completeRun = origComplete; }
    const seen = order.filter((x) => x === 'status:done' || x === 'commit' || x === 'event:done');
    expect(seen).toEqual(['event:done', 'status:done']);
  });
});

describe('#8 claim + marker + resume run are committed together', () => {
  it('creating the resume run fails → nothing half-done: the claim is rolled back and the notice path takes over', async () => {
    await seedSession('M1'); await seedRun({ id: 'm1', session: 'M1', status: 'interrupted', reason: 'app_update' });
    (deps().host as any).transactionSync((run: any) => run(`CREATE TRIGGER no_resume BEFORE INSERT ON agent_runs WHEN NEW.input LIKE '%"trigger":"recovery"%' BEGIN SELECT RAISE(ABORT, 'boom'); END`));
    await recoverQueuedRuns();
    expect((await runRow('m1')).resumed_by, '不留指向不存在的 run 的认领').toBe('-');
    const rows = await userRowsOf('M1');
    expect(rows.some((c) => c.startsWith('<turn_resume>')), '续跑行随事务回滚').toBe(false);
    expect(rows).toContain(interruptedNoticeMarker('app_update'));
  });

  it('a claim whose resume run never got written (a store without transactions crashed in between) is completed on the next start', async () => {
    await seedSession('M2'); await seedRun({ id: 'm2', session: 'M2', status: 'interrupted', reason: 'app_update' });
    await query(`UPDATE agent_runs SET resumed_by = 'M2-RESUME' WHERE id = 'm2'`);
    script = [finalTurn('Picked up.')];
    await recoverQueuedRuns();
    await waitUntil(async () => (await runRow('M2-RESUME'))?.status === 'done', '补齐的续跑跑完');
    const resume = await runRow('M2-RESUME');
    expect(JSON.parse(resume.input)).toMatchObject({ trigger: 'recovery', resumeOf: 'm2', userMessageId: derivedId('marker', 'M2-RESUME') });
    expect((await userRowsOf('M2')).filter((c) => c === autoResumeMarker('app_update'))).toHaveLength(1);
  });
});

describe('#9 gate 7 uses a stable order and is checked again at commit', () => {
  it('a newer run created in the same second (already finished) still blocks the resume', async () => {
    await seedSession('N1'); await seedRun({ id: 'n1', session: 'N1', status: 'interrupted', reason: 'app_update', ageMin: 0 });
    await createRun({ id: 'n2', sessionId: 'N1', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'n2-a', input: { message: 'newer', userMessageId: 'n2-u', attachments: [] } });
    await query(`UPDATE agent_runs SET status = 'done', created_at = (SELECT created_at FROM agent_runs WHERE id = 'n1') WHERE id = 'n2'`);
    await recoverQueuedRuns();
    expect(await resumesOf('n1')).toHaveLength(0);
    expect(await userRowsOf('N1')).toContain(interruptedNoticeMarker('app_update'));
  });

  it('a run that appears while the resume is being prepared is caught by the re-check inside the transaction', async () => {
    await seedSession('N3', 'user', 'm-session'); // 会话模型与旧 run 不同 → 准备续跑时探一次旧模型(那段空档里插进一个新 run)
    await seedRun({ id: 'n3', session: 'N3', status: 'interrupted', reason: 'app_update' });
    probe = async () => {
      probe = null;
      await createRun({ id: 'n4', sessionId: 'N3', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'n4-a', input: { message: 'meanwhile', userMessageId: 'n4-u', attachments: [] } });
      await query(`UPDATE agent_runs SET status = 'done' WHERE id = 'n4'`);
    };
    await recoverQueuedRuns();
    expect(await resumesOf('n3')).toHaveLength(0);
    expect(await userRowsOf('N3')).toContain(interruptedNoticeMarker('app_update'));
  });
});

describe('#10 the time a run stopped is kept', () => {
  it('re-marking does not move the clock: a crash marked 3 hours ago is expired even though the row was touched just now', async () => {
    await seedSession('E1'); await seedRun({ id: 'e1', session: 'E1', status: 'interrupted', reason: 'crash' });
    await query(`UPDATE agent_runs SET interrupted_at = datetime('now', '-180 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = 'e1'`);
    await recoverQueuedRuns();
    expect(await resumesOf('e1')).toHaveLength(0);
    expect(await userRowsOf('E1')).toContain(interruptedNoticeMarker('crash'));
  });

  it('the orphan sweep stamps interrupted_at with the last activity, not with now', async () => {
    await seedSession('E2'); await seedRun({ id: 'e2', session: 'E2', status: 'running', ageMin: 180 });
    await recoverQueuedRuns();
    const r = (await query<any[]>(`SELECT CASE WHEN interrupted_at < datetime('now', '-170 minutes') THEN 1 ELSE 0 END AS old, status, resumed_by FROM agent_runs WHERE id = 'e2'`))[0];
    expect(r).toMatchObject({ old: 1, status: 'interrupted', resumed_by: '-' });
  });
});

describe('D5 D10 restart status counts only this process', () => {
  it('own runs only; resumable excludes runs that would not be resumed', async () => {
    await seedSession('D1'); await seedRun({ id: 'd-orphan', session: 'D1', status: 'running' }); // 别的(已死)进程留下的
    script = [hang(), hang()];
    const a = await startRun();
    markRecoveryHost(false); // 不带 hostRecovery 戳(TUI 起的)→ 停了也不会被自动续
    await seedSession('D2');
    const b = await startRun({ execMode: 'sandbox', cwd: '' }, 'D2');
    markRecoveryHost(true);
    await waitUntil(() => streamCalls === 2, '两条都在跑');
    expect(ownRunIds().sort()).toEqual([a.runId, b.runId].sort());
    expect(await wouldAutoResume(a.runId)).toBe(true);
    expect(await wouldAutoResume(b.runId), '没有 hostRecovery 戳').toBe(false);
    expect(await wouldAutoResume('d-orphan'), '它不在本进程的清单里,但单看也会被续').toBe(true);
    await seedSession('D3'); await seedRun({ id: 'd-group', session: 'D3', status: 'queued', input: { agentConfig: { execMode: 'sandbox', cwd: home, groupChat: true } } });
    expect(await wouldAutoResume('d-group'), '群聊编排不续').toBe(false);
    process.env.TANGU_AUTO_RESUME = '0';
    expect(await wouldAutoResume(a.runId)).toBe(false);
    abortRun(a.runId); abortRun(b.runId);
    await settled(a.runId); await settled(b.runId);
    a.off(); b.off();
  });
});

