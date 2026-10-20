/** Calendar 视图偏好(按 vault 存 localStorage,不进 vault 文件/不进 git):
 *  每个源多维表的事件颜色、是否可见、新建事件落入的默认库,以及「日历成员」列映射。
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
  colors: Record<string, string> // dbPath → 颜色覆盖(未设则取调色板)
  hidden: string[] // 隐藏的 dbPath
  defaultDbPath: string | null // 新建事件落入
  members: Record<string, CalMember> // dbPath → 列映射;有键 = 「在日历中」(显式成员制)
  migrated?: boolean // 旧「有 calendarDate 列即入历」数据一次性迁移完成;之后成员全靠显式增删
}
interface CalCfgState {
  byVault: Record<string, VaultCfg>
  setColor(vault: string, dbPath: string, color: string): void
  clearColor(vault: string, dbPath: string): void
  toggleHidden(vault: string, dbPath: string): void
  setDefault(vault: string, dbPath: string): void
  /** 加入日历 / 更新列映射(同一动作:写入即成员)。 */
  addMember(vault: string, dbPath: string, dateCol: string, checkboxCol?: string): void
  /** 移出日历(不删库文件,仅撤成员)。 */
  removeMember(vault: string, dbPath: string): void
  /** 一次性迁移:把 seeds 里尚未登记的库补为成员,并置 migrated 标记。 */
  migrate(vault: string, seeds: Array<{ dbPath: string; dateCol: string; checkboxCol?: string }>): void
  /** .db 文件改名后迁移颜色/隐藏/默认库/成员四处 dbPath 键,防配置静默丢失。 */
  migratePath(vault: string, oldPath: string, newPath: string): void
}

const KEY = 'amadeus.calendar.cfg'
const emptyVc = (): VaultCfg => ({ colors: {}, hidden: [], defaultDbPath: null, members: {} })
// Windows 老版本按 `a\b.db` 记的配置:读进来换成 `/`(库根就是键),不然这些库从日历里掉出去,颜色 / 默认库全丢。
const slashCfg = (vault: string, v: VaultCfg): VaultCfg => {
  const rel = (p: string): string => slashRel(p, vault)
  const keys = <T>(o: Record<string, T> | undefined): Record<string, T> | undefined =>
    o && Object.fromEntries(Object.entries(o).map(([k, x]) => [rel(k), x]))
  return {
    ...v,
    colors: keys(v.colors) ?? {},
    hidden: Array.isArray(v.hidden) ? v.hidden.map(rel) : [],
    defaultDbPath: typeof v.defaultDbPath === 'string' ? rel(v.defaultDbPath) : v.defaultDbPath ?? null,
    members: keys(v.members) as VaultCfg['members'],
  }
}
const loadAll = (): Record<string, VaultCfg> => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, VaultCfg>
    return Object.fromEntries(Object.entries(all).map(([vault, v]) => [vault, isWinRoot(vault) && v ? slashCfg(vault, v) : v]))
  } catch {
    return {}
  }
}
const persist = (m: Record<string, VaultCfg>): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* ignore */
  }
}
// 归一:旧持久化数据可能没有 members 键,取用前补空,免下游 members[...] 崩。
const vc = (m: Record<string, VaultCfg>, vault: string): VaultCfg => {
  const v = m[vault]
  return v ? { ...v, members: v.members ?? {} } : emptyVc()
}
const member = (dateCol: string, checkboxCol?: string): CalMember => (checkboxCol ? { dateCol, checkboxCol } : { dateCol })

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
      const next = {
        ...s.byVault,
        [vault]: {
          ...cur,
          colors,
          hidden: cur.hidden.map((x) => (x === oldPath ? newPath : x)),
          defaultDbPath: cur.defaultDbPath === oldPath ? newPath : cur.defaultDbPath,
          members,
        },
      }
      persist(next)
      return { byVault: next }
    }),
}))

type Cfg = Record<string, VaultCfg>
export const colorForDb = (vault: string, byVault: Cfg, dbPath: string, dbIndex: number): string =>
  byVault[vault]?.colors[dbPath] ?? EVENT_PALETTE[dbIndex % EVENT_PALETTE.length]
export const isHidden = (vault: string, byVault: Cfg, dbPath: string): boolean =>
  byVault[vault]?.hidden.includes(dbPath) ?? false
export const defaultDbPath = (vault: string, byVault: Cfg): string | null => byVault[vault]?.defaultDbPath ?? null
export const memberOf = (vault: string, byVault: Cfg, dbPath: string): CalMember | undefined =>
  byVault[vault]?.members?.[dbPath]
export const isMigrated = (vault: string, byVault: Cfg): boolean => byVault[vault]?.migrated ?? false
