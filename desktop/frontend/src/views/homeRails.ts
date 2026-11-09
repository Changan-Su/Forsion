// 主页三栏几何(桌面):六个数、收起算法、开发用调节。HomeWidgetParts 照旧导出这些名字。
// 门槛全是像素算术,没有比例:主页宽 − 中间 − 两边(外边 + 缝)剩下的给展开的栏分。
import { useSyncExternalStore } from 'react'
import { registerMessages } from '../i18n'

export const RAIL_W = 256, RAIL_MIN = 216, STRIP_W = 36, EDGE = 16, GAP = 32, CENTER_W = 840
export type RailMode = 'open' | 'strip' | 'hidden'
/** 三栏几何。centerMin < centerW 时中间可以先缩、再收栏;缺省 centerMin = centerW = 中间不缩(11-03 定的)。
 *  maxShift = 中间最多偏离正中多少:两边占的不一样(一边空、一边图标条一边展开)时,少的那边至少留「多的那边 − 2×maxShift」,
 *  0 = 两边对称、空栏也留白;SHIFT_ANY(缺省)= 不限,空栏只留外边、中间往空的那边让(现在的样子)。 */
export interface RailGeometry { centerW: number; centerMin: number; railW: number; railMin: number; gap: number; edge: number; maxShift: number }
export const SHIFT_ANY = 400
export const RAIL_GEOMETRY: Readonly<RailGeometry> = { centerW: CENTER_W, centerMin: CENTER_W, railW: RAIL_W, railMin: RAIL_MIN, gap: GAP, edge: EDGE, maxShift: SHIFT_ANY }
export interface RailLayout { left: RailMode; right: RailMode; /** 展开的栏有多宽(两栏同宽) */ railW: number; /** 中间那块有多宽 */ centerW: number }

// ── 开发用调节(只在 dev 构建里生效;生产恒为缺省) ──
registerMessages({
  'home.tune.cmd': { zh: '主页：调节侧栏收起（开发用）', en: 'Home: tune side rail folding (dev)' },
})
const KEY = 'forsion.dev.homeRails'
/** 每个滑块的范围;最窄的上限跟着最宽走(见 sanitize)。 */
export const RAIL_TUNE_RANGE: Readonly<Record<keyof RailGeometry, readonly [number, number]>> = {
  centerW: [600, 960], centerMin: [480, 960], railW: [160, 360], railMin: [120, 360], gap: [8, 64], edge: [0, 48], maxShift: [0, SHIFT_ANY],
}
const clampTo = (k: keyof RailGeometry, v: unknown, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  const [lo, hi] = RAIL_TUNE_RANGE[k]
  return Math.min(hi, Math.max(lo, n))
}
/** 夹进范围,并保证 最窄 ≤ 最宽(先认刚动的那个:把另一个推过去)。 */
function sanitize(raw: Partial<RailGeometry>, moved?: keyof RailGeometry): RailGeometry {
  const g = {} as RailGeometry
  for (const k of Object.keys(RAIL_GEOMETRY) as (keyof RailGeometry)[]) g[k] = clampTo(k, raw[k], RAIL_GEOMETRY[k])
  if (g.railMin > g.railW) { if (moved === 'railMin') g.railW = g.railMin; else g.railMin = g.railW }
  if (g.centerMin > g.centerW) { if (moved === 'centerMin') g.centerW = g.centerMin; else g.centerMin = g.centerW }
  return g
}
export interface RailTuning { geo: RailGeometry; open: boolean }
const DEFAULT_TUNING: RailTuning = { geo: RAIL_GEOMETRY, open: false }
function load(): RailTuning {
  if (!import.meta.env.DEV) return DEFAULT_TUNING
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null') as { geo?: Partial<RailGeometry>; open?: boolean } | null
    if (!v || typeof v !== 'object') return DEFAULT_TUNING
    return { geo: sanitize(v.geo ?? {}), open: v.open === true }
  } catch { return DEFAULT_TUNING }
}
let tuning = load()
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of listeners) l() }
function commit(next: RailTuning): void {
  if (!import.meta.env.DEV) return
  tuning = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 存不下就只改这一窗 */ }
  emit()
}
if (import.meta.env.DEV && typeof window !== 'undefined') {
  // 别的窗口(拖出去的独立窗)调了同一份:跟上
  window.addEventListener('storage', (e) => { if (e.key === KEY) { tuning = load(); emit() } })
}
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }
/** 当前生效的几何(生产 = 缺省)。 */
export const railGeometry = (): RailGeometry => tuning.geo
export const useRailTuning = (): RailTuning => useSyncExternalStore(subscribe, () => tuning)
export const setRailTuning = (k: keyof RailGeometry, v: number): void => commit({ ...tuning, geo: sanitize({ ...tuning.geo, [k]: v }, k) })
export const resetRailTuning = (): void => commit({ ...tuning, geo: RAIL_GEOMETRY })
export const setRailTunerOpen = (open: boolean): void => commit({ ...tuning, open })
export const toggleRailTuner = (): void => setRailTunerOpen(!tuning.open)

// ── 收起算法 ──
/** 一边占多少:空栏只留外边;图标条 = 外边 + 36 + 缝;展开 = 外边 + 栏宽 + 缝。 */
const sideRes = (g: RailGeometry, mode: RailMode, has: boolean, railW: number): number => (!has ? g.edge : mode === 'strip' ? g.edge + STRIP_W + g.gap : g.edge + railW + g.gap)
/** 两边一共占多少。中间最多偏 maxShift,所以少的那边至少要「多的那边 − 2×maxShift」(空栏也跟着留白)。 */
function sides(g: RailGeometry, left: RailMode, right: RailMode, has: { left: boolean; right: boolean }, railW: number): number {
  const l = sideRes(g, left, has.left, railW), r = sideRes(g, right, has.right, railW)
  if (g.maxShift >= SHIFT_ANY) return l + r
  return Math.max(l, r - 2 * g.maxShift) + Math.max(r, l - 2 * g.maxShift)
}
/** 主页宽(不含 Ribbon,布局 px)+ 两栏有没有东西 → 两栏的样子。依次试 两栏展开 → 左收右开 → 两栏图标条:
 *  ① 中间满宽,栏取 [railMin, railW] 里放得下的最宽;② 栏已到最窄,中间从 centerW 缩到 centerMin;
 *  都放不下就试下一种,最后只剩中间。缺省几何(中间不缩、偏移不限)下的门槛:两栏都有 ≥1368 三栏(≥1448 才 256 宽)、
 *  ≥1188 先收左栏、≥1008 两栏都收;只有右栏 ≥1120 展开、≥940 图标条(#552,11-08)。 */
export function railModes(width: number, has: { left: boolean; right: boolean } = { left: true, right: true }, g: RailGeometry = railGeometry()): RailLayout {
  for (const [left, right] of [['open', 'open'], ['strip', 'open'], ['strip', 'strip']] as const) {
    const opens = Number(has.left && left === 'open') + Number(has.right && right === 'open')
    if (opens && sides(g, left, right, has, g.railMin) + g.centerW <= width) {
      let lo = g.railMin, hi = g.railW // 放得下的最宽栏(sides 随栏宽单调增)
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sides(g, left, right, has, mid) + g.centerW <= width) lo = mid; else hi = mid - 1 }
      return { left, right, railW: lo, centerW: g.centerW }
    }
    const centerW = Math.floor(Math.min(g.centerW, width - sides(g, left, right, has, g.railMin)))
    if (centerW >= g.centerMin) return { left, right, railW: opens ? g.railMin : g.railW, centerW }
  }
  return { left: 'hidden', right: 'hidden', railW: g.railW, centerW: g.centerW }
}
const reserve = (g: RailGeometry, mode: RailMode, shown: boolean, railW: number): number => (!shown ? 0 : mode === 'open' ? g.edge + railW + g.gap : mode === 'strip' ? g.edge + STRIP_W + g.gap : 0)
/** 中间那块的横向让位:居中放得下就居中;否则贴着有东西的那一栏留一道缝(空栏不占地方)。centerW 传 railModes 算出来的那个。 */
export function centerShift(width: number, left: { mode: RailMode; shown: boolean }, right: { mode: RailMode; shown: boolean }, railW = RAIL_W, g: RailGeometry = railGeometry(), centerW = g.centerW): number {
  const nat = (width - centerW) / 2
  const lo = reserve(g, left.mode, left.shown, railW), hi = width - reserve(g, right.mode, right.shown, railW) - centerW
  if (lo > hi) return 0
  return Math.min(Math.max(nat, lo), hi) - nat
}

/** 这套几何下的门槛(布局 px;null = 这种样子在 600–2600 里出现不了)。给调节面板看。 */
export interface RailThresholds { both: { full: number | null; open: number | null; leftStrip: number | null; strips: number | null }; right: { open: number | null; strip: number | null } }
export function railThresholds(g: RailGeometry): RailThresholds {
  const first = (has: { left: boolean; right: boolean }, ok: (m: RailLayout) => boolean): number | null => {
    for (let w = 600; w <= 2600; w++) if (ok(railModes(w, has, g))) return w
    return null
  }
  const both = { left: true, right: true }, rightOnly = { left: false, right: true }
  return {
    both: {
      full: first(both, (m) => m.left === 'open' && m.right === 'open' && m.railW === g.railW && m.centerW === g.centerW),
      open: first(both, (m) => m.left === 'open'),
      leftStrip: first(both, (m) => m.right === 'open'),
      strips: first(both, (m) => m.right !== 'hidden'),
    },
    right: { open: first(rightOnly, (m) => m.right === 'open'), strip: first(rightOnly, (m) => m.right !== 'hidden') },
  }
}
