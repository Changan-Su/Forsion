import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** 串行队列:任务等前一个结束(成功或失败)才开始;失败只抛给自己的调用方,不堵后面的
 *  (别学 ensureChain 整条吞错 —— 写配置的调用方要拿到失败)。 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.then(() => {}, () => {})
    return run
  }
}

/** 配置 JSON 原子落盘:唯一临时名 + rename,临时文件建出来就是 0600(含 token / apiKey / 配对密钥)。
 *  截断直写、或几个写者共用一个 `.tmp`,并发时会拼出半截 JSON(2026-09-17 真 Electron 实测两份配置都被写坏)。
 *  ponytail: 不 fsync —— 断电瞬间那次写可能留下空文件,与原 writeHomeConfig 同;要防就照 hostTextWrite 加 sync。
 *  (config.json 不走这里:lockedUpdateJson 用 writeAtomicSync,fsync + .bak。) */
export async function writePrivateJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

// ── 跨进程写锁(~/.forsion/config.json 由桌面主进程、引擎、CLI 三方同写)。与 tangu-agent/src/core/config.ts 的
//    withConfigLock / updateConfigFile 是同一协议,改一边必须改另一边:锁 = `<file>.lock`,O_EXCL 建出即持有,
//    内容 = 本次持有的唯一 token;持锁只包同步的「读 → 改 → 写临时文件 → 核 token → rename」;锁 mtime 超
//    LOCK_STALE_MS = 持锁进程死在临界区 → rename 到一旁再删;等锁超 LOCK_WAIT_MS 抛错,绝不硬写。读者不加锁(rename 原子)。
//    偷锁会被骗:判陈旧与 rename 之间锁已被别人偷走重建(ABA),或持锁进程被挂起 / 合盖睡眠超过 5s —— 活锁被挪走。
//    所以提交前核锁里还是自己的 token,不是就抛错不落盘;放锁也只删自己的。代价 = 这种交错下一次写入失败(抛给调用方)。
//    残余窗口:「核 token → rename」与「核 token → 删锁」之间的微秒 —— 持锁者恰好停在这两处超过 5s 才会撞上。
const LOCK_STALE_MS = 5_000
const LOCK_WAIT_MS = 10_000
/** Windows 上锁文件处于「删除挂起」时 CREATE_NEW 报 EPERM/EACCES,按「被占」处理;POSIX 上它们是真权限错误,立刻抛。 */
const LOCK_BUSY = new Set(process.platform === 'win32' ? ['EEXIST', 'EPERM', 'EACCES'] : ['EEXIST'])

function stealIfStale(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return
    const aside = `${lock}.stale-${process.pid}-${randomUUID()}`
    renameSync(lock, aside)
    rmSync(aside, { force: true })
  } catch { /* 锁刚被释放 / 被别人先偷走:回去重抢 */ }
}

// ── 写前备份 / 读坏恢复。与 tangu-agent/src/core/config.ts 的 readLockedJson / commitLockedJson 是同一协议,改一边必须改另一边:
//    `<目录>/config-backup/<名>.bak` = 上一次写盘前那份好的(原样字节,0600;写不进去整次拒写);读到坏文件(零字节 / 半截 / 不是对象)且 .bak 有效 →
//    坏的复制成 `<名>.bad-<时间>-<随机>` 留着、.bak 原子换回原位、写恢复标记 `<名>.recovered`(设置页据此提示);.bak 也坏 → 什么都不动、拒写。
//    .bak 只在恢复时读,平时不是第二条读路径。整个目录在引擎的凭据 / 受保护清单里(hostSandboxProtection)。
/** 某个配置文件的备份目录(与它同目录,rename 不跨盘)。 */
export const configBackupDir = (file: string): string => join(dirname(file), 'config-backup')
const backupOf = (file: string): string => join(configBackupDir(file), `${basename(file)}.bak`)
/** 恢复标记:`{ at: 恢复时刻, version: 恢复到的那份 .bak 的写入时刻, bad: 坏文件留存名 }`(epoch ms)。 */
export const recoveryMarkerOf = (file: string): string => join(configBackupDir(file), `${basename(file)}.recovered`)

function parseObject(raw: string): Record<string, any> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

/** 唯一临时名 + 0600 + fsync + rename;rename 前核 mine()(同 lockedUpdateJson 的提交纪律)。
 *  rename 前 fsync 临时文件:断电后不会留下长度对、内容全 0 的 config.json(magpie #1505);同引擎 core/config.ts 的 writeAtomic。
 *  ponytail: 不 fsync 目录 —— 断电丢的是这次 rename,原位仍是上一份好的。 */
function writeAtomicSync(file: string, text: string, mine: () => boolean): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    const closing = fd; fd = undefined; closeSync(closing) // 先放手再关:close 报错时 catch 里不会再关一次(那个号可能已被别处复用)
    if (!mine()) throw new Error(`${file} 的写锁在持有期间被当作陈旧锁回收(进程被挂起超过 ${LOCK_STALE_MS / 1000}s?),放弃本次写入`)
    renameSync(tmp, file)
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就留着,别盖掉原始错误 */ }
    throw e
  }
}

/** 坏文件原样复制进备份目录(0600),返回留存路径;留不下就抛。
 *  Windows 文件名不许冒号;EXCL + 随机后缀:同一毫秒两次也不会盖掉前一份坏文件。 */
export function keepBadCopy(file: string): string {
  const bad = join(configBackupDir(file), `${basename(file)}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  mkdirSync(dirname(bad), { recursive: true })
  copyFileSync(file, bad, fsConstants.COPYFILE_EXCL)
  try { chmodSync(bad, 0o600) } catch { /* Windows 无此语义 */ }
  return bad
}

/** 锁内:.bak 有效 → 坏的复制留存、.bak 换回、记标记,返回恢复后的内容;否则 null 且什么都不动。
 *  先复制再 rename 换回:中途死掉原位仍是那份坏文件,下次再恢复,原位永远不会变成「不存在」。 */
function restoreFromBackup(file: string, mine: () => boolean): Record<string, any> | null {
  const bak = backupOf(file)
  let bakRaw: string
  let version: number
  try { bakRaw = readFileSync(bak, 'utf8'); version = statSync(bak).mtimeMs } catch { return null }
  const restored = parseObject(bakRaw)
  if (!restored) return null
  const bad = keepBadCopy(file)
  writeAtomicSync(file, bakRaw, mine)
  try {
    writeFileSync(recoveryMarkerOf(file), JSON.stringify({ at: Date.now(), version, bad: basename(bad) }), { encoding: 'utf8', mode: 0o600 })
  } catch { /* 只是提示用的标记,写不进去不影响恢复本身 */ }
  console.warn(`[config] ${basename(file)} 读到坏文件,已从备份恢复(坏文件留在 ${bad})`)
  return restored
}

/** 跨进程读改写一个 JSON 配置文件。抢锁时异步等(不堵主线程);抢到后整段同步 —— 持锁期间不让出事件循环,
 *  主进程被弹框冻住只会发生在两次任务之间,不会冻在持锁时、连带卡住同步写这份文件的引擎。
 *  mutate 恰好执行一次、必须同步;文件不存在给 {},坏 JSON / 非对象先从 .bak 恢复,恢复不了抛错(绝不拿空配置覆盖读不出的安全配置);
 *  返回 undefined = 不写。落盘同 writePrivateJson:唯一临时名 + 0600 + rename,换上前把旧的好文件存成 .bak。
 *  ponytail: 陈旧判定靠 mtime(墙钟),不查持锁 pid 是否存活;活锁被误偷时靠提交前核 token 兜住(见上),
 *  残余只剩核对到 rename 之间的微秒窗口。 */
export async function lockedUpdateJson(
  file: string,
  mutate: (cur: Record<string, any>) => Record<string, any> | undefined,
): Promise<void> {
  const lock = `${file}.lock`
  const token = `${process.pid}-${randomUUID()}`
  const deadline = performance.now() + LOCK_WAIT_MS // 单调时钟:墙钟回拨不拉长等待
  mkdirSync(dirname(file), { recursive: true })
  for (;;) {
    let fd: number
    try {
      fd = openSync(lock, 'wx')
    } catch (e) {
      if (!LOCK_BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      stealIfStale(lock)
      if (performance.now() > deadline) throw new Error(`${file} 的写锁被占超过 ${LOCK_WAIT_MS / 1000}s,放弃本次写入`)
      await new Promise((r) => setTimeout(r, 5))
      continue
    }
    try {
      writeSync(fd, token)
    } catch (e) { // 锁建出来了、token 没写进去(磁盘满):自己删掉,别留空锁让所有写者干等 5s
      try { closeSync(fd) } catch { /* ignore */ }
      rmSync(lock, { force: true })
      throw e
    }
    closeSync(fd)
    break
  }
  const mine = (): boolean => { try { return readFileSync(lock, 'utf8') === token } catch { return false } }
  try {
    let raw: string | null = null
    try { raw = readFileSync(file, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    let cur = raw === null ? {} : parseObject(raw)
    if (!cur) {
      cur = restoreFromBackup(file, mine)
      if (!cur) throw new Error(`Invalid ${file}: expected an object (no usable backup)`)
      raw = null // 恢复出来的就是 .bak,不再备份
    }
    const next = mutate(cur)
    if (next === undefined) return
    // 备份写不进去(盘满 / 备份目录没权限)就整次拒写:.bak 缺了或停在更旧的版本,下次读坏时救不回 / 救回更旧的
    if (raw !== null) writeAtomicSync(backupOf(file), raw, mine)
    writeAtomicSync(file, JSON.stringify(next, null, 2), mine)
  } finally {
    try { if (mine()) rmSync(lock, { force: true }) } catch { /* 删不掉(Windows 杀软占着)就留给 stale 回收 */ }
  }
}

/** 读一份锁写的 JSON 对象文件(config.json):不存在 → {};坏了先在锁内从 .bak 恢复(lockedUpdateJson 的读侧)再读,恢复不了抛。 */
export async function readJsonRecovering(file: string): Promise<Record<string, any>> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  const parsed = parseObject(raw)
  if (parsed) return parsed
  await lockedUpdateJson(file, () => undefined) // 恢复不了在这里抛(读失败不等于空)
  const again = parseObject(await readFile(file, 'utf8'))
  if (!again) throw new Error(`Invalid ${file}: expected an object`)
  return again
}

/** 设置页的「上次的设置文件损坏，已恢复」:读几份文件的恢复标记,取最近一次;没有 → null。 */
export async function readRecoveryNotice(files: string[]): Promise<{ at: number; version: number } | null> {
  let best: { at: number; version: number } | null = null
  for (const f of files) {
    try {
      const m = JSON.parse(await readFile(recoveryMarkerOf(f), 'utf8'))
      if (typeof m?.at === 'number' && typeof m?.version === 'number' && (!best || m.at > best.at)) best = { at: m.at, version: m.version }
    } catch { /* 没恢复过 */ }
  }
  return best
}

/** 点掉提示:删标记(坏文件与 .bak 都留着)。 */
export async function clearRecoveryNotice(files: string[]): Promise<void> {
  await Promise.all(files.map((f) => rm(recoveryMarkerOf(f), { force: true })))
}
