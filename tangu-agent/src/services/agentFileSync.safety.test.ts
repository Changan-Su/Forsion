import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runAgentFilesSync, prepareAgentFilesForRun } from './agentFileSync.js';
import { agentSyncScope, setAgentSyncPermission, invalidateAgentSyncOperations, registerAgentSyncIdentity } from './cloudSyncAccount.js';
import { createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { createMemoryRepository } from './memoryRepository.js';
import { AgentFileConflictError, type AgentFileContent, type AgentFilesBrain } from '../seams/cloudBrain.js';
import { runMemorySync } from './memorySync.js';

let home: string; let oldHome: string | undefined;
beforeEach(() => { oldHome = process.env.TANGU_HOME; home = mkdtempSync(join(tmpdir(), 'sync-safety-')); process.env.TANGU_HOME = home; });
afterEach(() => { invalidateAgentSyncOperations(); if (oldHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = oldHome; rmSync(home, { recursive: true, force: true }); });
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
function cloudFixture() {
  const files = new Map<string, AgentFileContent>();
  const cloud: AgentFilesBrain = {
    getManifest: vi.fn(async () => {
      const groups = new Map<string, any[]>();
      for (const [key, f] of files) { const [slug, ...rest] = key.split('/'); const a = groups.get(slug) ?? []; a.push({ ...f, relPath: rest.join('/'), size: Buffer.byteLength(f.content ?? '') }); groups.set(slug, a); }
      return [...groups].map(([slug, f]) => ({ slug, files: f }));
    }),
    getFile: vi.fn(async (_uid, slug, p) => files.get(`${slug}/${p}`) ?? null),
    putFile: vi.fn(async (_uid, slug, p, body) => {
      const key = `${slug}/${p}`; const old = files.get(key); const seq = old && !old.deleted ? old.seq! : 0;
      if (body.baseSeq !== undefined && body.baseSeq !== seq) throw new AgentFileConflictError({ code: 'CONFLICT', seq, hash: old?.hash ?? null, mtimeMs: 1000, deleted: false });
      const value = { content: body.content ?? '', isBinary: body.isBinary, mtimeMs: body.mtimeMs, deleted: false, seq: seq + 1, hash: hash(body.content ?? '') };
      files.set(key, value); return value;
    }), deleteFile: vi.fn(async (_uid, slug, p) => { files.delete(`${slug}/${p}`); }),
  };
  return { cloud, files, remote(slug: string, path: string, content: string, modern = true) { files.set(`${slug}/${path}`, { content, isBinary: false, mtimeMs: 1000, deleted: false, ...(modern ? { seq: 1, hash: hash(content) } : {}) }); } };
}
function owned(cloud: AgentFilesBrain, slug = 'private-agent'): string {
  const dir = join(home, 'agents', slug); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.toml'), `name = "${slug}"\ncloud_sync = true\n`);
  setAgentSyncPermission(slug, agentSyncScope(cloud, 'u')!, true, false); return dir;
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

describe('agent sync boundaries and lifecycle', () => {
  it.each([false, true])('rejects manifest traversal and absolute paths (modern=%s)', async (modern) => {
    const f = cloudFixture(); owned(f.cloud);
    for (const p of ['../escaped.md', '/tmp/escaped.md', 'Library/../../victim/MEMORY.md', 'LOG/2026-02-30.md', 'C:/escape', '.cloudsync-accounts.json']) f.remote('private-agent', p, 'UNTRUSTED', modern);
    const r = await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' });
    expect(r.ok).toBe(false); expect(existsSync(join(home, 'agents', 'escaped.md'))).toBe(false);
    expect(vi.mocked(f.cloud.getFile).mock.calls.some((c) => c[2].includes('..'))).toBe(false);
  });
  it('rejects agent and nested symlinks without touching their targets', async () => {
    const f = cloudFixture(); const dir = owned(f.cloud); const outside = join(home, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'note.md'), 'SAFE'); symlinkSync(outside, join(dir, 'Library'));
    f.remote('private-agent', 'Library/note.md', 'UNTRUSTED');
    expect((await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' })).ok).toBe(false);
    expect(readFileSync(join(outside, 'note.md'), 'utf8')).toBe('SAFE');
  });
  it('does not request or sync other agents during a selected agent run', async () => {
    const f = cloudFixture(); const one = owned(f.cloud, 'one'); owned(f.cloud, 'two');
    createLocalMemoryStore(one).writeMemory('ONE_ONLY'); f.remote('two', 'MEMORY.md', 'TWO_ONLY');
    const r = await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'one' }); expect(r.ok).toBe(true);
    expect(vi.mocked(f.cloud.getFile).mock.calls.every((c) => c[1] === 'one')).toBe(true);
    expect(vi.mocked(f.cloud.putFile).mock.calls.every((c) => c[1] === 'one')).toBe(true);
    expect(createLocalMemoryStore(one).readMemory()).toBe('ONE_ONLY');
  });
  it('rechecks consent after a pending pull, including revoke and re-enable', async () => {
    const f = cloudFixture(); const dir = owned(f.cloud); f.remote('private-agent', 'SOUL.md', 'REMOTE');
    const gate = deferred<AgentFileContent | null>(); const started = deferred<void>();
    const get = f.cloud.getFile;
    f.cloud.getFile = vi.fn(async (uid, slug, p, opts) => { if (p === 'SOUL.md') { started.resolve(); return gate.promise; } return get(uid, slug, p, opts); });
    const pending = runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' }); await started.promise;
    const scope = agentSyncScope(f.cloud, 'u')!; setAgentSyncPermission('private-agent', scope, false); setAgentSyncPermission('private-agent', scope, true, false);
    gate.resolve(f.files.get('private-agent/SOUL.md')!); const r = await pending;
    expect(r.ok).toBe(false); expect(existsSync(join(dir, 'SOUL.md'))).toBe(false);
  });
  it('stops pending local commits when the account/source changes', async () => {
    const f = cloudFixture(); const dir = owned(f.cloud); f.remote('private-agent', 'SOUL.md', 'REMOTE');
    const gate = deferred<AgentFileContent | null>(); const started = deferred<void>(); const get = f.cloud.getFile;
    f.cloud.getFile = async (uid, slug, p, opts) => { if (p === 'SOUL.md') { started.resolve(); return gate.promise; } return get(uid, slug, p, opts); };
    const pending = runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' }); await started.promise; invalidateAgentSyncOperations();
    gate.resolve(f.files.get('private-agent/SOUL.md')!); expect((await pending).ok).toBe(false); expect(existsSync(join(dir, 'SOUL.md'))).toBe(false);
  });
  it('keeps a concurrent local edit when a remote pull returns', async () => {
    const f = cloudFixture(); const dir = owned(f.cloud); f.remote('private-agent', 'SOUL.md', 'REMOTE');
    const get = f.cloud.getFile; f.cloud.getFile = async (uid, slug, p, opts) => { if (p === 'SOUL.md') writeFileSync(join(dir, p), 'LOCAL_NEW'); return get(uid, slug, p, opts); };
    const r = await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' });
    expect(r.ok).toBe(false); expect(readFileSync(join(dir, 'SOUL.md'), 'utf8')).toBe('LOCAL_NEW');
  });
  it('existing valid local agent starts without awaiting the manifest', async () => {
    const f = cloudFixture(); owned(f.cloud); const gate = deferred<any[]>(); f.cloud.getManifest = async () => gate.promise;
    const result = await prepareAgentFilesForRun(f.cloud, 'u', 'private-agent'); expect(result.status).toBe('local');
    gate.resolve([]); // settle the real background operation before fixture teardown
    await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' });
  });
  it('first hydrate deadline aborts the real request and does not create a fallback agent', async () => {
    const f = cloudFixture(); f.cloud.getManifest = async (_uid, opts) => new Promise((_, reject) => { opts!.signal!.addEventListener('abort', () => reject(opts!.signal!.reason), { once: true }); });
    const r = await prepareAgentFilesForRun(f.cloud, 'u', 'fresh', { timeoutMs: 10 });
    expect(r.status).toBe('failed'); expect(existsSync(join(home, 'agents', 'fresh'))).toBe(false);
  });
  it('recovers an authorized incomplete hydration on the next run', async () => {
    const f = cloudFixture(); const dir = join(home, 'agents', 'fresh'); mkdirSync(dir, { recursive: true });
    setAgentSyncPermission('fresh', agentSyncScope(f.cloud, 'u')!, true, false); f.remote('fresh', 'config.toml', 'name = "Fresh"\ncloud_sync = true\n');
    expect((await prepareAgentFilesForRun(f.cloud, 'u', 'fresh')).status).toBe('hydrated');
  });
  it('propagates tombstones before importing old MEMORY from another device', async () => {
    const f = cloudFixture(); const dir = owned(f.cloud); const repo = createMemoryRepository(dir);
    const added = repo.mutate({ action: 'add', fact: 'forgotten exact fact' }); repo.mutate({ action: 'forget', id: added.entries[0].id });
    f.remote('private-agent', 'MEMORY.md', 'forgotten exact fact\nother useful fact');
    const r = await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' }); expect(r.ok).toBe(true);
    expect(repo.snapshot().content).not.toContain('forgotten exact fact'); expect(repo.snapshot().content).toContain('other useful fact');
    expect(f.files.get('private-agent/.memory-tombstones.json')?.content).toContain('forgotten exact fact');
    expect(vi.mocked(f.cloud.putFile).mock.calls[0][2]).toBe('.memory-tombstones.json');
  });
  it('tracks dynamic token identity instead of keeping an old request user scope', () => {
    const f = cloudFixture(); const token = (u: string) => `x.${Buffer.from(JSON.stringify({ userId: u })).toString('base64url')}.x`;
    let current = token('a'); registerAgentSyncIdentity(f.cloud, 'https://synthetic.invalid', () => current);
    const a = agentSyncScope(f.cloud, 'local'); current = token('b'); expect(agentSyncScope(f.cloud, 'local')).not.toBe(a);
  });
});

describe('legacy log append regression', () => {
  it('preserves entries appended while a cloud append is in flight', async () => {
    const dir = join(home, 'agents', 'log-agent'); const store = createLocalMemoryStore(dir); const date = '2026-09-08';
    store.writeLog(date, '# day\n\n### 10:00\nLOCAL_OLD\n');
    const cloud = {
      getMemory: async () => ({ content: '', updatedAt: null }), appendMemoryEntry: async () => ({ appended: false, length: 0 }),
      getLog: async () => ({ date, content: '# day\n\n### 09:00\nCLOUD_OLD\n', updatedAt: 1 }),
      appendLogEntry: async () => { store.writeLog(date, store.readLog(date) + '\n### 11:00\nLOCAL_CONCURRENT\n'); return { date, time: '10:00' }; },
    };
    const r = await runMemorySync(store, cloud, { dates: [date] }); expect(r.ok).toBe(true);
    for (const marker of ['LOCAL_OLD', 'CLOUD_OLD', 'LOCAL_CONCURRENT']) expect(store.readLog(date)).toContain(marker);
  });
  it('reports failed appends honestly while keeping successful pulls', async () => {
    const store = createLocalMemoryStore(join(home, 'agents', 'log-agent')); const date = '2026-09-08';
    store.writeLog(date, '### 10:00\nLOCAL\n');
    const cloud = { getMemory: async () => ({ content: '', updatedAt: null }), appendMemoryEntry: async () => ({ appended: false, length: 0 }), getLog: async () => ({ date, content: '### 09:00\nREMOTE\n', updatedAt: 1 }), appendLogEntry: async () => { throw new Error('synthetic upload failure'); } };
    const r = await runMemorySync(store, cloud, { dates: [date] }); expect(r.ok).toBe(false); expect(r.logs[0]).toMatchObject({ pushed: 0, pulled: 1 }); expect(store.readLog(date)).toContain('LOCAL');
  });
  it('rejects invalid dates before any cloud request', async () => {
    const f = vi.fn(); const cloud: any = { getMemory: f };
    const r = await runMemorySync(createLocalMemoryStore(join(home, 'agents', 'log-agent')), cloud, { dates: ['../escape'] }); expect(r.ok).toBe(false); expect(f).not.toHaveBeenCalled();
  });
});

it('an old cloud without log CAS preserves local union and reports the blocked upload', async () => {
  const f = cloudFixture(); const dir = owned(f.cloud); const store = createLocalMemoryStore(dir); const date = '2026-09-08';
  store.writeLog(date, '### 10:00\nLOCAL\n'); f.remote('private-agent', `LOG/${date}.md`, '### 09:00\nREMOTE\n', false);
  const r = await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' }); expect(r.ok).toBe(false); expect(r.error).toContain('safe log CAS');
  expect(store.readLog(date)).toContain('LOCAL'); expect(store.readLog(date)).toContain('REMOTE');
  expect(f.files.get(`private-agent/LOG/${date}.md`)?.content).not.toContain('LOCAL');
});
it('missing MEMORY.md projection blocks sync without erasing authoritative records', async () => {
  const f = cloudFixture(); const dir = owned(f.cloud); const repo = createMemoryRepository(dir); repo.mutate({ action: 'add', fact: 'KEPT' });
  const saved = readFileSync(join(dir, '.memory-state.json'), 'utf8');
  rmSync(join(dir, 'MEMORY.md')); expect(() => repo.snapshot()).toThrow('MEMORY.md disappeared');
  expect((await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' })).ok).toBe(false);
  expect(readFileSync(join(dir, '.memory-state.json'), 'utf8')).toBe(saved);
});
it('cloud LOG CAS collision merges a second device without losing local append during upload', async () => {
  const f = cloudFixture(); const dir = owned(f.cloud); const store = createLocalMemoryStore(dir); const date = '2026-09-08';
  store.writeLog(date, '### 10:00\nLOCAL\n'); f.remote('private-agent', `LOG/${date}.md`, '### 09:00\nREMOTE\n');
  const put = f.cloud.putFile; let raced = false;
  f.cloud.putFile = async (uid, slug, p, body, opts) => {
    if (p.startsWith('LOG/') && !raced) {
      raced = true; store.writeLog(date, store.readLog(date) + '\n### 12:00\nLOCAL_CONCURRENT\n');
      const old = f.files.get(`${slug}/${p}`)!; const content = old.content + '\n### 11:00\nSECOND_DEVICE\n';
      f.files.set(`${slug}/${p}`, { ...old, content, seq: old.seq! + 1, hash: hash(content) });
    }
    return put(uid, slug, p, body, opts);
  };
  const r = await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' }); expect(r.ok).toBe(true);
  for (const marker of ['LOCAL', 'REMOTE', 'LOCAL_CONCURRENT', 'SECOND_DEVICE']) { expect(store.readLog(date)).toContain(marker); expect(f.files.get(`private-agent/LOG/${date}.md`)?.content).toContain(marker); }
});
it('revoking consent aborts an actual in-flight upload signal before committing bytes', async () => {
  const f = cloudFixture(); owned(f.cloud); const started = deferred<void>(); let committed = false;
  f.cloud.putFile = async (_uid, _slug, _p, body, opts) => {
    started.resolve();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { committed = true; resolve(); }, 500);
      opts!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(opts!.signal!.reason); }, { once: true });
    });
    return { mtimeMs: body.mtimeMs, seq: 1 };
  };
  const task = runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' }); await started.promise;
  setAgentSyncPermission('private-agent', agentSyncScope(f.cloud, 'u')!, false);
  expect((await task).ok).toBe(false); expect(committed).toBe(false);
});
it('explicit re-remember survives a two-device cloud tombstone roundtrip', async () => {
  const root = home; const f = cloudFixture();
  try {
    home = join(root, 'device-a'); mkdirSync(home); process.env.TANGU_HOME = home;
    const repoA = createMemoryRepository(owned(f.cloud)); const initial = repoA.add('same exact fact'); repoA.forget(initial.entries[0].id);
    expect((await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' })).ok).toBe(true);
    home = join(root, 'device-b'); mkdirSync(home); process.env.TANGU_HOME = home;
    const repoB = createMemoryRepository(owned(f.cloud)); repoB.add('same exact fact');
    expect((await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' })).ok).toBe(true);
    expect(repoB.snapshot().content).not.toContain('same exact fact');
    repoB.add('same exact fact');
    expect((await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' })).ok).toBe(true);
    expect(repoB.snapshot().content).toContain('same exact fact');
    home = join(root, 'device-a'); process.env.TANGU_HOME = home;
    expect((await runAgentFilesSync(f.cloud, 'u', { onlySlug: 'private-agent' })).ok).toBe(true);
    expect(repoA.snapshot().content).toContain('same exact fact');
  } finally { home = root; process.env.TANGU_HOME = root; }
});
