/**
 * Multi-account mode: who is calling. Host token and account header admission, account id format (no case folding,
 * no paths), no caller is ever an admin, and the account-scope API itself (paths throw outside an account, resolve
 * per account inside, context survives async hops and stored callbacks, per-account singletons).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-gate-')));
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

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCAL_TOKEN, MODEL_ID, OWNER_REGISTRY_RE, bootMultiAccount, describeResp, diffSnaps, ownerRegistryProblems, routeKey, waitQuiet, type MaEngine,
} from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';

let E: MaEngine;
let th: any;
const accDir = (id: string) => join(env.home, 'accounts', id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bearer = (t = LOCAL_TOKEN) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  E = await bootMultiAccount();
  th = await import('../src/core/tanguHome.js');
}, 120_000);
afterAll(async () => {
  try { await E?.dispose(); } catch { /* ignore */ }
  try { rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('multi-account mode: admission', () => {
  it('401 without the host token or without an account header', async () => {
    const cases: Array<[string, Record<string, string | string[]>]> = [
      ['no headers', {}],
      ['account only', { 'X-Forsion-User': 'alice' }],
      ['wrong token', { ...bearer('not-the-token'), 'X-Forsion-User': 'alice' }],
      ['token with extra suffix', { ...bearer(`${LOCAL_TOKEN}x`), 'X-Forsion-User': 'alice' }],
      ['token prefix only', { ...bearer(LOCAL_TOKEN.slice(0, 10)), 'X-Forsion-User': 'alice' }],
      ['basic auth', { Authorization: `Basic ${Buffer.from(`alice:${LOCAL_TOKEN}`).toString('base64')}`, 'X-Forsion-User': 'alice' }],
      ['token, no account', bearer()],
      ['wrong token, no account', bearer('nope')],
    ];
    const bad: string[] = [];
    for (const [label, headers] of cases) {
      for (const [m, p] of [['GET', '/agent/sessions'], ['GET', '/agent/memory'], ['POST', '/agent/runs'], ['GET', '/agent/agents']]) {
        const r = await E.client.raw(m, p, { ...headers, 'Content-Type': 'application/json', 'Content-Length': '0' });
        if (r.status !== 401) bad.push(`${label}: ${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
      }
      // a path outside the allowlist may be refused by either gate first
      const u = await E.client.raw('GET', '/agent/nonexistent-route', headers);
      if (![401, 403].includes(u.status)) bad.push(`${label}: unknown path → ${u.status}`);
    }
    // the token in the query string is not a credential
    const q = await E.client.raw('GET', `/agent/sessions?token=${LOCAL_TOKEN}&access_token=${LOCAL_TOKEN}`, { 'X-Forsion-User': 'alice' });
    if (q.status !== 401) bad.push(`token in query → ${q.status}`);
    expect(bad).toEqual([]);
  });

  it('400 for account ids that are not exactly ^[a-z0-9][a-z0-9_-]{0,63}$ (no case folding, no paths, no lists)', async () => {
    const badIds = ['Alice', 'ALICE', 'aLice', '../x', '..', '.', 'a/b', 'a\\b', '-alice', '_alice', 'al ice', 'alice.', 'alice..', 'a'.repeat(65),
      'alice%2fbob', 'alice%00', 'ålice', 'alice, bob', 'alice,bob', 'alice;bob', '~alice'];
    const bad: string[] = [];
    for (const id of badIds) {
      const r = await E.client.raw('GET', '/agent/sessions', { ...bearer(), 'X-Forsion-User': id });
      if (r.status !== 400) bad.push(`${JSON.stringify(id)} → ${r.status}`);
    }
    const dup = await E.client.raw('GET', '/agent/sessions', { ...bearer(), 'X-Forsion-User': ['alice', 'bob'] });
    if (dup.status !== 400) bad.push(`two X-Forsion-User headers → ${dup.status}`);
    expect(bad).toEqual([]);
    expect(existsSync(accDir('Alice')) && !existsSync(accDir('alice')), 'an upper-case folder was created').toBe(false);
    for (const id of ['a', '0', 'a'.repeat(64), 'a_b-c', 'tangu', '9lives']) {
      const r = await E.client.raw('GET', '/agent/sessions', { ...bearer(), 'X-Forsion-User': id });
      expect(r.status, `${id}: ${r.text.slice(0, 200)}`).toBe(200);
    }
  });

  it('an empty X-Forsion-User counts as a missing header (401)', async () => {
    // HTTP trims surrounding whitespace, so " " and a tab arrive as "" too
    for (const id of ['', ' ', '\t']) {
      for (const [m, p] of [['GET', '/agent/sessions'], ['POST', '/agent/runs'], ['GET', '/agent/memory']]) {
        const r = await E.client.raw(m, p, { ...bearer(), 'X-Forsion-User': id, 'Content-Type': 'application/json', 'Content-Length': '0' });
        expect(r.status, `${JSON.stringify(id)} ${m} ${p}: ${r.text.slice(0, 160)}`).toBe(401);
      }
    }
    expect(existsSync(join(env.home, 'accounts', '')) && readdirSync(join(env.home, 'accounts')).some((n) => n.trim() === ''), 'a folder with an empty name').toBe(false);
  });

  it('GET /health needs no credentials and carries no account data', async () => {
    const r = await E.client.call(null, 'GET', '/health', { noAuth: true });
    expect([400, 401]).not.toContain(r.status);
    expect(r.text).not.toMatch(/accounts\//);
  });

  it('no caller is an admin: admin routes and management writes are 403, whatever the headers say', async () => {
    const fixed: Array<[string, string]> = [
      ['GET', '/agent/admin/sessions'], ['GET', '/agent/admin/stats'], ['GET', '/agent/admin/runs'], ['GET', '/agent/admin/resources'],
      ['POST', '/agent/admin/runs/probe/abort'], ['PUT', '/agent/admin/sandbox/config'], ['PUT', '/agent/admin/historian/config'],
    ];
    const management = /^\/agent\/(admin|providers?|websearch|plugins?|reply-segments|hooks?|mcp|engines?|channels?|wechat|browser[-a-z]*|inbox|processes|special)(\/|$)/;
    const enumerated = E.routes.filter((r) => r.kind === 'route' && r.method !== 'GET' && management.test(r.path))
      .map((r) => [r.method === 'ALL' ? 'POST' : r.method, r.path.replace(/:[A-Za-z_]+/g, 'probe')] as [string, string]);
    const bad: string[] = [];
    for (const [m, p] of [...fixed, ...enumerated]) {
      for (const headers of <Array<Record<string, string>>>[{}, { 'x-forsion-role': 'ADMIN' }, { 'x-forsion-role': 'admin', 'x-forsion-username': 'admin', 'x-forsion-remote': 'tunnel', 'x-forsion-remote-role': 'delegated-admin' }]) {
        const r = await E.client.call('alice', m, p, { body: {}, headers });
        if (r.status !== 403) bad.push(`${m} ${p} ${JSON.stringify(headers)} → ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    const allowedManagement = E.routeAllowlist.filter((e) => e.method.toUpperCase() !== 'GET' && management.test(e.path)).map((e) => routeKey(e.method, e.path));
    expect(allowedManagement, 'management write routes in the allowlist').toEqual([]);
    expect(bad).toEqual([]);
  });
});

describe('multi-account mode: account scope', () => {
  it('path functions throw outside an account and resolve under accounts/<id> inside', async () => {
    const scope = E.scope;
    expect(scope.isMultiAccount()).toBe(true);
    expect(scope.engineRoot()).toBe(env.home);
    expect(scope.accountHome('bob')).toBe(accDir('bob'));
    expect(scope.currentAccountId()).toBeUndefined();
    const fns: Array<[string, () => string]> = [
      ['tanguHome', th.tanguHome], ['stateDbPath', th.stateDbPath], ['agentsDir', th.agentsDir], ['forsionSharedDir', th.forsionSharedDir],
      ['configFile', th.configFile], ['memoryDir', th.memoryDir], ['skillsDir', th.skillsDir], ['authFile', th.authFile],
      ['providerAuthFile', th.providerAuthFile], ['humanDir', th.humanDir], ['checkpointsDir', th.checkpointsDir], ['deviceIdFile', th.deviceIdFile],
    ];
    for (const [name, fn] of fns) expect(() => fn(), `${name}() outside an account`).toThrow(/multi-account/);
    scope.runWithAccount('alice', () => {
      expect(th.tanguHome()).toBe(accDir('alice'));
      expect(th.stateDbPath()).toBe(join(accDir('alice'), 'state.db'));
      expect(th.agentsDir()).toBe(join(accDir('alice'), 'agents'));
      expect(th.forsionSharedDir()).toBe(accDir('alice'));
      for (const [name, fn] of fns) expect(fn().startsWith(accDir('alice')), `${name}() = ${fn()}`).toBe(true);
    });
    // a folder literally named "tangu" must not make the shared dir jump to its parent (accounts/)
    scope.runWithAccount('tangu', () => {
      expect(th.forsionSharedDir()).toBe(accDir('tangu'));
      expect(th.configFile()).toBe(join(accDir('tangu'), 'config.json'));
    });
    for (const id of ['Alice', '../x', '', 'a/b', 'a'.repeat(65)]) expect(() => scope.runWithAccount(id, () => 1), JSON.stringify(id)).toThrow();
    expect(() => scope.requireAccountId('probe-thing')).toThrow('multi-account: no account in context for probe-thing');
    expect(scope.isValidAccountId('alice')).toBe(true);
    for (const id of ['Alice', '', '-a', 'a'.repeat(65), 'a.b']) expect(scope.isValidAccountId(id), id).toBe(false);
    expect(scope.ACCOUNT_ID_RE.test('alice')).toBe(true);
  });

  it('the account survives async hops; stored callbacks keep the account they were bound in; per-account singletons', async () => {
    const scope = E.scope;
    await scope.runWithAccount('alice', async () => {
      await sleep(5);
      await Promise.resolve();
      expect(scope.currentAccountId()).toBe('alice');
    });
    expect(scope.currentAccountId()).toBeUndefined();
    const bound = scope.runWithAccount('alice', () => scope.bindAccount(() => scope.currentAccountId()));
    expect(await new Promise((r) => setTimeout(() => r(bound()), 5))).toBe('alice');
    expect(scope.runWithAccount('bob', () => bound())).toBe('alice');
    const get = scope.perAccount(() => ({ made: Math.random() }));
    const a1 = scope.runWithAccount('alice', get);
    const a2 = scope.runWithAccount('alice', get);
    const b1 = scope.runWithAccount('bob', get);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(() => get()).toThrow(/multi-account/);
    // interleaved async work of two accounts never sees the other's id
    const seen: string[] = [];
    await Promise.all(['alice', 'bob', 'alice', 'bob'].map((id, i) => scope.runWithAccount(id, async () => {
      for (let k = 0; k < 5; k++) { await sleep(1 + ((i + k) % 3)); seen.push(`${id}:${scope.currentAccountId()}`); }
    })));
    expect(seen.filter((s) => s.split(':')[0] !== s.split(':')[1])).toEqual([]);
  });

  it("an account named 'tangu' keeps its config and data inside accounts/tangu", async () => {
    const before = await waitQuiet(env.root, () => E.fake.outbound.length);
    const who = 'tangu';
    expect((await E.client.call(who, 'POST', '/agent/memory', { body: { text: 'tangu account fact' } })).status).toBeLessThan(300);
    expect((await E.client.call(who, 'POST', '/agent/sessions', { body: { title: 'tangu account session', model_id: MODEL_ID } })).status).toBe(200);
    for (const [m, p, body] of [['PUT', '/agent/masking', { secrets: true, personal: true, action: 'mask' }], ['PUT', '/agent/compaction', { enabled: true }], ['PUT', '/agent/approval-rules', { rules: [] }]] as const) {
      const r = await E.client.call(who, m, p, { body });
      expect([200, 201, 204, 400, 403, 404], describeResp(r)).toContain(r.status);
    }
    const after = await waitQuiet(env.root, () => E.fake.outbound.length);
    const d = diffSnaps(before, after);
    const outside = [...d.added, ...d.changed, ...d.removed].filter((p) => !p.startsWith('home/accounts/tangu/') && !OWNER_REGISTRY_RE.test(p));
    expect.soft(outside, "files written outside accounts/tangu").toEqual([]);
    const users = [...new Set([...E.client.log.map((x) => x.user), 'a', '0', 'a'.repeat(64), 'a_b-c', '9lives'])].filter((u): u is string => typeof u === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(u));
    expect.soft(ownerRegistryProblems(env.home, ['tangu account fact', 'tangu account session'], users, 0), 'session registry').toEqual([]);
    for (const p of [join(env.home, 'config.json'), join(env.home, 'accounts', 'config.json'), join(env.home, 'accounts', 'state.db')]) expect(existsSync(p), p).toBe(false);
  });

  it('no child process was started', () => {
    expect(spawnLog().filter((x) => !x.tag).map((x) => `${x.fn} ${x.command}`)).toEqual([]);
  });
});
