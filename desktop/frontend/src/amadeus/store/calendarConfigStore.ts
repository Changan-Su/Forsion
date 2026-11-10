/** Calendar 视图偏好(按 vault 存 localStorage,不进 vault 文件/不进 git):
 *  每个源的事件颜色(手选色 colors + 第一次出现时自动定下的 autoColors)、是否可见、新建事件落入的默认库,以及「日历成员」列映射。
 *  成员制(显式):有 members[dbPath] 才算「在日历中」;旧「有 calendarDate 列即入历」经 migrate 一次性收编。 */
import { create } from 'zustand'
import { isWinRoot, slashRel } from '@amadeus/lib/vaultFiles'

export const EVENT_PALETTE = ['#6d8fd6', '#e0925f', '#5aa98b', '#b57bd0', '#d76d8a', '#8a9a5b', '#c99a3f', '#5c9bd1']

/** 日历成员的列映射:哪一列是日期锚点(必)、哪一列是完成/待办勾选(可选)。 */
export interface CalMember {
  dateCol: string
  checkboxCol?: string
}
interface VaultCfg {
  colors: Record<string, string> // dbPath → 用户手选的颜色(优先;自动定色永不改写它)
  /** 来源路径 → 自动定下的调色板色:一个来源第一次出现时定一次,之后顺序怎么变都不动;来源移除后也留着(加回来还是原来的色)。
   *  键 = 来源自己的路径(表的库内路径 / `human://…` / `agent://…` / `otherside:…` / `ics://<id>` / `mdnote://…`)。
   *  没有这个键 = 这个库还没播种:播种那一次按老规则(排第几个取第几个色)存下当时的一整列,保证升级前后颜色不变。 */
  autoColors?: Record<string, string>
  hidden: string[] // 隐藏的 dbPath
  defaultDbPath: string | null // 新建事件落入
  members: Record<string, CalMember> // dbPath → 列映射;有键 = 「在日历中」(显式成员制)
  migrated?: boolean // 旧「有 calendarDate 列即入历」数据一次性迁移完成;之后成员全靠显式增删
}
interface CalCfgState {
  byVault: Record<string, VaultCfg>
  setColor(vault: string, dbPath: string, color: string): void
  /** 清掉手选色 → 回到自动定下的那个色(不是重新按序号取)。 */
  clearColor(vault: string, dbPath: string): void
  /** 给这一列来源里还没定色的定色并存下(只在出现新路径时写一次)。paths = 此刻的一整列来源,按图例顺序。
   *  seed = 这一列已经到齐、可以做升级播种;库还没播种而 seed 为假时什么都不做(到齐前照旧按序号显示)。 */
  ensureColors(vault: string, paths: readonly string[], seed: boolean): void
  toggleHidden(vault: string, dbPath: string): void
  setDefault(vault: string, dbPath: string): void
  /** 加入日历 / 更新列映射(同一动作:写入即成员)。 */
  addMember(vault: string, dbPath: string, dateCol: string, checkboxCol?: string): void
  /** 移出日历(不删库文件,仅撤成员)。 */
  removeMember(vault: string, dbPath: string): void
  /** 一次性迁移:把 seeds 里尚未登记的库补为成员,并置 migrated 标记。 */
  migrate(vault: string, seeds: Array<{ dbPath: string; dateCol: string; checkboxCol?: string }>): void
  /** .db 文件改名后迁移颜色/自动色/隐藏/默认库/成员五处 dbPath 键,防配置静默丢失。 */
  migratePath(vault: string, oldPath: string, newPath: string): void
}

const KEY = 'amadeus.calendar.cfg'
/** 读不出来的那份原文另存到这里(见 loadAll)。 */
const UNREADABLE_KEY = `${KEY}.unreadable`
type Cfg = Record<string, VaultCfg>
const emptyVc = (): VaultCfg => ({ colors: {}, hidden: [], defaultDbPath: null, members: {} })
/** 叠加源的合成路径(`agent://…` / `ics://…` / `human://…` / `mdnote://…` / `otherside:<另一侧根>/…`):不是库内相对路径,原样比对。 */
const SYNTHETIC = /^(?:[a-z][a-z0-9+.-]*:\/\/|otherside:)/i
// Windows 老版本按 `a\b.db` 记的配置:读进来换成 `/`(库根就是键),不然这些库从日历里掉出去,颜色 / 默认库全丢。
// 合成路径不换:`otherside:` 后面跟的是另一侧的绝对根,换了斜杠就和运行时的路径对不上(自动色每次启动都会重定)。
const slashCfg = (vault: string, v: VaultCfg): VaultCfg => {
  const rel = (p: string): string => (SYNTHETIC.test(p) ? p : slashRel(p, vault))
  const keys = <T>(o: Record<string, T> | undefined): Record<string, T> | undefined =>
    o && Object.fromEntries(Object.entries(o).map(([k, x]) => [rel(k), x]))
  const auto = keys(v.autoColors)
  return {
    ...v,
    colors: keys(v.colors) ?? {},
    ...(auto ? { autoColors: auto } : {}), // 没播种过就别凭空造出这个键(有键 = 已播种)
    hidden: Array.isArray(v.hidden) ? v.hidden.map(rel) : [],
    defaultDbPath: typeof v.defaultDbPath === 'string' ? rel(v.defaultDbPath) : v.defaultDbPath ?? null,
    members: keys(v.members) as VaultCfg['members'],
  }
}
/** 读盘。没有这个键 = 空(ok);取不到 / 解析不了 / 不是对象 = 不知道(ok:false),**不能当空**。 */
const readAll = (): { ok: true; all: Cfg } | { ok: false; raw: string | null } => {
  if (typeof localStorage === 'undefined') return { ok: true, all: {} } // 没有存储的环境(node 单测):本来就什么都存不下
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
    if (!raw) return { ok: true, all: {} }
    const all = JSON.parse(raw) as Cfg
    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('not an object')
    return { ok: true, all: Object.fromEntries(Object.entries(all).map(([vault, v]) => [vault, isWinRoot(vault) && v ? slashCfg(vault, v) : v])) }
  } catch {
    return { ok: false, raw }
  }
}
/** 把读不出来的那份原文挪到旁边(留着可恢复)。挪成了才允许覆盖主键;取都取不到 / 配额满 → false。 */
const stash = (raw: string | null): boolean => {
  if (raw === null) return false
  try {
    localStorage.setItem(UNREADABLE_KEY, raw)
    return true
  } catch {
    return false
  }
}
/** 启动时没读出来、原文也没能另存:这一程不落盘 —— 拿「读失败当成的空」写回去,就把用户原来的设置盖掉了。 */
let writeBlocked = false
const loadAll = (): Cfg => {
  const r = readAll()
  if (r.ok) return r.all
  writeBlocked = !stash(r.raw)
  console.warn('[amadeus] 日历设置读不出来,按「不知道」处理', writeBlocked ? '(本次运行不落盘)' : '(原文已另存)')
  return {}
}
const writeAll = (m: Cfg): void => {
  if (writeBlocked) return
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* ignore */
  }
}
/** 整份落盘(用户手势触发的那些写)。别的窗口定下的自动色不在这个窗口的内存里 → 从盘上带过来,不让整份覆盖把它们冲掉。
 *  moved = 这次写是把某个库的一条路径改了名:盘上旧名字的自动色不原样带回来 —— 内存里已经挪过的就摘掉,
 *  内存里还没有的(别的窗口刚定的)在这里挪到新名字上。 */
const persist = (m: Cfg, moved?: { vault: string; from: string; to: string }): void => {
  if (writeBlocked) return
  const disk = readAll()
  if (!disk.ok) {
    if (stash(disk.raw)) writeAll(m) // 盘上那份读不出来:原文另存了才盖
    return
  }
  const out: Cfg = { ...m }
  for (const [vault, d] of Object.entries(disk.all)) {
    const mine = out[vault]
    if (!mine || !d?.autoColors) continue
    const auto = { ...d.autoColors, ...mine.autoColors }
    if (moved?.vault === vault && moved.from in auto && !(moved.from in (mine.autoColors ?? {}))) {
      if (!(moved.to in (mine.autoColors ?? {}))) auto[moved.to] = auto[moved.from]
      delete auto[moved.from]
    }
    out[vault] = { ...mine, autoColors: auto }
  }
  writeAll(out)
}
// 归一:旧持久化数据可能没有 members 键,取用前补空,免下游 members[...] 崩。
const vc = (m: Record<string, VaultCfg>, vault: string): VaultCfg => {
  const v = m[vault]
  return v ? { ...v, members: v.members ?? {} } : emptyVc()
}
const member = (dateCol: string, checkboxCol?: string): CalMember => (checkboxCol ? { dateCol, checkboxCol } : { dateCol })

/** 定色(纯函数):给 paths 里还没有自动色的来源定色,返回新的整张 autoColors;没有要定的 → null。
 *  · 还没播种(没有 autoColors):seed 为真才播,按老规则「排第几个取第几个色」存下这一整列 —— 升级那一刻屏幕上的颜色原样留住;
 *  · 播种之后:新来源取这一列里此刻用得最少的调色板色(手选色也算在用),并列按调色板顺序。已有的一律不动。 */
export function planAutoColors(
  cfg: { colors?: Record<string, string>; autoColors?: Record<string, string> } | null | undefined,
  paths: readonly string[],
  seed: boolean,
): Record<string, string> | null {
  const n = EVENT_PALETTE.length
  const stored = cfg?.autoColors
  if (!stored) {
    if (!seed) return null
    const out: Record<string, string> = {}
    paths.forEach((p, i) => { if (typeof out[p] !== 'string') out[p] = EVENT_PALETTE[i % n] })
    return out
  }
  if (paths.every((p) => typeof stored[p] === 'string')) return null
  const out = { ...stored }
  const used = EVENT_PALETTE.map(() => 0)
  for (const p of new Set(paths)) {
    const shown = cfg?.colors?.[p] ?? out[p]
    const at = typeof shown === 'string' ? EVENT_PALETTE.indexOf(shown.toLowerCase()) : -1
    if (at >= 0) used[at]++
  }
  for (const p of paths) {
    if (typeof out[p] === 'string') continue
    const at = used.indexOf(Math.min(...used))
    out[p] = EVENT_PALETTE[at]
    used[at]++ // 新来源已经有手选色时(少见),备着的这个自动色也占名额:清掉手选色回到它时不和同批的别的来源撞
  }
  return out
}

export const useCalendarConfig = create<CalCfgState>((set) => ({
  byVault: loadAll(),
  setColor: (vault, dbPath, color) =>
    set((s) => {
      const cur = vc(s.byVault, vault)
      const next = { ...s.byVault, [vault]: { ...cur, colors: { ...cur.colors, [dbPath]: color } } }
      persist(next)
      return { byVault: next }
    }),
  clearColor: (vault, dbPath) =>
    set((s) => {
      const cur = vc(s.byVault, vault)
      const colors = { ...cur.colors }
      delete colors[dbPath]
      const next = { ...s.byVault, [vault]: { ...cur, colors } }
      persist(next)
      return { byVault: next }
    }),
  ensureColors: (vault, paths, seed) =>
    set((s) => {
      if (!vault) return s
      const cur = s.byVault[vault]
      if (!planAutoColors(cur, paths, seed)) return s // 没有新来源:不读盘、不落盘、不换引用(调用方挂在 store 订阅上,必须幂等)
      // 这是唯一一处不由用户手势触发的写:别的窗口(同一份 localStorage)可能先定过色、用户也可能刚在那边改过设置 ——
      // 以盘上那份为底,盘上已有的色照用,只补盘上也没有的;落盘只动 autoColors 一个字段。
      const disk = readAll()
      const diskVc = disk.ok ? disk.all[vault] : undefined
      const known = cur?.autoColors || diskVc?.autoColors ? { ...cur?.autoColors, ...diskVc?.autoColors } : undefined
      const auto = planAutoColors({ colors: cur?.colors, autoColors: known }, paths, seed) ?? known ?? {}
      const mine = { ...vc(s.byVault, vault), autoColors: auto }
      const next = { ...s.byVault, [vault]: mine }
      if (disk.ok) writeAll({ ...disk.all, [vault]: { ...(diskVc ?? mine), autoColors: auto } })
      else if (stash(disk.raw)) writeAll(next) // 盘上那份读不出来 = 不知道:原文另存了才盖,否则只留在内存里
      return { byVault: next }
    }),
  toggleHidden: (vault, dbPath) =>
    set((s) => {
      const cur = vc(s.byVault, vault)
      const hidden = cur.hidden.includes(dbPath) ? cur.hidden.filter((x) => x !== dbPath) : [...cur.hidden, dbPath]
      const next = { ...s.byVault, [vault]: { ...cur, hidden } }
      persist(next)
      return { byVault: next }
    }),
  setDefault: (vault, dbPath) =>
    set((s) => {
      const cur = vc(s.byVault, vault)
      const next = { ...s.byVault, [vault]: { ...cur, defaultDbPath: dbPath } }
      persist(next)
      return { byVault: next }
    }),
  addMember: (vault, dbPath, dateCol, checkboxCol) =>
    set((s) => {
      const cur = vc(s.byVault, vault)
      const next = { ...s.byVault, [vault]: { ...cur, members: { ...cur.members, [dbPath]: member(dateCol, checkboxCol) } } }
      persist(next)
      return { byVault: next }
    }),
  removeMember: (vault, dbPath) =>
    set((s) => {
      const cur = vc(s.byVault, vault)
      const members = { ...cur.members }
      delete members[dbPath]
      const next = { ...s.byVault, [vault]: { ...cur, members } }
      persist(next)
      return { byVault: next }
    }),
  migrate: (vault, seeds) =>
    set((s) => {
      const cur = vc(s.byVault, vault)
      if (cur.migrated) return s
      const members = { ...cur.members }
      for (const sd of seeds) if (!members[sd.dbPath]) members[sd.dbPath] = member(sd.dateCol, sd.checkboxCol)
      const next = { ...s.byVault, [vault]: { ...cur, members, migrated: true } }
      persist(next)
      return { byVault: next }
    }),
  migratePath: (vault, oldPath, newPath) =>
    set((s) => {
      const cur = s.byVault[vault]
      if (!cur) return s
      const colors = { ...cur.colors }
      if (oldPath in colors) {
        colors[newPath] = colors[oldPath]
        delete colors[oldPath]
      }
      const members = { ...(cur.members ?? {}) }
      if (oldPath in members) {
        members[newPath] = members[oldPath]
        delete members[oldPath]
      }
      // 自动色跟着走(改了名还是原来的颜色);新名字上若留着别的表的旧色,以被改名的这份为准。没播种过就不造这个键。
      const autoColors = cur.autoColors && { ...cur.autoColors }
      if (autoColors && oldPath in autoColors) {
        autoColors[newPath] = autoColors[oldPath]
        delete autoColors[oldPath]
      }
      const next = {
        ...s.byVault,
        [vault]: {
          ...cur,
          colors,
          ...(autoColors ? { autoColors } : {}),
          hidden: cur.hidden.map((x) => (x === oldPath ? newPath : x)),
          defaultDbPath: cur.defaultDbPath === oldPath ? newPath : cur.defaultDbPath,
          members,
        },
      }
      persist(next, { vault, from: oldPath, to: newPath })
      return { byVault: next }
    }),
}))

// 别的窗口写了这份设置(同一份 localStorage,各自内存里一份):把内存换成盘上最新的。不换的话,这个窗口下一次整份落盘
// 就是拿旧内存把那边刚改的颜色 / 成员 / 显隐盖掉。storage 事件只发给别的窗口,自己写的不会回来;盘上读不出来就不动。
// 键被删了 / 成了空串 / 某个库那一项不是对象 = 不知道,**不当成空**:内存里这份好的留着,不换、也不据此落盘。
// 盘上没有的库照旧留在内存里(没有哪个写动作会删掉整个库的设置)。
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
/** 别的窗口写来的一项:缺的字段补空(下游直接读 hidden / colors / members),形状不对整份作废。 */
const saneVc = (v: unknown): VaultCfg | null => {
  if (!isObj(v)) return null
  const o = v as Partial<VaultCfg>
  return {
    ...o,
    colors: isObj(o.colors) ? (o.colors as VaultCfg['colors']) : {},
    hidden: Array.isArray(o.hidden) ? o.hidden : [],
    defaultDbPath: typeof o.defaultDbPath === 'string' ? o.defaultDbPath : null,
    members: isObj(o.members) ? (o.members as VaultCfg['members']) : {},
  } as VaultCfg
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    const r = readAll()
    if (!r.ok || !localStorage.getItem(KEY)) return
    const incoming: Cfg = {}
    for (const [vault, v] of Object.entries(r.all)) {
      const s = saneVc(v)
      if (!s) return
      incoming[vault] = s
    }
    writeBlocked = false // 内存现在包含盘上读得出来的那份,照常落盘不会盖掉什么
    useCalendarConfig.setState((st) => ({ byVault: { ...st.byVault, ...incoming } }))
  })
}

/** 手选色 → 自动定下的色 → 都没有(这个库还没播种 / 新来源还没轮到定色的那一拍)才按序号取调色板。 */
export const colorForDb = (vault: string, byVault: Cfg, dbPath: string, dbIndex: number): string => {
  const v = byVault[vault]
  return v?.colors?.[dbPath] ?? v?.autoColors?.[dbPath] ?? EVENT_PALETTE[dbIndex % EVENT_PALETTE.length]
}
/** 这个库的来源颜色播种过没有(有 autoColors 键 = 播过)。 */
export const colorsSeeded = (vault: string, byVault: Cfg): boolean => !!byVault[vault]?.autoColors
export const isHidden = (vault: string, byVault: Cfg, dbPath: string): boolean =>
  byVault[vault]?.hidden.includes(dbPath) ?? false
export const defaultDbPath = (vault: string, byVault: Cfg): string | null => byVault[vault]?.defaultDbPath ?? null
export const memberOf = (vault: string, byVault: Cfg, dbPath: string): CalMember | undefined =>
  byVault[vault]?.members?.[dbPath]
export const isMigrated = (vault: string, byVault: Cfg): boolean => byVault[vault]?.migrated ?? false
