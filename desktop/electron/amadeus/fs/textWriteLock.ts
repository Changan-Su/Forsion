import { realpathSync } from 'node:fs'
import path from 'node:path'

/** mkdir + atomic rename can target a whole missing subtree. Resolve the deepest existing
 * directory so the key stays the same before and after creating those directories. */
function physicalDirectory(dir: string): string {
  try { return realpathSync.native(dir) }
  catch (error) {
    const parent = path.dirname(dir)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) throw error
    return path.join(physicalDirectory(parent), path.basename(dir))
  }
}

function lockKeys(file: string): string[] {
  const abs = path.resolve(file)
  const entry = path.join(physicalDirectory(path.dirname(abs)), path.basename(abs))
  // Atomic replacement renames onto the directory entry. A leaf symlink is also read through
  // its target during CAS, so protect both names even when the rename will replace the link.
  try { return [entry, realpathSync.native(entry)] }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return [entry]
  }
}

/** 同一路径的文本写串行化(进程内)。CAS 的「读→比对→写」中间有两次 await,两个窗口的 invoke
 *  会交错在它们之间 —— 两边都比对通过、先写的那份被后写的静默盖掉,等于没做 CAS。非 CAS 的写也进同一条
 *  链,免得一发盲写插在别人的比对与落盘之间。引擎是另一个进程,不在这把锁里(它的改动走 watcher → 回灌)。
 *  ⚠️ **同一篇 .md 的每一条读改写 / 写通道都得进这把锁,并且在锁内读**(Codex g3#2):setPageFrontmatter、patchMark、
 *  改名引用重写这些「读全文 → 改一处 → 整篇写回」若在锁外,读到旧全文后编辑器的 CAS 写照样比对通过、回 ok:true,
 *  随后旧正文连同补丁写回 → 编辑器刚落盘的新正文静默丢失。不可重入:只在最底层那段「读→改→写」上锁,
 *  别把一个会再去拿锁的 helper 整个包进来。 */
const textWriteChains = new Map<string, Promise<unknown>>()
function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = textWriteChains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  textWriteChains.set(key, tail)
  void tail.then(() => { if (textWriteChains.get(key) === tail) textWriteChains.delete(key) })
  return run
}

export async function withTextWriteLock<T>(file: string | readonly string[], fn: () => Promise<T>): Promise<T> {
  const paths = typeof file === 'string' ? [file] : file
  // Multi-file moves and sync batches take each physical key once, in the same order.
  const keys = [...new Set(paths.flatMap(lockKeys))].sort()
  return keys.reduceRight<() => Promise<T>>((next, key) => () => enqueue(key, next), fn)()
}
