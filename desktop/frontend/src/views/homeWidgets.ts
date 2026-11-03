/** 桌面主页的组件摆放(主页第四轮,11-02 定):左栏 / 中间 / 下排 / 右栏,只存摆放,记在本机 —— 和近况卡一样桌面手机各摆各的,
 *  手机这轮不做。中间是主页组件(时钟、输入框、下排、Space 坞)的上下顺序:时钟和坞能拿掉(回收纳的「主页组件」),输入框只能挪。
 *  下排 4 格,一张卡占 1 或 2 格;近况卡是内置的一张,占满 4 格 —— 老用户什么都不改看到的就是今天的主页。
 *  左右栏各最多 3 张。存的是 id:`builtin:status` 或小组件 id(w_…);对不上的画的时候跳过,不替用户补位。 */
import { useSyncExternalStore } from 'react'
import { registerMessages } from '../i18n'

// 命令「编辑主页」的标题在启动时就要(bootstrapEngine 注册),所以登记在这里而不是 HomeWidgetParts.tsx
registerMessages({ 'home.edit': { zh: '编辑主页', en: 'Edit Home' } })

export const HOME_WIDGETS_KEY = 'forsion.homepage.widgets.desktop.v1'
export type HomePart = 'clock' | 'composer' | 'row' | 'dock'
export const HOME_PARTS: readonly HomePart[] = ['clock', 'composer', 'row', 'dock']
export const REMOVABLE_PARTS: readonly HomePart[] = ['clock', 'dock']
export const STATUS_CARD = 'builtin:status'
export const ROW_CELLS = 4
export const RAIL_MAX = 3
export interface RowCell { id: string; w: 1 | 2 | 4 }
export interface HomeLayout { left: string[]; center: HomePart[]; row: RowCell[]; right: string[] }
export const DEFAULT_HOME_LAYOUT: HomeLayout = { left: [], center: [...HOME_PARTS], row: [{ id: STATUS_CARD, w: 4 }], right: [] }

const isId = (x: unknown): x is string => typeof x === 'string' && (x === STATUS_CARD || /^w_[A-Za-z0-9_-]{1,64}$/.test(x))

/** 存的那份 → 合法的一份:去重、限量、composer 必在。读不懂 = 缺省(ponytail: 本机摆放坏了没法救,缺省就是今天的主页)。 */
export function sanitizeHomeLayout(raw: unknown): HomeLayout {
  if (!raw || typeof raw !== 'object') return DEFAULT_HOME_LAYOUT
  const o = raw as Partial<Record<keyof HomeLayout, unknown>>
  const seen = new Set<string>()
  const take = (x: unknown): x is string => isId(x) && !seen.has(x) && (seen.add(x), true)
  const center = (Array.isArray(o.center) ? o.center : HOME_PARTS).filter((p, i, a): p is HomePart => HOME_PARTS.includes(p as HomePart) && a.indexOf(p) === i)
  if (!center.includes('composer')) center.splice(Math.min(1, center.length), 0, 'composer')
  if (!center.includes('row')) center.splice(center.indexOf('composer') + 1, 0, 'row')
  const row: RowCell[] = []
  let used = 0
  for (const c of Array.isArray(o.row) ? o.row : []) {
    const cell = c as Partial<RowCell>
    const w = cell?.w === 4 && cell.id === STATUS_CARD ? 4 : cell?.w === 2 ? 2 : 1
    if (!take(cell?.id) || used + w > ROW_CELLS) continue
    row.push({ id: cell.id as string, w })
    used += w
  }
  const rail = (x: unknown): string[] => (Array.isArray(x) ? x : []).filter(take).filter((id) => id !== STATUS_CARD).slice(0, RAIL_MAX)
  return { center, row, left: rail(o.left), right: rail(o.right) }
}

let cached: HomeLayout | null = null
const subs = new Set<() => void>()
export function readHomeLayout(): HomeLayout {
  if (cached) return cached
  try { cached = sanitizeHomeLayout(JSON.parse(localStorage.getItem(HOME_WIDGETS_KEY) ?? 'null')) } catch { cached = DEFAULT_HOME_LAYOUT }
  return cached
}
export function saveHomeLayout(next: HomeLayout): void {
  cached = sanitizeHomeLayout(next)
  try { localStorage.setItem(HOME_WIDGETS_KEY, JSON.stringify(cached)) } catch { /* 存不下:这次会话里照样生效 */ }
  for (const f of subs) f()
}
export const useHomeLayout = (): HomeLayout => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, readHomeLayout)

const rowUsed = (l: HomeLayout): number => l.row.reduce((s, c) => s + c.w, 0)
export const isOnHome = (l: HomeLayout, id: string): boolean => l.row.some((c) => c.id === id) || l.left.includes(id) || l.right.includes(id)

/** 放到第一个空位:先下排(放得下 2 格就占 2 格),再右栏。都满了回 null。 */
export function placeOnHome(l: HomeLayout, id: string): HomeLayout | null {
  if (isOnHome(l, id)) return l
  const free = ROW_CELLS - rowUsed(l)
  if (free > 0) return { ...l, row: [...l.row, { id, w: free >= 2 ? 2 : 1 }] }
  if (l.right.length < RAIL_MAX) return { ...l, right: [...l.right, id] }
  return null
}
export function removeFromHome(l: HomeLayout, id: string): HomeLayout {
  return { ...l, row: l.row.filter((c) => c.id !== id), left: l.left.filter((x) => x !== id), right: l.right.filter((x) => x !== id) }
}

export type HomeSlot = { area: 'left' | 'right' | 'row'; index: number }
/** 拖动松手:把 id 从原处拿出来插到 slot。放不下(栏满 / 下排格子不够)回 null,卡回原处。 */
export function moveOnHome(l: HomeLayout, id: string, to: HomeSlot): HomeLayout | null {
  const cell = l.row.find((c) => c.id === id)
  const rest = removeFromHome(l, id)
  if (to.area === 'row') {
    const w = cell?.w ?? 1
    if (rowUsed(rest) + w > ROW_CELLS) return null
    const row = [...rest.row]
    row.splice(Math.min(to.index, row.length), 0, { id, w })
    return { ...rest, row }
  }
  if (id === STATUS_CARD || rest[to.area].length >= RAIL_MAX) return null
  const list = [...rest[to.area]]
  list.splice(Math.min(to.index, list.length), 0, id)
  return { ...rest, [to.area]: list }
}

export function moveCenterPart(l: HomeLayout, part: HomePart, before: HomePart | null): HomeLayout {
  const center = l.center.filter((p) => p !== part)
  const at = before ? center.indexOf(before) : -1
  center.splice(at < 0 ? center.length : at, 0, part)
  return { ...l, center }
}
export const removeCenterPart = (l: HomeLayout, part: HomePart): HomeLayout =>
  REMOVABLE_PARTS.includes(part) ? { ...l, center: l.center.filter((p) => p !== part) } : l
export const addCenterPart = (l: HomeLayout, part: HomePart): HomeLayout =>
  l.center.includes(part) ? l : { ...l, center: part === 'clock' ? [part, ...l.center] : [...l.center, part] }
/** 下排一张卡在 1 格 / 2 格之间切换(近况卡固定 4 格)。 */
export function resizeRowCell(l: HomeLayout, id: string): HomeLayout {
  const row = l.row.map((c) => (c.id === id && c.id !== STATUS_CARD ? { ...c, w: (c.w === 2 ? 1 : 2) as 1 | 2 } : c))
  return rowUsed({ ...l, row }) > ROW_CELLS ? l : { ...l, row }
}

// 命令「编辑主页」:主页挂着就直接进;还没挂上(人在别的 Space,命令先切回主页)就等它挂上时接手这一下。
let editHandler: (() => void) | null = null
let editPending = false
export function setHomeEditHandler(fn: () => void): () => void {
  editHandler = fn
  if (editPending) { editPending = false; fn() }
  return () => { if (editHandler === fn) editHandler = null }
}
export function requestHomeEdit(): void {
  if (editHandler) editHandler()
  else editPending = true
}
