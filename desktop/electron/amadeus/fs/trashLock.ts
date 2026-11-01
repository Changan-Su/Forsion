import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

type Owner = { pid: number; token: string }
const readOwner = async (file: string): Promise<Owner | null> => {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    return Number.isSafeInteger(value?.pid) && value.pid > 0 && /^[a-f0-9-]{36}$/.test(value?.token)
      ? value as Owner : null
  } catch { return null }
}
const isDead = (pid: number): boolean => {
  try { process.kill(pid, 0); return false }
  catch (error: any) { return error?.code === 'ESRCH' } // EPERM/unknown means possibly alive.
}

/** Trash transactions can take arbitrarily long (recursive deletes, slow disks).
 * Never steal a live owner based on wall-clock age. Publish complete ownership
 * with an exclusive hard link, so termination cannot leave an ownerless lock.
 * PID reuse fails closed rather than risking two live transaction owners. */
export async function withTrashLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(root, '.trash-transaction.lock')
  const owner: Owner = { pid: process.pid, token: randomUUID() }
  const prepared = `${lock}.${owner.token}.owner`
  await fs.writeFile(prepared, JSON.stringify(owner), { flag: 'wx' })
  const deadline = Date.now() + 5000
  try {
    for (;;) {
      try { await fs.link(prepared, lock); break }
      catch (error: any) { if (error?.code !== 'EEXIST') throw error }
      const previous = await readOwner(lock)
      if (previous && isDead(previous.pid)) {
        // A token-specific recovery claim prevents two contenders from both
        // unlinking the dead owner's path after a new owner has acquired it.
        const claim = `${lock}.${previous.token}.recover`
        let claimed = false
        try {
          await fs.link(prepared, claim)
          claimed = true
          if ((await readOwner(lock))?.token === previous.token) await fs.unlink(lock)
        } catch (error: any) {
          if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error
        } finally { if (claimed) await fs.unlink(claim).catch(() => {}) }
      }
      if (Date.now() >= deadline) throw new Error('Another process owns the trash transaction; retry after it finishes')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    try { return await fn() }
    finally {
      if ((await readOwner(lock))?.token === owner.token) await fs.unlink(lock)
    }
  } finally { await fs.unlink(prepared).catch(() => {}) }
}
