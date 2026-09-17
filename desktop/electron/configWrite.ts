import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
 *  ponytail: 不 fsync —— 断电瞬间那次写可能留下空文件,与原 writeHomeConfig 同;要防就照 hostTextWrite 加 sync。 */
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

/** 跨进程读改写一个 JSON 配置文件。抢锁时异步等(不堵主线程);抢到后整段同步 —— 持锁期间不让出事件循环,
 *  主进程被弹框冻住只会发生在两次任务之间,不会冻在持锁时、连带卡住同步写这份文件的引擎。
 *  mutate 恰好执行一次、必须同步;文件不存在给 {},坏 JSON / 非对象抛错(绝不拿空配置覆盖读不出的安全配置);
 *  返回 undefined = 不写。落盘同 writePrivateJson:唯一临时名 + 0600 + rename。
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
    const cur = raw === null ? {} : JSON.parse(raw)
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error(`Invalid ${file}: expected an object`)
    const next = mutate(cur)
    if (next === undefined) return
    const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
      if (!mine()) throw new Error(`${file} 的写锁在持有期间被当作陈旧锁回收(进程被挂起超过 ${LOCK_STALE_MS / 1000}s?),放弃本次写入`)
      renameSync(tmp, file)
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch { /* 清不掉就留着,别盖掉原始错误 */ }
      throw e
    }
  } finally {
    try { if (mine()) rmSync(lock, { force: true }) } catch { /* 删不掉(Windows 杀软占着)就留给 stale 回收 */ }
  }
}
