/**
 * 多窗口纯几何(无 electron 依赖 → node vitest 可测)。
 * - rectUnderPoint:跨窗拖拽落点命中测试(哪个窗口在屏幕点下)。
 * - nearestEdge / collapsedBounds / expandedBounds:mini 卡片贴边吸附折叠 ↔ 展开。
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
