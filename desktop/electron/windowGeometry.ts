/**
 * 多窗口纯几何(无 electron 依赖 → node vitest 可测)。
 * - rectUnderPoint:跨窗拖拽落点命中测试(哪个窗口在屏幕点下)。
 * - nearestEdge / collapsedBounds / expandedBounds:mini 卡片贴边吸附折叠 ↔ 展开。
 * - resizeFromEdge:mini 卡片自绘缩放边(透明无边框窗在 Windows 上没有系统缩放边)。
 * 折叠策略 = 不改尺寸,把窗口滑出工作区、只露 peek px 的把手(mouseenter 该把手即展开;
 * 保尺寸不 reflow → Mini Card 内容不抖)。expandedBounds 是 collapsedBounds 的逆(尺寸不变故可逆推)。
 */
export interface Rect { x: number; y: number; width: number; height: number }
export type Edge = 'left' | 'right' | 'top' | 'bottom'

/** 屏幕点落在哪个矩形(按数组顺序从后往前 = 调用方传 z 序,后者在上)。返回索引,未命中 -1。 */
export function rectUnderPoint(rects: Rect[], x: number, y: number): number {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return i
  }
  return -1
}

/** 窗口贴近工作区哪条边(阈值内);都不贴 → null。左右优先于上下(卡片竖长,侧边吸附更自然)。 */
export function nearestEdge(bounds: Rect, workArea: Rect, threshold = 12): Edge | null {
  if (bounds.x - workArea.x <= threshold) return 'left'
  if ((workArea.x + workArea.width) - (bounds.x + bounds.width) <= threshold) return 'right'
  if (bounds.y - workArea.y <= threshold) return 'top'
  if ((workArea.y + workArea.height) - (bounds.y + bounds.height) <= threshold) return 'bottom'
  return null
}

/** 折叠:窗口滑出工作区、只露 peek px 薄条(尺寸不变)。另一轴保持原位。 */
export function collapsedBounds(bounds: Rect, edge: Edge, workArea: Rect, peek = 8): Rect {
  switch (edge) {
    case 'left': return { ...bounds, x: workArea.x - bounds.width + peek }
    case 'right': return { ...bounds, x: workArea.x + workArea.width - peek }
    case 'top': return { ...bounds, y: workArea.y - bounds.height + peek }
    case 'bottom': return { ...bounds, y: workArea.y + workArea.height - peek }
  }
}

/** 展开:折叠的逆 —— 窗口贴边完整回到工作区内(尺寸不变)。 */
export function expandedBounds(bounds: Rect, edge: Edge, workArea: Rect): Rect {
  switch (edge) {
    case 'left': return { ...bounds, x: workArea.x }
    case 'right': return { ...bounds, x: workArea.x + workArea.width - bounds.width }
    case 'top': return { ...bounds, y: workArea.y }
    case 'bottom': return { ...bounds, y: workArea.y + workArea.height - bounds.height }
  }
}

/** 矩形与工作区的可见交集(折叠后只露一条时=那条薄条的屏上矩形)。无交集则 width/height≤0。 */
export function visibleRect(b: Rect, wa: Rect): Rect {
  const x1 = Math.max(b.x, wa.x), y1 = Math.max(b.y, wa.y)
  const x2 = Math.min(b.x + b.width, wa.x + wa.width), y2 = Math.min(b.y + b.height, wa.y + wa.height)
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/** 点在矩形内(含边)。 */
export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
}

/** 四周外扩 m px(迟滞/触发容差用)。 */
export function growRect(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m }
}

/** 拖 edge(n / s 与 e / w 的组合,如 'se')把 start 拉伸 (dx, dy):对边不动,只动被拖的那个轴,尺寸夹在 [min, max];
 *  给了 within(工作区)时被拖的边不拉出它 —— 伸到屏幕外的卡片一挪就会被 nearestEdge 判成贴边、折起来。 */
export function resizeFromEdge(start: Rect, edge: string, dx: number, dy: number,
  min: { width: number; height: number }, max: { width: number; height: number }, within?: Rect): Rect {
  const axis = (size: number, d: number, lo: number, hi: number, room: number): number =>
    Math.round(Math.min(Math.max(lo, Math.min(hi, room)), Math.max(lo, size + d)))
  const width = edge.includes('e') ? axis(start.width, dx, min.width, max.width, within ? within.x + within.width - start.x : Infinity)
    : edge.includes('w') ? axis(start.width, -dx, min.width, max.width, within ? start.x + start.width - within.x : Infinity) : start.width
  const height = edge.includes('s') ? axis(start.height, dy, min.height, max.height, within ? within.y + within.height - start.y : Infinity)
    : edge.includes('n') ? axis(start.height, -dy, min.height, max.height, within ? start.y + start.height - within.y : Infinity) : start.height
  return {
    x: edge.includes('w') ? start.x + start.width - width : start.x,
    y: edge.includes('n') ? start.y + start.height - height : start.y,
    width, height,
  }
}

/** 两个矩形有没有面积上的重叠(只碰边不算)。 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** 新开的 Mini 落在哪(LCL 表面规范第二期,多开):沿工作区右缘从上往下找第一块不压着别的 Mini 的空位,
 *  这一列排满就往左换一列;所有列都满了,从右上角往左下错开(不叠在同一处)。按已开那些窗的**当前**位置算,
 *  用户拖走的那扇空出来的位置会被重新用上。离边 inset(> 贴边阈值 12),所以新窗不会一放下就被判成贴边折起来。 */
export function stackPosition(size: { width: number; height: number }, work: Rect, occupied: readonly Rect[], inset = 24, gap = 12): { x: number; y: number } {
  const right = work.x + work.width - inset, bottom = work.y + work.height - inset
  for (let col = 0; ; col++) {
    const x = right - size.width - col * (size.width + gap)
    if (col > 0 && x < work.x + inset) break
    let y = work.y + inset
    while (y + size.height <= bottom || (y === work.y + inset && col === 0)) {
      const slot = { x, y, ...size }
      const hits = occupied.filter((o) => rectsOverlap(slot, o))
      if (!hits.length) return { x, y }
      const next = Math.max(...hits.map((o) => o.y + o.height)) + gap
      if (next <= y) break // 防御:不前进就换列
      y = next
    }
    if (x - size.width - gap < work.x + inset) break
  }
  const step = 24 * (occupied.length % 8)
  return {
    x: Math.max(work.x + inset, right - size.width - step),
    y: Math.min(Math.max(work.y + inset, bottom - size.height), work.y + inset + step),
  }
}

/** 记住的位置还能不能用:至少有一块 80×40 露在某块屏的工作区里(拔掉的显示器 / 换了分辨率 = 不能用,重新排)。 */
export function mostlyOnScreen(r: Rect, workAreas: readonly Rect[]): boolean {
  return workAreas.some((w) => {
    const ix = Math.min(r.x + r.width, w.x + w.width) - Math.max(r.x, w.x)
    const iy = Math.min(r.y + r.height, w.y + w.height) - Math.max(r.y, w.y)
    return ix >= Math.min(80, r.width) && iy >= Math.min(40, r.height)
  })
}
