/** 日历设置跟着账号走:「账号的同步库」(库键 `sync`)的设置以 human/Settings/calendar.db 为真源,本机 localStorage 只是镜像。
 *
 *  · 库键:只有账号自己的同步库进共享文件(resolveCalendarSettingsKey);别人共享给你的库、手机 /vault、单独运行的 Unit、
 *    没有 listVaults 的老主进程 → 留本机,行为和以前一样(不读不写共享文件)。算不出来(刚启动、账号还没到)= 不知道。
 *  · 写:store 的动作照旧同步改内存、写镜像;对 sync 库(或还不知道是不是)另把这次改动记成单项改动(set / del / setIfAbsent)。
 *    **一条改动一条记录**(localStorage 键 `amadeus.calendar.cfg.op.<账号>.<id>`):追加 = 新写一个键,ack = 删那个键,
 *    多个窗口同时追加 / ack 不会互相盖掉。写记录失败(配额满)的留在内存覆盖层里,照样重放,写进共享文件之前不被投影盖掉。
 *    落共享文件 = 重读最新那份 → 重放挂起改动 → 带票据写;409 拿带回的那份再重放再写(有上限)。**绝不整份覆盖。**
 *  · 一轮「读 → 重放 → 写 → ack → 记合过了 → 投影」绑定账号 + 库键 + 代次,每个 await 之后核对,变了整轮作废;
 *    并且按账号跨窗口串行(Web Locks;没有就退回进程内互斥,那种环境按单窗口假设),锁里重读「合过了」与队列、现算第一次合并的贡献。
 *    另记一张「本机最后一次写成的票据」:投影前发现别的窗口写过,丢掉这次读,重读。
 *  · 加载闸:共享那份没读到(loading / unknown / 接口不存在 / corrupt)时一个字都不写;界面照旧按本机那份,改动只排队。
 *  · 第一次合并(每个账号一次):共享那份读到(ok 或确认 missing)、本机已迁移且已播种之后,本机这份按 setIfAbsent 补进去 ——
 *    共享里已有的不覆盖。真的写成功 / 读到一份 ok 之后才在本机记「合过了」(确认没有、本机也没东西可补 = 还没合)。
 *  · 镜像的 owner:库键一算出是某个账号的同步库,没主的镜像当场打上这个账号(不等第一次读写成功);
 *    带着别的账号标记的那份不贡献给这个账号。
 *  · 留本机期间(关了同步 / 退出登录,库键变成留本机)、镜像 owner 是某个合过的账号:这段时间的改动记在那个账号名下,
 *    同一个账号回来时重放;别的账号认领这个库(投影)时丢掉。从没合过的库不记(非同步库不多写任何键)。
 *  · 之后:聚焦 + 定时重读,内存 = 共享那份 + 挂起改动 + 本机独有的不可移植项(`otherside:`、`ics://`)。
 *    同一个库同时只跑一轮,轮中再来的触发并成一次尾随;接口不存在 / 读失败时退避;远端(server)间隔放长。
 *
 *  已知不严密(这一期不解决):
 *  · 桌面的 listVaults().sync 只说明「新同步开着且绑在这个库上」,不检查笔记类是不是真的同步到所有设备共用
 *    (用户把笔记整类设成只备份这台电脑时会误判成 sync);
 *  · 顶层文件夹单独设成只在某台设备的,里面的表在别的端不存在,那些键在别的端留着不生效;
 *  · 库键还不知道、镜像也还没主时记下的改动只在内存里(落盘的话非同步库会多写键):这期间退出就只剩镜像里那份,
 *    第一次合并时照「只补」带上去。 */
import type { DbFile } from '@amadeus-shared/db/schema'
import { sha1Hex } from '@amadeus-shared/sha1'
import {
  applySettingOps, docToVaultCfg, emptySettingsDoc, mergeContribution, projectShared, sameSettings, vaultCfgEntries,
  type SettingOp, type VaultCfg,
} from './calendarSettingsDoc'
import type { SettingsRead, SettingsTransport } from './calendarSettingsIo'

export type SettingsKey = { kind: 'sync'; acct: string } | { kind: 'local' } | { kind: 'unknown' }

export interface SettingsStorage {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  /** 此刻全部键(按前缀列挂起改动用)。抛 = 列不出来 = 不知道。 */
  keys(): string[]
}

/** 跨窗口互斥:拿到锁才跑 fn,fn 结束放锁。 */
export type SettingsLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>

export interface SettingsSyncDeps {
  io: SettingsTransport
  /** null = 没有存储的环境(node 单测):挂起改动 / 「合过了」只活在内存里。 */
  storage: SettingsStorage | null
  resolveKey(root: string): Promise<SettingsKey>
  /** 内存里这个库此刻的设置。 */
  getVc(root: string): VaultCfg | undefined
  /** 把内存换成这一份并照写镜像(不再记改动)。 */
  applyVc(root: string, vc: VaultCfg): void
  /** 此刻登录的账号(同步拿):一轮里每个 await 之后都核对它,变了整轮作废。缺省不核(单测)。 */
  account?(): string | null
  /** 本机镜像这一程读得出来吗:读不出来(启动时内存是空的)= 不知道本机有什么,不做第一次合并、不记合过了。缺省可信。 */
  localTrusted?(): boolean
  /** 这个库在本次启动时本机有没有设置:没有 = 这台设备上这个库是新的,第一次合并不贡献
   *  (之后日历一打开就会按本机的表跑一遍迁移,那是「有日期列即入历」的推断,不是用户的选择,不拿去并进共享成员)。缺省 = 看此刻内存。 */
  hadLocalAtStart?(root: string): boolean
  /** 改动之后多久踢一次落盘;单测传一个不排队的,自己调 tick。 */
  schedule?(fn: () => void, ms: number): unknown
  /** 跨窗口锁。缺省:有 navigator.locks 用它,没有退回进程内互斥;null = 强制进程内互斥。 */
  lock?: SettingsLock | null
  /** 传输是不是远端(网页 / 手机打 server,或桌面外部模式):定时重读放慢。缺省 false(本机引擎)。 */
  remote?(): boolean
}

/** 旧的整份队列(这份代码发布前的形状):启动时迁成单条记录再删。 */
export const PENDING_KEY = 'amadeus.calendar.cfg.pending'
export const MERGED_KEY = 'amadeus.calendar.cfg.merged'
/** 单条改动:`<前缀><账号>.<id>`,值 = OpRecord 的 JSON。 */
export const OP_PREFIX = 'amadeus.calendar.cfg.op.'
/** 本机(任一窗口)最后一次写成共享文件的标记:`<前缀><账号>`。 */
export const SEEN_PREFIX = 'amadeus.calendar.cfg.seen.'
export const LOCK_PREFIX = 'amadeus.calendar.cfg.sync.'
/** 409 重放上限:每次都重读最新再重放,还撞说明有人在狂写,留在队列里等下一次。 */
export const MAX_CAS_RETRY = 3

/** 定时重读间隔。本机引擎不低于 15 秒;远端(server)不低于 60 秒。连续「不知道」(接口不存在 / 读失败)按档退避。 */
export const POLL_LOCAL_MS = 15_000
export const POLL_REMOTE_MS = 60_000
export const BACKOFF_LOCAL_MS = [15_000, 30_000, 120_000, 300_000]
export const BACKOFF_REMOTE_MS = [60_000, 120_000, 300_000]
/** 库键还算不出来(账号没到 / 库清单没刷完)时的追赶:这不发设置请求,只重算库键。 */
export const NOKEY_RETRY_MS = [3_000, 10_000, 30_000]

/** 一条挂起改动。 */
export interface OpRecord {
  v: 1
  id: string
  /** 记在谁名下。'' = 产生时账号不知道(只在内存里,见 limbo)。 */
  acct: string
  /** 产生它的库根;'' = 旧整份队列迁来的(没记库根),哪个库算出是这个账号的同步库就归哪个。 */
  root: string
  /** 产生顺序:时间 → 窗口 → 窗口内序号。 */
  ts: number
  win: string
  seq: number
  op: SettingOp
  /** 迁移推断出来的(「有日期列即入历」),不是用户的选择:新设备第一次合并时丢掉。 */
  inferred?: true
  /** 库键还不知道时记的:算出库键后认领(账号对得上)或丢。 */
  u?: true
  /** 留本机期间记的(D):同一个账号回来时重放;别的账号认领这个库时丢。 */
  l?: true
}

interface Live {
  acct: string
  /** 上一次读到的共享那份(ok 才有)。 */
  doc: DbFile | null
  read: SettingsRead['status'] | 'loading'
  /** 内存此刻是不是由共享那份投出来的(合过了且读到过)。 */
  shared: boolean
}

/** 一轮:绑定的账号 / 库 / 代次,以及进锁时看到的「本机最后写成」标记。 */
interface Round { root: string; acct: string; epoch: number; seen: string }

type CommitResult =
  | { t: 'done'; doc: DbFile }
  /** 对端确认没有、这边也没有东西可写:没建文件(不能记合过了)。 */
  | { t: 'empty' }
  /** 没写成(不知道 / 被拒 / 撞满上限 / 写闸):base = 最后一次见到的那份。 */
  | { t: 'failed'; base: SettingsRead }
  /** 账号 / 库键 / 代次变了,或别的窗口写过:整轮作废。 */
  | { t: 'aborted' }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const isSettingOp = (x: unknown): x is SettingOp =>
  isObj(x) && typeof x.k === 'string' && (x.t === 'del' || ((x.t === 'set' || x.t === 'setIfAbsent') && typeof x.v === 'string'))
const isRecord = (x: unknown): x is OpRecord =>
  isObj(x) && x.v === 1 && typeof x.id === 'string' && !!x.id && typeof x.acct === 'string' && typeof x.root === 'string' &&
  typeof x.ts === 'number' && typeof x.win === 'string' && typeof x.seq === 'number' && isSettingOp(x.op) &&
  (x.inferred === undefined || x.inferred === true) && (x.u === undefined || x.u === true) && (x.l === undefined || x.l === true)
const isLegacyQueue = (x: unknown): x is { acct: Record<string, Array<SettingOp & { id: string; inferred?: boolean }>> } =>
  isObj(x) && isObj(x.acct) &&
  Object.values(x.acct).every((l) => Array.isArray(l) && l.every((op) => isSettingOp(op) && typeof (op as { id?: unknown }).id === 'string'))
const isMerged = (x: unknown): x is Record<string, true> => isObj(x) && Object.values(x).every((v) => v === true)
/** 账号 id 进键名:点号也转义(前缀按 `.` 分段,账号里的点会串号)。 */
const encAcct = (a: string): string => encodeURIComponent(a).replace(/\./g, '%2E')
export const opKeyOf = (acct: string, id: string): string => `${OP_PREFIX}${encAcct(acct)}.${id}`
const seenKeyOf = (acct: string): string => `${SEEN_PREFIX}${encAcct(acct)}`
const byOrder = (a: OpRecord, b: OpRecord): number => a.ts - b.ts || (a.win < b.win ? -1 : a.win > b.win ? 1 : 0) || a.seq - b.seq
const stripFlags = (r: OpRecord, keep: { l?: boolean } = {}): OpRecord => {
  const { u: _u, l: _l, ...rest } = r
  return keep.l ? { ...rest, l: true } : rest
}

/** 本机这份要不要等:还没迁移 / 还没播种的先在本机跑完(否则没迁移的设备会丢隐式成员,没播种的会跳过播种)。 */
const localReady = (vc: VaultCfg): boolean => !!vc.migrated && !!vc.autoColors

/** 一份设置里能进共享文件的那些项,原样投成设置(去掉本机独有项)。 */
const portableOf = (vc: VaultCfg | undefined): VaultCfg =>
  docToVaultCfg(applySettingOps(emptySettingsDoc(), [...vaultCfgEntries(vc ?? { colors: {}, hidden: [], defaultDbPath: null, members: {} })].map(([k, v]) => ({ t: 'set' as const, k, v }))))

// ── 锁 ──
/** 进程内互斥(按名字排队)。没有 Web Locks 的环境用它:那种环境按单窗口假设 —— 同一份 localStorage 的别的窗口不受它管,
 *  只剩「本机最后写成」标记那一道(投影前发现别的窗口写过就丢掉这次读)。 */
const processQueues = new Map<string, Promise<void>>()
export const processLock: SettingsLock = (name, fn) => {
  const prev = processQueues.get(name) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => { release = r })
  const tail = prev.then(() => mine)
  processQueues.set(name, tail)
  return prev.then(async () => {
    try { return await fn() } finally {
      release()
      if (processQueues.get(name) === tail) processQueues.delete(name)
    }
  })
}
interface LockManagerLike { request(name: string, cb: () => Promise<unknown>): Promise<unknown> }
/** navigator.locks(同源各窗口共享);没有 / 调用就抛 → 进程内互斥。 */
export function defaultLock(): SettingsLock {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: LockManagerLike }) : undefined
  const locks = nav?.locks
  if (!locks || typeof locks.request !== 'function') return processLock
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    let p: Promise<unknown>
    try { p = locks.request(name, () => fn()) } catch { return processLock(name, fn) }
    return p as Promise<T>
  }
}

export function createCalendarSettingsSync(deps: SettingsSyncDeps) {
  const lock: SettingsLock = deps.lock === null ? processLock : deps.lock ?? defaultLock()
  const win = Math.random().toString(36).slice(2, 8) || 'w'
  const mem: { merged: Record<string, true>; seen: Map<string, string> } = { merged: {}, seen: new Map() }
  /** 本机存的挂起改动 / 「合过了」读不出来 = 不知道:这一程不写共享那份(不拿「读失败当成的空」去合并)。 */
  let blocked = false
  let seq = 0
  let lastTs = 0
  const keys = new Map<string, SettingsKey>()
  /** 落盘没成功的记录(配额满)、以及没有存储的环境里的全部记录:盖在盘上那份之上,ack 时一起删。 */
  const overlay = new Map<string, OpRecord>()
  /** 库键还不知道、镜像也还没主时记下的改动(只在内存):acct = 产生时登录的账号('' = 不知道)。 */
  const limbo: OpRecord[] = []
  const live = new Map<string, Live>()
  /** 同一个账号连续拒掉的那份内容(票据 + 内容的指纹):挂起内容或共享基线变了之前不再重试。 */
  const rejected = new Map<string, string>()
  /** 读的健康度:连续「不知道」几次(退避用)、上一轮是不是库键都没算出来。 */
  const health = { streak: 0, nokey: false }

  const block = (why: string): void => {
    if (!blocked) console.warn('[amadeus] 日历设置的同步状态读不出来,本次运行不写共享那份', why)
    blocked = true
  }

  // ── 「合过了」 ──
  const loadMerged = (): Record<string, true> => {
    if (!deps.storage) return mem.merged
    let raw: string | null
    try { raw = deps.storage.getItem(MERGED_KEY) } catch { block(MERGED_KEY); return {} }
    if (!raw) return {}
    try {
      const x = JSON.parse(raw)
      if (isMerged(x)) return x
    } catch { /* 下面 */ }
    block(MERGED_KEY)
    return {}
  }
  const mergedFor = (acct: string): boolean => !!loadMerged()[acct]
  const markMerged = (acct: string): void => {
    if (!deps.storage) { mem.merged = { ...mem.merged, [acct]: true }; return }
    const cur = loadMerged()
    if (blocked) return
    try { deps.storage.setItem(MERGED_KEY, JSON.stringify({ ...cur, [acct]: true })) } catch { /* 下次再记:第一次合并都是只补,重做无害 */ }
  }

  // ── 「本机最后写成」标记 ──
  const readSeen = (acct: string): string => {
    if (!deps.storage) return mem.seen.get(acct) ?? ''
    try { return deps.storage.getItem(seenKeyOf(acct)) ?? '' } catch { return '?' }
  }
  const bumpSeen = (acct: string): string => {
    const v = `${Date.now().toString(36)}-${win}-${(++seq).toString(36)}`
    if (!deps.storage) { mem.seen.set(acct, v); return v }
    try { deps.storage.setItem(seenKeyOf(acct), v) } catch { /* 写不进去:别的窗口看不到,靠锁 */ }
    return readSeen(acct)
  }

  // ── 单条记录 ──
  let legacyDone = false
  /** 旧整份队列 → 单条记录(id 沿用旧 op 的 id,两个窗口同时迁也是同一批键)。全部写成才删旧键;读不出来不动、不写共享。 */
  function migrateLegacy(): void {
    if (legacyDone || !deps.storage) return
    legacyDone = true
    let raw: string | null
    try { raw = deps.storage.getItem(PENDING_KEY) } catch { block(PENDING_KEY); return }
    if (!raw) return
    let x: unknown
    try { x = JSON.parse(raw) } catch { block(PENDING_KEY); return }
    if (!isLegacyQueue(x)) { block(PENDING_KEY); return }
    let ok = true
    for (const [acct, list] of Object.entries(x.acct)) {
      list.forEach((o, i) => {
        const op: SettingOp = o.t === 'del' ? { t: 'del', k: o.k } : { t: o.t, k: o.k, v: (o as { v: string }).v }
        const rec: OpRecord = { v: 1, id: `legacy-${o.id}`, acct, root: '', ts: 0, win: '', seq: i, op, ...(o.inferred ? { inferred: true as const } : {}) }
        try { deps.storage!.setItem(opKeyOf(acct, rec.id), JSON.stringify(rec)) } catch { ok = false }
      })
    }
    if (ok) { try { deps.storage.removeItem(PENDING_KEY) } catch { /* 下次启动再迁一遍,同一批键,幂等 */ } }
    else legacyDone = false
  }

  /** 全部记录(盘上 + 覆盖层,覆盖层优先),按产生顺序。某条读不出来 = 不知道:写闸关上,那条不参与。 */
  function listAll(): OpRecord[] {
    migrateLegacy()
    const out = new Map<string, OpRecord>()
    if (deps.storage) {
      let ks: string[] = []
      try { ks = deps.storage.keys() } catch { block('keys') }
      for (const k of ks) {
        if (!k.startsWith(OP_PREFIX)) continue
        let raw: string | null
        try { raw = deps.storage.getItem(k) } catch { block(k); continue }
        if (raw === null) continue // 别的窗口刚 ack 掉
        let x: unknown
        try { x = JSON.parse(raw) } catch { block(k); continue }
        if (!isRecord(x) || opKeyOf(x.acct, x.id) !== k) { block(k); continue }
        out.set(x.id, x)
      }
    }
    for (const r of overlay.values()) out.set(r.id, r)
    return [...out.values()].sort(byOrder)
  }
  const put = (r: OpRecord): void => {
    if (!deps.storage) { overlay.set(r.id, r); return }
    try { deps.storage.setItem(opKeyOf(r.acct, r.id), JSON.stringify(r)); overlay.delete(r.id) } catch { overlay.set(r.id, r) }
  }
  const remove = (r: OpRecord): void => {
    overlay.delete(r.id)
    if (!deps.storage) return
    try { deps.storage.removeItem(opKeyOf(r.acct, r.id)) } catch { /* 删不掉:下次再重放一遍,改动幂等 */ }
  }
  const sameBucket = (a: OpRecord, b: OpRecord): boolean => a.acct === b.acct && a.root === b.root && !!a.u === !!b.u && !!a.l === !!b.l
  /** 追加一批。set / del 完全决定这一项:同一桶里同一项更早的记录删掉(不让留本机期 / 未登录期的记录无界增长)。 */
  function append(list: OpRecord[]): void {
    if (!list.length) return
    const all = listAll()
    for (const r of list) {
      if (r.op.t === 'setIfAbsent') continue
      for (const old of all) if (old.op.k === r.op.k && sameBucket(old, r) && byOrder(old, r) < 0) remove(old)
    }
    for (const r of list) put(r)
  }
  const mint = (acct: string, root: string, op: SettingOp, flags: { inferred?: boolean; u?: boolean; l?: boolean }): OpRecord => {
    const ts = Math.max(Date.now(), lastTs)
    lastTs = ts
    const s = ++seq
    return {
      v: 1, id: `${ts.toString(36)}-${win}-${s.toString(36)}`, acct, root, ts, win, seq: s, op,
      ...(flags.inferred ? { inferred: true as const } : {}), ...(flags.u ? { u: true as const } : {}), ...(flags.l ? { l: true as const } : {}),
    }
  }
  /** 这个账号在这个库上要重放的(不含还没认领的 u)。 */
  const pendingFor = (acct: string, root: string): OpRecord[] =>
    listAll().filter((r) => r.acct === acct && !r.u && (r.root === '' || r.root === root))

  // ── 账号代次 ──
  let epoch = 0
  let lastAcct: string | null | undefined
  const observe = (): string | null | undefined => {
    if (!deps.account) return undefined
    const a = deps.account()
    if (a !== lastAcct) { lastAcct = a; epoch++ }
    return a
  }
  /** 这一轮还算数:登录的账号没变(也没在两次核对之间变过)、库键还是这个账号的同步库。 */
  const alive = (c: Round): boolean => {
    if (deps.account && observe() !== c.acct) return false
    if (c.epoch !== epoch) return false
    const k = keys.get(c.root)
    return k?.kind === 'sync' && k.acct === c.acct
  }
  /** 还算数,且这一轮之外没有别的窗口写过共享文件(不拿可能过时的读去投影 / 写 / ack)。 */
  const still = (c: Round): boolean => alive(c) && readSeen(c.acct) === c.seen

  const kick = (root: string, ms = 300): void => {
    const run = (): void => { void tick(root) }
    if (deps.schedule) deps.schedule(run, ms)
    else setTimeout(run, ms)
  }

  const claimable = (root: string, acct: string): boolean => !listAll().some((r) => r.root === root && r.acct !== acct && (r.u || r.l))
  /** 没主的镜像打上账号(不新建条目、镜像不可信时不打)。 */
  function stamp(root: string, acct: string): void {
    if (deps.localTrusted && !deps.localTrusted()) return
    const local = deps.getVc(root)
    if (!local || local.owner) return
    deps.applyVc(root, { ...local, owner: acct })
  }

  /** store 的写动作调:前后两份 → 单项改动。留本机且从没合过的库什么都不做(和改动前一样,不写任何键)。 */
  function record(root: string, ops: SettingOp[], opts: { inferred?: boolean } = {}): void {
    if (!root || !ops.length) return
    const key = keys.get(root)
    const owner = deps.getVc(root)?.owner
    const inferred = !!opts.inferred
    if (key?.kind === 'local') {
      // D:这个库合过、镜像归某个账号 → 记在那个账号名下,等它回来;否则和以前一样
      if (owner && mergedFor(owner)) append(ops.map((op) => mint(owner, root, op, { inferred, l: true })))
      return
    }
    const now = deps.account ? observe() ?? null : key?.kind === 'sync' ? key.acct : null
    if (key?.kind === 'sync' && now === key.acct) {
      append(ops.map((op) => mint(key.acct, root, op, { inferred }))) // 内存已经由动作本身改好了
    } else {
      // 库键还没算出来(或缓存的库键是上一个账号的):带上产生它时的账号。镜像有主 = 这是个同步过的库,落盘(跨重启不丢);
      // 镜像没主(可能是从没同步的库)只记在内存里 —— 留本机的库不该因为这一步多写任何键。
      const origin = now ?? owner ?? null
      if (owner && origin) append(ops.map((op) => mint(origin, root, op, { inferred, u: true })))
      else for (const op of ops) limbo.push(mint(origin ?? '', root, op, { inferred, u: true }))
    }
    kick(root)
  }

  /** 库键算出来了:还没认领的改动按产生时的账号认领或丢。acct = null 表示算出是留本机。 */
  function settleUnresolved(root: string, acct: string | null): void {
    const local = deps.getVc(root)
    const unowned = !!local && !local.owner && (!deps.localTrusted || deps.localTrusted())
    // 内存里的(镜像当时没主)
    for (let i = limbo.length - 1; i >= 0; i--) {
      const r = limbo[i]
      if (r.root !== root) continue
      limbo.splice(i, 1)
      if (!acct) continue // 留本机:改动已经在镜像里
      if (r.acct === acct || (!r.acct && unowned && claimable(root, acct))) append([stripFlags({ ...r, acct })])
      else if (r.acct && r.acct !== acct && unowned) {
        // 别的账号在这份没主的镜像上改过:镜像归它,不当成「升级前的老数据」给这个账号
        const v = deps.getVc(root)
        if (v && !v.owner) deps.applyVc(root, { ...v, owner: r.acct })
      }
    }
    // 盘上的(镜像当时有主)
    for (const r of listAll()) {
      if (!r.u || r.root !== root) continue
      if (acct) {
        if (r.acct === acct) put(stripFlags(r))
        else remove(r) // 对不上账号就丢:绝不写进另一个账号
      } else if (r.acct && deps.getVc(root)?.owner === r.acct && mergedFor(r.acct)) put(stripFlags(r, { l: true })) // 留本机 + 合过:按 D 留着
      else remove(r)
    }
  }

  /** 内存 = 共享那份 + 挂起改动 + 本机独有的不可移植项。只在持锁的那一轮、核对过之后调。 */
  function project(c: Round, doc: DbFile): void {
    const l = live.get(c.root)
    if (!l || l.acct !== c.acct) return
    l.doc = doc
    l.shared = true
    // D:别的账号在这个库留本机期间记的改动,这个库现在归这个账号了 → 丢(不留着日后拿旧手势盖那个账号更新的值)
    for (const r of listAll()) if (r.l && r.root === c.root && r.acct !== c.acct) remove(r)
    const local = deps.getVc(c.root)
    const shared = docToVaultCfg(applySettingOps(doc, pendingFor(c.acct, c.root).map((r) => r.op)))
    const next = projectShared(shared, local, c.acct)
    if (JSON.stringify(next) !== JSON.stringify(local)) deps.applyVc(c.root, next)
  }

  /** 带票据写;409 换成带回的那份再重放。extra 每次现算(锁里、拿最新的本机那份)。 */
  async function commit(c: Round, base: SettingsRead, extra: () => SettingOp[]): Promise<CommitResult> {
    for (let attempt = 0; attempt <= MAX_CAS_RETRY; attempt++) {
      if (base.status !== 'ok' && base.status !== 'missing') return { t: 'failed', base }
      if (!still(c)) return { t: 'aborted' }
      const queued = pendingFor(c.acct, c.root) // 每一轮都重读:写的时候用户又改了的也带上
      const ops: SettingOp[] = [...extra(), ...queued.map((r) => r.op)]
      const from = base.status === 'ok' ? base.data : emptySettingsDoc()
      const next = applySettingOps(from, ops)
      if (base.status === 'ok' && sameSettings(next, from)) { for (const r of queued) remove(r); return { t: 'done', doc: from } }
      if (base.status === 'missing' && !ops.length) return { t: 'empty' } // 两边都没有东西:不建空文件
      if (blocked) return { t: 'failed', base }
      const print = sha1Hex(`${base.status === 'ok' ? base.version : '-'}\n${JSON.stringify(next)}`)
      if (rejected.get(c.acct) === print) return { t: 'failed', base } // 同一份内容对同一个基线被拒过:不再撞
      const w = await deps.io.write(next, base.status === 'ok' ? base.version : null)
      if (w.status === 'ok') {
        const mine = bumpSeen(c.acct)
        if (!alive(c)) return { t: 'aborted' }
        c.seen = mine
        rejected.delete(c.acct)
        for (const r of queued) remove(r)
        return { t: 'done', doc: next }
      }
      if (!alive(c)) return { t: 'aborted' }
      if (w.status === 'rejected') { rejected.set(c.acct, print); return { t: 'failed', base } }
      if (w.status !== 'conflict') return { t: 'failed', base } // 不知道写没写进去:改动留着,下次重读再重放(都幂等)
      base = w.current
    }
    return { t: 'failed', base }
  }

  async function locked(c: Round): Promise<void> {
    if (!alive(c) || blocked) return
    const { root, acct } = c
    c.seen = readSeen(acct)
    let l = live.get(root)
    if (!l || l.acct !== acct) { l = { acct, doc: null, read: 'loading', shared: false }; live.set(root, l) }
    const r = await deps.io.read()
    if (!alive(c)) return
    health.nokey = false
    health.streak = r.status === 'unknown' ? health.streak + 1 : 0
    l.read = r.status
    if (r.status !== 'ok' && r.status !== 'missing') return // corrupt / unknown:不写、不记合过了;内存照旧
    if (!still(c)) { kick(root); return } // 读的时候别的窗口写过:这份可能旧了,重读
    const trusted = deps.localTrusted ? deps.localTrusted() : true
    const mineNow = (): VaultCfg | undefined => {
      const local = deps.getVc(root)
      return local && (local.owner === acct || (!local.owner && claimable(root, acct))) ? local : undefined // 别的账号的那份不带进来
    }
    if (!mergedFor(acct)) { // 锁里重读:别的窗口可能刚合完
      if (!trusted) return // 本机镜像读不出来:不知道本机有什么,不合、不记
      const fresh = deps.hadLocalAtStart ? !deps.hadLocalAtStart(root) : !deps.getVc(root)
      if (fresh) {
        // 这台设备上这个库是新的:不贡献,也不等迁移 / 播种;迁移推断出来的那几条(日历比共享那份先打开时会有)也丢掉 ——
        // 不管谁先到,结果一样。用户在这期间的手势、插件 ensureMember、定色照常带上。
        for (const x of pendingFor(acct, root)) if (x.inferred) remove(x)
      } else {
        const mine = mineNow()
        if (mine && !localReady(mine)) return // 先在本机把迁移 / 播种跑完(迁移、定色动作会再踢一次)
      }
      const contribution = (): SettingOp[] => {
        if (fresh || mergedFor(acct)) return []
        const mine = mineNow()
        return mine ? mergeContribution(mine) : []
      }
      const res = await commit(c, r, contribution)
      if (res.t === 'aborted') { kick(root); return }
      if (res.t !== 'done') return // empty:确认没有、也没东西可补 → 还没合,等第一次真写成或读到 ok
      if (!still(c)) return
      markMerged(acct)
      project(c, res.doc)
      return
    }
    if (r.status === 'missing') {
      // 合过之后共享那份不见了(文件被删 / 被隔离 / 引擎换了家目录):**不拿空的去盖内存**。用本账号这份镜像按「只补」重建;
      // 镜像不可信(读不出来 / 属于别的账号)就什么都不动,等下一次。
      if (!trusted || !mineNow()) return
      const res = await commit(c, r, () => { const m = mineNow(); return m ? mergeContribution(m) : [] })
      if (res.t === 'aborted') { kick(root); return }
      if (res.t !== 'done' || !still(c)) return
      project(c, res.doc)
      return
    }
    const res = await commit(c, r, () => [])
    if (res.t === 'aborted') { kick(root); return }
    if (!still(c)) return
    const doc = res.t === 'done' ? res.doc : res.t === 'failed' && res.base.status === 'ok' ? res.base.data : null
    if (doc) project(c, doc)
  }

  async function tickInner(root: string): Promise<void> {
    const key = await deps.resolveKey(root)
    keys.set(root, key)
    if (key.kind === 'unknown') { health.nokey = true; return }
    health.nokey = false
    if (key.kind === 'local') { settleUnresolved(root, null); live.delete(root); return }
    const acct = key.acct
    if (deps.account && observe() !== acct) return // 库键是上一个账号时算的
    settleUnresolved(root, acct)
    if (claimable(root, acct)) stamp(root, acct) // 账号一确定就打上(不等第一次读写成功)
    const c: Round = { root, acct, epoch, seen: '' }
    await lock(`${LOCK_PREFIX}${encAcct(acct)}`, () => locked(c))
  }

  // ── 单飞 + 尾随 ──
  type Reason = 'poll' | 'change'
  interface Flight { trail: Reason | null; done: Promise<void> }
  const flights = new Map<string, Flight>()
  let users = 0
  /** 同一个库同时只跑一轮;跑着的时候又来的并成一次尾随(change 优先于 poll)。返回的 promise 等尾随那轮也跑完。
   *  没人看日历了:纯轮询触发的尾随取消(有挂起改动的那一轮由 change 触发,照跑)。 */
  function tick(root: string, reason: Reason = 'change'): Promise<void> {
    if (!root) return Promise.resolve()
    const f = flights.get(root)
    if (f) {
      if (f.trail !== 'change') f.trail = reason
      return f.done
    }
    const fl: Flight = { trail: null, done: Promise.resolve() }
    flights.set(root, fl)
    fl.done = (async () => {
      let next: Reason | null = reason
      while (next) {
        fl.trail = null
        try { await tickInner(root) } catch (e) { console.warn('[amadeus] 日历设置同步失败', e) }
        next = fl.trail
        if (next === 'poll' && users === 0) next = null
      }
      flights.delete(root)
    })()
    return fl.done
  }

  // ── 定时重读:有人在看日历(acquire)时才跑 ──
  let stop: (() => void) | null = null
  const roots = new Set<() => string | null>()
  const nextDelay = (nokeyRuns: number): number => {
    const remote = deps.remote ? deps.remote() : false
    if (health.streak > 0) {
      const ladder = remote ? BACKOFF_REMOTE_MS : BACKOFF_LOCAL_MS
      return ladder[Math.min(health.streak - 1, ladder.length - 1)]
    }
    if (health.nokey && nokeyRuns < NOKEY_RETRY_MS.length) return NOKEY_RETRY_MS[nokeyRuns]
    return remote ? POLL_REMOTE_MS : POLL_LOCAL_MS
  }
  function start(): () => void {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let nokeyRuns = 0
    const runAll = (): Promise<unknown> =>
      Promise.all([...new Set([...roots].map((f) => f()))].filter((r): r is string => !!r).map((r) => tick(r, 'poll')))
    const loop = async (first: boolean): Promise<void> => {
      timer = undefined
      if (stopped) return
      if (first || typeof document === 'undefined' || document.visibilityState !== 'hidden') await runAll()
      if (stopped) return
      const d = nextDelay(nokeyRuns)
      nokeyRuns = health.nokey ? nokeyRuns + 1 : 0
      timer = setTimeout(() => { void loop(false) }, d)
    }
    void loop(true)
    const onFocus = (): void => { void runAll() } // 聚焦:立即试一次(不打乱定时)
    const hasWin = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
    if (hasWin) window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      if (hasWin) window.removeEventListener('focus', onFocus)
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    record,
    tick: (root: string): Promise<void> => tick(root, 'change'),
    /** 有人在看日历:起定时重读(多处共用,最后一个释放时停;释放函数只生效一次)。currentRoot = 此刻打开的库。 */
    acquire(currentRoot: () => string | null): () => void {
      roots.add(currentRoot)
      if (++users === 1) stop = start()
      else { const r = currentRoot(); if (r) void tick(r, 'poll') }
      let released = false
      return () => {
        if (released) return
        released = true
        roots.delete(currentRoot)
        if (--users === 0) { stop?.(); stop = null }
      }
    },
    /** 这个库此刻的内存是不是由共享那份投出来的:是的话本机镜像只写不读(别的窗口写的镜像不拿来盖它)。 */
    isShared: (root: string): boolean => !!live.get(root)?.shared,
    /** 别的窗口写了镜像:对随账号走的库,可移植项保持此刻内存里的(不拿上一次读到的旧共享那份重投,也不收镜像里可能更旧的),
     *  只把镜像里的本机独有项叠进来,再去重读(重读在锁里,读到的才投影)。 */
    onMirrorChanged(root: string, mirror: VaultCfg | undefined): void {
      const l = live.get(root)
      if (!l?.shared) return
      const cur = deps.getVc(root)
      const next = projectShared(portableOf(cur), mirror, l.acct)
      if (JSON.stringify(next) !== JSON.stringify(cur)) deps.applyVc(root, next)
      kick(root, 0)
    },
    /** 单测 / 诊断用。 */
    debugState: (root: string) => ({ key: keys.get(root), live: live.get(root), blocked, health: { ...health }, overlay: overlay.size, limbo: limbo.length }),
  }
}

export type CalendarSettingsSync = ReturnType<typeof createCalendarSettingsSync>
