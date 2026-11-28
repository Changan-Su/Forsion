/**
 * 本地磁盘侧(Forsion 自研):
 *  - walkLocalFiles / sha256 / atomicWrite:引擎用的本地库扫描与写入工具
 *  - createDirRemote:把一个目录当远端(folder 后端:U 盘 / NAS 挂载点;也是测试假远端)
 *    opts.cas = TargetFs 语义(targetFs.ts):null = 独占新建(同目录临时文件 + link,原子)、
 *    string = 进程内写锁里复查身份再写 / 删(非原子:只防进程内交错,外部进程的窗口缩到一次 stat)。缺省 = 旧行为。
 *    cas 下每次变更(及 stat)都先确认 key 的真实父目录在根的真实路径之内(父路径上的符号链接会把写删带到目标树外);
 *    条件写先把临时文件写完刷盘,再复查身份与中止信号,紧接着 rename。
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RemoteEntity, RemoteFs } from './types'
import { withTextWriteLock } from '../amadeus/fs/textWriteLock'
import { renameAtomic, writeFileDurable } from '../amadeus/fs/renameAtomic'

export interface LocalFile {
  key: string
  size: number
  mtimeMs: number
  absPath: string
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 递归列出 root 下全部普通文件(跳过符号链接);key = posix 相对路径。root 不存在 → throw。 */
export async function walkLocalFiles(root: string): Promise<LocalFile[]> {
  const out: LocalFile[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true })
    for (const it of items) {
      const abs = path.join(dir, it.name)
      const key = rel ? `${rel}/${it.name}` : it.name
      if (it.isSymbolicLink()) continue
      if (it.isDirectory()) {
        await walk(abs, key)
      } else if (it.isFile()) {
        const st = await fs.stat(abs)
        out.push({ key, size: st.size, mtimeMs: Math.floor(st.mtimeMs), absPath: abs })
      }
    }
  }
  await walk(root, '')
  return out
}

/** 原子写(同目录 tmp + fsync + rename,见 writeFileDurable)+ 尽力对齐 mtime(跨设备 stat 缓存命中)。
 *  临时名带随机后缀:writeFileDurable 独占创建,只带 pid 时崩溃留下的同名残渣会让之后每次写都 EEXIST。
 *  不拼目标文件名:长文件名再加 UUID 会超 255 字符上限(ENAMETOOLONG);点开头,库 watcher 不当成新文件。 */
export async function atomicWrite(absPath: string, data: Buffer, mtimeMs?: number): Promise<void> {
  const dir = path.dirname(absPath)
  await fs.mkdir(dir, { recursive: true })
  await writeFileDurable(absPath, path.join(dir, `.rsync-tmp-${process.pid}-${randomUUID()}`), data)
  if (mtimeMs && mtimeMs > 0) {
    await fs.utimes(absPath, new Date(mtimeMs), new Date(mtimeMs)).catch(() => {})
  }
}

export interface DirRemoteOptions {
  /** TargetFs 语义(见 targetFs.ts):expectedId 生效。缺省 false = 旧行为(expectedId 忽略、无条件写删),
   *  旧引擎和 engine.test 的假远端走这里,不许改。 */
  cas?: boolean
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code
const entityOfStat = (key: string, st: { size: number; mtimeMs: number }): RemoteEntity => {
  const mt = Math.floor(st.mtimeMs)
  return { key, size: st.size, mtimeMs: mt, id: `${mt}:${st.size}` }
}

/** 同目录写一个刷过盘、对齐过 mtime 的临时文件,返回它的路径与 fstat(link / rename 之后 inode 不变,
 *  所以这份 stat 就是落位后的身份 —— 不在落位后再 stat 最终路径,免得把外部进程紧接着的写认成自己的)。 */
async function writeTempDurable(dir: string, data: Buffer, mtimeMs: number): Promise<{ tmp: string; st: { size: number; mtimeMs: number } }> {
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.rsync-tmp-${process.pid}-${randomUUID()}`)
  let h: Awaited<ReturnType<typeof fs.open>> | undefined = await fs.open(tmp, 'wx')
  try {
    await h.writeFile(data)
    await h.sync()
    if (mtimeMs > 0) await h.utimes(new Date(mtimeMs), new Date(mtimeMs)).catch(() => {})
    const st = await h.stat()
    const closing = h
    h = undefined
    await closing.close()
    return { tmp, st }
  } catch (e) {
    if (h) await h.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/** cas 条件覆盖后的身份必须变:新内容恰好同 mtime 同大小时把临时文件的 mtime 往后挪(1ms 不够的文件系统 ——
 *  HFS+ 秒级、FAT 2 秒 —— 依次再试 1s、2s),返回挪过之后的 stat。挪不动就抛(不让旧身份的删除删到新内容)。
 *  剩余限制:身份仍只是 mtime:size,外部进程写出同 mtime 同大小的内容照样认不出来(要更强得换内容 hash)。 */
async function bumpPastIdentity(tmp: string, st: { size: number; mtimeMs: number }, oldId: string, key: string): Promise<{ size: number; mtimeMs: number }> {
  const base = Math.floor(st.mtimeMs)
  for (const step of [1, 1000, 2000]) {
    await fs.utimes(tmp, new Date(base + step), new Date(base + step))
    const now = await fs.stat(tmp)
    if (entityOfStat(key, now).id !== oldId) return now
  }
  throw new Error(`folder identity unchanged after write: ${key}`)
}

/** 目录当远端。身份 = mtime+size(ponytail: 同毫秒同大小的改动检测不到,够用;要更强换内容 hash)。 */
export function createDirRemote(root: string, opts: DirRemoteOptions = {}): RemoteFs & Required<Pick<RemoteFs, 'stat'>> {
  const abs = (key: string): string => {
    const p = path.join(root, ...key.split('/'))
    const resolved = path.resolve(p)
    if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
      throw new Error(`key escapes root: ${key}`)
    }
    return resolved
  }
  const conflict = (op: string, key: string, why: string): Error => new Error(`cas-conflict folder ${op} ${key}: ${why}`)
  const rootAbs = path.resolve(root)
  /** cas:key 的父目录(还没建出来就取最深的已存在祖先)的真实路径必须是根的真实路径或在它里面 ——
   *  lstat 只管最后一段,父路径上的符号链接照样会被穿过去。根本身不在(U 盘没插)→ 抛,不当不存在。
   *  非原子:检查与变更之间被换成链接的窗口仍在,所以变更前一刻再查一次。 */
  const assertInsideRoot = async (key: string, file: string): Promise<void> => {
    const rootReal = await fs.realpath(rootAbs)
    let dir = path.dirname(file)
    for (;;) {
      let real: string
      try {
        real = await fs.realpath(dir)
      } catch (e) {
        const c = errCode(e)
        if ((c === 'ENOENT' || c === 'ENOTDIR') && dir !== rootAbs && path.dirname(dir) !== dir) {
          dir = path.dirname(dir)
          continue
        }
        throw e
      }
      if (real !== rootReal && !real.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep)) {
        throw new Error(`path-escapes-target folder ${key}`)
      }
      return
    }
  }
  const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  }
  /** lstat:符号链接 walk 不列,这里也不当文件(拒绝,而不是穿过链接去写别处)。 */
  const statKey = async (key: string): Promise<RemoteEntity | null> => {
    const file = abs(key)
    if (opts.cas) await assertInsideRoot(key, file)
    let st: Awaited<ReturnType<typeof fs.lstat>>
    try {
      st = await fs.lstat(file)
    } catch (e) {
      if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return null
      throw e
    }
    if (!st.isFile()) throw new Error(`not-a-file folder ${key}`)
    return entityOfStat(key, st)
  }
  /** 独占新建:临时文件 link 到目标(EEXIST = 有人先建了,目标原样不动);link 因其他任何原因失败都退回 open(final,'wx')
   *  —— FAT/exFAT U 盘、部分网络盘不支持硬链接,报的码因平台而异(POSIX 上 EPERM / ENOTSUP / EXDEV,Windows 上 libuv 可能译成
   *  EISDIR),而 'wx' 本身就是独占创建,任何错误都退过去不会削弱「不覆盖」。退路非原子落内容:中途崩溃可能留下半截文件;
   *  写内容失败时只删自己建的那个 inode(dev + ino 对得上),路径已被别的进程换掉就不动。 */
  const createExclusive = async (key: string, file: string, data: Buffer, mtimeMs: number, signal?: AbortSignal): Promise<RemoteEntity> => {
    const { tmp, st } = await writeTempDurable(path.dirname(file), data, mtimeMs)
    try {
      // 父目录可能是刚 mkdir 出来的:落位前一刻再确认一次在根里面,也别让已中止的请求落盘
      throwIfAborted(signal)
      await assertInsideRoot(key, file)
      try {
        await fs.link(tmp, file)
        return entityOfStat(key, st)
      } catch (e) {
        if (errCode(e) === 'EEXIST') throw conflict('PUT', key, 'exists')
      }
      let h: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        h = await fs.open(file, 'wx')
      } catch (e) {
        if (errCode(e) === 'EEXIST') throw conflict('PUT', key, 'exists')
        throw e
      }
      let own: { dev: bigint; ino: bigint } | undefined
      try {
        own = await h.stat({ bigint: true })
        await h.writeFile(data)
        await h.sync()
        if (mtimeMs > 0) await h.utimes(new Date(mtimeMs), new Date(mtimeMs)).catch(() => {})
        const st2 = await h.stat()
        const closing = h
        h = undefined
        await closing.close()
        return entityOfStat(key, st2)
      } catch (e) {
        if (h) await h.close().catch(() => {})
        // 我们独占建的半截文件 —— 但只在路径上还是它时才删(写的途中别的进程可能已把路径换成了它的文件)
        const now = await fs.lstat(file, { bigint: true }).catch(() => null)
        if (own && now && now.dev === own.dev && now.ino === own.ino) await fs.rm(file, { force: true }).catch(() => {})
        throw e
      }
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
  return {
    kind: 'folder',
    async walk() {
      const files = await walkLocalFiles(root)
      return files.map((f) => ({ key: f.key, size: f.size, mtimeMs: f.mtimeMs, id: `${f.mtimeMs}:${f.size}` }))
    },
    async readFile(key) {
      return fs.readFile(abs(key))
    },
    async writeFile(key, data, mtimeMs, signal, expectedId) {
      const file = abs(key)
      if (!opts.cas || expectedId === undefined) {
        return withTextWriteLock(file, async () => {
          await atomicWrite(file, data, mtimeMs)
          const st = await fs.stat(file)
          const mt = Math.floor(st.mtimeMs)
          return { key, size: st.size, mtimeMs: mt, id: `${mt}:${st.size}` }
        })
      }
      return withTextWriteLock(file, async () => {
        // 先于 writeTempDurable 的 mkdir -p 查:父路径上的符号链接会让 mkdir / 临时文件也落到目标树外
        await assertInsideRoot(key, file)
        if (expectedId === null) return createExclusive(key, file, data, mtimeMs, signal)
        // 早查一次:明显过期就不写临时文件(也不替已删的父目录重建出来);下面 rename 前一刻还有权威的一次
        const cur = await statKey(key)
        if (!cur) throw conflict('PUT', key, 'absent')
        if (cur.id !== expectedId) throw conflict('PUT', key, 'remote changed')
        const { tmp, st } = await writeTempDurable(path.dirname(file), data, mtimeMs)
        try {
          const fin = entityOfStat(key, st).id === expectedId ? await bumpPastIdentity(tmp, st, expectedId, key) : st
          // 写完、刷完盘再复查(刷盘可能很慢,外部进程这期间存的新版本不能被 rename 盖掉;中止了的请求也不许落盘)
          throwIfAborted(signal)
          const now = await statKey(key)
          if (!now) throw conflict('PUT', key, 'absent')
          if (now.id !== expectedId) throw conflict('PUT', key, 'remote changed')
          await renameAtomic(tmp, file)
          return entityOfStat(key, fin)
        } catch (e) {
          await fs.rm(tmp, { force: true }).catch(() => {})
          throw e
        }
      })
    },
    async rm(key, signal, expectedId) {
      const file = abs(key)
      if (!opts.cas || expectedId === undefined) {
        await withTextWriteLock(file, () => fs.rm(file, { force: true }))
        return
      }
      await withTextWriteLock(file, async () => {
        const cur = await statKey(key)
        if (expectedId === null) {
          if (cur) throw conflict('rm', key, 'exists')
          return
        }
        if (!cur) return // 已不在 = 幂等
        if (cur.id !== expectedId) throw conflict('rm', key, 'remote changed')
        throwIfAborted(signal)
        await fs.rm(file, { force: true })
      })
    },
    async stat(key) {
      return statKey(key)
    },
    async check() {
      try {
        await fs.mkdir(root, { recursive: true })
        await fs.access(root)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
    },
  }
}
