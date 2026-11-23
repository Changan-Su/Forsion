/**
 * Multi-account mode: what a previous engine left behind, and closing idle account databases.
 *
 * Recovery: an account database copied from a real provisioned account is planted with rows a crashed engine leaves —
 * a run still marked running, one still queued (never started), one queued with a stop request, one interrupted but not
 * yet settled. On the account's first request in this process they are settled once: interrupted (not replayed), the
 * user's words restored, a notice row added, the stopped one aborted. Nothing reaches the model; other accounts are untouched.
 *
 * Eviction: an idle account's database handle is closed and reopens on the next request with everything intact, and the
 * reopening does not run the first-open recovery again. An account with a run in flight is never closed, and its run
 * finishes normally.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-life-')));
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, userHome, tmp]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['TANGU_DATABASE_URL', 'DATABASE_URL', 'TANGU_EMBED', 'TANGU_DATA_DIR', 'TANGU_BUNDLE_DIRS']) delete process.env[k];
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  process.env.TANGU_LOCAL_TOKEN = 'multi-account-local-host-token-qwertyuiop';
  process.env.HOME = userHome;
  process.env.TMPDIR = tmp;
  return { root, home };
});

vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
vi.mock('child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));

import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bootMultiAccount, canary, outboundAccount, randomUUID, runToEnd, startRun, steps, type MaEngine } from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';

const accDir = (id: string) => join(env.home, 'accounts', id);
const dbOf = (id: string, readonly = true) => new Database(join(accDir(id), 'state.db'), { readonly, fileMustExist: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let E: MaEngine;

beforeAll(async () => {
  E = await bootMultiAccount();
}, 60_000);

afterAll(async () => {
  await E?.dispose();
  rmSync(env.root, { recursive: true, force: true });
});

const DAVE = 'dave';
const W = { running: canary(DAVE, 'saidrunning'), queued: canary(DAVE, 'saidqueued'), stopped: canary(DAVE, 'saidstopped'), parked: canary(DAVE, 'saidparked') };
const ids = {
  sRun: randomUUID(), sQueue: randomUUID(), sStop: randomUUID(), sPark: randomUUID(),
  rRun: randomUUID(), rQueue: randomUUID(), rStop: randomUUID(), rPark: randomUUID(),
  uRun: randomUUID(), uQueue: randomUUID(), uStop: randomUUID(), uPark: randomUUID(),
};

describe('multi-account: runs left by a previous engine', () => {
  it('a copied account database with stale rows is settled once on first open, never replayed', async () => {
    const c = E.client;
    // a real provisioned account gives a database with the full migrated schema
    const seed = E.fake.script('seeder', 'seed', steps([], 'seeded'));
    const seeded = await runToEnd(c, 'seeder', seed);
    expect(seeded.follow?.status).toBe('done');

    mkdirSync(accDir(DAVE), { recursive: true });
    const src = dbOf('seeder');
    try { src.prepare('VACUUM INTO ?').run(join(accDir(DAVE), 'state.db')); } finally { src.close(); }
    const d = dbOf(DAVE, false);
    try {
      for (const t of ['agent_run_events', 'agent_runs', 'chat_messages', 'chat_sessions']) d.prepare(`DELETE FROM ${t}`).run();
      const session = d.prepare(`INSERT INTO chat_sessions (id, user_id, app_id, title) VALUES (?, ?, 'tangu', ?)`);
      const run = d.prepare(`INSERT INTO agent_runs (id, session_id, user_id, app_id, status, model_id, input, error, cancel_requested) VALUES (?, ?, ?, 'tangu', ?, 'fake/model-1', ?, ?, ?)`);
      const input = (said: string, u: string) => JSON.stringify({ message: said, userMessageId: u });
      session.run(ids.sRun, DAVE, 'running one');
      session.run(ids.sQueue, DAVE, 'queued one');
      session.run(ids.sStop, DAVE, 'stopped one');
      session.run(ids.sPark, DAVE, 'parked one');
      run.run(ids.rRun, ids.sRun, DAVE, 'running', input(W.running, ids.uRun), null, null);
      run.run(ids.rQueue, ids.sQueue, DAVE, 'queued', input(W.queued, ids.uQueue), null, null);
      run.run(ids.rStop, ids.sStop, DAVE, 'queued', input(W.stopped, ids.uStop), null, 'user');
      run.run(ids.rPark, ids.sPark, DAVE, 'interrupted', input(W.parked, ids.uPark), 'interrupted:app_quit', null);
      // the user's words of the parked run were already saved when it was stopped
      d.prepare(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)`).run(ids.uPark, ids.sPark, W.parked, Date.now());
    } finally { d.close(); }

    const before = E.fake.outbound.length;
    const first = await c.call(DAVE, 'GET', '/agent/sessions');
    expect(first.status).toBe(200);

    const db = dbOf(DAVE);
    try {
      const row = (id: string) => db.prepare('SELECT status, error, resumed_by FROM agent_runs WHERE id = ?').get(id) as any;
      expect(row(ids.rRun)).toMatchObject({ status: 'interrupted', error: 'interrupted:crash', resumed_by: '-' });
      expect(row(ids.rQueue)).toMatchObject({ status: 'interrupted', error: 'interrupted:engine_restart', resumed_by: '-' });
      expect(row(ids.rStop)).toMatchObject({ status: 'aborted' });
      expect(row(ids.rPark)).toMatchObject({ status: 'interrupted', resumed_by: '-' });
      const msgs = (sid: string) => db.prepare(`SELECT id, role, content FROM chat_messages WHERE session_id = ? ORDER BY timestamp, rowid`).all(sid) as any[];
      // the user's words are back, followed by one notice row; the stopped run gets no notice and no replay
      for (const [sid, u, said] of [[ids.sRun, ids.uRun, W.running], [ids.sQueue, ids.uQueue, W.queued], [ids.sPark, ids.uPark, W.parked]] as const) {
        const m = msgs(sid);
        expect(m.find((x) => x.id === u)?.content).toBe(said);
        expect(m.filter((x) => x.role === 'user' && x.id !== u)).toHaveLength(1);
        expect(m.filter((x) => x.role === 'assistant')).toHaveLength(0);
      }
      expect(msgs(ids.sStop).filter((x) => x.role === 'assistant')).toHaveLength(0);
      // no new runs were created for any of them
      expect((db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as any).n).toBe(4);
    } finally { db.close(); }
    await sleep(300);
    expect(E.fake.outbound.slice(before).filter((r) => outboundAccount(r) === DAVE)).toEqual([]);
    expect(spawnLog().length).toBe(0);
  });

  it('the settled runs answer like finished runs: their event streams end instead of waiting', async () => {
    const f = await E.client.follow(DAVE, ids.rRun, { timeoutMs: 5_000 });
    expect(f.httpStatus).toBe(200);
    expect(['error', 'done']).toContain(f.status);
  });
});

describe('multi-account: closing idle account databases', () => {
  it('an idle account is closed, reopens on the next request with its data, and first-open recovery does not run again', async () => {
    const c = E.client;
    const said = canary('erin', 'said');
    const s = E.fake.script('erin', 'first', steps([], 'erin reply'));
    const r = await runToEnd(c, 'erin', s, { text: said });
    expect(r.follow?.status).toBe('done');
    await sleep(100);
    expect(E.accounts.open()).toContain('erin');
    // nothing in flight for erin once the 30 s run bookkeeping is gone; force the close anyway via idle 0 after it clears
    const until = Date.now() + 40_000;
    let closed: string[] = [];
    while (Date.now() < until) {
      closed = E.accounts.evictIdleNow(0);
      if (closed.includes('erin')) break;
      await sleep(500);
    }
    expect(closed).toContain('erin');
    expect(E.accounts.open()).not.toContain('erin');
    expect(E.accounts.provisioned()).toContain('erin');

    // a stale row planted while the database is closed stays as it is: reopening is not a first open
    const staleRun = randomUUID();
    const d = dbOf('erin', false);
    try {
      d.prepare(`INSERT INTO agent_runs (id, session_id, user_id, app_id, status, model_id, input) VALUES (?, ?, 'erin', 'tangu', 'running', 'fake/model-1', '{}')`).run(staleRun, r.sessionId);
    } finally { d.close(); }

    const again = await c.call('erin', 'GET', `/agent/sessions/${r.sessionId}/messages`);
    expect(again.status).toBe(200);
    expect(again.text).toContain(said);
    expect(E.accounts.open()).toContain('erin');
    const db = dbOf('erin');
    try { expect((db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(staleRun) as any).status).toBe('running'); } finally { db.close(); }
  }, 60_000);

  it('an account with a run in flight is never closed, and the run finishes normally', async () => {
    const c = E.client;
    const s = E.fake.script('frank', 'held', steps([], 'frank done'));
    const g = E.fake.gate(s.token, 0);
    const started = await startRun(c, 'frank', s);
    expect(started.runId).toBeTruthy();
    await g.reached;
    expect(E.accounts.evictIdleNow(0, 0)).not.toContain('frank');
    expect(E.accounts.open()).toContain('frank');
    g.release();
    const f = await c.follow('frank', started.runId!, { timeoutMs: 20_000 });
    expect(f.status).toBe('done');
    const db = dbOf('frank');
    try { expect((db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(started.runId) as any).status).toBe('done'); } finally { db.close(); }
  }, 60_000);

  it('a cap on open databases closes the least recently used idle ones first', async () => {
    const c = E.client;
    for (const id of ['gina', 'hank']) expect((await c.call(id, 'GET', '/agent/sessions')).status).toBe(200);
    await sleep(20);
    expect((await c.call('gina', 'GET', '/agent/sessions')).status).toBe(200);
    const closed = E.accounts.evictIdleNow(60 * 60_000, 1);
    expect(closed).toContain('hank');
    // least recently used first: gina (touched last) goes only after hank, if at all (another account may still be busy)
    if (closed.includes('gina')) expect(closed.indexOf('hank')).toBeLessThan(closed.indexOf('gina'));
    expect((await c.call('hank', 'GET', '/agent/sessions')).status).toBe(200);
  });
});
