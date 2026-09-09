/** Account-scoped agent files. Network I/O never holds the synchronous local write lock. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { deps } from '../seams/runtime.js';
import { agentsDir, userMdFile } from '../core/tanguHome.js';
import { getDeviceId } from '../core/deviceId.js';
import { getAgent, listAgents, parseAgentConfig, resolveMemorySlug, type NormalAgentDef } from '../agents/agentRegistry.js';
import { splitLogBlocks, mergeBlocks } from './memorySync.js';
import { AgentFileConflictError, type AgentFilesBrain, type AgentFileMeta } from '../seams/cloudBrain.js';
import { agentSyncPermission, agentSyncScope, setAgentSyncPermission, captureAgentSyncPermission, agentSyncOperationSignal, agentSyncConsentSignal } from './cloudSyncAccount.js';
import { agentSyncDir, assertSyncPath, atomicSyncWrite, readSyncBytes, validSyncPath, validSyncSlug } from './agentSyncPaths.js';
import { createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { createMemoryRepository, withMemoryDirectoryLock, type MemoryTombstone } from './memoryRepository.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TOMBSTONES = '.memory-tombstones.json';
const TEXT_EXTS = new Set(['.md', '.toml', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.xml', '.js', '.ts', '.py']);
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
type Guard = () => void;
type Category = 'DEF' | 'MEM';
const categoryOf = (p: string): Category => p === 'MEMORY.md' || p === TOMBSTONES || p.startsWith('LOG/') ? 'MEM' : 'DEF';
interface PrevEntry { seq?: number; hash?: string; lastCloudMtimeMs?: number }
interface PrevState { files: Record<string, PrevEntry> }
const emptyResult = (): AgentFileSyncResult => ({ ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, conflicts: 0 });
function fail(result: AgentFileSyncResult, e: unknown): void {
  result.ok = false;
  const message = e instanceof Error ? e.message : String(e);
  result.error = result.error ? `${result.error}; ${message}` : message;
}
function readPrev(dir: string, scope: string, root = agentsDir()): PrevState {
  const bytes = readSyncBytes(root, join(dir, `.cloudsync-${scope}.json`));
  if (!bytes) return { files: {} };
  try { const value = JSON.parse(bytes.toString('utf8')); return { files: value.files ?? {} }; } catch { return { files: {} }; }
}
function localFiles(dir: string, cats: Set<Category>): string[] {
  const out: string[] = [];
  const walk = (p: string, rel: string): void => {
    assertSyncPath(agentsDir(), p);
    if (!existsSync(p)) return;
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      // Symlinks never participate, even if their target is currently inside this agent.
      if (entry.isDirectory() && (child === 'Library' || child.startsWith('Library/') || child === 'LOG')) walk(join(p, entry.name), child);
      else if (entry.isFile() && validSyncPath(child) && child !== TOMBSTONES && cats.has(categoryOf(child))) out.push(child);
    }
  };
  walk(dir, '');
  return out;
}
function logText(header: string, blocks: string[]): string { return `${header.trimEnd()}\n\n${blocks.map((b) => `${b}\n`).join('\n')}`; }
interface ShadowVer { seq: number; hash: string }
interface RemoteVer { seq: number; hash: string | null }
type Decision =
  | { kind: 'none' } | { kind: 'adopt' } | { kind: 'pull' }
  | { kind: 'push'; baseSeq: number } | { kind: 'pushCreate' } | { kind: 'pushDelete' }
  | { kind: 'deleteLocal' } | { kind: 'dropShadow' } | { kind: 'conflict' };

export function decide(local: string | null, shadow: ShadowVer | null, remote: RemoteVer | null): Decision {
  if (local === null && shadow === null && remote === null) return { kind: 'none' };
  if (remote === null) {
    if (local === null) return shadow ? { kind: 'dropShadow' } : { kind: 'none' };
    if (!shadow) return { kind: 'pushCreate' };
    return local === shadow.hash ? { kind: 'deleteLocal' } : { kind: 'pushCreate' }; // 本地未动=删除生效;改过=编辑胜删除
  }
  if (local === null) {
    if (!shadow) return { kind: 'pull' };
    return remote.seq === shadow.seq ? { kind: 'pushDelete' } : { kind: 'pull' }; // 服务端未动=本地删生效;动过=编辑胜删除
  }
  if (!shadow) return local === remote.hash ? { kind: 'adopt' } : { kind: 'conflict' };
  const localDirty = local !== shadow.hash;
  const remoteMoved = remote.seq !== shadow.seq;
  if (!localDirty && !remoteMoved) return { kind: 'none' };
  if (!localDirty) return { kind: 'pull' };
  if (!remoteMoved) return { kind: 'push', baseSeq: shadow.seq };
  return local === remote.hash ? { kind: 'adopt' } : { kind: 'conflict' };
}


export function conflictCopyName(relPath: string, now: Date): string {
  const slash = relPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relPath.slice(0, slash + 1);
  const base = slash < 0 ? relPath : relPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
  return `${dir}${stem} (conflict ${stamp})${ext}`;
}

export interface AgentFileSyncResult { ok: boolean; agents: number; pushed: number; pulled: number; deleted: number; skipped: number; conflicts: number; error?: string }
export interface AgentFileSyncOptions { /** Display/owning agent slug, never its resolved memory bucket. */ onlySlug?: string; signal?: AbortSignal; assertActive?: () => void }
const tails = new Map<string, Promise<void>>();

/** One account's sync runs serialize; each file commit still checks current consent and local revision. */
export async function runAgentFilesSync(cloud: AgentFilesBrain, userId: string, opts: AgentFileSyncOptions = {}): Promise<AgentFileSyncResult> {
  const result = emptyResult();
  const scope = agentSyncScope(cloud, userId);
  if (!scope) return { ...result, ok: false, error: 'cloud account identity unavailable' };
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const signal = AbortSignal.any([agentSyncOperationSignal(opts.signal), controller.signal]);
  const watch = (slug: string): void => {
    const consent = agentSyncConsentSignal(slug, scope);
    const abort = (): void => controller.abort(consent.reason);
    consent.addEventListener('abort', abort, { once: true });
    cleanups.push(() => consent.removeEventListener('abort', abort));
    if (consent.aborted) abort();
  };
  const guard = (): void => { signal.throwIfAborted(); opts.assertActive?.(); if (agentSyncScope(cloud, userId) !== scope) throw new Error('cloud account changed'); };
  const previous = tails.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  tails.set(scope, tail);
  try {
    await previous; guard();
    if (opts.onlySlug !== undefined && !validSyncSlug(opts.onlySlug)) throw new Error('invalid selected agent sync slug');
    await syncAccount(cloud, userId, scope, opts.onlySlug, signal, guard, result, watch);
  } catch (e) { fail(result, e); }
  finally { cleanups.forEach((fn) => fn()); release(); if (tails.get(scope) === tail) tails.delete(scope); }
  return result;
}

async function syncAccount(cloud: AgentFilesBrain, userId: string, scope: string, onlySlug: string | undefined, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult, watch: (slug: string) => void): Promise<void> {
  const selected = onlySlug ? await getAgent(onlySlug) : null;
  const locals = onlySlug ? (selected ? [selected] : []) : await listAgents(); guard();
  const agents = locals.filter((a) => (!onlySlug || a.slug === onlySlug) && agentSyncPermission(a.slug, scope).enabled);
  agents.forEach((a) => watch(a.slug));
  // Existing unconsented local agents incur no network request, including the run hot path.
  if (onlySlug && existsSync(agentSyncDir(onlySlug)) && !agentSyncPermission(onlySlug, scope).enabled) return;
  guard();
  const manifest = await cloud.getManifest(userId, { signal }); guard();
  const bySlug = new Map<string, AgentFileMeta[]>();
  for (const item of manifest) {
    if (item.slug !== '__user__' && !validSyncSlug(item.slug)) { fail(result, new Error('invalid cloud manifest slug')); continue; }
    if (!Array.isArray(item.files)) { fail(result, new Error('invalid cloud manifest files')); continue; }
    bySlug.set(item.slug, item.files);
  }
  const known = new Set(agents.map((a) => a.slug));
  for (const [slug, files] of bySlug) {
    if (!validSyncSlug(slug) || (onlySlug && slug !== onlySlug) || known.has(slug)) continue;
    const dir = agentSyncDir(slug);
    const owned = agentSyncPermission(slug, scope).enabled;
    if (existsSync(dir) && !owned) continue;
    const consent = owned ? captureAgentSyncPermission(slug, scope) : guard;
    if (owned) watch(slug);
    if (!files.some((f) => f.relPath === 'config.toml' && !f.deleted)) continue;
    guard();
    try {
      consent(); const config = await cloud.getFile(userId, slug, 'config.toml', { signal }); guard(); consent();
      if (!config || config.deleted || config.isBinary || !config.content) continue;
      verifyBytes(config, Buffer.from(config.content));
      const def = parseAgentConfig(slug, config.content, '');
      if (!def.cloudSync) continue;
      // Cloud discovery authorizes only a new directory, never a pre-existing agent/account.
      assertSyncPath(agentsDir(), dir); mkdirSync(agentsDir(), { recursive: true });
      if (!owned) {
        try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e; }
        guard(); setAgentSyncPermission(slug, scope, true, false); watch(slug);
      }
      agents.push(def); known.add(slug);
    } catch (e) { fail(result, e); guard(); }
  }
  result.agents = agents.length;
  const buckets = new Map<string, { cats: Set<Category>; guards: Guard[] }>();
  const add = (slug: string, cat: Category, consent: Guard): void => {
    const b = buckets.get(slug) ?? { cats: new Set<Category>(), guards: [] };
    b.cats.add(cat); b.guards.push(consent); buckets.set(slug, b);
  };
  const shared: Guard[] = [];
  for (const agent of agents) {
    const consent = captureAgentSyncPermission(agent.slug, scope);
    add(agent.slug, 'DEF', consent);
    const memSlug = resolveMemorySlug(agent);
    if (memSlug === agent.slug) add(memSlug, 'MEM', consent);
    else if (agentSyncPermission(agent.slug, scope).shared) add(memSlug, 'MEM', captureAgentSyncPermission(agent.slug, scope, true));
    if (agentSyncPermission(agent.slug, scope).shared) shared.push(captureAgentSyncPermission(agent.slug, scope, true));
  }
  for (const [slug, bucket] of buckets) {
    const check = (): void => { guard(); for (const consent of bucket.guards) consent(); agentSyncDir(slug); };
    check();
    await syncBucket(cloud, userId, slug, scope, bucket.cats, bySlug.get(slug) ?? [], signal, check, result);
  }
  // USER is an explicit shared-data opt-in, never an implicit private-agent pool.
  if (shared.length) {
    const check = (): void => { guard(); shared.forEach((g) => g()); };
    const dir = dirname(userMdFile());
    const prev = readPrev(dir, scope, dir);
    try { await reconcileFile(cloud, userId, '__user__', dir, 'USER.md', bySlug.get('__user__')?.find((f) => f.relPath === 'USER.md'), prev, signal, check, result, dir); }
    catch (e) { fail(result, e); }
    check(); atomicSyncWrite(dir, join(dir, `.cloudsync-${scope}.json`), JSON.stringify(prev), check);
  }
}
function verifyBytes(file: { hash?: string | null }, bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('cloud file exceeds sync limit');
  if (file.hash != null && sha256(bytes) !== file.hash) throw new Error('cloud file hash mismatch');
}
async function syncBucket(cloud: AgentFilesBrain, uid: string, slug: string, scope: string, cats: Set<Category>, manifest: AgentFileMeta[], signal: AbortSignal, guard: Guard, result: AgentFileSyncResult): Promise<void> {
  const dir = agentSyncDir(slug);
  const prev = readPrev(dir, scope);
  const remote = new Map<string, AgentFileMeta>();
  for (const entry of manifest) {
    if (!validSyncPath(entry.relPath)) { fail(result, new Error(`invalid cloud path for ${slug}`)); continue; }
    if (cats.has(categoryOf(entry.relPath))) remote.set(entry.relPath, entry);
  }
  // Forgetting crosses devices before any old MEMORY projection can be imported.
  if (cats.has('MEM')) {
    try { await syncTombstones(cloud, uid, slug, dir, remote.get(TOMBSTONES), signal, guard, result); }
    catch (e) { fail(result, e); return; } // No memory import without a trustworthy tombstone pass.
  }
  const paths = new Set([...localFiles(dir, cats), ...remote.keys(), ...Object.keys(prev.files).filter((p) => validSyncPath(p) && cats.has(categoryOf(p)))]);
  paths.delete(TOMBSTONES);
  for (const p of paths) {
    guard();
    try {
      if (p.startsWith('LOG/')) await reconcileLog(cloud, uid, slug, dir, p, signal, guard, result);
      else await reconcileFile(cloud, uid, slug, dir, p, remote.get(p), prev, signal, guard, result);
    } catch (e) { fail(result, e); guard(); }
  }
  guard(); withMemoryDirectoryLock(dir, () => atomicSyncWrite(agentsDir(), join(dir, `.cloudsync-${scope}.json`), JSON.stringify(prev), guard));
}

async function syncTombstones(cloud: AgentFilesBrain, uid: string, slug: string, dir: string, meta: AgentFileMeta | undefined, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult): Promise<void> {
  const repo = createMemoryRepository(dir);
  // Missing manifest means no remote tombstones. Every newly forgotten local fact is still uploaded.
  for (let attempt = 0; attempt < 4; attempt++) {
    guard();
    const file = await cloud.getFile(uid, slug, TOMBSTONES, { signal });
    guard();
    let remote: MemoryTombstone[] = [];
    if (file && !file.deleted) {
      if (file.isBinary) throw new Error('invalid tombstone data');
      verifyBytes(file, Buffer.from(file.content ?? ''));
      const parsed = JSON.parse(file.content ?? '');
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tombstones)) throw new Error('invalid tombstone schema');
      remote = parsed.tombstones;
      repo.mergeTombstones(remote, signal);
    }
    guard(); const tombstones = repo.snapshot().tombstones;
    if (!tombstones.length) return;
    const content = JSON.stringify({ schemaVersion: 1, tombstones: tombstones.map((t) => ({ ...t, evidenceIds: [...t.evidenceIds].sort() })).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)) });
    if (file?.content === content) return;
    if (file && !file.deleted && typeof file.seq !== 'number') throw new Error('cloud upgrade required for safe tombstone CAS');
    guard();
    try {
      await cloud.putFile(uid, slug, TOMBSTONES, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: Date.now(), deviceId: getDeviceId(), baseSeq: file && !file.deleted ? file.seq : 0 }, { signal });
      guard(); result.pushed++; return;
    } catch (e) { if (!(e instanceof AgentFileConflictError)) throw e; }
  }
  throw new Error('tombstone sync still conflicting; retry required');
}

async function reconcileFile(cloud: AgentFilesBrain, uid: string, slug: string, dir: string, p: string, meta: AgentFileMeta | undefined, prev: PrevState, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult, root = agentsDir()): Promise<void> {
  const abs = assertSyncPath(root, join(dir, p));
  const memory = p === 'MEMORY.md' ? createMemoryRepository(dir) : null;
  const initialMemory = memory?.snapshot();
  const initial = initialMemory ? Buffer.from(initialMemory.content) : readSyncBytes(root, abs);
  const hash = initial === null ? null : sha256(initial);
  const live = meta && !meta.deleted ? meta : undefined;
  const pe = prev.files[p];
  const modern = !live || (typeof live.seq === 'number' && live.hash != null);
  let decision: Decision;
  if (modern) decision = decide(hash, pe?.seq != null && pe.hash ? { seq: pe.seq, hash: pe.hash } : null, live ? { seq: live.seq!, hash: live.hash ?? null } : null);
  else if (initial === null) decision = { kind: 'pull' };
  else if (Math.floor(statSync(abs).mtimeMs) > live!.mtimeMs) decision = { kind: 'push', baseSeq: -1 };
  else if (Math.floor(statSync(abs).mtimeMs) < live!.mtimeMs) decision = { kind: 'conflict' };
  else decision = { kind: 'none' };
  const record = (seq: number | undefined, cloudHash: string | undefined, mtime?: number): void => { prev.files[p] = { seq, hash: cloudHash, lastCloudMtimeMs: mtime }; };
  const assertUnchanged = (): void => {
    guard();
    const current = memory ? Buffer.from(memory.snapshot().content) : readSyncBytes(root, abs);
    if ((current === null ? null : sha256(current)) !== hash) throw new Error(`local file changed during sync: ${p}`);
  };
  const archive = (): void => {
    if (!initial) return;
    let name = conflictCopyName(p, new Date());
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${conflictCopyName(p, new Date())}.${n}`;
    atomicSyncWrite(root, join(dir, name), initial, guard); result.conflicts++;
  };
  const pull = async (conflict: boolean): Promise<void> => {
    guard(); const file = await cloud.getFile(uid, slug, p, { signal }); guard();
    if (!file || file.deleted) throw new Error(`cloud file changed during sync: ${p}`);
    const bytes = file.isBinary ? Buffer.from(file.contentBase64 ?? '', 'base64') : Buffer.from(file.content ?? '');
    verifyBytes(file, bytes);
    withMemoryDirectoryLock(dir, () => {
      assertUnchanged();
      if (conflict) archive();
      if (memory) memory.commit({ expectedVersion: initialMemory!.version, content: bytes.toString('utf8'), source: { kind: 'sync' }, signal });
      else atomicSyncWrite(root, abs, bytes, guard);
      record(file.seq, sha256(bytes), file.mtimeMs);
    });
    result.pulled++;
  };
  if (decision.kind === 'pull' || decision.kind === 'conflict') { await pull(decision.kind === 'conflict'); return; }
  if (decision.kind === 'deleteLocal') {
    // Memory deletion is a revisioned commit; existing tombstones continue to suppress old facts.
    withMemoryDirectoryLock(dir, () => { assertUnchanged(); if (memory) memory.commit({ expectedVersion: initialMemory!.version, content: '', source: { kind: 'sync' }, signal }); else if (existsSync(abs)) unlinkSync(abs); });
    delete prev.files[p]; result.deleted++; return;
  }
  if (decision.kind === 'dropShadow') { delete prev.files[p]; return; }
  if (decision.kind === 'pushDelete') {
    guard(); await cloud.deleteFile(uid, slug, p, Date.now(), getDeviceId(), pe?.seq, { signal }); guard();
    delete prev.files[p]; result.deleted++; return;
  }
  if (decision.kind === 'adopt') { record(live?.seq, live?.hash ?? undefined, live?.mtimeMs); result.skipped++; return; }
  if (decision.kind === 'none') { result.skipped++; return; }
  if (!initial) return;
  verifyBytes({}, initial); guard(); assertUnchanged();
  const isBinary = !TEXT_EXTS.has(extname(p).toLowerCase());
  try {
    const res = await cloud.putFile(uid, slug, p, { ...(isBinary ? { contentBase64: initial.toString('base64') } : { content: initial.toString('utf8') }), isBinary, size: initial.length, mtimeMs: Date.now(), deviceId: getDeviceId(), ...(decision.kind === 'pushCreate' ? { baseSeq: 0 } : decision.baseSeq >= 0 ? { baseSeq: decision.baseSeq } : {}) }, { signal });
    guard(); record(res.seq, sha256(initial), res.mtimeMs); result.pushed++;
  } catch (e) {
    // A CAS collision never overwrites either side. Next sync reconciles the fresh cloud revision.
    if (e instanceof AgentFileConflictError) throw new Error(`cloud file changed during sync: ${p}`);
    throw e;
  }
}

async function reconcileLog(cloud: AgentFilesBrain, uid: string, slug: string, dir: string, p: string, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult): Promise<void> {
  const store = createLocalMemoryStore(dir);
  const date = p.slice(4, -3);
  for (let attempt = 0; attempt < 4; attempt++) {
    guard(); const file = await cloud.getFile(uid, slug, p, { signal }); guard();
    if (file?.isBinary) throw new Error('invalid binary log');
    const remoteContent = file && !file.deleted ? file.content ?? '' : '';
    if (file && !file.deleted) verifyBytes(file, Buffer.from(remoteContent));
    const remote = splitLogBlocks(remoteContent);
    let content = '';
    withMemoryDirectoryLock(dir, () => {
      guard(); assertSyncPath(agentsDir(), join(dir, p));
      const snapshot = store.readLogSnapshot!(date);
      const local = splitLogBlocks(snapshot.content);
      const merged = mergeBlocks(local.blocks, remote.blocks);
      content = logText(local.header || remote.header || `# ${date}`, merged.merged);
      if (merged.onlyInB.length) { store.writeLog(date, content, snapshot.version); result.pulled++; }
      else content = snapshot.content;
    });
    if (!content || content === remoteContent) return;
    if (file && !file.deleted && typeof file.seq !== 'number') throw new Error('cloud upgrade required for safe log CAS');
    guard();
    try {
      await cloud.putFile(uid, slug, p, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: Date.now(), deviceId: getDeviceId(), baseSeq: file && !file.deleted ? file.seq : 0 }, { signal });
      guard(); result.pushed++; return;
    } catch (e) { if (!(e instanceof AgentFileConflictError)) throw e; }
  }
  throw new Error('log sync still conflicting; retry required');
}

export function scheduleAgentFilesSync(userId: string, displayAgentSlug?: string): void {
  try {
    const d = deps();
    if (!d.profile.capabilities.hostExec || !d.brain.agentFiles || !displayAgentSlug) return;
    void runAgentFilesSync(d.brain.agentFiles, userId, { onlySlug: displayAgentSlug }).then((r) => { if (!r.ok) console.warn('[agent sync]', r.error); });
  } catch { /* runtime not assembled */ }
}
export interface PrepareAgentFilesResult { status: 'local' | 'hydrated' | 'skipped' | 'failed'; sync?: AgentFileSyncResult }
/** Existing local definition starts immediately. A first hydration waits for real cancellation/completion. */
export async function prepareAgentFilesForRun(cloud: AgentFilesBrain | undefined, userId: string, displayAgentSlug: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PrepareAgentFilesResult> {
  if (!validSyncSlug(displayAgentSlug)) return { status: 'failed', sync: { ...emptyResult(), ok: false, error: 'invalid selected agent' } };
  opts.signal?.throwIfAborted();
  const local = await getAgent(displayAgentSlug);
  opts.signal?.throwIfAborted();
  if (local) {
    if (cloud && agentSyncPermission(displayAgentSlug, agentSyncScope(cloud, userId)).enabled) {
      void runAgentFilesSync(cloud, userId, { onlySlug: displayAgentSlug, signal: opts.signal }).then((r) => { if (!r.ok) console.warn('[agent sync]', r.error); });
    }
    return { status: 'local' };
  }
  if (!cloud) return { status: 'failed', sync: { ...emptyResult(), ok: false, error: 'selected agent has no local snapshot or cloud source' } };
  const timeout = AbortSignal.timeout(Math.max(1, opts.timeoutMs ?? 15_000));
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const sync = await runAgentFilesSync(cloud, userId, { onlySlug: displayAgentSlug, signal });
  opts.signal?.throwIfAborted();
  return { status: sync.ok && await getAgent(displayAgentSlug) ? 'hydrated' : 'failed', sync };
}
