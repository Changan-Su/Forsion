/**
 * 画布几何内核 —— **纯函数,零 React、零 ProseMirror、零 DOM**(node 可测)。
 *
 * View 基座方案 §6.4 S2:Amadeus 画布(`canvasStage`)与仪表盘(`DashboardCanvasView`)此前各写
 * 一份平移缩放与调整尺寸,手感因此对不上(2026-08-25 用户实报)。这里是两边共同的那一份。
 * PM 相关的东西**一律不进来**(dragCss / pmOwns / transaction 是 canvasStage 独有的负担,
 * 它们存在的唯一原因是 PM 拥有卡片 DOM;仪表盘的卡就是普通绝对定位 div)。
 */

export interface Box { x: number; y: number; w: number; h: number }

/** 点阵步长(吸附与方向键微移共用这一个数)。 */
export const GRID_STEP = 24
/** 缩放钳位。两边同档,否则「同一份画布换个地方缩放上限不一样」。 */
export const MIN_Z = 0.25
export const MAX_Z = 2.5
/** 方向键微移一步(不吸附时)。 */
export const NUDGE = 8
/** 指针一次都没真正移动过(纯点击)的判据,**舞台单位**。 */
export const CLICK_SLOP = 3
/** 触屏版同一道闸,**屏幕像素** —— 进 onDown 时才 ÷(z × 页面 zoom)换算成舞台单位。
 *  手指抖动比鼠标大一个数量级,写死舞台单位会在缩小后把「点一下」判成拖动(08-23 实证)。 */
export const TOUCH_SLOP = 10
/** 长按出菜单(触屏的右键):时长与作废半径(半径按屏幕像素算)。 */
export const LONG_PRESS_MS = 500
export const PRESS_SLOP = 10

export type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

export const snapGrid = (v: number): number => Math.round(v / GRID_STEP) * GRID_STEP

/** 四边/四角调整盒子;固定对边不动,开吸附时**只量化正在移动的那条边**。 */
export function resizeBox(b: Box, edge: ResizeEdge, dx: number, dy: number, snap: boolean, minW: number, minH: number): Box {
  const west = edge.includes('w')
  const east = edge.includes('e')
  const north = edge.includes('n')
  const south = edge.includes('s')
  let left = west ? b.x + dx : b.x
  let right = east ? b.x + b.w + dx : b.x + b.w
  let top = north ? b.y + dy : b.y
  let bottom = south ? b.y + b.h + dy : b.y + b.h
  if (snap) {
    if (west) left = snapGrid(left)
    if (east) right = snapGrid(right)
    if (north) top = snapGrid(top)
    if (south) bottom = snapGrid(bottom)
  } else {
    left = Math.round(left); right = Math.round(right); top = Math.round(top); bottom = Math.round(bottom)
  }
  if (right - left < minW) {
    if (west) left = right - minW
    else right = left + minW
  }
  if (bottom - top < minH) {
    if (north) top = bottom - minH
    else bottom = top + minH
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 两个盒子相交?(边贴边不算) */
export const boxOverlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** 由两点定一个规范化的矩形(框选用:反向拖也得到正的 w/h)。 */
export const boxFromPoints = (ax: number, ay: number, bx: number, by: number): Box => ({
  x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay),
})

/** 框选命中:与选框相交的键。**相交即中**(不要求整个包住)—— 画布与 Figma/Excalidraw 同款。 */
export function marqueeHit(marquee: Box, boxes: Iterable<[string, Box]>): string[] {
  const out: string[] = []
  for (const [key, b] of boxes) if (boxOverlaps(marquee, b)) out.push(key)
  return out
}

/** 一组盒子的外接盒;空集给 null。 */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

// ───────────────────────── 贴邻居边缘吸附(拼版用) ─────────────────────────
//
// 点阵吸附保证「都落在同一张网上」,但只要卡片尺寸不是步长的整倍数,两张卡就永远差那么几像素 ——
// 而仪表盘锁定后是**一张拼出来的页面**,那几像素就是破绽。所以再加一层:拖近邻居的边就吸上去。
// 判定在**舞台坐标**里做,容差由调用方按缩放折算(屏幕上看着一样近,缩小后舞台距离更大)。

/** 对齐参考线(舞台坐标)。v = 竖线的 x,h = 横线的 y。渲染成细线给用户看「吸到哪儿了」。 */
export interface SnapGuides { v: number[]; h: number[] }

const EMPTY_GUIDES: SnapGuides = { v: [], h: [] }

/** 一根轴上的三个特征位置:起、中、止。 */
const marks = (start: number, size: number): number[] => [start, start + size / 2, start + size]

/** 求单轴上最近的一次吸附。返回位移量与命中的参考线;没够到容差就给 null。 */
function bestSnap(mine: number[], theirs: number[], tol: number): { d: number; line: number } | null {
  let best: { d: number; line: number } | null = null
  for (const m of mine) {
    for (const t of theirs) {
      const d = t - m
      if (Math.abs(d) > tol) continue
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, line: t }
    }
  }
  return best
}

/** 拖动时贴邻居:给出该额外施加的位移与要画的参考线。多选传外接盒(整批同一个位移)。 */
export function snapMoveToNeighbors(box: Box, others: readonly Box[], tol: number): { dx: number; dy: number; guides: SnapGuides } {
  if (!others.length || tol <= 0) return { dx: 0, dy: 0, guides: EMPTY_GUIDES }
  const xs: number[] = []
  const ys: number[] = []
  for (const o of others) { xs.push(...marks(o.x, o.w)); ys.push(...marks(o.y, o.h)) }
  const bx = bestSnap(marks(box.x, box.w), xs, tol)
  const by = bestSnap(marks(box.y, box.h), ys, tol)
  return { dx: bx?.d ?? 0, dy: by?.d ?? 0, guides: { v: bx ? [bx.line] : [], h: by ? [by.line] : [] } }
}

/** 调整尺寸时贴邻居:**只吸正在动的那几条边**(固定的对边一步都不许挪)。 */
export function snapResizeToNeighbors(box: Box, edge: ResizeEdge, others: readonly Box[], tol: number, minW: number, minH: number): { box: Box; guides: SnapGuides } {
  if (!others.length || tol <= 0) return { box, guides: EMPTY_GUIDES }
  const xs: number[] = []
  const ys: number[] = []
  for (const o of others) { xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h) }
  let { x, y, w, h } = box
  const guides: SnapGuides = { v: [], h: [] }
  if (edge.includes('w')) {
    const s = bestSnap([x], xs, tol)
    if (s && w - s.d >= minW) { x += s.d; w -= s.d; guides.v.push(s.line) }
  } else if (edge.includes('e')) {
    const s = bestSnap([x + w], xs, tol)
    if (s && w + s.d >= minW) { w += s.d; guides.v.push(s.line) }
  }
  if (edge.includes('n')) {
    const s = bestSnap([y], ys, tol)
    if (s && h - s.d >= minH) { y += s.d; h -= s.d; guides.h.push(s.line) }
  } else if (edge.includes('s')) {
    const s = bestSnap([y + h], ys, tol)
    if (s && h + s.d >= minH) { h += s.d; guides.h.push(s.line) }
  }
  return { box: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, guides }
}

/** 贴邻居的容差(**屏幕像素**;进手势时 ÷(z × 页面 zoom)换算成舞台单位)。 */
export const NEIGHBOR_SNAP_PX = 7
