/**
 * Multi-account mode: limits that keep one account from taking the engine from everyone else.
 *
 *   - each account runs at most `runsPerAccount` tasks at once (others wait, in order); the engine at most `concurrentRuns`
 *   - waiting because the engine is full for longer than `queueTimeoutMinutes` ends the run with code ENGINE_BUSY;
 *     waiting for one's own other task does not count toward that
 *   - an account can have at most `queuedRunsPerAccount` tasks waiting (ACCOUNT_QUEUE_FULL)
 *   - a turn is stopped after `runMinutes` (reason time_limit)
 *   - an account over `accountStorageMB` cannot write (HTTP 507 STORAGE_LIMIT, tools refuse) but can still read and delete;
 *     other accounts are unaffected
 *   - once all accounts together reach `totalStorageGB`, new accounts are refused (503 NEW_ACCOUNTS_CLOSED) and existing ones keep working
 *   - the limits file is engine-level; a broken file keeps the last good values, a missing one means the defaults
 * Every slot taken is given back: after every scenario nothing holds or waits for admission.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-limits-')));
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
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMultiAccount, canary, randomUUID, startRun, steps, type MaEngine, type Script } from './helpers/multiAccountHarness.js';
import { DEFAULT_LIMITS, LIMITS_FILE_NAME, reloadMultiAccountLimits } from '../src/core/multiAccountLimits.js';
import { admissionSnapshot } from '../src/services/runAdmission.js';
import { __resetAccountStorageForTests, accountUsageBytes } from '../src/services/accountStorage.js';

const accDir = (id: string) => join(env.home, 'accounts', id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const limitsPath = join(env.home, LIMITS_FILE_NAME);
function setLimits(v: Record<string, unknown> | string | null): void {
  if (v === null) rmSync(limitsPath, { force: true });
  else writeFileSync(limitsPath, typeof v === 'string' ? v : JSON.stringify(v));
  // the file is checked by size + mtime; make sure two writes within one clock tick are still seen as different
  reloadMultiAccountLimits();
}
const runStatus = (account: string, runId: string): string => {
  const db = new Database(join(accDir(account), 'state.db'), { readonly: true, fileMustExist: true });
  try { return (db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as any)?.status; } finally { db.close(); }
};

let E: MaEngine;
beforeAll(async () => { E = await bootMultiAccount(); }, 60_000);
afterAll(async () => { await E?.dispose(); rmSync(env.root, { recursive: true, force: true }); });
afterEach(async () => {
  // every slot taken is given back
  const until = Date.now() + 10_000;
  const busy = () => { const a = admissionSnapshot(); return a.running.length + a.waiting.length + a.onUser.length; };
  while (Date.now() < until && busy()) await sleep(50);
  expect(admissionSnapshot()).toEqual({ running: [], waiting: [], onUser: [] });
  setLimits(null);
});

/** a run whose first model call is held until released */
async function held(account: string, label: string): Promise<{ s: Script; runId: string; sessionId: string; release: () => void; reached: Promise<void> }> {
  const s = E.fake.script(account, label, steps([], `${label} done`));
  const g = E.fake.gate(s.token, 0);
  const r = await startRun(E.client, account, s);
  expect(r.resp.status, r.resp.text).toBe(200);
  return { s, runId: r.runId!, sessionId: r.sessionId, release: g.release, reached: g.reached };
}
/** reached within ms? */
const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

describe('multi-account limits: tasks at once', () => {
  it('an account runs one task at a time; its second waits for the first while another account runs right away', async () => {
    const a1 = await held('alice', 'a1');
    await a1.reached;
    const a2 = await held('alice', 'a2');
    const b1 = await held('bob', 'b1');
    expect(await within(b1.reached, 5_000)).toBe(true);
    expect(await within(a2.reached, 1_500)).toBe(false);
    const w = admissionSnapshot().waiting.find((x) => x.runId === a2.runId);
    expect(w).toMatchObject({ account: 'alice', waitingFor: 'account' });
    a1.release();
    expect(await within(a2.reached, 5_000)).toBe(true);
    a2.release(); b1.release();
    for (const [acct, r] of [['alice', a1], ['alice', a2], ['bob', b1]] as const) {
      expect((await E.client.follow(acct, r.runId, { timeoutMs: 15_000 })).status).toBe('done');
    }
  }, 60_000);

  it('the waiting run tells its stream why it waits', async () => {
    const a1 = await held('alice', 'a1s');
    await a1.reached;
    const a2 = await held('alice', 'a2s');
    const f = await E.client.follow('alice', a2.runId, { timeoutMs: 3_000, until: (ev) => ev.type === 'status' && ev.payload?.state === 'queued' });
    expect(f.status).toBe('until');
    expect(f.events.find((e) => e.type === 'status' && e.payload?.state === 'queued')?.payload?.waitingFor).toBe('account');
    a1.release(); a2.release();
    await E.client.follow('alice', a2.runId, { timeoutMs: 15_000 });
  }, 30_000);

  it('when the engine is full, a run that waits longer than the queue timeout ends with ENGINE_BUSY', async () => {
    setLimits({ concurrentRuns: 2, queueTimeoutMinutes: 0.03 });
    const a = await held('alice', 'full-a');
    const b = await held('bob', 'full-b');
    await Promise.all([a.reached, b.reached]);
    const c = await held('carol', 'full-c');
    const f = await E.client.follow('carol', c.runId, { timeoutMs: 10_000 });
    expect(f.status).toBe('error');
    const err = f.events.find((e) => e.type === 'error');
    expect(err?.payload?.code).toBe('ENGINE_BUSY');
    expect(String(err?.payload?.error)).toMatch(/busy/i);
    expect(runStatus('carol', c.runId)).toBe('failed');
    expect(E.fake.outbound.some((r) => r.runId === c.runId)).toBe(false);
    a.release(); b.release();
    await E.client.follow('alice', a.runId, { timeoutMs: 15_000 });
    await E.client.follow('bob', b.runId, { timeoutMs: 15_000 });
  }, 60_000);

  it('waiting for one\'s own other task does not count toward the queue timeout', async () => {
    setLimits({ concurrentRuns: 2, queueTimeoutMinutes: 0.02 });
    const a1 = await held('alice', 'own-1');
    await a1.reached;
    const a2 = await held('alice', 'own-2');
    await sleep(2_500); // longer than the 1.2 s timeout
    expect(admissionSnapshot().waiting.find((x) => x.runId === a2.runId)?.waitingFor).toBe('account');
    a1.release();
    expect(await within(a2.reached, 5_000)).toBe(true);
    a2.release();
    expect((await E.client.follow('alice', a2.runId, { timeoutMs: 15_000 })).status).toBe('done');
  }, 60_000);

  it('an account cannot fill the queue: past queuedRunsPerAccount waiting tasks it gets ACCOUNT_QUEUE_FULL', async () => {
    setLimits({ queuedRunsPerAccount: 1 });
    const a1 = await held('alice', 'q-1');
    await a1.reached;
    const a2 = await held('alice', 'q-2');
    const a3 = await held('alice', 'q-3');
    const f = await E.client.follow('alice', a3.runId, { timeoutMs: 10_000 });
    expect(f.status).toBe('error');
    expect(f.events.find((e) => e.type === 'error')?.payload?.code).toBe('ACCOUNT_QUEUE_FULL');
    // another account is not affected by alice's queue
    const b = await held('bob', 'q-b');
    expect(await within(b.reached, 5_000)).toBe(true);
    a1.release(); a2.release(); b.release();
    await E.client.follow('alice', a2.runId, { timeoutMs: 15_000 });
    await E.client.follow('bob', b.runId, { timeoutMs: 15_000 });
  }, 60_000);

  it('stopping a waiting task gives nothing back twice and lets the next one run', async () => {
    const a1 = await held('alice', 'stop-1');
    await a1.reached;
    const a2 = await held('alice', 'stop-2');
    const a3 = await held('alice', 'stop-3');
    expect((await E.client.call('alice', 'POST', `/agent/runs/${a2.runId}/abort`)).status).toBe(200);
    const f2 = await E.client.follow('alice', a2.runId, { timeoutMs: 10_000 });
    expect(f2.status).toBe('error');
    expect(runStatus('alice', a2.runId)).toBe('aborted');
    a1.release();
    expect(await within(a3.reached, 5_000)).toBe(true);
    a3.release();
    expect((await E.client.follow('alice', a3.runId, { timeoutMs: 15_000 })).status).toBe('done');
  }, 60_000);

  it('a turn longer than runMinutes is stopped with reason time_limit and frees its slot', async () => {
    setLimits({ runMinutes: 0.02 });
    const s = E.fake.script('alice', 'long', steps([], 'long done'));
    const g = E.fake.gate(s.token, 0);
    const started = await startRun(E.client, 'alice', s);
    const a1 = { runId: started.runId!, release: g.release };
    await g.reached;
    // the fake model ignores aborts while held: wait for the engine to abort the call, then let it return
    const until = Date.now() + 10_000;
    while (!g.signal()?.aborted && Date.now() < until) await sleep(50);
    expect(g.signal()?.aborted).toBe(true);
    a1.release();
    const f = await E.client.follow('alice', a1.runId, { timeoutMs: 10_000 });
    expect(f.status).toBe('error');
    expect(f.events.find((e) => e.type === 'error')?.payload?.reason).toBe('time_limit');
    expect(runStatus('alice', a1.runId)).toBe('aborted');
    setLimits(null);
    const a2 = await held('alice', 'after-long');
    expect(await within(a2.reached, 5_000)).toBe(true);
    a2.release();
    expect((await E.client.follow('alice', a2.runId, { timeoutMs: 15_000 })).status).toBe('done');
  }, 60_000);
});

describe('multi-account limits: waiting on the person', () => {
  /** a run that asks the user a question first and finishes once answered */
  async function asking(account: string, label: string) {
    const s = E.fake.script(account, label, steps([{ calls: [{ name: 'ask_user', args: { question: `${label}?` } }] }], `${label} done`));
    const r = await startRun(E.client, account, s);
    expect(r.resp.status, r.resp.text).toBe(200);
    const f = await E.client.follow(account, r.runId!, { timeoutMs: 10_000, autoAnswer: false, until: (ev) => ev.type === 'inquiry_request' });
    expect(f.status).toBe('until');
    const inquiry = String(f.events.find((e) => e.type === 'inquiry_request')?.payload?.inquiryId);
    return { runId: r.runId!, answer: (text = 'yes') => E.client.call(account, 'POST', `/agent/runs/${r.runId}/inquiries/${inquiry}`, { body: { answer: text } }) };
  }

  it('a run waiting for an answer gives its slot back; once answered it takes it again before going on', async () => {
    const q = await asking('alice', 'asks-1');
    expect(admissionSnapshot().onUser.map((x) => x.runId)).toContain(q.runId);
    const a2 = await held('alice', 'while-asking');
    expect(await within(a2.reached, 5_000)).toBe(true); // alice's only slot was free
    expect((await q.answer()).status).toBe(200);
    await sleep(300);
    expect(admissionSnapshot().waiting.find((x) => x.runId === q.runId)?.waitingFor).toBe('account');
    a2.release();
    expect((await E.client.follow('alice', a2.runId, { timeoutMs: 15_000 })).status).toBe('done');
    expect((await E.client.follow('alice', q.runId, { timeoutMs: 15_000 })).status).toBe('done');
  }, 60_000);

  it('runs waiting for answers do not fill the engine: with three accounts asking, a fourth runs at once', async () => {
    setLimits({ concurrentRuns: 3 });
    const qs = [await asking('alice', 'e-a'), await asking('bob', 'e-b'), await asking('carol', 'e-c')];
    const d = await held('dave', 'e-d');
    expect(await within(d.reached, 5_000)).toBe(true);
    d.release();
    await E.client.follow('dave', d.runId, { timeoutMs: 15_000 });
    for (const [i, q] of qs.entries()) {
      const acct = ['alice', 'bob', 'carol'][i];
      expect((await q.answer()).status).toBe(200);
      expect((await E.client.follow(acct, q.runId, { timeoutMs: 15_000 })).status).toBe('done');
    }
  }, 60_000);

  it('the turn clock stops while waiting for an answer', async () => {
    setLimits({ runMinutes: 0.02 }); // 1.2 s
    const q = await asking('alice', 'slow-answer');
    await sleep(2_500);
    expect((await q.answer()).status).toBe(200);
    expect((await E.client.follow('alice', q.runId, { timeoutMs: 15_000 })).status).toBe('done');
    expect(runStatus('alice', q.runId)).toBe('done');
  }, 30_000);
});

describe('multi-account limits: storage', () => {
  it('an account over its storage limit cannot write but can read and delete; other accounts are unaffected', async () => {
    const c = E.client;
    expect((await c.call('dave', 'GET', '/agent/sessions')).status).toBe(200);
    expect((await c.call('bob', 'GET', '/agent/sessions')).status).toBe(200);
    __resetAccountStorageForTests();
    const base = await accountUsageBytes('dave');
    const bobBase = await accountUsageBytes('bob');
    // the limit leaves dave about 200 KB (and bob at least that much too, under the same per-account limit)
    const limit = Math.max(base, bobBase) + 200 * 1024;
    setLimits({ accountStorageMB: limit / 1024 / 1024 });
    __resetAccountStorageForTests();

    // a tool write that fits goes through; one that does not is refused and nothing is written
    const headroom = limit - base;
    const small = 'x'.repeat(40 * 1024);
    const big = 'y'.repeat(headroom + 60 * 1024);
    expect(big.length).toBeLessThan(500 * 1024); // kept small enough for the fake model's context window
    const s = E.fake.script('dave', 'writes', steps([
      { calls: [{ name: 'write_file', args: { path: 'small.txt', content: small } }] },
      { calls: [{ name: 'write_file', args: { path: 'big.txt', content: big } }] },
    ], 'done'));
    const r = await startRun(c, 'dave', s);
    const fd = await c.follow('dave', r.runId!, { timeoutMs: 20_000 });
    expect(fd.status, JSON.stringify(fd.events.filter((e) => e.type === 'error'))).toBe('done');
    const outputs = s.results.map((x) => `${x.name}: ${x.output}`);
    expect(outputs.find((o) => o.includes('Storage limit')), outputs.join('\n')).toBeTruthy();
    expect(existsSync(join(accDir('dave'), 'workspace', 'small.txt'))).toBe(true);
    expect(existsSync(join(accDir('dave'), 'workspace', 'big.txt'))).toBe(false);

    // fill dave's folder past the limit from outside (as if earlier uploads); writing routes answer 507, reads and deletes work
    writeFileSync(join(accDir('dave'), 'workspace', 'filler.bin'), Buffer.alloc(1024 * 1024));
    __resetAccountStorageForTests();
    const blocked = await c.call('dave', 'POST', '/agent/runs', { body: { session_id: randomUUID(), model_id: 'fake/model-1', message: 'hi' } });
    expect(blocked.status).toBe(507);
    expect(blocked.json?.code).toBe('STORAGE_LIMIT');
    expect((await c.call('dave', 'POST', '/agent/memory', { body: { content: canary('dave', 'mem') } })).status).toBe(507);
    expect((await c.call('dave', 'GET', '/agent/sessions')).status).toBe(200);
    expect((await c.call('dave', 'DELETE', `/agent/sessions/${r.sessionId}`)).status).toBe(200);
    // bob is under his own limit and keeps working
    const sb = E.fake.script('bob', 'fine', steps([], 'bob fine'));
    const rb = await startRun(c, 'bob', sb);
    expect(rb.resp.status).toBe(200);
    const fb = await c.follow('bob', rb.runId!, { timeoutMs: 15_000 });
    expect(fb.status, JSON.stringify(fb.events.filter((e) => e.type === 'error'))).toBe('done');
  }, 60_000);

  it('once all accounts together reach the total limit, new accounts are refused and existing ones keep working', async () => {
    const c = E.client;
    setLimits({ totalStorageGB: 0.000001 }); // about 1 KB: already exceeded by the accounts above
    __resetAccountStorageForTests();
    const zed = await c.call('zed', 'GET', '/agent/sessions');
    expect(zed.status).toBe(503);
    expect(zed.json?.code).toBe('NEW_ACCOUNTS_CLOSED');
    expect(existsSync(accDir('zed'))).toBe(false);
    expect((await c.call('alice', 'GET', '/agent/sessions')).status).toBe(200);
    const h = await c.call(null, 'GET', '/health', { noAuth: true });
    expect(h.json?.newAccounts).toBe('closed');
    setLimits(null);
    __resetAccountStorageForTests();
    expect((await c.call('zed', 'GET', '/agent/sessions')).status).toBe(200);
  }, 30_000);
});

describe('multi-account limits: the limits file', () => {
  it('missing = defaults; a broken file keeps the last good values; a bad field falls back to its default alone', () => {
    setLimits(null);
    expect(reloadMultiAccountLimits()).toEqual(DEFAULT_LIMITS);
    setLimits({ runsPerAccount: 2, concurrentRuns: 7 });
    expect(reloadMultiAccountLimits()).toMatchObject({ runsPerAccount: 2, concurrentRuns: 7 });
    setLimits('{ not json');
    expect(reloadMultiAccountLimits()).toMatchObject({ runsPerAccount: 2, concurrentRuns: 7 });
    setLimits({ runsPerAccount: -1, concurrentRuns: 'many', runMinutes: 3, maxOpenAccounts: 1.5 });
    expect(reloadMultiAccountLimits()).toMatchObject({ runsPerAccount: DEFAULT_LIMITS.runsPerAccount, concurrentRuns: DEFAULT_LIMITS.concurrentRuns, runMinutes: 3, maxOpenAccounts: DEFAULT_LIMITS.maxOpenAccounts });
    setLimits({ concurrentRuns: 1_000_000 });
    expect(reloadMultiAccountLimits().concurrentRuns).toBeLessThan(1_000_000);
  });
});
