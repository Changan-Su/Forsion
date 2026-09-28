/**
 * P1 · K2 §3.5:远程活动 / 急停 / 解锁四条路由。真 express + 真路由 + 真 agentLoop(内存 SQLite,模型挂住直到被中止)+ 真后台进程。
 *   S5  急停中止远程 + 通道 + 无人值守 run(终态事件带 reason:'remote_estop')、杀它们的后台进程、撤回远端批准的 Muse 条目;本机交互 run 不动;
 *       恒上闩 → 之后新的远程 run 在 dispatchRun 被拦(remote_locked)。
 *   S2  解锁:锁文件 ENOENT / 仍 locked / 坏 JSON → 409 且闩不动(只凭本机令牌清不掉);主进程写好 lock:null 之后才清。
 *   S11 带 x-forsion-remote → 403(unitWeb 允许清单之外的第二道);hostExec=false(云端 worker)→ 404。
 *   SSE 连上即一帧全量 snapshot,之后每次变更再发全量。
 * 负对照(实跑见红,记在 K2 交付报告):estop 去掉 killProcessesWhere → 「后台进程被杀」红;去掉路由里的远程判断 → 403 那条红。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { subscribe } from '../src/services/eventBus.js';
import { enqueueRun, abortRun } from '../src/services/agentLoop.js';
import remoteRouter from '../src/routes/remote.js';
import { REMOTE_LOCK_FILE_ENV, __resetRemoteLatchForTests, remoteLocked } from '../src/services/remoteLock.js';
import { startBackgroundProcess, disposeAllProcesses, type BackgroundProcess } from '../src/tools/processRegistry.js';
import { recordRemoteCreated, listRemoteCreated } from '../src/services/remoteCreated.js';
import { ensureEntry, validateEntryInput, loadSchedule, entriesOf } from '../src/services/agentSchedule.js';

const USER = 'u1';
const AUTH = { Authorization: 'Bearer x' };
const REMOTE_HDR = { 'x-forsion-remote': 'tunnel' };
let home: string;
let lockFile: string;
let srv: Server;
let base: string;
let deps: any;

const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { headers: { ...AUTH, ...headers } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-routes-'));
  process.env.TANGU_HOME = home;
  lockFile = join(home, 'remote-lock.json');
  process.env[REMOTE_LOCK_FILE_ENV] = lockFile;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const hang = (o: any): Promise<any> => new Promise((_res, rej) => {
    const fail = (): void => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (o.signal?.aborted) return fail();
    o.signal?.addEventListener('abort', fail, { once: true });
  });
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        return hang(o); // 在飞:直到被中止
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  deps = { host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) };
  configureTangu(deps);
  await runMigration();
  for (const s of ['SR', 'SC', 'SM', 'SL', 'SN']) await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [s, USER]);
  const app = express();
  app.use(express.json());
  app.use(remoteRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  delete process.env[REMOTE_LOCK_FILE_ENV];
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  __resetRemoteLatchForTests();
  rmSync(lockFile, { force: true });
});
afterEach(() => {
  disposeAllProcesses();
  __resetRemoteLatchForTests();
});

let seq = 0;
const started: string[] = [];
afterEach(async () => { for (const id of started.splice(0)) abortRun(id); });
async function start(session: string, extra: Record<string, unknown>): Promise<{ runId: string; errors: any[] }> {
  const runId = `RR${++seq}`;
  const { agentConfig, ...rest } = extra as any;
  await createRun({
    id: runId, sessionId: session, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'host', cwd: home, ...(agentConfig || {}) }, ...rest },
  });
  const errors: any[] = [];
  subscribe(runId, (ev) => { if (ev.type === 'error') errors.push(ev.payload); });
  enqueueRun(session, runId);
  started.push(runId);
  return { runId, errors };
}
const statusOf = async (runId: string): Promise<string> => String((await getRun(runId))?.status);
const settled = (runId: string): Promise<void> => vi.waitFor(async () => expect(['done', 'failed', 'aborted']).toContain(await statusOf(runId)), { timeout: 8000 });
const alive = (pid: number | null): boolean => { try { process.kill(pid!, 0); return true; } catch { return false; } };

const REMOTE = { remote: { via: 'tunnel', marked: true, callerUnit: '0f5b2c1e-8a3d-4c6b-9e7f-1a2b3c4d5e6f', callerKind: 'phone', callerName: 'Pixel' } };

describe('路由闸:本机专用', () => {
  it('带 x-forsion-remote → 四条都 403 LOCAL_ONLY', async () => {
    for (const [m, p] of [['GET', '/agent/remote/activity'], ['GET', '/agent/remote/activity/events'], ['POST', '/agent/remote/estop'], ['POST', '/agent/remote/unlock']] as const) {
      const r = m === 'GET' ? await get(p, REMOTE_HDR) : await post(p, {}, REMOTE_HDR);
      expect([p, r.status, r.body?.code]).toEqual([p, 403, 'LOCAL_ONLY']);
    }
    expect(remoteLocked()).toBe(false); // 远端的 estop 没有上闩
  });

  it('hostExec=false(云端 worker)→ 四条都 404', async () => {
    configureTangu({ ...deps, profile: createAiStudioProfile() });
    try {
      for (const [m, p] of [['GET', '/agent/remote/activity'], ['GET', '/agent/remote/activity/events'], ['POST', '/agent/remote/estop'], ['POST', '/agent/remote/unlock']] as const) {
        expect((m === 'GET' ? await get(p) : await post(p)).status).toBe(404);
      }
    } finally { configureTangu(deps); }
  });
});

describe('活动快照 + SSE', () => {
  it('GET /agent/remote/activity 列在飞 run(含分类、调用方);SSE 首帧全量、变更再推', async () => {
    const res = await fetch(`${base}/agent/remote/activity/events`, { headers: AUTH });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let raw = '';
    const frames = (): any[] => raw.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l!.slice(6)));
    let pending: Promise<any> | null = null; // 同一时刻只挂一个 read():超时的那次留着下轮接着等,别丢字节
    const readUntil = async (pred: (f: any[]) => boolean): Promise<void> => {
      const end = Date.now() + 4000;
      while (!pred(frames()) && Date.now() < end) {
        pending ??= reader.read();
        const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), 200))]);
        if (!r) continue;
        pending = null;
        if (r.done) break;
        raw += dec.decode(r.value, { stream: true });
      }
    };
    await readUntil((f) => f.length >= 1);
    expect(frames()[0]).toMatchObject({ type: 'snapshot', v: 1, runs: [] });
    const r = await start('SR', REMOTE);
    await readUntil((f) => f.some((x) => x.runs?.some((y: any) => y.runId === r.runId)));
    const last = frames().filter((x) => x.runs?.length).pop();
    expect(last.runs).toEqual([expect.objectContaining({ runId: r.runId, sessionId: 'SR', category: 'remote', remote: expect.objectContaining({ via: 'tunnel', callerName: 'Pixel' }) })]);
    await reader.cancel();
    const snap = await get('/agent/remote/activity');
    expect(snap.body.runs.map((x: any) => x.runId)).toEqual([r.runId]);
    abortRun(r.runId);
    await settled(r.runId);
  });
});

describe('急停 + 解锁(S5 / S2)', () => {
  it('中止远程 / 通道 / 无人值守 run + 杀后台进程 + 撤回远端批准的 Muse 条目;本机 run 不动;恒上闩;解锁需主进程先写 lock:null', async () => {
    const remote = await start('SR', REMOTE);
    const channel = await start('SC', { source: { channel: 'wechat', accountId: 'a', openid: 'p', messageId: 'm' } });
    const muse = await start('SM', { background: 'muse' });
    const local = await start('SL', {});
    await vi.waitFor(async () => expect((await get('/agent/remote/activity')).body.runs.length).toBe(4), { timeout: 5000 });
    // 远程 run 起的后台进程(run 结束后仍会跑的那种)+ 本机的一个
    const rp = startBackgroundProcess('SR', 'sleep 60', home, { remote: { via: 'tunnel', marked: true }, runId: remote.runId, cwd: home } as any) as BackgroundProcess;
    const lp = startBackgroundProcess('SL', 'sleep 60', home, { runId: local.runId, cwd: home } as any) as BackgroundProcess;
    expect(typeof rp).toBe('object');
    // 远端批准的 Muse TODO:条目还没跑 → 急停撤回、TODO 回 pending
    await query(`INSERT INTO muse_todos (id, user_id, title, status) VALUES ('T1', ?, '整理下载', 'injected')`, [USER]);
    const v = validateEntryInput({ name: '整理下载', date: '2026-09-28T10:00', auto: true, todo: true, prompt: 'do it', description: 'todo T1' });
    if (!v.ok) throw new Error(v.error);
    const e = await ensureEntry('muse', v.value, (x) => x.description === 'todo T1');
    if (!e.ok) throw new Error(e.error);
    await recordRemoteCreated({ kind: 'muse-todo', slug: 'muse', entryId: e.entry.id, todoId: 'T1', via: 'tunnel' });

    const r = await post('/agent/remote/estop', { source: 'hotkey' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, killedProcesses: 1, revertedEntries: 1, locked: true });
    expect(r.body.aborted.map((x: any) => [x.runId, x.category]).sort()).toEqual([[remote.runId, 'remote'], [channel.runId, 'channel'], [muse.runId, 'unattended']].sort());
    for (const x of [remote, channel, muse]) {
      await settled(x.runId);
      expect(await statusOf(x.runId)).toBe('aborted');
      expect(x.errors.at(-1)).toMatchObject({ aborted: true, reason: 'remote_estop' });
    }
    expect(await statusOf(local.runId)).toBe('running');
    await vi.waitFor(() => expect(alive(rp.pid)).toBe(false), { timeout: 6000 });
    expect(alive(lp.pid)).toBe(true);
    expect(entriesOf((await loadSchedule('muse'))!).find((x) => x.id === e.entry.id)).toBeUndefined();
    expect((await query<any[]>(`SELECT status FROM muse_todos WHERE id = 'T1'`))[0].status).toBe('pending');
    expect(await listRemoteCreated()).toEqual([]);

    // 恒上闩:锁文件还没写(主进程写盘失败 / 还没到),新的远程 run 照样被拦
    expect(remoteLocked()).toBe(true);
    const late = await start('SN', REMOTE);
    await settled(late.runId);
    expect(late.errors.at(-1)).toMatchObject({ error: 'remote_locked', reason: 'remote_locked' });

    // 解锁:文件 ENOENT / 仍锁 / 坏 → 409,闩不动
    expect((await post('/agent/remote/unlock')).status).toBe(409);
    writeFileSync(lockFile, JSON.stringify({ v: 1, lock: { locked: true, at: 1, source: 'hotkey' }, hotkey: '' }));
    expect((await post('/agent/remote/unlock')).body).toMatchObject({ code: 'REMOTE_UNLOCK_NOT_CONFIRMED' });
    writeFileSync(lockFile, '{bad');
    expect((await post('/agent/remote/unlock')).status).toBe(409);
    expect(remoteLocked()).toBe(true);
    writeFileSync(lockFile, JSON.stringify({ v: 1, lock: null, hotkey: '' }));
    expect((await post('/agent/remote/unlock')).body).toEqual({ ok: true, locked: false });
    expect(remoteLocked()).toBe(false);

    abortRun(local.runId);
    await settled(local.runId);
  }, 30_000);

  it('急停幂等:没有在飞 run 也成功并上闩;source 非法按 settings', async () => {
    const r = await post('/agent/remote/estop', { source: 'evil' });
    expect(r.body).toEqual({ ok: true, aborted: [], killedProcesses: 0, revertedEntries: 0, locked: true });
    expect((await post('/agent/remote/estop', {})).body.locked).toBe(true);
  });
});
