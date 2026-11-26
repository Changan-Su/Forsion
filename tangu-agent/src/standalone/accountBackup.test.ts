/**
 * Host-side account backups in multi-account mode (standalone/accountBackup.ts): the host credential, admission instead of
 * automatic new accounts, a consistent snapshot, removing the local copy, and restoring from an untrusted archive.
 * Each refusal is paired with the same request done right.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const env = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-backup-'));
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  delete process.env.TANGU_BUNDLE_DIRS;
  return { home };
});

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { createMultiAccountApp } from './multiAccount.js';
import { accountFingerprint } from './accountBackup.js';
import { tarEnd, tarEntryHeader, tarPadding } from '../core/tarArchive.js';
import { reloadMultiAccountLimits } from '../core/multiAccountLimits.js';
import { __resetAccountStorageForTests } from '../services/accountStorage.js';

const TOKEN = 'visitor-path-secret';
const CONTROL = 'host-control-secret-0123456789';
let holdRun: Promise<void> | null = null;
const brain: any = {
  llm: {
    resolveModelAndKey: async () => ({ model: { provider: 'test', context_window: 128000 }, apiKey: '', baseUrl: '', apiModelId: 'test' }),
    buildProviderPayload: async (opts: any) => ({ messages: structuredClone(opts.messages), tools: opts.tools }),
    streamProviderCompletion: async (opts: any) => {
      const msgs: any[] = Array.isArray(opts.payload?.messages) ? opts.payload.messages : [];
      if (holdRun && JSON.stringify(msgs).includes('HOLD_RUN')) await holdRun;
      opts.onToken?.('reply');
      return { content: 'reply', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  },
  models: { listGlobalModels: async () => [], hasDirectModel: () => false },
};

let server: Server;
let base = '';
let dispose: () => Promise<void>;

async function call(method: string, path: string, opts: { as?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...opts.headers };
  headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.as) headers['X-Forsion-User'] = opts.as;
  const res = await fetch(base + path, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
  return { status: res.status, json, buf };
}
const host = (method: string, path: string, opts: { body?: unknown; raw?: Buffer } = {}) => call(method, `/_host${path}`, { ...opts, token: CONTROL });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const accountDir = (id: string) => join(env.home, 'accounts', id);

/** Every regular file under the account folder except the database's side files and scratch, by path → sha256. */
function files(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      if (!rel && ['state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal', '.scratch'].includes(name)) continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile() && st.nlink === 1) out[r] = sha(readFileSync(p));
    }
  };
  walk(accountDir(id), '');
  return out;
}
/** What the account database holds (read through a second connection: sees committed WAL frames). */
function dbView(id: string): { sessions: string[]; messages: string[] } {
  const db = new Database(join(accountDir(id), 'state.db'), { readonly: true });
  try {
    return {
      sessions: (db.prepare('SELECT id FROM chat_sessions ORDER BY id').pluck().all() as string[]),
      messages: (db.prepare('SELECT role || \':\' || content FROM chat_messages ORDER BY id').pluck().all() as string[]),
    };
  } finally { db.close(); }
}
async function runTurn(as: string, sessionId: string, message: string) {
  const r = await call('POST', '/agent/runs', { as, body: { session_id: sessionId, model_id: 'test-model', message } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const sse = await fetch(`${base}/agent/runs/${r.json.runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': as } });
  await sse.text();
  return r.json.runId as string;
}
function archive(entries: Array<{ name: string; type?: 'file' | 'dir'; body?: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = e.body ?? Buffer.alloc(0);
    parts.push(tarEntryHeader(e.name, e.type ?? 'file', body.length, 0o600));
    if ((e.type ?? 'file') === 'file') parts.push(body, tarPadding(body.length));
  }
  parts.push(tarEnd());
  return gzipSync(Buffer.concat(parts));
}
const manifestFor = (account: string) => Buffer.from(JSON.stringify({ format: 'tangu-account-backup', version: 1, account, sessions: [] }));

beforeAll(async () => {
  const made = await createMultiAccountApp({ localToken: TOKEN, brain, defaultModelId: 'test-model', hostControlToken: CONTROL });
  dispose = made.dispose;
  server = made.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await dispose();
});

describe('account backups (host control)', () => {
  it('opens /_host only with the host credential; the visitor-path credential never does', async () => {
    expect((await host('GET', '/accounts')).status).toBe(200);
    expect((await call('GET', '/_host/accounts', { as: 'alice' })).status).not.toBe(200);
    expect((await call('GET', '/_host/accounts')).status).toBe(401);
    expect((await call('POST', '/_host/accounts/alice/admit', { as: 'alice' })).status).not.toBe(200);
  });

  it('never creates an account on its own: an unknown account is 409 until the host admits it', async () => {
    const before = await call('GET', '/agent/sessions', { as: 'alice' });
    expect(before.status).toBe(409);
    expect(before.json.code).toBe('ACCOUNT_NOT_ADMITTED');
    expect(existsSync(accountDir('alice'))).toBe(false);
    expect((await host('GET', '/accounts/alice')).json.state).toBe('absent');
    const admit = await host('POST', '/accounts/alice/admit');
    expect(admit.json).toEqual({ state: 'active', created: true });
    expect((await call('GET', '/agent/sessions', { as: 'alice' })).status).toBe(200);
    expect((await host('POST', '/accounts/alice/admit')).json).toEqual({ state: 'active', created: false });
  });

  let sid = '';
  let snap: any;
  let before: { files: Record<string, string>; db: ReturnType<typeof dbView> };

  it('takes a consistent snapshot: conversation (still in the WAL), an agent, memory and workspace files; links stay out', async () => {
    sid = (await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'kept-title' } })).json.session.id;
    await runTurn('alice', sid, 'first message to keep');
    expect((await call('POST', '/agent/agents', { as: 'alice', body: { name: 'Keeper', slug: 'keeper', systemPrompt: 'You keep things.' } })).status).toBe(200);
    expect((await call('POST', '/agent/memory', { as: 'alice', body: { text: 'Alice likes tea' } })).status).toBe(200);
    expect((await call('POST', '/agent/workspace/upload', { as: 'alice', body: { sessionId: sid, files: [{ path: 'notes/plan.txt', content: 'the plan' }] } })).status).toBe(200);
    // things a backup must not carry: a symlink out of the folder, a file with another hard link, a setuid bit
    const outside = join(env.home, 'outside-secret.txt');
    writeFileSync(outside, 'not alice');
    symlinkSync(outside, join(accountDir('alice'), 'link-out'));
    writeFileSync(join(env.home, 'hard-src.txt'), 'hard');
    linkSync(join(env.home, 'hard-src.txt'), join(accountDir('alice'), 'hard-in'));
    writeFileSync(join(accountDir('alice'), 'suid.sh'), '#!/bin/sh\n');
    chmodSync(join(accountDir('alice'), 'suid.sh'), 0o4755);

    snap = (await host('POST', '/accounts/alice/snapshot', { body: {} })).json;
    expect(snap.snapshotId, JSON.stringify(snap)).toBeTruthy();
    expect(snap.sessions).toBe(1);
    const body = (await host('GET', `/snapshots/${snap.snapshotId}`)).buf;
    expect(body.length).toBe(snap.size);
    expect(sha(body)).toBe(snap.sha256);
    expect(createHash('md5').update(body).digest('base64')).toBe(snap.md5);
    snap.body = body;
    before = { files: files('alice'), db: dbView('alice') };
    expect(before.db.messages.some((m) => m.includes('first message to keep'))).toBe(true);
    expect(Object.keys(before.files)).toEqual(expect.arrayContaining(['suid.sh']));
    // nothing changed → unchanged, no archive
    const again = await host('POST', '/accounts/alice/snapshot', { body: { since: snap.fingerprint } });
    expect(again.json).toEqual({ unchanged: true, fingerprint: snap.fingerprint });
  });

  it('a same-size edit that puts the old modification time back still counts as a change', async () => {
    const f = join(accountDir('alice'), 'same-size.txt');
    writeFileSync(f, 'aaaa');
    utimesSync(f, 1_700_000_000, 1_700_000_000); // a whole second, so it can be put back exactly
    const s1 = (await host('POST', '/accounts/alice/snapshot', { body: {} })).json;
    await host('DELETE', `/snapshots/${s1.snapshotId}`);
    const st = statSync(f, { bigint: true });
    writeFileSync(f, 'bbbb');
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    expect(statSync(f, { bigint: true }).mtimeNs).toBe(st.mtimeNs);
    const s2 = (await host('POST', '/accounts/alice/snapshot', { body: { since: s1.fingerprint } })).json;
    expect(s2.unchanged, JSON.stringify(s2)).toBe(false);
    expect(s2.snapshotId).toBeTruthy();
    await host('DELETE', `/snapshots/${s2.snapshotId}`);
    unlinkSync(f);
  });

  it('one host operation per account at a time: two snapshots at once, one is busy', async () => {
    const [a, b] = await Promise.all([host('POST', '/accounts/alice/snapshot', { body: {} }), host('POST', '/accounts/alice/snapshot', { body: {} })]);
    const codes = [a, b].map((r) => (r.status === 200 ? 'ok' : r.json.code)).sort();
    expect(codes).toEqual(['ACCOUNT_BUSY', 'ok']);
    for (const r of [a, b]) if (r.json?.snapshotId) await host('DELETE', `/snapshots/${r.json.snapshotId}`);
  });

  it('a file name that is not valid UTF-8 is not carried, and keeps the account from being purged (Linux; APFS refuses such names)', async () => {
    const bad = Buffer.concat([Buffer.from(join(accountDir('alice'), 'raw-')), Buffer.from([0xff, 0xfe]), Buffer.from('.txt')]);
    try { writeFileSync(bad, 'bytes under a name that is not UTF-8'); } catch (e: any) { if (['EILSEQ', 'EINVAL'].includes(e?.code)) return; throw e; }
    try {
      const s = (await host('POST', '/accounts/alice/snapshot', { body: {} })).json;
      const tar = (await host('GET', `/snapshots/${s.snapshotId}`)).buf;
      expect(tar.length).toBe(s.size);
      await host('DELETE', `/snapshots/${s.snapshotId}`);
      const kept = await host('POST', '/accounts/alice/purge', { body: { fingerprint: s.fingerprint, backupId: 'b-raw', sha256: s.sha256 } });
      expect(kept.json.code).toBe('ACCOUNT_NOT_ARCHIVABLE');
      expect(existsSync(accountDir('alice'))).toBe(true);
    } finally { unlinkSync(bad); }
  });

  it('refuses a snapshot while a run is going', async () => {
    let release!: () => void;
    holdRun = new Promise<void>((r) => { release = r; });
    const r = await call('POST', '/agent/runs', { as: 'alice', body: { session_id: sid, model_id: 'test-model', message: 'HOLD_RUN' } });
    expect(r.status).toBe(200);
    try {
      const busy = await host('POST', '/accounts/alice/snapshot', { body: {} });
      expect(busy.status).toBe(409);
      expect(busy.json.code).toBe('ACCOUNT_BUSY');
      // nor "unchanged" (which would let the host mark the account as saved while the run still has output to write)
      const now = await accountFingerprint('alice');
      const same = await host('POST', '/accounts/alice/snapshot', { body: { since: now } });
      expect(same.status, JSON.stringify(same.json)).toBe(409);
      expect(same.json.code).toBe('ACCOUNT_BUSY');
    } finally {
      release();
      holdRun = null;
      await (await fetch(`${base}/agent/runs/${r.json.runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': 'alice' } })).text();
    }
  });

  it('purges only when nothing changed since the backup and nobody is in; the folder goes, a cold marker stays', async () => {
    // the held run above changed the account: the old fingerprint no longer matches
    const stale = await host('POST', '/accounts/alice/purge', { body: { fingerprint: snap.fingerprint, backupId: 'b-1', sha256: snap.sha256 } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('ACCOUNT_CHANGED');
    expect(existsSync(accountDir('alice'))).toBe(true);
    // a fresh backup of the current state, then purge with its fingerprint
    writeFileSync(join(accountDir('alice'), 'back\\slash.txt'), 'a name an archive cannot carry');
    snap = (await host('POST', '/accounts/alice/snapshot', { body: {} })).json;
    snap.body = (await host('GET', `/snapshots/${snap.snapshotId}`)).buf;
    before = { files: files('alice'), db: dbView('alice') };
    // the backup leaves out a file with another hard link and a name with a backslash: purging would lose their bytes
    const kept = await host('POST', '/accounts/alice/purge', { body: { fingerprint: snap.fingerprint, backupId: 'b-2', sha256: snap.sha256 } });
    expect(kept.status, JSON.stringify(kept.json)).toBe(409);
    expect(kept.json.code).toBe('ACCOUNT_NOT_ARCHIVABLE');
    unlinkSync(join(accountDir('alice'), 'hard-in'));
    expect((await host('POST', '/accounts/alice/purge', { body: { fingerprint: snap.fingerprint, backupId: 'b-2', sha256: snap.sha256 } })).json.code).toBe('ACCOUNT_NOT_ARCHIVABLE');
    unlinkSync(join(accountDir('alice'), 'back\\slash.txt'));
    expect(existsSync(accountDir('alice'))).toBe(true);
    delete before.files['back\\slash.txt'];
    const ok = await host('POST', '/accounts/alice/purge', { body: { fingerprint: snap.fingerprint, backupId: 'b-2', sha256: snap.sha256 } });
    expect(ok.json, JSON.stringify(ok.json)).toEqual({ state: 'cold' });
    expect(existsSync(accountDir('alice'))).toBe(false);
    expect(JSON.parse(readFileSync(join(env.home, 'account-state', 'alice.json'), 'utf8')).backupId).toBe('b-2');
    expect((await host('GET', '/accounts/alice')).json.state).toBe('cold');
    // a visitor request is refused, never served from an empty new account
    const cold = await call('GET', '/agent/sessions', { as: 'alice' });
    expect(cold.status).toBe(409);
    expect(cold.json.code).toBe('ACCOUNT_COLD');
    expect((await host('POST', '/accounts/alice/admit')).json.code).toBe('ACCOUNT_COLD');
    expect(existsSync(accountDir('alice'))).toBe(false);
    // its session id is still registered to it: nobody else can take it while it is cold
    await host('POST', '/accounts/bob/admit');
    expect((await call('POST', '/agent/runs', { as: 'bob', body: { session_id: sid, model_id: 'test-model', message: 'mine now?' } })).status).toBe(404);
  });

  it('refuses damaged or foreign archives and leaves nothing behind', async () => {
    const tries: Array<[string, Buffer, string]> = [
      ['wrong checksum', snap.body, '0'.repeat(64)],
      ['climbs out', archive([{ name: 'manifest.json', body: manifestFor('alice') }, { name: 'home', type: 'dir' }, { name: 'home/../escape.txt', body: Buffer.from('x') }]), ''],
      ['absolute path', archive([{ name: 'manifest.json', body: manifestFor('alice') }, { name: '/tmp/escape.txt', body: Buffer.from('x') }]), ''],
      ['another account', archive([{ name: 'manifest.json', body: manifestFor('bob') }, { name: 'home', type: 'dir' }, { name: 'home/state.db', body: Buffer.from('x') }]), ''],
      ['no manifest first', archive([{ name: 'home', type: 'dir' }, { name: 'home/state.db', body: Buffer.from('x') }]), ''],
      ['truncated', snap.body.subarray(0, Math.floor(snap.body.length / 2)), ''],
    ];
    for (const [what, buf, given] of tries) {
      const r = await host('POST', `/accounts/alice/restore?backupId=b-2&size=${buf.length}&sha256=${given || sha(buf)}`, { raw: buf });
      expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(422);
      expect(existsSync(accountDir('alice')), what).toBe(false);
      expect((await host('GET', '/accounts/alice')).json.state, what).toBe('cold');
    }
    expect(existsSync(join(env.home, 'escape.txt'))).toBe(false);
    expect(existsSync(join(env.home, 'accounts', 'escape.txt'))).toBe(false);
    expect(readdirSync(join(env.home, '.host-backup', 'in'))).toEqual([]);
    // the archive of another backup than the one the account was archived with
    const other = await host('POST', `/accounts/alice/restore?backupId=b-1&size=${snap.body.length}&sha256=${snap.sha256}`, { raw: snap.body });
    expect(other.json.code).toBe('BACKUP_NOT_EXPECTED');
  });

  it('restores the account exactly, and the visitor carries on writing', async () => {
    // two restores at once: exactly one installs the folder, the other is turned away (never one over the other)
    const both = await Promise.all([0, 1].map(() => host('POST', `/accounts/alice/restore?backupId=b-2&size=${snap.body.length}&sha256=${snap.sha256}`, { raw: snap.body })));
    const r = both.find((x) => x.status === 200)!;
    expect(both.filter((x) => x.status === 200).length, JSON.stringify(both.map((x) => x.json))).toBe(1);
    expect(['ACCOUNT_BUSY', 'ACCOUNT_EXISTS']).toContain(both.find((x) => x.status !== 200)!.json.code);
    expect(r.json, JSON.stringify(r.json)).toMatchObject({ state: 'active', sessions: 1 });
    expect(r.json.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await host('GET', '/accounts/alice')).json.state).toBe('active');
    expect(existsSync(join(env.home, 'account-state', 'alice.json'))).toBe(false);
    // file by file the same, minus what a backup never carries
    const after = files('alice');
    const expected = { ...before.files };
    delete expected['hard-in'];
    expect(after).toEqual(expected);
    expect(existsSync(join(accountDir('alice'), 'link-out'))).toBe(false);
    expect(statSync(join(accountDir('alice'), 'suid.sh')).mode & 0o7000).toBe(0);
    expect(dbView('alice')).toEqual(before.db);
    // and it is the visitor's again: same session, one more turn
    const list = await call('GET', '/agent/sessions', { as: 'alice' });
    expect(JSON.stringify(list.json)).toContain(sid);
    await runTurn('alice', sid, 'after the restore');
    expect(dbView('alice').messages.some((m) => m.includes('after the restore'))).toBe(true);
    // never over an account that is here
    const twice = await host('POST', `/accounts/alice/restore?backupId=b-2&size=${snap.body.length}&sha256=${snap.sha256}`, { raw: snap.body });
    expect(twice.json.code).toBe('ACCOUNT_EXISTS');
    expect(dbView('alice').messages.some((m) => m.includes('after the restore'))).toBe(true);
  });

  it('restores into an account that was never here (a rebuilt engine) only from a matching archive', async () => {
    const r = await host('POST', `/accounts/carol/restore?size=${snap.body.length}&sha256=${snap.sha256}`, { raw: snap.body });
    expect(r.json.code).toBe('BACKUP_INVALID'); // alice's archive is not carol's
    expect(existsSync(accountDir('carol'))).toBe(false);
  });

  it('when all accounts together reach the engine limit, existing accounts cannot write either', async () => {
    writeFileSync(join(env.home, 'multi-account-limits.json'), JSON.stringify({ totalStorageGB: 0.000001 }));
    reloadMultiAccountLimits();
    __resetAccountStorageForTests();
    try {
      const full = await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'one more' } });
      expect(full.status).toBe(507);
      expect(full.json.code).toBe('ENGINE_STORAGE_FULL');
      expect((await call('GET', '/agent/sessions', { as: 'alice' })).status).toBe(200); // reading still works
      expect((await host('POST', '/accounts/dave/admit')).json.code).toBe('NEW_ACCOUNTS_CLOSED');
    } finally {
      writeFileSync(join(env.home, 'multi-account-limits.json'), JSON.stringify({}));
      reloadMultiAccountLimits();
      __resetAccountStorageForTests();
    }
    expect((await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'one more' } })).status).toBe(200);
  });
});
