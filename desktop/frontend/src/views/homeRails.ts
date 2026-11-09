// 主页三栏几何(桌面):七个数 + 收起算法。HomeWidgetParts 照旧导出这些名字。
// 门槛全是像素算术,没有比例。数是 11-09 用户在试玩页 / dev 面板里拉出来的手感
// (docs/ToBeImproved/主页侧栏收起手感试玩_2026-11-09):中间 720、可缩到 500,两边对称。
export const RAIL_W = 256, RAIL_MIN = 216, STRIP_W = 36, EDGE = 16, GAP = 32, CENTER_W = 720, CENTER_MIN = 500
export type RailMode = 'open' | 'strip' | 'hidden'
/** 三栏几何。centerMin < centerW:栏缩到最窄以后中间还能缩到 centerMin,再不够才收栏。
 *  maxShift = 中间最多偏离正中多少:两边占的不一样(一边空、一边图标条一边展开)时,少的那边至少留「多的那边 − 2×maxShift」;
 *  0 = 两边对称、空栏也留出同样的白(11-09 用户:「只有一边有卡片时……左边也要留白」)。 */
export interface RailGeometry { centerW: number; centerMin: number; railW: number; railMin: number; gap: number; edge: number; maxShift: number }
export const RAIL_GEOMETRY: Readonly<RailGeometry> = { centerW: CENTER_W, centerMin: CENTER_MIN, railW: RAIL_W, railMin: RAIL_MIN, gap: GAP, edge: EDGE, maxShift: 0 }
export interface RailLayout { left: RailMode; right: RailMode; /** 展开的栏有多宽(两栏同宽) */ railW: number; /** 中间那块有多宽 */ centerW: number }

/** 一边占多少:空栏只留外边;图标条 = 外边 + 36 + 缝;展开 = 外边 + 栏宽 + 缝。 */
const sideRes = (g: RailGeometry, mode: RailMode, has: boolean, railW: number): number => (!has ? g.edge : mode === 'strip' ? g.edge + STRIP_W + g.gap : g.edge + railW + g.gap)
/** 两边一共占多少。中间最多偏 maxShift,所以少的那边至少要「多的那边 − 2×maxShift」(空栏也跟着留白)。 */
function sides(g: RailGeometry, left: RailMode, right: RailMode, has: { left: boolean; right: boolean }, railW: number): number {
  const l = sideRes(g, left, has.left, railW), r = sideRes(g, right, has.right, railW)
  return Math.max(l, r - 2 * g.maxShift) + Math.max(r, l - 2 * g.maxShift)
}
/** 主页宽(不含 Ribbon,布局 px)+ 两栏有没有东西 → 两栏的样子。依次试 两栏展开 → 左收右开 → 两栏图标条:
 *  ① 中间满宽,栏取 [railMin, railW] 里放得下的最宽;② 栏已到最窄,中间从 centerW 缩到 centerMin;都放不下就试下一种,最后只剩中间。
 *  缺省几何下(两边对称,所以只有右栏和两栏都有同一套门槛):≥1328 全宽(栏 256、中间 720)、≥1028 展开(栏 216、中间 500–720)、
 *  ≥668 两边都收成图标条、再窄只剩中间。历史:11-03 中间 840 不缩 → #552 空栏不占地方、栏先缩到 216 → 11-09 这一版。 */
export function railModes(width: number, has: { left: boolean; right: boolean } = { left: true, right: true }, g: RailGeometry = RAIL_GEOMETRY): RailLayout {
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
/** 中间那块的横向让位:居中放得下就居中;否则贴着有东西的那一栏留一道缝。centerW 传 railModes 算出来的那个。
 *  railModes 已按 maxShift 给少的那边留够了地方,所以这里算出的偏移不会超过 maxShift。 */
export function centerShift(width: number, left: { mode: RailMode; shown: boolean }, right: { mode: RailMode; shown: boolean }, railW = RAIL_W, g: RailGeometry = RAIL_GEOMETRY, centerW = g.centerW): number {
  const nat = (width - centerW) / 2
  const lo = reserve(g, left.mode, left.shown, railW), hi = width - reserve(g, right.mode, right.shown, railW) - centerW
  if (lo > hi) return 0
  return Math.min(Math.max(nat, lo), hi) - nat
}
