/**
 * Multi-account mode: per-account backup support for the host (the Unit that runs this engine).
 *
 * The host holds the object-storage side (it signs, uploads and downloads); the engine only does what needs its database
 * handles and request queue: a consistent snapshot of one account, restoring one account from an archive, and removing the
 * local copy of an account that has been backed up. All of it sits behind a second credential, TANGU_HOST_CONTROL_TOKEN,
 * on routes under /_host/ that are handled before the visitor identity check: the token visitors' requests carry
 * (TANGU_LOCAL_TOKEN) never opens them.
 *
 * With host control on, the engine also stops creating accounts on its own: an account whose folder is not there must be
 * admitted (new) or restored by the host first. A folder that is missing is never taken to mean "new person": the host
 * asks its backup service before it admits anyone.
 *
 *   GET    /_host/accounts                      { accounts: [{ id, state }] }
 *   GET    /_host/accounts/:id                  { state: 'active' | 'cold' | 'absent', cold? }
 *   POST   /_host/accounts/:id/admit            absent → provisioned; cold → 409 ACCOUNT_COLD
 *   POST   /_host/accounts/:id/snapshot         { since? } → { unchanged, fingerprint } | { snapshotId, size, md5, sha256, fingerprint, sessions }
 *   GET    /_host/snapshots/:sid                the archive (gzip'd tar)
 *   DELETE /_host/snapshots/:sid
 *   POST   /_host/accounts/:id/purge            { fingerprint, backupId, sha256 } → cold
 *   POST   /_host/accounts/:id/restore?backupId=&sha256=&size=   body = archive → { state: 'active', sessions, fingerprint }
 *   POST   /_host/accounts/:id/forget           cold → absent, only after the backup service removed the account's backups
 *
 * Snapshot: new requests of the account wait, writes in flight and pending memory organize passes drain, no run may be
 * active; state.db goes through SQLite's online backup, the rest of the folder is streamed into the archive, and the
 * folder's fingerprint is taken before and after: if anything changed while copying, the snapshot is thrown away (409).
 * Restore: the archive is treated as untrusted input. Only regular files and directories under home/, no '..', no absolute
 * paths; it is unpacked outside the accounts folder, checked, and renamed into place. An existing account is never
 * overwritten. Purge: only when the account is completely idle and its fingerprint still equals the one the host backed
 * up; a cold marker is written (and synced) before the folder goes, and the session id registry keeps its claims.
 */
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { accountHome, engineRoot, isValidAccountId, runWithAccount } from '../core/accountScope.js';
import { mbBytes, multiAccountLimits } from '../core/multiAccountLimits.js';
import { readTar, tarEnd, tarEntryHeader, tarPadding } from '../core/tarArchive.js';
import { accountHasActiveRuns } from '../services/agentLoop.js';
import { markAccountUsageDirty, newAccountsAllowed, SCRATCH_DIR } from '../services/accountStorage.js';
import { organizePendingFor } from '../services/memoryOrganize.js';
import type { MultiAccountHost } from '../adapters/standalone/multiAccountSqliteHost.js';

export const HOST_CONTROL_ENV = 'TANGU_HOST_CONTROL_TOKEN';
export const BACKUP_FORMAT = 'tangu-account-backup';
export const BACKUP_VERSION = 1;

/** Top-level names never copied: plugin script scratch, the database's side files (state.db goes through the online backup). */
const SKIP_TOP = new Set([SCRATCH_DIR, 'state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal']);
const MAX_ENTRIES = 200_000;
const DRAIN_WAIT_MS = 10_000;
const SNAPSHOT_GATE_MAX_MS = 120_000;
const SNAPSHOT_TTL_MS = 60 * 60_000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

export interface AccountBackupDeps {
  mh: MultiAccountHost;
  /** Requests of this account in flight (after the gate): all of them, and the ones that may write (not GET). */
  inflight(id: string): { all: number; writes: number };
}

type Gate = { kind: 'snapshot'; done: Promise<void> } | { kind: 'restore' } | { kind: 'purge' };
interface ColdMarker { backupId: string | null; sha256: string | null; fingerprint: string | null; at: string }
interface Snapshot { path: string; account: string; size: number; md5: string; sha256: string; at: number }

class HostError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const backupRoot = (): string => join(engineRoot(), '.host-backup');
const stateDir = (): string => join(engineRoot(), 'account-state');
const markerPath = (id: string): string => join(stateDir(), `${id}.json`);

/** Writes a file so that after a crash it is either the old content or the new one, and the rename itself is on disk. */
async function writeDurable(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await rename(tmp, path);
  await syncDir(dirname(path));
}
async function syncDir(dir: string): Promise<void> {
  try { const d = await open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch { /* not supported everywhere (e.g. Windows) */ }
}

/**
 * The account folder's fingerprint: every regular file that a backup contains (and state.db plus a non-empty WAL),
 * by relative path, size, inode, modification and change time in nanoseconds. Any write changes it — the change time
 * moves even when a writer puts the old modification time back; opening the database read-only does not.
 */
export async function accountFingerprint(id: string): Promise<string> {
  return (await scanAccount(id)).fingerprint;
}

/**
 * The fingerprint, plus what the folder holds that a backup would leave out and that carries data of its own: regular
 * files with other hard links, names an archive cannot carry (see safeRelative), entries that cannot be read. Symbolic
 * links and special files are left out of backups by design (no data of their own) and are not counted.
 */
async function scanAccount(id: string): Promise<{ fingerprint: string; unarchivable: number }> {
  const home = accountHome(id);
  const lines: string[] = [];
  let seen = 0;
  let unarchivable = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      if (++seen > MAX_ENTRIES) throw new Error('too many entries');
      const relName = rel ? `${rel}/${name}` : name;
      const p = join(dir, name);
      let st;
      try { st = await lstat(p, { bigint: true }); } catch { unarchivable++; continue; }
      if (!rel && (name === SCRATCH_DIR || name === 'state.db-shm' || name === 'state.db-journal')) continue;
      if (!rel && name === 'state.db-wal' && st.size === 0n) continue;
      const carried = (!rel && name === 'state.db') || archivableName(relName);
      if (st.isDirectory()) {
        if (!carried) { unarchivable++; continue; }
        lines.push(`d\0${relName}`);
        await walk(p, relName);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.nlink > 1n || !carried) { unarchivable++; continue; }
      lines.push(`f\0${relName}\0${st.size}\0${st.ino}\0${st.mtimeNs}\0${st.ctimeNs}`);
    }
  };
  await walk(home, '');
  return { fingerprint: createHash('sha256').update(lines.join('\n')).digest('hex'), unarchivable };
}

/** A name under the account folder that the archive can carry and a restore will take back (the same check as restore). */
const archivableName = (rel: string): boolean => safeRelative(`home/${rel}`) !== null;

/** Archive paths of account files: home/<relative path>. Every segment plain, nothing that climbs out. */
function safeRelative(name: string): string | null {
  if (name === 'manifest.json') return name;
  if (!name.startsWith('home/') && name !== 'home') return null;
  if (name.includes('\\') || name.includes('\0') || posix.isAbsolute(name)) return null;
  const segs = name.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return null;
  return segs.join('/');
}

export function createAccountBackup(deps: AccountBackupDeps & { controlToken: string; localToken: string }) {
  if (!deps.controlToken || deps.controlToken.length < 16) throw new Error(`${HOST_CONTROL_ENV} must be at least 16 characters`);
  if (deps.controlToken === deps.localToken) throw new Error(`${HOST_CONTROL_ENV} must differ from TANGU_LOCAL_TOKEN`);
  const { mh } = deps;
  const gates = new Map<string, Gate>();
  /** One host operation per account at a time, taken before the first await (the visitor gate above is separate). */
  const ops = new Set<string>();
  const claim = (id: string): (() => void) => {
    if (ops.has(id)) throw new HostError(409, 'ACCOUNT_BUSY', 'another operation is running on this account');
    ops.add(id);
    let done = false;
    return () => { if (!done) { done = true; ops.delete(id); } };
  };
  const cold = new Map<string, ColdMarker>();
  const snapshots = new Map<string, Snapshot>();

  // Leftovers of a previous process: half-written archives, unpacked restores, removed folders.
  for (const sub of ['out', 'in', 'trash']) {
    try { readdirSync(join(backupRoot(), sub)).forEach((n) => void rm(join(backupRoot(), sub, n), { recursive: true, force: true })); } catch { /* none */ }
  }
  mkdirSync(join(backupRoot(), 'out'), { recursive: true, mode: 0o700 });
  mkdirSync(join(backupRoot(), 'in'), { recursive: true, mode: 0o700 });
  mkdirSync(join(backupRoot(), 'trash'), { recursive: true, mode: 0o700 });
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  for (const name of readdirSync(stateDir())) {
    const m = /^(.+)\.json$/.exec(name);
    if (!m || !isValidAccountId(m[1])) continue;
    try {
      const body = JSON.parse(readFileSync(join(stateDir(), name), 'utf8'));
      cold.set(m[1], { backupId: body?.backupId ?? null, sha256: body?.sha256 ?? null, fingerprint: body?.fingerprint ?? null, at: String(body?.at ?? '') });
    } catch (e) {
      // Unreadable is not "not cold": keep the account closed until the host restores it.
      console.error(`[tangu] multi-account: the cold marker of ${m[1]} is unreadable (${(e as Error)?.message || e}); the account stays closed until it is restored`);
      cold.set(m[1], { backupId: null, sha256: null, fingerprint: null, at: '' });
    }
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of snapshots) if (now - s.at > SNAPSHOT_TTL_MS) { snapshots.delete(sid); void rm(s.path, { force: true }); }
  }, 10 * 60_000);
  sweep.unref?.();

  const exists = (id: string): boolean => existsSync(accountHome(id));
  const stateOf = (id: string): 'active' | 'cold' | 'absent' =>
    cold.has(id) ? 'cold' : exists(id) || mh.provisionedAccounts().includes(id) ? 'active' : 'absent';

  const waitUntil = async (ok: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  };

  // ── visitor gate ─────────────────────────────────────────────────────────────────────

  /** Runs before a visitor request is counted and before the account is opened. */
  const visitorGate: RequestHandler = (req, res, next) => {
    const id = (req as any).accountId as string;
    let left = false;
    res.once('close', () => { left = true; });
    void (async () => {
      const started = Date.now();
      for (;;) {
        const g = gates.get(id);
        if (g?.kind === 'snapshot') {
          // the few seconds a snapshot takes: queue, then go on
          if (Date.now() - started > SNAPSHOT_GATE_MAX_MS) return void res.status(503).json({ code: 'ACCOUNT_BUSY', detail: 'This account is being saved; try again in a moment.' });
          await g.done;
          continue;
        }
        if (g) return void res.status(503).json({ code: 'ACCOUNT_BUSY', detail: 'This account is being restored or archived; try again in a moment.' });
        break;
      }
      if (cold.has(id)) return void res.status(409).json({ code: 'ACCOUNT_COLD', detail: 'This account must be restored first.' });
      if (!mh.provisionedAccounts().includes(id) && !exists(id)) return void res.status(409).json({ code: 'ACCOUNT_NOT_ADMITTED', detail: 'This account is not open on this engine yet.' });
      // gone while queued behind a snapshot: nothing to serve (and its in-flight count would never be released)
      if (left || req.socket?.destroyed) return;
      next();
    })().catch(() => { if (!res.headersSent) res.status(500).json({ detail: 'Request failed' }); });
  };

  // ── snapshot ─────────────────────────────────────────────────────────────────────────

  async function buildArchive(id: string, fingerprint: string, out: string): Promise<{ size: number; md5: string; sha256: string; sessions: number }> {
    const home = accountHome(id);
    const dbCopy = join(backupRoot(), 'out', `${randomUUID()}.db`);
    await mh.backupDatabase(id, dbCopy);
    try {
      const sessions = mh.sessionIdsOf(id).filter((s) => SESSION_ID_RE.test(s));
      const manifest = Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, account: id, createdAt: new Date().toISOString(), fingerprint, sessions }));
      const gzip = createGzip({ level: 6 });
      const sha = createHash('sha256');
      const md5 = createHash('md5');
      let size = 0;
      const tap = new PassThrough();
      tap.on('data', (c: Buffer) => { sha.update(c); md5.update(c); size += c.length; });
      const done = pipeline(gzip, tap, createWriteStream(out, { mode: 0o600 }));
      const write = (b: Buffer): Promise<void> => new Promise((ok, fail) => { gzip.write(b, (e) => (e ? fail(e) : ok())); });
      const addFile = async (name: string, path: string): Promise<void> => {
        const fh = await open(path, 'r');
        try {
          const st = await fh.stat();
          if (!st.isFile()) return;
          await write(tarEntryHeader(name, 'file', st.size, 0o600));
          let left = st.size;
          const buf = Buffer.allocUnsafe(1024 * 1024);
          while (left > 0) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), null);
            if (!bytesRead) throw new HostError(409, 'ACCOUNT_BUSY', 'a file shrank while it was being saved');
            await write(Buffer.from(buf.subarray(0, bytesRead)));
            left -= bytesRead;
          }
          await write(tarPadding(st.size));
        } finally { await fh.close(); }
      };
      let entries = 0;
      await write(tarEntryHeader('manifest.json', 'file', manifest.length, 0o600));
      await write(manifest);
      await write(tarPadding(manifest.length));
      await write(tarEntryHeader('home', 'dir', 0, 0o700));
      await addFile('home/state.db', dbCopy);
      const walk = async (dir: string, rel: string): Promise<void> => {
        for (const name of (await readdir(dir)).sort()) {
          if (++entries > MAX_ENTRIES) throw new HostError(413, 'BACKUP_TOO_LARGE', 'too many files');
          if (!rel && SKIP_TOP.has(name)) continue;
          const relName = rel ? `${rel}/${name}` : name;
          // a name the restore would refuse stays out (and keeps the account from being purged, see scanAccount)
          if (!archivableName(relName)) continue;
          const p = join(dir, name);
          const st = await lstat(p);
          if (st.isDirectory()) { await write(tarEntryHeader(`home/${relName}`, 'dir', 0, 0o700)); await walk(p, relName); continue; }
          // links, devices, sockets and files with other hard links stay out of the backup (they could point at other accounts' data)
          if (!st.isFile() || st.nlink > 1) continue;
          await addFile(`home/${relName}`, p);
        }
      };
      await walk(home, '');
      await write(tarEnd());
      gzip.end();
      await done;
      return { size, md5: md5.digest('base64'), sha256: sha.digest('hex'), sessions: sessions.length };
    } finally {
      await rm(dbCopy, { force: true });
    }
  }

  async function snapshot(id: string, since: string | undefined) {
    const release = claim(id);
    try { return await snapshotClaimed(id, since); } finally { release(); }
  }
  async function snapshotClaimed(id: string, since: string | undefined) {
    if (gates.has(id)) throw new HostError(409, 'ACCOUNT_BUSY', 'another operation is running on this account');
    if (cold.has(id)) throw new HostError(409, 'ACCOUNT_COLD', 'the account is not on this engine');
    if (!exists(id)) throw new HostError(404, 'ACCOUNT_ABSENT', 'no such account');
    const before = await accountFingerprint(id);
    // "unchanged" lets the host mark the account as backed up: not while a run, a write or memory organising is still going
    // (its output would land after the answer and stay out of every backup until the next visit)
    if (since && before === since) {
      if (accountHasActiveRuns(id) || deps.inflight(id).writes > 0 || organizePendingFor(id)) throw new HostError(409, 'ACCOUNT_BUSY', 'the account is in use');
      return { unchanged: true as const, fingerprint: before };
    }
    // a run that is going is not waited for behind the gate (it can take minutes): only one that is just finishing
    if (!(await waitUntil(() => !accountHasActiveRuns(id), 2_000))) throw new HostError(409, 'ACCOUNT_BUSY', 'a run of this account is going');
    let open!: () => void;
    gates.set(id, { kind: 'snapshot', done: new Promise<void>((r) => { open = r; }) });
    const out = join(backupRoot(), 'out', `${randomUUID()}.tgz`);
    try {
      const quiet = () => deps.inflight(id).writes === 0 && !organizePendingFor(id) && !accountHasActiveRuns(id);
      if (!(await waitUntil(quiet, DRAIN_WAIT_MS))) {
        const why = accountHasActiveRuns(id) ? 'a run started' : organizePendingFor(id) ? 'memory is being organized' : 'requests are still writing';
        throw new HostError(409, 'ACCOUNT_BUSY', `the account is busy (${why})`);
      }
      const f1 = await accountFingerprint(id);
      const meta = await buildArchive(id, f1, out);
      const f2 = await accountFingerprint(id);
      if (f1 !== f2) throw new HostError(409, 'ACCOUNT_BUSY', 'the account changed while it was being saved');
      const sid = randomUUID();
      snapshots.set(sid, { path: out, account: id, size: meta.size, md5: meta.md5, sha256: meta.sha256, at: Date.now() });
      return { unchanged: false as const, snapshotId: sid, size: meta.size, md5: meta.md5, sha256: meta.sha256, fingerprint: f1, sessions: meta.sessions };
    } catch (e) {
      await rm(out, { force: true });
      throw e;
    } finally {
      gates.delete(id);
      open();
    }
  }

  // ── purge ────────────────────────────────────────────────────────────────────────────

  async function purge(id: string, body: { fingerprint?: unknown; backupId?: unknown; sha256?: unknown }) {
    if (typeof body.fingerprint !== 'string' || !HEX64.test(body.fingerprint)) throw new HostError(400, 'BAD_REQUEST', 'fingerprint is required');
    const backupId = typeof body.backupId === 'string' && body.backupId.length <= 128 ? body.backupId : null;
    const sha256 = typeof body.sha256 === 'string' && HEX64.test(body.sha256) ? body.sha256 : null;
    const release = claim(id);
    if (gates.has(id)) { release(); throw new HostError(409, 'ACCOUNT_BUSY', 'another operation is running on this account'); }
    if (cold.has(id)) { release(); return { state: 'cold' as const }; }
    if (!exists(id)) { release(); throw new HostError(404, 'ACCOUNT_ABSENT', 'no such account'); }
    gates.set(id, { kind: 'purge' });
    try {
      const idle = await waitUntil(() => deps.inflight(id).all === 0, 5_000);
      if (!idle || accountHasActiveRuns(id) || organizePendingFor(id)) throw new HostError(409, 'ACCOUNT_BUSY', 'the account is in use');
      const scan = await scanAccount(id);
      if (scan.fingerprint !== body.fingerprint) throw new HostError(409, 'ACCOUNT_CHANGED', 'the account changed since that backup');
      // anything with data of its own that the backup left out would be lost with the folder: keep the account here
      if (scan.unarchivable > 0) throw new HostError(409, 'ACCOUNT_NOT_ARCHIVABLE', `${scan.unarchivable} item(s) in this account cannot be carried by a backup`);
      const marker: ColdMarker = { backupId, sha256, fingerprint: body.fingerprint, at: new Date().toISOString() };
      // the marker first: from here on a missing folder means "restore it", never "new account"
      await writeDurable(markerPath(id), JSON.stringify(marker));
      cold.set(id, marker);
      mh.closeAccount(id);
      const trash = join(backupRoot(), 'trash', `${id}-${Date.now()}-${randomUUID()}`);
      await rename(accountHome(id), trash);
      await syncDir(join(engineRoot(), 'accounts'));
      await rm(trash, { recursive: true, force: true });
      markAccountUsageDirty(id);
      return { state: 'cold' as const };
    } finally {
      gates.delete(id);
      release();
    }
  }

  // ── restore ──────────────────────────────────────────────────────────────────────────

  async function restore(id: string, req: Request) {
    const sha256 = String(req.query.sha256 ?? '');
    const size = Number(req.query.size);
    const backupId = typeof req.query.backupId === 'string' && req.query.backupId.length <= 128 ? req.query.backupId : null;
    const maxArchive = Math.max(mbBytes(multiAccountLimits().accountStorageMB) * 2, 64 * 1024 * 1024);
    if (!HEX64.test(sha256) || !Number.isSafeInteger(size) || size <= 0) throw new HostError(400, 'BAD_REQUEST', 'sha256 and size are required');
    if (size > maxArchive) throw new HostError(413, 'BACKUP_TOO_LARGE', 'the archive is larger than an account may be');
    const release = claim(id);
    try { return await restoreClaimed(id, req, sha256, size, backupId, maxArchive); } finally { release(); }
  }
  async function restoreClaimed(id: string, req: Request, sha256: string, size: number, backupId: string | null, maxArchive: number) {
    if (gates.has(id)) throw new HostError(409, 'ACCOUNT_BUSY', 'another operation is running on this account');
    const marker = cold.get(id);
    if (marker) {
      if (marker.backupId && backupId !== marker.backupId) throw new HostError(409, 'BACKUP_NOT_EXPECTED', 'this account was archived with another backup');
    } else if (exists(id) || mh.provisionedAccounts().includes(id)) {
      throw new HostError(409, 'ACCOUNT_EXISTS', 'the account is already here; it is never overwritten');
    }
    if (!(await newAccountsAllowed())) throw new HostError(507, 'ENGINE_STORAGE_FULL', 'this engine is out of space for accounts');
    gates.set(id, { kind: 'restore' });
    const work = join(backupRoot(), 'in', randomUUID());
    try {
      await mkdir(work, { recursive: true, mode: 0o700 });
      // 1. the archive to disk, hashed and bounded
      const gz = join(work, 'archive.tgz');
      const hash = createHash('sha256');
      let got = 0;
      const counter = new PassThrough();
      counter.on('data', (c: Buffer) => {
        got += c.length;
        if (got > size) counter.destroy(new HostError(422, 'BACKUP_INVALID', 'the archive is larger than declared'));
        else hash.update(c);
      });
      await pipeline(req, counter, createWriteStream(gz, { mode: 0o600 }));
      if (got !== size || hash.digest('hex') !== sha256) throw new HostError(422, 'BACKUP_INVALID', 'the archive does not match its checksum');
      // 2. unpack outside the accounts folder, every path checked
      const root = join(work, 'unpacked');
      await mkdir(root, { mode: 0o700 });
      let manifest: any = null;
      let total = 0;
      const limit = maxArchive * 4;
      const madeDirs = new Set<string>(['']);
      await readTar(createReadStream(gz).pipe(createGunzip()) as AsyncIterable<Buffer>, {
        entry: async (e, body) => {
          const rel = safeRelative(e.name);
          if (!rel) throw new HostError(422, 'BACKUP_INVALID', `unexpected path in the archive: ${JSON.stringify(e.name).slice(0, 120)}`);
          if (rel === 'manifest.json') {
            if (e.type !== 'file' || e.size > 4 * 1024 * 1024 || manifest) throw new HostError(422, 'BACKUP_INVALID', 'bad manifest');
            const chunks: Buffer[] = [];
            for await (const c of body) chunks.push(c);
            try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HostError(422, 'BACKUP_INVALID', 'bad manifest'); }
            return;
          }
          if (!manifest) throw new HostError(422, 'BACKUP_INVALID', 'the manifest must come first');
          const target = join(root, ...rel.split('/'));
          const parent = rel.split('/').slice(0, -1).join('/');
          if (!madeDirs.has(parent)) throw new HostError(422, 'BACKUP_INVALID', 'a file comes before its folder');
          if (e.type === 'dir') {
            await mkdir(target, { mode: 0o700 }).catch((err) => { if (err?.code !== 'EEXIST') throw err; });
            const st = await lstat(target);
            if (!st.isDirectory()) throw new HostError(422, 'BACKUP_INVALID', 'duplicate path in the archive');
            madeDirs.add(rel);
            return;
          }
          total += e.size;
          if (total > limit) throw new HostError(422, 'BACKUP_INVALID', 'the archive unpacks to more than an account may hold');
          // 'wx': a name that appears twice is refused instead of overwriting the first one
          await pipeline(Readable.from(body), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        },
      }, { maxEntries: MAX_ENTRIES }).catch((e) => {
        // anything wrong inside the archive (truncated, bad gzip, a name twice, a file where a folder is) is a bad backup
        throw e instanceof HostError ? e : new HostError(422, 'BACKUP_INVALID', `the archive is damaged: ${(e as Error)?.message || e}`);
      });
      if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION || manifest.account !== id) {
        throw new HostError(422, 'BACKUP_INVALID', 'the archive is not a backup of this account');
      }
      const unpackedHome = join(root, 'home');
      if (!(await stat(unpackedHome).catch(() => null))?.isDirectory() || !(await stat(join(unpackedHome, 'state.db')).catch(() => null))?.isFile()) {
        throw new HostError(422, 'BACKUP_INVALID', 'the archive has no account folder');
      }
      const sessions = Array.isArray(manifest.sessions) ? manifest.sessions.filter((s: unknown): s is string => typeof s === 'string' && SESSION_ID_RE.test(s)) : [];
      // 3. into place. A folder left behind by an interrupted archive step (cold marker present) is moved aside, never merged.
      await mkdir(join(engineRoot(), 'accounts'), { recursive: true, mode: 0o700 });
      if (exists(id)) {
        if (!marker) throw new HostError(409, 'ACCOUNT_EXISTS', 'the account is already here; it is never overwritten');
        await rename(accountHome(id), join(backupRoot(), 'trash', `${id}-${Date.now()}-${randomUUID()}`));
      }
      await rename(unpackedHome, accountHome(id));
      await syncDir(join(engineRoot(), 'accounts'));
      // 4. its sessions belong to it again before anyone can claim them; ids another account holds stay with that account
      runWithAccount(id, () => {
        for (const sid of sessions) if (!mh.claimSession(sid)) console.error(`[tangu] multi-account: restored session ${sid} of ${id} is registered to another account; it stays closed`);
      });
      if (marker) {
        await unlink(markerPath(id)).catch((e) => { if (e?.code !== 'ENOENT') throw e; });
        await syncDir(stateDir());
        cold.delete(id);
      }
      markAccountUsageDirty(id);
      return { state: 'active' as const, sessions: sessions.length, fingerprint: await accountFingerprint(id) };
    } finally {
      gates.delete(id);
      await rm(work, { recursive: true, force: true });
    }
  }

  // ── routes ───────────────────────────────────────────────────────────────────────────

  const router: Router = express.Router();
  router.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), deps.controlToken)) {
      return void res.status(401).json({ detail: 'Unauthorized' });
    }
    next();
  });
  const handle = (fn: (req: Request, res: Response, id: string) => Promise<unknown>): RequestHandler => (req, res) => {
    const id = String(req.params.id ?? '');
    if (req.params.id !== undefined && !isValidAccountId(id)) return void res.status(400).json({ code: 'BAD_REQUEST', detail: 'Invalid account id' });
    fn(req, res, id).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }, (e) => {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HostError) return void res.status(e.status).json({ code: e.code, detail: e.message });
      console.error(`[tangu] multi-account: host operation on ${id || '-'} failed:`, (e as Error)?.message || e);
      res.status(500).json({ code: 'FAILED', detail: 'The operation failed' });
    });
  };
  const json = express.json({ limit: '64kb' });

  router.get('/accounts', handle(async () => {
    const ids = new Set<string>(cold.keys());
    try { for (const n of readdirSync(join(engineRoot(), 'accounts'))) if (isValidAccountId(n)) ids.add(n); } catch { /* none yet */ }
    return { accounts: [...ids].sort().map((id) => ({ id, state: stateOf(id) })) };
  }));
  router.get('/accounts/:id', handle(async (_req, _res, id) => {
    const state = stateOf(id);
    return state === 'cold' ? { state, cold: cold.get(id) } : { state };
  }));
  router.post('/accounts/:id/admit', handle(async (_req, _res, id) => {
    const release = claim(id);
    try {
      if (gates.has(id)) throw new HostError(409, 'ACCOUNT_BUSY', 'another operation is running on this account');
      const state = stateOf(id);
      if (state === 'cold') throw new HostError(409, 'ACCOUNT_COLD', 'the account must be restored, not admitted');
      if (state === 'active') return { state, created: false };
      if (!(await newAccountsAllowed())) throw new HostError(503, 'NEW_ACCOUNTS_CLOSED', 'This engine is not accepting new accounts right now.');
      await mh.ensureAccount(id);
      return { state: 'active', created: true };
    } finally { release(); }
  }));
  router.post('/accounts/:id/snapshot', json, handle(async (req, _res, id) => {
    const since = typeof req.body?.since === 'string' && HEX64.test(req.body.since) ? req.body.since : undefined;
    return snapshot(id, since);
  }));
  router.get('/snapshots/:sid', handle(async (req, res) => {
    const s = snapshots.get(String(req.params.sid));
    if (!s) throw new HostError(404, 'NOT_FOUND', 'no such snapshot');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(s.size) });
    await pipeline(createReadStream(s.path), res);
    return undefined;
  }));
  router.delete('/snapshots/:sid', handle(async (req) => {
    const s = snapshots.get(String(req.params.sid));
    if (s) { snapshots.delete(String(req.params.sid)); await rm(s.path, { force: true }); }
    return { ok: true };
  }));
  router.post('/accounts/:id/purge', json, handle(async (req, _res, id) => purge(id, req.body ?? {})));
  router.post('/accounts/:id/restore', handle(async (req, _res, id) => restore(id, req)));
  // The backup service removed this account's backups after its retention period: drop the cold marker so it can start over.
  // Only for a cold account (there is no folder to lose); the host calls it only on that answer from the service.
  router.post('/accounts/:id/forget', handle(async (_req, _res, id) => {
    const release = claim(id);
    try {
      if (gates.has(id)) throw new HostError(409, 'ACCOUNT_BUSY', 'another operation is running on this account');
      if (!cold.has(id)) throw new HostError(409, 'ACCOUNT_NOT_COLD', 'only an archived account can be forgotten');
      if (exists(id)) throw new HostError(409, 'ACCOUNT_EXISTS', 'the account folder is here');
      await unlink(markerPath(id)).catch((e) => { if (e?.code !== 'ENOENT') throw e; });
      await syncDir(stateDir());
      cold.delete(id);
      return { state: 'absent' };
    } finally { release(); }
  }));
  router.use((_req, res) => { res.status(404).json({ detail: 'Not found' }); });

  return {
    router,
    visitorGate,
    dispose: () => {
      clearInterval(sweep);
      for (const s of snapshots.values()) void rm(s.path, { force: true });
      snapshots.clear();
    },
    /** Tests / diagnostics. */
    coldAccounts: () => [...cold.keys()],
  };
}

export type AccountBackup = ReturnType<typeof createAccountBackup>;
