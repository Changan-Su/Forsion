/**
 * `.db`(多维表)的**跨进程**写锁 —— 桌面 main 侧这一半。
 *
 * 为什么需要:同一张表有两个进程在写 ——
 *   · 桌面 main 的 `db:write-cas`(读 → 比对内容哈希 → 写),
 *   · Tangu 引擎的自动化 DB 动作(`tangu-agent/src/services/amadeusDb.ts` 的 `mutateDb`)。
 * 两边各自的护栏都只在自己进程内成立:CAS 的「比对完」到「写下去」之间引擎 rename 一次,
 * 我们照抹不误;反过来我们写在引擎的读与 rename 之间,引擎也照抹我们。**比对交换不是跨进程原子的**,
 * 锁文件是两个进程唯一能共享的同步点。
 *
 * ⚠️ **这是引擎那份的镜像实现,两边必须逐字一致**(锁路径算法、陈旧超时、等待上限)。
 * 算出不同的锁路径 = 各锁各的 = 白锁,而且是静默失效,没有任何报错。改一处必须改另一处:
 *   引擎侧 `tangu-agent/src/services/amadeusDb.ts` 的 `lockPathFor` / `withDbLock`。
 * 不能抽成共享模块:两个是彼此独立的包,desktop 不 import 引擎源码(只在运行时动态 import 它的 dist)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000

/**
 * 锁文件路径:`<realpath(所在目录)>/.<文件名>.lock`。
 * · 点开头 —— watcher 的 ignored 里 `base.startsWith('.')` 直接滤掉,加解锁不会刷 vault 变更事件;
 *   同步侧另有 `isIgnoredName` 的 `.lock` 白名单,不会被当成用户文件传上云。
 * · 目录取 realpath —— 两个进程的 vault 根字符串未必逐字相同(一侧走软链就够了),
 *   落到同一个真实目录才能真的互斥。
 */
export async function dbLockPath(abs: string): Promise<string> {
  const dir = await fs.realpath(path.dirname(abs)).catch(() => path.dirname(abs))
  return path.join(dir, `.${path.basename(abs)}.lock`)
}

/**
 * 拿到锁再跑 `fn`,无论成败都释放。拿不到(等满 LOCK_WAIT_MS)抛错 —— 调用方按冲突处理即可,
 * 别默默写下去。
 *
 * ponytail: 建议锁(只约束走这两条路的写者);陈旧锁按 mtime 超时破除,否则持锁进程一崩,
 *   这张表就永久写不进去了。代价:原主还活着但被挂起超过 LOCK_STALE_MS 时会有两个持锁者。
 *   要根治得上 flock(2) 那类内核锁(node 无内建),这个规模不值得。
 */
export async function withDbLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const lock = await dbLockPath(abs)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx') // O_CREAT|O_EXCL:创建成功 = 拿到锁
      try {
        await fh.write(String(process.pid))
      } finally {
        await fh.close()
      }
      break
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      const st = await fs.stat(lock).catch(() => null)
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lock).catch(() => {}) // 陈旧锁:原主多半已死,破锁
      } else if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the write lock on ${path.basename(abs)} — another process is writing this table`)
      }
      // 每轮都要睡:破锁那条分支也走这里,否则争用时会退化成忙等。
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.unlink(lock).catch(() => {})
  }
}
