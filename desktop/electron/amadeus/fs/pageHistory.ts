/** 页面版本历史(评审 C-20):笔记的本地快照,存在**库外**(`tanguDataDir()/amadeus-history`),智库里一个字节都不写、不 git init。
 *
 *  取材:笔记的比对交换写(vaultHandlers 的 writeTextFile 带 base 那一支)在比对通过、落盘之前手里已经有盘上旧文 `cur` ——
 *  就拿它做快照,不额外读盘。同一篇按时间窗最多一份(缺省 5 分钟);与最近一份内容相同不存。写快照**绝不阻断或拖慢保存**:
 *  保存那边 fire-and-forget,本模块自己排队、出错只记日志。
 *
 *  布局:`<root>/<库标识>/<路径 hash>/{index.json, <id>.md}`。库标识 = 库根绝对路径的 hash(云镜像目录按账号分开,天然不串);
 *  路径 hash 按 `/` 归一后的库内相对路径算,index.json 记原路径(改名 / 移动由 move 搬目录、改记录)。
 *  每篇最多 N 份(缺省 50),全局容量上限(缺省 200MB):超了按**最久没写过的先走**(LRU,以快照时刻计)跨库淘汰。
 *
 *  落盘顺序是不变量:**加** = 先落快照文件、后写 index;**删** = 先写 index、后删文件 —— index 永远不指向不存在的文件
 *  (读者不排队也读不到半截)。index 损坏按空处理并记日志,不许让保存链抛。
 *
 *  恢复(restorePageHistory)在同篇写锁内:比对 base → 给现文**强制**补一份快照(只跳过时间窗,内容相同仍不存)→ 原子写回。
 *  补快照失败就中止恢复:保存路径的快照失败可以只记日志,恢复不行 —— 没留底就覆盖,那一版就真没了。 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { IPC, type PageHistoryEntry, type TextWriteResult } from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import type { VaultManager } from './vaultManager'
import type { VaultIndex } from './vaultIndex'
import { writeVaultText } from './pageWrite'

export const HISTORY_WINDOW_MS = 5 * 60_000
export const HISTORY_MAX_PER_FILE = 50
export const HISTORY_MAX_BYTES = 200 * 1024 * 1024

interface StoredEntry extends PageHistoryEntry {
  /** 内容 hash:判「与最近一份相同」用,不对外。 */
  hash: string
}
interface IndexFile {
  v: 1
  /** 原路径(库内相对,`/` 分隔)。 */
  path: string
  /** 旧 → 新。 */
  entries: StoredEntry[]
}

export interface PageHistoryOptions {
  /** 历史根目录。传函数:tanguDataDir() 要在 setDevMode 之后求值(dev 落 ~/.forsion-dev,别碰正式家目录)。 */
  root: () => string
  now?: () => number
  windowMs?: number
  maxPerFile?: number
  maxBytes?: number
  log?: (msg: string) => void
  /** 路径键按哪个平台的分隔符口径算(测试用;缺省 process.platform)。 */
  platform?: NodeJS.Platform
}

export interface PageHistory {
  /** 存一份快照。返回是否真存了(时间窗内 / 与最近一份相同 = false)。
   *  非 force:永不 reject(出错记日志、回 false),保存路径可以直接 `void`。force(恢复前补快照):跳过时间窗,出错照抛。 */
  snapshot(vaultRoot: string | null, rel: string, text: string, opts?: { force?: boolean }): Promise<boolean>
  /** 新 → 旧。 */
  list(vaultRoot: string | null, rel: string): Promise<PageHistoryEntry[]>
  read(vaultRoot: string | null, rel: string, id: string): Promise<string | null>
  /** 改名 / 移动:历史跟着走(目标已有历史 = 合并后按每篇上限截)。永不 reject。 */
  move(vaultRoot: string | null, pairs: Record<string, string>): Promise<void>
  /** 等排队中的写全部落定(测试用;保存路径不等它)。 */
  settle(): Promise<void>
}

const sha = (s: string): string => createHash('sha1').update(s).digest('hex')
/** 校验用:把 `\` 当分隔符看(拒 `a\..\b.md` 这类,宁严勿松)。**不**用来算历史的路径键 —— 见 createPageHistory 的 keyRel。 */
const normRel = (rel: string): string => rel.replace(/\\/g, '/')
/** id 只许 `[0-9a-z-]`:拼进文件名,带 `/` `\` `.` 的一律拒(防在历史目录里穿越)。 */
export const isHistoryId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-z]+-[0-9a-f]{8}(?:-\d+)?$/.test(id)

async function atomicWrite(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, file)
}
const unlinkQuiet = (file: string): Promise<void> => fs.unlink(file).catch((e: NodeJS.ErrnoException) => { if (e?.code !== 'ENOENT') throw e })

export function createPageHistory(opts: PageHistoryOptions): PageHistory {
  const now = opts.now ?? Date.now
  const windowMs = opts.windowMs ?? HISTORY_WINDOW_MS
  const maxPerFile = Math.max(1, opts.maxPerFile ?? HISTORY_MAX_PER_FILE)
  const maxBytes = opts.maxBytes ?? HISTORY_MAX_BYTES
  const log = opts.log ?? ((m: string) => console.warn(`[amadeus] 版本历史:${m}`))
  // 路径键:只在 Windows 上把 `\` 归一成 `/`(那边 listPages 出反斜杠,渲染层又常写正斜杠,是同一篇)。macOS / Linux 上
  // `\` 是合法文件名字符,根目录的 `a\b.md` 与 `a/b.md` 是两篇笔记,归一就会共用一份历史(Codex 复核 C-20 #4)。
  const win = (opts.platform ?? process.platform) === 'win32'
  const keyRel = (rel: string): string => (win ? rel.replace(/\\/g, '/') : rel)

  // 一切改动排成一条队(同步入队):同篇两次快照、快照 × 改名、淘汰扫描互不交错。读不入队(见顶注的落盘顺序);list 先等队空。
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }
  /** 全部快照的字节数;null = 还没扫过(首次需要时全量扫一遍,此后增量记)。 */
  let total: number | null = null

  const vaultDir = (vaultRoot: string): string => path.join(opts.root(), sha(path.resolve(vaultRoot)).slice(0, 16))
  const fileDir = (vaultRoot: string, rel: string): string => path.join(vaultDir(vaultRoot), sha(keyRel(rel)).slice(0, 16))

  async function readIndex(dir: string): Promise<IndexFile | null> {
    let raw: string
    try {
      raw = await fs.readFile(path.join(dir, 'index.json'), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') log(`读不了 ${dir}/index.json:${(e as Error)?.message}`)
      return null
    }
    try {
      const j = JSON.parse(raw) as Partial<IndexFile>
      if (typeof j.path !== 'string' || !Array.isArray(j.entries)) throw new Error('bad shape')
      const entries = j.entries.filter((x): x is StoredEntry =>
        !!x && isHistoryId(x.id) && Number.isFinite(x.at) && Number.isFinite(x.size) && typeof x.hash === 'string')
      return { v: 1, path: j.path, entries: entries.sort((a, b) => a.at - b.at) }
    } catch (e) {
      log(`${dir}/index.json 损坏,按空处理:${(e as Error)?.message}`)
      return null
    }
  }
  const writeIndex = (dir: string, idx: IndexFile): Promise<void> => atomicWrite(path.join(dir, 'index.json'), JSON.stringify(idx))

  /** 全部 index(跨库)。 */
  async function allIndexes(): Promise<Array<{ dir: string; idx: IndexFile }>> {
    const out: Array<{ dir: string; idx: IndexFile }> = []
    const root = opts.root()
    const vaults = await fs.readdir(root).catch(() => [] as string[])
    for (const v of vaults) {
      const files = await fs.readdir(path.join(root, v)).catch(() => [] as string[])
      for (const f of files) {
        const dir = path.join(root, v, f)
        const idx = await readIndex(dir)
        if (idx) out.push({ dir, idx })
      }
    }
    return out
  }
  const sumOf = (entries: StoredEntry[]): number => entries.reduce((n, e) => n + e.size, 0)

  /** 从 idx 里拿掉 drop 这几份:先写 index(空了就整目录删)、后删文件。返回释放的字节数。 */
  async function dropEntries(dir: string, idx: IndexFile, drop: StoredEntry[]): Promise<number> {
    if (!drop.length) return 0
    const gone = new Set(drop.map((e) => e.id))
    idx.entries = idx.entries.filter((e) => !gone.has(e.id))
    if (idx.entries.length) {
      await writeIndex(dir, idx)
      for (const e of drop) await unlinkQuiet(path.join(dir, `${e.id}.md`))
    } else {
      await fs.rm(dir, { recursive: true, force: true })
    }
    return sumOf(drop)
  }

  /** 全局容量:超了按快照时刻最旧的先走(跨库、跨篇),直到回到上限以内。keep = 本次刚写入的那份,**豁免**:
   *  恢复前补的那份要是被当场淘汰,恢复照样报成功、留底却没了(Codex 复核 C-20 #2)。单份就超上限时宁可暂时超额。 */
  async function enforceTotal(keep: { dir: string; id: string }): Promise<void> {
    if (total == null) total = sumOf((await allIndexes()).flatMap((x) => x.idx.entries))
    if (total <= maxBytes) return
    const all = await allIndexes()
    total = sumOf(all.flatMap((x) => x.idx.entries))
    const pool = all.flatMap(({ dir, idx }) => idx.entries.map((e) => ({ dir, idx, e })))
      .filter((x) => !(x.dir === keep.dir && x.e.id === keep.id))
      .sort((a, b) => a.e.at - b.e.at)
    const plan = new Map<string, { idx: IndexFile; drop: StoredEntry[] }>()
    let over = total - maxBytes
    for (const { dir, idx, e } of pool) {
      if (over <= 0) break
      const p = plan.get(dir) ?? { idx, drop: [] }
      p.drop.push(e)
      plan.set(dir, p)
      over -= e.size
    }
    for (const [dir, p] of plan) total -= await dropEntries(dir, p.idx, p.drop)
  }

  async function doSnapshot(vaultRoot: string, rel: string, text: string, force: boolean): Promise<boolean> {
    const dir = fileDir(vaultRoot, rel)
    const idx = (await readIndex(dir)) ?? { v: 1 as const, path: keyRel(rel), entries: [] }
    idx.path = keyRel(rel)
    const at = now()
    const hash = sha(text).slice(0, 16)
    const last = idx.entries[idx.entries.length - 1]
    if (last && last.hash === hash) return false // 与最近一份相同:不存(force 也一样 —— 现文已经在历史里了)
    if (!force && last && at >= last.at && at - last.at < windowMs) return false // 时间窗内已有一份
    let id = `${at.toString(36)}-${hash.slice(0, 8)}`
    for (let n = 2; idx.entries.some((e) => e.id === id); n++) id = `${at.toString(36)}-${hash.slice(0, 8)}-${n}`
    const size = Buffer.byteLength(text, 'utf8')
    await atomicWrite(path.join(dir, `${id}.md`), text) // 先落文件
    idx.entries.push({ id, at, size, hash })
    const extra = idx.entries.length > maxPerFile ? idx.entries.slice(0, idx.entries.length - maxPerFile) : []
    if (extra.length) {
      const freed = await dropEntries(dir, idx, extra) // 内部先写 index(已含新条目)
      if (total != null) total -= freed
    } else {
      await writeIndex(dir, idx) // 后写 index
    }
    if (total != null) total += size
    await enforceTotal({ dir, id })
    return true
  }

  async function doMove(vaultRoot: string, from: string, to: string): Promise<void> {
    const src = fileDir(vaultRoot, from)
    const dst = fileDir(vaultRoot, to)
    if (src === dst) return
    const sIdx = await readIndex(src)
    if (!sIdx) return
    const dIdx = await readIndex(dst)
    if (!dIdx) {
      await fs.rm(dst, { recursive: true, force: true }) // 残目录(index 坏 / 缺)不挡路
      await fs.rename(src, dst)
      await writeIndex(dst, { ...sIdx, path: keyRel(to) })
      return
    }
    // 目标位置已有历史(同名位置删过又建):合并,不覆盖。不丢版本的顺序(Codex 复核 C-20 #3):先把源快照**复制**过去 →
    // 写目标 index → 最后才删源目录。任一步中断,源 index 与源文件都原样在(最坏是目标里多几份没登记的副本 / 两边各一份),
    // 不会出现「文件已搬走、目标 index 没写成」两边都读不到的那一刻。
    const have = new Set(dIdx.entries.map((e) => e.id))
    const moved: StoredEntry[] = []
    for (const e of sIdx.entries) {
      if (have.has(e.id)) { if (total != null) total -= e.size; continue } // 同一份已在目标:源那份随源目录删掉
      try {
        await fs.copyFile(path.join(src, `${e.id}.md`), path.join(dst, `${e.id}.md`))
        moved.push(e)
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
        if (total != null) total -= e.size
      }
    }
    const merged: IndexFile = { v: 1, path: keyRel(to), entries: [...dIdx.entries, ...moved].sort((a, b) => a.at - b.at) }
    const extra = merged.entries.length > maxPerFile ? merged.entries.slice(0, merged.entries.length - maxPerFile) : []
    if (extra.length) {
      const freed = await dropEntries(dst, merged, extra)
      if (total != null) total -= freed
    } else {
      await writeIndex(dst, merged)
    }
    await fs.rm(src, { recursive: true, force: true })
  }

  return {
    snapshot(vaultRoot, rel, text, o) {
      const force = o?.force === true
      if (!vaultRoot) return force ? Promise.reject(new Error('No vault is open')) : Promise.resolve(false)
      const run = enqueue(() => doSnapshot(vaultRoot, rel, text, force))
      return force ? run : run.catch((e) => { log(`快照没存成(${rel}):${(e as Error)?.message}`); return false })
    },
    async list(vaultRoot, rel) {
      if (!vaultRoot) return []
      await chain // 刚打开面板时那一发冲洗保存的快照还在队里:等它落定再列,别少一份
      const idx = await readIndex(fileDir(vaultRoot, rel))
      return idx ? idx.entries.map(({ id, at, size }) => ({ id, at, size })).reverse() : []
    },
    async read(vaultRoot, rel, id) {
      if (!vaultRoot || !isHistoryId(id)) return null
      const dir = fileDir(vaultRoot, rel)
      const idx = await readIndex(dir)
      if (!idx?.entries.some((e) => e.id === id)) return null
      return fs.readFile(path.join(dir, `${id}.md`), 'utf8').catch(() => null)
    },
    move(vaultRoot, pairs) {
      if (!vaultRoot) return Promise.resolve()
      return enqueue(async () => {
        for (const [from, to] of Object.entries(pairs)) {
          try {
            await doMove(vaultRoot, from, to)
          } catch (e) {
            log(`改名后历史没跟上(${from} → ${to}):${(e as Error)?.message}`)
          }
        }
      })
    },
    settle: () => chain.then(() => {}),
  }
}

/** 渲染层传来的笔记路径:必须是字符串、库内相对、不带 `..` / `.` / 空段、是一篇笔记(插件文件类型 / 画板不算),
 *  并且 absPath 钳得住(越界即抛)。返回值只用于校验;落盘 / 加锁 / 回灌仍用调用方原样的路径(与 writeTextFile 同键)。 */
function assertNotePath(vault: VaultManager, rel: unknown): asserts rel is string {
  if (typeof rel !== 'string' || !rel) throw new Error('Invalid note path')
  const n = normRel(rel)
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error('Invalid note path')
  if (!vault.isPagePath(n)) throw new Error('Not a note')
  vault.absPath(n)
}

export interface PageHistoryHandlerDeps {
  vault: VaultManager
  index: VaultIndex
  history: PageHistory
  handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void
  withPathLock: <T>(rel: string, fn: () => Promise<T>) => Promise<T>
  notifyPeers?: (origin: unknown, channel: string, payload?: unknown) => void
}

/** 三条 IPC(registerVaultHandlers 在拿到 pageHistory 依赖时调)。经 ipc.ts 的 handle 注册 = 也进 /vault/rpc 派发表,
 *  但 unitWeb 的 VAULT_RPC_ALLOW 是 default-deny,远端设备调不到 —— 版本历史是本机的事。 */
export function registerPageHistoryHandlers(d: PageHistoryHandlerDeps): void {
  const { vault, index, history, handle, withPathLock } = d
  handle(IPC.listPageHistory, async (_e, pagePath: unknown) => {
    assertNotePath(vault, pagePath)
    return history.list(vault.getRoot(), pagePath)
  })
  handle(IPC.readPageHistory, async (_e, pagePath: unknown, id: unknown) => {
    assertNotePath(vault, pagePath)
    if (!isHistoryId(id)) throw new Error('Invalid version id')
    return history.read(vault.getRoot(), pagePath, id)
  })
  handle(IPC.restorePageHistory, async (e, pagePath: unknown, id: unknown, base: unknown): Promise<TextWriteResult> => {
    assertNotePath(vault, pagePath)
    if (!isHistoryId(id)) throw new Error('Invalid version id')
    if (typeof base !== 'string') throw new Error('Missing base')
    const root = vault.getRoot()
    if (!root) throw new Error('No vault is open')
    /** 盘上现文:同 writeTextFile 的 CAS,只有 ENOENT 算「不在」(null,不按旧路径重建);其余读错原样抛。 */
    const readCur = async (): Promise<string | null> => {
      try {
        return await fs.readFile(vault.absPath(pagePath), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err
        return null
      }
    }
    return withPathLock(pagePath, async () => {
      const cur = await readCur()
      if (cur == null) return { ok: false as const, current: null }
      if (textFingerprint(cur) !== base) return { ok: false as const, current: cur }
      const text = await history.read(root, pagePath, id)
      if (text == null) throw new Error('This version is no longer available')
      if (text === cur) return { ok: true as const }
      await history.snapshot(root, pagePath, cur, { force: true }) // 补不成 → 抛 → 不恢复(没留底就覆盖不可逆)
      // 读历史 + 补快照要排队落盘,期间外部程序(引擎 / 外部编辑器 / 云同步,都不在本进程的路径锁里)可能改了这篇:
      // 写回前**再比一次**,把窗口收窄到与普通 CAS 写同级(Codex 复核 C-20 #1)。对不上 = 不写,按 CAS 被拒交回现文。
      const again = await readCur()
      if (again == null) return { ok: false as const, current: null }
      if (textFingerprint(again) !== base) return { ok: false as const, current: again }
      await writeVaultText(vault, index, pagePath, text)
      if (e != null) d.notifyPeers?.(e, IPC.externalChange, pagePath) // 别的窗口开着这篇:同 writeTextFile 的跨窗回灌
      return { ok: true as const }
    })
  })
}
