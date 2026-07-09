/** Calendar 视图偏好(按 vault 存 localStorage,不进 vault 文件/不进 git):
 *  每个源多维表的事件颜色、是否可见、以及新建事件落入的默认库。 */
import { create } from 'zustand'

export const EVENT_PALETTE = ['#6d8fd6', '#e0925f', '#5aa98b', '#b57bd0', '#d76d8a', '#8a9a5b', '#c99a3f', '#5c9bd1']

interface VaultCfg {
  colors: Record<string, string> // dbPath → 颜色覆盖(未设则取调色板)
  hidden: string[] // 隐藏的 dbPath
  defaultDbPath: string | null // 新建事件落入
}
interface CalCfgState {
  byVault: Record<string, VaultCfg>
  setColor(vault: string, dbPath: string, color: string): void
  clearColor(vault: string, dbPath: string): void
  toggleHidden(vault: string, dbPath: string): void
  setDefault(vault: string, dbPath: string): void
  /** .db 文件改名后迁移颜色/隐藏/默认库三处 dbPath 键,防配置静默丢失。 */
  migratePath(vault: string, oldPath: string, newPath: string): void
}

const KEY = 'amadeus.calendar.cfg'
const emptyVc = (): VaultCfg => ({ colors: {}, hidden: [], defaultDbPath: null })
const loadAll = (): Record<string, VaultCfg> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, VaultCfg>
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
const vc = (m: Record<string, VaultCfg>, vault: string): VaultCfg => m[vault] ?? emptyVc()

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
  migratePath: (vault, oldPath, newPath) =>
    set((s) => {
      const cur = s.byVault[vault]
      if (!cur) return s
      const colors = { ...cur.colors }
      if (oldPath in colors) {
        colors[newPath] = colors[oldPath]
        delete colors[oldPath]
      }
      const next = {
        ...s.byVault,
        [vault]: {
          colors,
          hidden: cur.hidden.map((x) => (x === oldPath ? newPath : x)),
          defaultDbPath: cur.defaultDbPath === oldPath ? newPath : cur.defaultDbPath,
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
