/** Wire paths are untrusted, even when the response belongs to the authenticated account. */
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentsDir } from '../core/tanguHome.js';

export function validSyncSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && !slug.startsWith('__');
}
export function validLogDate(date: unknown): date is string {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
export function validSyncPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 1024 || /[\\\x00-\x1f:]/.test(p)) return false;
  if (p === '.memory-tombstones.json') return true;
  const parts = p.split('/');
  if (parts.some((s) => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith(' '))) return false;
  if (['config.toml', 'SOUL.md', 'HARNESS.md', 'MEMORY.md'].includes(p)) return true;
  if (p.startsWith('LOG/')) return parts.length === 2 && p.endsWith('.md') && validLogDate(parts[1].slice(0, -3));
  return parts.length > 1 && parts[0] === 'Library';
}

/** Reject symlinks at every component; both reads and atomic writes use this fence. */
export function assertSyncPath(root: string, target: string): string {
  const base = resolve(root);
  const full = resolve(target);
  const rel = relative(base, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== full) throw new Error('sync path escapes its agent');
  let current = base;
  for (const component of ['', ...rel.split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) throw new Error('sync paths cannot contain symlinks');
      if (current !== full && !st.isDirectory()) throw new Error('sync parent is not a directory');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return full;
}
export function agentSyncDir(slug: string): string {
  if (!validSyncSlug(slug)) throw new Error('invalid agent sync slug');
  return assertSyncPath(agentsDir(), join(agentsDir(), slug));
}
export function readSyncBytes(root: string, file: string): Buffer | null {
  assertSyncPath(root, file);
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile()) throw new Error('sync target is not a regular file');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(fd);
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Synchronous commit: no promise/cancellation can race a later local write. */
export function atomicSyncWrite(root: string, file: string, bytes: string | Buffer, guard: () => void = () => {}): void {
  guard(); assertSyncPath(root, file);
  mkdirSync(dirname(file), { recursive: true });
  assertSyncPath(root, file);
  try { if (!lstatSync(file).isFile()) throw new Error('sync target is not a regular file'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temp = join(dirname(file), `.sync-write-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    guard(); assertSyncPath(root, file); assertSyncPath(root, temp);
    renameSync(temp, file);
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
}
