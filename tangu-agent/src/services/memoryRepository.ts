/** Per-agent durable memory. No network or await is permitted inside a transaction. */
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface MemorySource {
  kind: 'explicit' | 'historian' | 'dream' | 'sync' | 'manual' | 'restore' | 'migration' | 'external-edit';
  sessionId?: string;
  messageId?: string;
  runId?: string;
}
export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  source: MemorySource;
  evidenceIds: string[];
}
export interface MemoryTombstone {
  id: string;
  fingerprint: string;
  content: string;
  forgottenAt: number;
  /** Explicit re-add is a causal event, retained for cross-device reconciliation. */
  restoredAt?: number;
  evidenceIds: string[];
}
export interface MemorySnapshot {
  version: string;
  content: string;
  entries: MemoryEntry[];
  tombstones: MemoryTombstone[];
  updatedAt: number;
  /** Last 8192 consumed candidate IDs; committed with memory, including discarded candidates. */
  processedCandidateIds: string[];
}
export interface MemoryRevision {
  version: string;
  content: string;
  entries: MemoryEntry[];
  createdAt: number;
  source: MemorySource;
}
export interface MemoryCommit {
  expectedVersion: string;
  content: string;
  source: MemorySource;
  provenance?: Array<{ fact: string; sourceIds: string[] }>;
  consumedCandidateIds?: string[];
  signal?: AbortSignal;
}
export interface MemoryMutation {
  action: 'add' | 'update' | 'forget';
  id?: string;
  fact?: string;
  expectedVersion?: string;
  source?: MemorySource;
  evidenceIds?: string[];
  /** Legacy append compatibility. Explicit entry tools use the defaults. */
  dedup?: boolean;
  cap?: number;
  signal?: AbortSignal;
}
interface MemoryState extends MemorySnapshot {
  schemaVersion: 1;
  repositoryId: string;
  source: MemorySource;
  revisions: MemoryRevision[];
  projectionPending: boolean;
  previousProjectionHash: string | null;
}

export class MemoryRepositoryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'MemoryRepositoryError'; }
}
export function memoryVersionConflict(): never {
  throw new MemoryRepositoryError('MEMORY_VERSION_CONFLICT', 'Memory changed since it was read; reload and review before retrying.');
}
export function memoryContentVersion(content: string | null): string {
  return createHash('sha256').update(content === null ? '\x00missing' : '\x01' + content).digest('hex');
}
export function normalizeMemoryFact(fact: string): string {
  return fact.trim().replace(/^[-*+]\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}
export function memoryFactFingerprint(fact: string): string {
  return createHash('sha256').update(normalizeMemoryFact(fact)).digest('hex');
}
export function isMemoryTombstoneActive(tombstone: MemoryTombstone): boolean {
  return tombstone.forgottenAt >= (tombstone.restoredAt ?? 0);
}
function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function isMissing(e: unknown): boolean { return (e as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function fail(message: string): never { throw new MemoryRepositoryError('MEMORY_CORRUPT', message); }

/** The configured home may itself be a symlink (desktop/CLI compatibility). The agent
 * directory and everything underneath it must be real directories/files. */
export function ensureMemoryDirectory(baseDir: string): string {
  const absolute = resolve(baseDir);
  mkdirSync(dirname(absolute), { recursive: true });
  const canonical = join(realpathSync(dirname(absolute)), absolute.split(sep).at(-1)!);
  try {
    const s = lstatSync(canonical);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Agent memory directory must be a real directory.');
  } catch (e) {
    if (!isMissing(e)) throw e;
    mkdirSync(canonical);
  }
  return canonical;
}
export function safeMemoryPath(baseDir: string, relPath: string, createParents = false): string {
  if (!relPath || isAbsolute(relPath) || relPath.includes('\\') || relPath.includes('\0') || relPath.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid memory file path.');
  }
  const root = ensureMemoryDirectory(baseDir);
  const parts = relPath.split('/');
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Memory files cannot follow symlinks or special files.');
      }
    } catch (e) {
      if (!isMissing(e)) throw e;
      if (i < parts.length - 1 && createParents) mkdirSync(cursor);
    }
  }
  if (relative(root, cursor).startsWith('..')) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Memory path escaped its agent.');
  return cursor;
}
export function readMemoryFile(baseDir: string, relPath: string): string | null {
  const file = safeMemoryPath(baseDir, relPath);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(fd, 'utf8');
  } catch (e) {
    if (isMissing(e)) return null;
    throw e; // EIO/EACCES are never an empty document.
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function atomicWriteMemoryFile(baseDir: string, relPath: string, content: string): void {
  const target = safeMemoryPath(baseDir, relPath, true);
  const tmp = join(dirname(target), `.memory-write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // Recheck immediately before rename; replacing a target symlink must never be silent.
    safeMemoryPath(baseDir, relPath, true);
    renameSync(tmp, target);
    // Windows cannot fsync a directory handle (FlushFileBuffers needs write access → EPERM);
    // NTFS journals the rename itself.
    if (process.platform !== 'win32') {
      const parent = openSync(dirname(target), constants.O_RDONLY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch (e) { if (!isMissing(e)) throw e; }
  }
}

const heldLocks = new Set<string>();
/** Reentrant only for synchronous calls in this process. A busy/abandoned lock is
 * reported, never broken by age: doing so could let another live writer overwrite us. */
export function withMemoryDirectoryLock<T>(baseDir: string, fn: () => T): T {
  if (fn.constructor.name === 'AsyncFunction') throw new MemoryRepositoryError('MEMORY_ASYNC_TRANSACTION', 'Memory transactions must be synchronous.');
  const root = ensureMemoryDirectory(baseDir);
  const invoke = (): T => {
    const result = fn();
    if (result && typeof (result as any).then === 'function') throw new MemoryRepositoryError('MEMORY_ASYNC_TRANSACTION', 'Memory transactions must not return a Promise.');
    return result;
  };
  if (heldLocks.has(root)) return invoke();
  const lock = safeMemoryPath(root, '.memory.lock');
  let fd: number;
  try { fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MemoryRepositoryError('MEMORY_BUSY', 'Memory directory is locked by another writer. Retry later; an abandoned lock needs recovery.');
    throw e;
  }
  heldLocks.add(root);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); return invoke(); }
  finally { heldLocks.delete(root); closeSync(fd); unlinkSync(lock); }
}

const SOURCE_KINDS = new Set(['explicit', 'historian', 'dream', 'sync', 'manual', 'restore', 'migration', 'external-edit']);
function validSource(x: any): x is MemorySource {
  return x && SOURCE_KINDS.has(x.kind) && ['sessionId', 'messageId', 'runId'].every(k => x[k] === undefined || typeof x[k] === 'string');
}
function stringArray(x: any): x is string[] { return Array.isArray(x) && x.every(v => typeof v === 'string'); }
function validEntry(x: any): x is MemoryEntry {
  return x && typeof x.id === 'string' && !!x.id && typeof x.content === 'string' && Number.isFinite(x.createdAt) && Number.isFinite(x.updatedAt) && validSource(x.source) && stringArray(x.evidenceIds);
}
export function validateMemoryTombstones(value: unknown): MemoryTombstone[] {
  if (!Array.isArray(value) || value.some(x => !x || typeof x.id !== 'string' || typeof x.content !== 'string' || typeof x.fingerprint !== 'string' || x.fingerprint !== memoryFactFingerprint(x.content) || !Number.isFinite(x.forgottenAt) || (x.restoredAt !== undefined && !Number.isFinite(x.restoredAt)) || !stringArray(x.evidenceIds))) {
    fail('Invalid memory tombstones; refusing to reset or import them.');
  }
  return structuredClone(value);
}
function decodeState(raw: string): MemoryState {
  let s: any;
  try { s = JSON.parse(raw); } catch { fail('Invalid memory metadata JSON; original files were preserved.'); }
  if (!s || s.schemaVersion !== 1 || typeof s.repositoryId !== 'string' || !s.repositoryId || typeof s.version !== 'string' || !s.version || typeof s.content !== 'string' || !Number.isFinite(s.updatedAt) || !validSource(s.source) || !Array.isArray(s.entries) || s.entries.some((e: any) => !validEntry(e)) || new Set(s.entries.map((e: any) => e.id)).size !== s.entries.length || !Array.isArray(s.revisions) || s.revisions.some((r: any) => !r || typeof r.version !== 'string' || typeof r.content !== 'string' || !Number.isFinite(r.createdAt) || !validSource(r.source) || !Array.isArray(r.entries) || r.entries.some((e: any) => !validEntry(e))) || typeof s.projectionPending !== 'boolean' || !(s.previousProjectionHash === null || typeof s.previousProjectionHash === 'string')) {
    fail('Unknown or damaged memory metadata; original files were preserved.');
  }
  validateMemoryTombstones(s.tombstones);
  if (s.processedCandidateIds === undefined) s.processedCandidateIds = [];
  if (!stringArray(s.processedCandidateIds) || s.processedCandidateIds.length > 8192) fail('Invalid processed memory candidates metadata.');
  if (JSON.stringify(s.content.split('\n').filter((line: string) => line.trim())) !== JSON.stringify(s.entries.map((e: MemoryEntry) => e.content))) {
    fail('Memory entries do not match the saved document; refusing to consolidate damaged metadata.');
  }
  return s;
}
function view(s: MemoryState): MemorySnapshot {
  return structuredClone({ version: s.version, content: s.content, entries: s.entries, tombstones: s.tombstones, updatedAt: s.updatedAt, processedCandidateIds: s.processedCandidateIds });
}
function reconcileEntries(content: string, previous: MemoryEntry[], source: MemorySource, provenance: MemoryCommit['provenance'] = []): MemoryEntry[] {
  const used = new Set<string>();
  const now = Date.now();
  return content.split('\n').filter(line => line.trim()).map(line => {
    const normalized = normalizeMemoryFact(line);
    const old = previous.find(e => !used.has(e.id) && normalizeMemoryFact(e.content) === normalized);
    if (old) used.add(old.id);
    const evidence = provenance.find(p => normalizeMemoryFact(p.fact) === normalized)?.sourceIds ?? [];
    const inheritedEvidence = evidence.flatMap(id => previous.find(e => e.id === id)?.evidenceIds ?? []);
    return {
      id: old?.id ?? randomUUID(), content: line, createdAt: old?.createdAt ?? now,
      updatedAt: old?.content === line ? old.updatedAt : now, source: old?.source ?? source,
      evidenceIds: [...new Set([...(old?.evidenceIds ?? []), ...evidence, ...inheritedEvidence, ...(source.messageId ? [source.messageId] : [])])],
    };
  });
}
/** Exact normalized text and known evidence prevent raw/sync replay. This is not a
 * semantic classifier; rephrased facts without provenance require model review. */
export function filterForgottenMemory(content: string, tombstones: MemoryTombstone[], provenance: MemoryCommit['provenance'] = []): string {
  const active = tombstones.filter(isMemoryTombstoneActive);
  const hashes = new Set(active.map(t => t.fingerprint));
  // Context references locate evidence, but are not fact identities: one session
  // or anchor message can legitimately support several independent facts.
  const evidence = new Set(active.flatMap(t => t.evidenceIds).filter(id => !id.startsWith('source:')));
  return content.split('\n').filter(line => {
    if (hashes.has(memoryFactFingerprint(line))) return false;
    const refs = provenance.find(p => normalizeMemoryFact(p.fact) === normalizeMemoryFact(line))?.sourceIds ?? [];
    return !refs.some(id => evidence.has(id));
  }).join('\n');
}

export function createMemoryRepository(baseDir: string) {
  const stateFile = '.memory-state.json';
  const locked = <T>(fn: () => T): T => withMemoryDirectoryLock(baseDir, fn);
  function persist(state: MemoryState, oldProjection: string | null): MemoryState {
    // Editors outside this process do not participate in our lock. Detect an edit
    // made since the snapshot before committing either representation.
    if (readMemoryFile(baseDir, 'MEMORY.md') !== oldProjection) memoryVersionConflict();
    state.projectionPending = true;
    state.previousProjectionHash = memoryContentVersion(oldProjection);
    atomicWriteMemoryFile(baseDir, stateFile, JSON.stringify(state));
    // A crash here leaves an explicit recovery intent; never mistake the older Markdown for a new edit.
    if (readMemoryFile(baseDir, 'MEMORY.md') !== oldProjection) throw new MemoryRepositoryError('MEMORY_PROJECTION_CONFLICT', 'Memory was committed but its editable document changed; both versions were retained for recovery.');
    atomicWriteMemoryFile(baseDir, 'MEMORY.md', state.content);
    state.projectionPending = false;
    state.previousProjectionHash = null;
    atomicWriteMemoryFile(baseDir, stateFile, JSON.stringify(state));
    return state;
  }
  function nextState(s: MemoryState, content: string, source: MemorySource, provenance?: MemoryCommit['provenance']): MemoryState {
    return {
      ...s, version: randomUUID(), content, source, updatedAt: Date.now(),
      entries: reconcileEntries(content, s.entries, source, provenance),
      revisions: [...s.revisions, { version: s.version, content: s.content, entries: s.entries, createdAt: s.updatedAt, source: s.source }].slice(-100),
    };
  }
  function load(): MemoryState {
    const raw = readMemoryFile(baseDir, stateFile);
    const markdown = readMemoryFile(baseDir, 'MEMORY.md');
    if (raw === null) {
      const content = markdown ?? '';
      const source: MemorySource = { kind: 'migration' };
      // Migration is not a fresh user write: inventing a new timestamp here makes
      // legacy LWW sync upload an empty document over an older nonempty cloud copy.
      const updatedAt = markdown === null ? 0 : lstatSync(safeMemoryPath(baseDir, 'MEMORY.md')).mtimeMs;
      return persist({ schemaVersion: 1, repositoryId: randomUUID(), version: randomUUID(), content, source, entries: reconcileEntries(content, [], source), tombstones: [], processedCandidateIds: [], updatedAt, revisions: [], projectionPending: false, previousProjectionHash: null }, markdown);
    }
    const s = decodeState(raw);
    if (s.projectionPending) {
      if (markdown !== s.content && memoryContentVersion(markdown) !== s.previousProjectionHash) fail('Memory projection changed during an interrupted commit; manual recovery required.');
      atomicWriteMemoryFile(baseDir, 'MEMORY.md', s.content);
      s.projectionPending = false; s.previousProjectionHash = null;
      atomicWriteMemoryFile(baseDir, stateFile, JSON.stringify(s));
      return s;
    }
    if (markdown === null) fail('MEMORY.md disappeared while metadata exists; refusing to treat this as empty memory.');
    if (markdown !== s.content) {
      const filtered = filterForgottenMemory(markdown, s.tombstones);
      return persist(nextState(s, filtered, { kind: 'external-edit' }), markdown);
    }
    return s;
  }
  function commit(input: MemoryCommit): MemorySnapshot {
    checkAbort(input.signal);
    return locked(() => {
      checkAbort(input.signal);
      const s = load();
      if (input.expectedVersion !== s.version) memoryVersionConflict();
      if (typeof input.content !== 'string' || input.content.length > 200_000 || !validSource(input.source)) throw new MemoryRepositoryError('MEMORY_INVALID', 'Invalid memory proposal or content exceeds 200000 characters.');
      if (input.consumedCandidateIds !== undefined && !stringArray(input.consumedCandidateIds)) throw new MemoryRepositoryError('MEMORY_INVALID', 'Invalid consumed candidate IDs.');
      const content = filterForgottenMemory(input.content, s.tombstones, input.provenance);
      const processed = [...new Set([...s.processedCandidateIds, ...(input.consumedCandidateIds ?? [])])].slice(-8192);
      if (content === s.content && !input.provenance?.length && JSON.stringify(processed) === JSON.stringify(s.processedCandidateIds)) return view(s);
      return view(persist({ ...nextState(s, content, input.source, input.provenance), processedCandidateIds: processed }, s.content));
    });
  }
  function mutate(input: MemoryMutation): MemorySnapshot {
    checkAbort(input.signal);
    return locked(() => {
      checkAbort(input.signal);
      const s = load();
      if (input.expectedVersion !== undefined && input.expectedVersion !== s.version) memoryVersionConflict();
      const source = input.source ?? { kind: 'explicit' };
      if (!validSource(source) || !['add', 'update', 'forget'].includes(input.action) || (input.evidenceIds !== undefined && !stringArray(input.evidenceIds))) throw new MemoryRepositoryError('MEMORY_INVALID', 'Invalid memory mutation.');
      const fact = input.fact?.trim().replace(/\s*\n\s*/g, ' ');
      if (input.action !== 'forget' && !fact) throw new MemoryRepositoryError('MEMORY_INVALID', 'fact is required.');
      const entry = input.id ? s.entries.find(e => e.id === input.id) : undefined;
      if (input.action !== 'add' && !entry) throw new MemoryRepositoryError('MEMORY_NOT_FOUND', 'Memory entry was not found in this agent.');
      if (input.action === 'add' && input.dedup !== false && s.entries.some(e => normalizeMemoryFact(e.content) === normalizeMemoryFact(fact!))) return view(s);
      let content = s.content;
      if (input.action === 'forget' || input.action === 'update') {
        const fingerprint = memoryFactFingerprint(entry!.content);
        const previous = s.tombstones.find(t => t.fingerprint === fingerprint);
        const forgottenAt = Math.max(Date.now(), (previous?.forgottenAt ?? 0) + 1, (previous?.restoredAt ?? 0) + 1);
        s.tombstones = [...s.tombstones.filter(t => t.fingerprint !== fingerprint), { id: randomUUID(), fingerprint, content: entry!.content, forgottenAt, ...(previous?.restoredAt ? { restoredAt: previous.restoredAt } : {}), evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), ...(input.action === 'forget' ? [entry!.id, ...entry!.evidenceIds] : [])])] }];
        content = filterForgottenMemory(content, s.tombstones);
      }
      if (input.action !== 'forget') {
        const cap = input.cap === undefined ? 20_000 : input.cap > 0 ? Math.min(input.cap, 200_000) : 200_000;
        if (fact!.length > cap || content.length + fact!.length + (content ? 1 : 0) > cap) throw new MemoryRepositoryError('MEMORY_FULL', `Long-term memory exceeds its ${cap} character budget.`);
        // Only an explicit user-facing add/update can deliberately remember the same fact again.
        s.tombstones = s.tombstones.map(t => t.fingerprint === memoryFactFingerprint(fact!) ? { ...t, restoredAt: Math.max(Date.now(), t.forgottenAt + 1, (t.restoredAt ?? 0) + 1) } : t);
        if (input.dedup === false || !content.split('\n').some(line => normalizeMemoryFact(line) === normalizeMemoryFact(fact!))) content = content ? content.replace(/\n+$/, '') + '\n' + fact : fact!;
      }
      const next = nextState(s, content, source, fact ? [{ fact, sourceIds: input.evidenceIds ?? [] }] : []);
      if (input.action === 'update' && entry) {
        const updated = next.entries.find(e => normalizeMemoryFact(e.content) === normalizeMemoryFact(fact!));
        if (updated) Object.assign(updated, { id: entry.id, createdAt: entry.createdAt, updatedAt: Date.now(), source, evidenceIds: [...new Set([...entry.evidenceIds, ...(input.evidenceIds ?? []), ...(source.messageId ? [source.messageId] : [])])] });
      }
      return view(persist(next, s.content));
    });
  }
  return {
    snapshot: (): MemorySnapshot => locked(() => view(load())),
    commit,
    mutate,
    add: (fact: string, opts: Omit<MemoryMutation, 'action' | 'fact'> = {}) => mutate({ ...opts, action: 'add', fact }),
    update: (id: string, fact: string, opts: Omit<MemoryMutation, 'action' | 'id' | 'fact'> = {}) => mutate({ ...opts, action: 'update', id, fact }),
    forget: (id: string, opts: Omit<MemoryMutation, 'action' | 'id'> = {}) => mutate({ ...opts, action: 'forget', id }),
    revisions: (): MemoryRevision[] => locked(() => { const s = load(); return structuredClone([...s.revisions, { version: s.version, content: s.content, entries: s.entries, createdAt: s.updatedAt, source: s.source }].reverse()); }),
    restore: (version: string, expectedVersion: string, signal?: AbortSignal): MemorySnapshot => locked(() => {
      checkAbort(signal); const s = load();
      if (expectedVersion !== s.version) memoryVersionConflict();
      const revision = s.revisions.find(r => r.version === version);
      if (s.version === version) return view(s);
      if (!revision) throw new MemoryRepositoryError('MEMORY_NOT_FOUND', 'Memory revision not found.');
      // Restoring a document is not permission to resurrect explicitly forgotten facts.
      const content = filterForgottenMemory(revision.content, s.tombstones);
      const next = nextState(s, content, { kind: 'restore' });
      next.entries = reconcileEntries(content, revision.entries, { kind: 'restore' });
      return view(persist(next, s.content));
    }),
    mergeTombstones: (incoming: MemoryTombstone[], signal?: AbortSignal): MemorySnapshot => locked(() => {
      checkAbort(signal); const tombstones = validateMemoryTombstones(incoming); const s = load();
      const merged = new Map(s.tombstones.map(t => [t.fingerprint, t]));
      for (const t of tombstones) {
        const prev = merged.get(t.fingerprint);
        const winner = prev && (prev.forgottenAt > t.forgottenAt || (prev.forgottenAt === t.forgottenAt && prev.id >= t.id)) ? prev : t;
        merged.set(t.fingerprint, prev ? { ...winner, ...(prev.restoredAt || t.restoredAt ? { restoredAt: Math.max(prev.restoredAt ?? 0, t.restoredAt ?? 0) } : {}), evidenceIds: [...new Set([...prev.evidenceIds, ...t.evidenceIds])].sort() } : t);
      }
      const mergedTombstones = [...merged.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
      if (JSON.stringify(mergedTombstones) === JSON.stringify(s.tombstones)) return view(s);
      s.tombstones = mergedTombstones;
      return view(persist(nextState(s, filterForgottenMemory(s.content, s.tombstones), { kind: 'sync' }), s.content));
    }),
  };
}
