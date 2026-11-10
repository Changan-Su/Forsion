/** 日历设置跟着账号走:「账号的同步库」(库键 `sync`)的设置以 human/Settings/calendar.db 为真源,本机 localStorage 只是镜像。
 *
 *  · 库键:只有账号自己的同步库进共享文件(resolveCalendarSettingsKey);别人共享给你的库、手机 /vault、单独运行的 Unit、
 *    没有 listVaults 的老主进程 → 留本机,行为和以前一字不差(这里一个调用都不进)。算不出来(刚启动、账号还没到)= 不知道。
 *  · 写:store 的动作照旧同步改内存、写镜像;对 sync 库(或还不知道是不是)另把这次改动记成单项改动(set / del / setIfAbsent),
 *    进挂起队列(按账号存 localStorage,跨重启不丢)。落共享文件 = 重读最新那份 → 重放挂起改动 → 带票据写;409 拿带回的那份
 *    再重放再写(有上限)。**绝不整份覆盖。**
 *  · 加载闸:共享那份没读到(loading / unknown / 接口不存在 / corrupt)时一个字都不写;界面照旧按本机那份,改动只排队。
 *  · 第一次合并(每个账号一次):共享那份读到(ok 或确认 missing)、本机已迁移且已播种之后,本机这份按 setIfAbsent 补进去 ——
 *    共享里已有的不覆盖。写成功之后才在本机记「合过了」。换账号:镜像上带着别的账号标记的那份不贡献。
 *  · 之后:聚焦 + 定时重读,内存 = 共享那份 + 挂起改动 + 本机独有的不可移植项(`otherside:`、`ics://`)。
 *
 *  已知不严密(这一期不解决):
 *  · 桌面的 listVaults().sync 只说明「新同步开着且绑在这个库上」,不检查笔记类是不是真的同步到所有设备共用
 *    (用户把笔记整类设成只备份这台电脑时会误判成 sync);
 *  · 顶层文件夹单独设成只在某台设备的,里面的表在别的端不存在,那些键在别的端留着不生效。 */
import type { DbFile } from '@amadeus-shared/db/schema'
import {
  applySettingOps, docToVaultCfg, emptySettingsDoc, mergeContribution, projectShared, sameSettings,
  type SettingOp, type VaultCfg,
} from './calendarSettingsDoc'
import type { SettingsRead, SettingsTransport } from './calendarSettingsIo'

export type SettingsKey = { kind: 'sync'; acct: string } | { kind: 'local' } | { kind: 'unknown' }

export interface SettingsStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface SettingsSyncDeps {
  io: SettingsTransport
  /** null = 没有存储的环境(node 单测):挂起队列 / 「合过了」只活在内存里。 */
  storage: SettingsStorage | null
  resolveKey(root: string): Promise<SettingsKey>
  /** 内存里这个库此刻的设置。 */
  getVc(root: string): VaultCfg | undefined
  /** 把内存换成这一份并照写镜像(不再记改动)。 */
  applyVc(root: string, vc: VaultCfg): void
  /** 改动之后多久踢一次落盘;单测传一个不排队的,自己调 tick。 */
  schedule?(fn: () => void, ms: number): unknown
}

export const PENDING_KEY = 'amadeus.calendar.cfg.pending'
export const MERGED_KEY = 'amadeus.calendar.cfg.merged'
/** 409 重放上限:每次都重读最新再重放,还撞说明有人在狂写,留在队列里等下一次。 */
export const MAX_CAS_RETRY = 3

type PendingOp = SettingOp & { id: string }
interface Persisted { acct: Record<string, PendingOp[]> }
interface Live {
  acct: string
  /** 上一次读到的共享那份(ok 才有)。 */
  doc: DbFile | null
  read: SettingsRead['status'] | 'loading'
  /** 内存此刻是不是由共享那份投出来的(合过了且读到过)。 */
  shared: boolean
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const isOp = (x: unknown): x is PendingOp =>
  isObj(x) && typeof x.id === 'string' && typeof x.k === 'string' &&
  (x.t === 'del' || ((x.t === 'set' || x.t === 'setIfAbsent') && typeof x.v === 'string'))

/** 本机这份要不要等:还没迁移 / 还没播种的先在本机跑完(否则没迁移的设备会丢隐式成员,没播种的会跳过播种)。 */
const localReady = (vc: VaultCfg): boolean => !!vc.migrated && !!vc.autoColors

export function createCalendarSettingsSync(deps: SettingsSyncDeps) {
  const mem: { persisted: Persisted; merged: Record<string, true> } = { persisted: { acct: {} }, merged: {} }
  /** 本机存的挂起队列 / 「合过了」读不出来 = 不知道:这一程不写共享那份(不拿「读失败当成的空」去合并)。 */
  let blocked = false
  let seq = 0
  const keys = new Map<string, SettingsKey>()
  const limbo = new Map<string, PendingOp[]>()
  const live = new Map<string, Live>()
  const inFlight = new Map<string, Promise<void>>()

  // ── 本机存的两份小状态(挂起队列、合过了) ──
  const load = <T>(key: string, fallback: T, ok: (x: unknown) => x is T): T => {
    if (!deps.storage) return fallback
    let raw: string | null
    try { raw = deps.storage.getItem(key) } catch { blocked = true; return fallback }
    if (!raw) return fallback
    try {
      const x = JSON.parse(raw)
      if (ok(x)) return x
    } catch { /* 下面 */ }
    blocked = true
    console.warn('[amadeus] 日历设置的同步状态读不出来,本次运行不写共享那份', key)
    return fallback
  }
  const save = (key: string, v: unknown): void => {
    if (!deps.storage || blocked) return
    try { deps.storage.setItem(key, JSON.stringify(v)) } catch { /* 配额满:内存里那份照用 */ }
  }
  const isPersisted = (x: unknown): x is Persisted =>
    isObj(x) && isObj(x.acct) && Object.values(x.acct).every((l) => Array.isArray(l) && l.every(isOp))
  const isMerged = (x: unknown): x is Record<string, true> => isObj(x) && Object.values(x).every((v) => v === true)
  /** 每次都从盘上重读:别的窗口(同一份 localStorage)也在往队列里加、也在 ack。 */
  const readPersisted = (): Persisted => (deps.storage ? load(PENDING_KEY, { acct: {} }, isPersisted) : mem.persisted)
  const writePersisted = (p: Persisted): void => { if (deps.storage) save(PENDING_KEY, p); else mem.persisted = p }
  const mergedFor = (acct: string): boolean => (deps.storage ? !!load(MERGED_KEY, {}, isMerged)[acct] : !!mem.merged[acct])
  const markMerged = (acct: string): void => {
    if (!deps.storage) { mem.merged = { ...mem.merged, [acct]: true }; return }
    const cur = load(MERGED_KEY, {}, isMerged)
    if (!blocked) save(MERGED_KEY, { ...cur, [acct]: true })
  }
  const pendingOf = (acct: string): PendingOp[] => readPersisted().acct[acct] ?? []
  const nextId = (): string => `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  const kick = (root: string, ms = 300): void => {
    const run = (): void => { void tick(root) }
    if (deps.schedule) deps.schedule(run, ms)
    else setTimeout(run, ms)
  }

  /** store 的写动作调:前后两份 → 单项改动进队列。留本机的库什么都不做。 */
  function record(root: string, ops: SettingOp[]): void {
    if (!root || !ops.length) return
    const key = keys.get(root)
    if (key?.kind === 'local') return
    const withIds = ops.map((op) => ({ ...op, id: nextId() }))
    if (key?.kind === 'sync') {
      const p = readPersisted()
      writePersisted({ ...p, acct: { ...p.acct, [key.acct]: [...(p.acct[key.acct] ?? []), ...withIds] } }) // 内存已经由动作本身改好了
    } else {
      // 库键还没算出来:先按库记在内存里,算出是 sync 再归到账号的队列,算出是留本机就丢(改动已经在镜像里)。
      // 不落 localStorage:留本机的库不该因为这一步多写任何东西。代价:算出来之前(通常不到一秒)就退出,这几条只在镜像里。
      limbo.set(root, [...(limbo.get(root) ?? []), ...withIds])
    }
    kick(root)
  }

  /** 只删本次真正写进去的那些(按 id):写的这段时间里别的窗口 / 用户又加的留着。 */
  function ack(acct: string, ids: Set<string>): void {
    if (!ids.size) return
    const p = readPersisted()
    const rest = (p.acct[acct] ?? []).filter((op) => !ids.has(op.id))
    const accts = { ...p.acct }
    if (rest.length) accts[acct] = rest
    else delete accts[acct]
    writePersisted({ ...p, acct: accts })
  }

  function adoptRootOps(root: string, key: SettingsKey): void {
    const ops = limbo.get(root)
    if (!ops) return
    limbo.delete(root)
    if (key.kind !== 'sync') return // 算出是留本机:这些改动已经在镜像里
    const p = readPersisted()
    writePersisted({ ...p, acct: { ...p.acct, [key.acct]: [...(p.acct[key.acct] ?? []), ...ops] } })
  }

  /** 内存 = 共享那份 + 挂起改动 + 本机独有的不可移植项。 */
  function reproject(root: string, local: VaultCfg | undefined = deps.getVc(root)): void {
    const l = live.get(root)
    if (!l?.doc) return
    const shared = docToVaultCfg(applySettingOps(l.doc, pendingOf(l.acct)))
    const next = projectShared(shared, local, l.acct)
    if (JSON.stringify(next) !== JSON.stringify(deps.getVc(root))) deps.applyVc(root, next)
  }

  /** 带票据写;409 换成带回的那份再重放。返回写成之后(或本来就一样)的那份,失败 = null(队列原样留着)。 */
  async function commit(acct: string, base: SettingsRead, extra: SettingOp[]): Promise<DbFile | null> {
    for (let attempt = 0; attempt <= MAX_CAS_RETRY; attempt++) {
      if (base.status !== 'ok' && base.status !== 'missing') return null
      const queued = pendingOf(acct) // 每一轮都重读:别的窗口可能已经把其中一些写进去、ack 掉了
      const ops: SettingOp[] = [...extra, ...queued]
      const from = base.status === 'ok' ? base.data : emptySettingsDoc()
      const next = applySettingOps(from, ops)
      const ids = new Set(queued.map((op) => op.id))
      if (base.status === 'ok' && sameSettings(next, from)) { ack(acct, ids); return from }
      if (base.status === 'missing' && !ops.length) return from // 两边都没有东西:不建空文件
      if (blocked) return null
      const w = await deps.io.write(next, base.status === 'ok' ? base.version : null)
      if (w.status === 'ok') { ack(acct, ids); return next }
      if (w.status !== 'conflict') return null // rejected / unknown:不知道写没写进去,改动留着,下次重读再重放(都幂等)
      base = w.current
    }
    return null
  }

  async function tickInner(root: string): Promise<void> {
    const key = await deps.resolveKey(root)
    keys.set(root, key)
    if (key.kind === 'unknown') return
    adoptRootOps(root, key)
    if (key.kind === 'local') { live.delete(root); return }
    const acct = key.acct
    let l = live.get(root)
    if (!l || l.acct !== acct) { l = { acct, doc: null, read: 'loading', shared: false }; live.set(root, l) }
    if (blocked) return
    const r = await deps.io.read()
    l.read = r.status
    if (r.status !== 'ok' && r.status !== 'missing') return // corrupt / unknown:不写、不记合过了;内存照旧
    if (!mergedFor(acct)) {
      const local = deps.getVc(root)
      const mine = local && (!local.owner || local.owner === acct) ? local : undefined // 别的账号的那份不带进来
      if (mine && !localReady(mine)) return // 先在本机把迁移 / 播种跑完(迁移、定色动作会再踢一次)
      const doc = await commit(acct, r, mine ? mergeContribution(mine) : [])
      if (!doc) return
      markMerged(acct)
      l.doc = doc
      l.shared = true
      reproject(root)
      return
    }
    const doc = await commit(acct, r, [])
    l.doc = doc ?? (r.status === 'ok' ? r.data : emptySettingsDoc())
    l.shared = true
    reproject(root)
  }

  /** 单飞:同一个库同时只跑一轮;跑着的时候又来的,跑完再补一轮。 */
  function tick(root: string): Promise<void> {
    if (!root) return Promise.resolve()
    const running = inFlight.get(root)
    if (running) return running.then(() => tick(root))
    const p = tickInner(root).catch((e) => { console.warn('[amadeus] 日历设置同步失败', e) }).finally(() => {
      if (inFlight.get(root) === p) inFlight.delete(root)
    })
    inFlight.set(root, p)
    return p
  }

  // ── 定时重读:有人在看日历(acquire)时才跑 ──
  let users = 0
  let stop: (() => void) | null = null
  const roots = new Set<() => string | null>()
  function start(): () => void {
    const run = (): void => { for (const r of new Set([...roots].map((f) => f()))) if (r) void tick(r) }
    run()
    const onFocus = (): void => run()
    const hasWin = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
    if (hasWin) window.addEventListener('focus', onFocus)
    const poll = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') run() }, 5_000)
    const retries = [3_000, 10_000, 30_000].map((ms) => setTimeout(run, ms))
    return () => { if (hasWin) window.removeEventListener('focus', onFocus); clearInterval(poll); retries.forEach(clearTimeout) }
  }

  return {
    record,
    tick,
    /** 有人在看日历:起定时重读(多处共用,最后一个释放时停;释放函数只生效一次)。currentRoot = 此刻打开的库。 */
    acquire(currentRoot: () => string | null): () => void {
      roots.add(currentRoot)
      if (++users === 1) stop = start()
      else { const r = currentRoot(); if (r) void tick(r) }
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
    /** 别的窗口写了镜像:对随账号走的库,只把本机独有项叠进来、从共享 + 队列重投一次,再去重读。 */
    onMirrorChanged(root: string, mirror: VaultCfg | undefined): void {
      if (!live.get(root)?.shared) return
      reproject(root, mirror)
      kick(root, 0)
    },
    /** 单测 / 诊断用。 */
    debugState: (root: string) => ({ key: keys.get(root), live: live.get(root), blocked }),
  }
}

export type CalendarSettingsSync = ReturnType<typeof createCalendarSettingsSync>
