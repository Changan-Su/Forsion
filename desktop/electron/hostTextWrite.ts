import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface HostTextWriteResult { ok?: boolean; conflict?: boolean; mtimeMs: number }
interface TextHandle {
  writeFile(content: string, encoding: 'utf8'): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}
/** Narrow filesystem seam for deterministic I/O-failure and concurrent-writer tests. */
export interface HostTextWriteIO {
  stat(path: string): Promise<{ mtimeMs: number }>
  open(path: string, flags: 'wx'): Promise<TextHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  create(path: string, content: string): Promise<void>
}
const nodeIO: HostTextWriteIO = {
  stat: path => fs.stat(path),
  open: (path, flags) => fs.open(path, flags),
  rename: (from, to) => fs.rename(from, to),
  unlink: path => fs.unlink(path),
  create: (path, content) => fs.writeFile(path, content, { encoding: 'utf8', flag: 'wx' }),
}

/** Serialize writes through this main process and check the disk immediately before
 * replacement. This is not atomic CAS against an uncooperative external process:
 * such a writer can still act between the final stat and rename, or preserve mtime. */
export function createHostTextWriter(overrides: Partial<HostTextWriteIO> = {}) {
  const io = { ...nodeIO, ...overrides }
  const pending = new Map<string, { tail: Promise<void>; commits: number; expected?: number; mtime: number }>()

  async function revision(path: string): Promise<number | null> {
    try { return (await io.stat(path)).mtimeMs }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
  }
  async function compare(path: string, expected: number): Promise<HostTextWriteResult | null> {
    const actual = await revision(path)
    return actual === null || actual !== expected ? { conflict: true, mtimeMs: actual ?? 0 } : null
  }

  async function writeLocked(path: string, content: string, expected?: number, createNew?: boolean): Promise<HostTextWriteResult> {
    if (createNew) {
      try { await io.create(path, content) }
      catch (error) { throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? new Error('同名文件/文件夹已存在') : error }
      return { ok: true, mtimeMs: (await io.stat(path)).mtimeMs }
    }
    if (expected !== undefined) {
      const conflict = await compare(path, expected)
      if (conflict) return conflict
    }
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    let ownsTemporary = false
    try {
      const handle = await io.open(temporary, 'wx')
      ownsTemporary = true
      try { await handle.writeFile(content, 'utf8'); await handle.sync() }
      finally { await handle.close() }
      // The temporary file is the version this operation actually wrote. Reading
      // the target after rename could return an external writer's later revision.
      const savedMtime = (await io.stat(temporary)).mtimeMs
      if (expected !== undefined) {
        const conflict = await compare(path, expected)
        if (conflict) return conflict
      }
      await io.rename(temporary, path)
      ownsTemporary = false
      return { ok: true, mtimeMs: savedMtime }
    } finally {
      if (ownsTemporary) await io.unlink(temporary).catch(() => {})
    }
  }

  return async (filePath: string, content: string, expectedMtimeMs?: number, createNew?: boolean): Promise<HostTextWriteResult> => {
    if (!filePath || typeof filePath !== 'string' || filePath.includes('\0') || typeof content !== 'string' ||
      (expectedMtimeMs !== undefined && !Number.isFinite(expectedMtimeMs))) throw new Error('非法的写入参数')
    const path = resolve(filePath)
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    const queue = pending.get(key) || { tail: Promise.resolve(), commits: 0, mtime: 0 }
    const observedCommits = queue.commits
    const operation = queue.tail.then(async () => {
      // A coarse filesystem can give two successive versions the same mtime.
      // Concurrent requests that supplied the same old token must still conflict;
      // a later caller that has received the saved token starts a fresh request.
      if (!createNew && expectedMtimeMs !== undefined && queue.commits !== observedCommits && queue.expected === expectedMtimeMs) {
        return { conflict: true, mtimeMs: queue.mtime }
      }
      const result = await writeLocked(path, content, expectedMtimeMs, createNew)
      if (result.ok) { queue.commits++; queue.expected = createNew ? undefined : expectedMtimeMs; queue.mtime = result.mtimeMs }
      return result
    })
    const settled = operation.then(() => {}, () => {})
    queue.tail = settled
    pending.set(key, queue)
    try { return await operation }
    finally { if (queue.tail === settled) pending.delete(key) }
  }
}

export const writeHostTextFile = createHostTextWriter()
