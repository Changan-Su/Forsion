/** Pure workspace geometry. User ratios are inputs; constrained output never writes them back. */
export type LayoutAxis = 'width' | 'height'
export interface LayoutBox { width: number; height: number }
export interface LayoutRect extends LayoutBox { x: number; y: number }
export type LayoutNode = { id: string; min: LayoutBox; visible: boolean; loc: string; size: LayoutBox }
  | { key: string; axis: LayoutAxis; children: LayoutNode[]; size: LayoutBox }
export type LayoutRatios = Record<string, number[]>
export const nodeKey = (n: LayoutNode): string => 'id' in n ? n.id : n.key
export const nodeLocation = (n: LayoutNode): string => {
  if ('id' in n) return n.loc
  const locs = new Set(n.children.map(nodeLocation))
  return locs.size === 1 ? [...locs][0] : 'mixed'
}
export function minimum(n: LayoutNode): LayoutBox {
  if ('id' in n) return n.visible ? n.min : { width: 0, height: 0 }
  const c = n.children.map(minimum)
  return { width: n.axis === 'width' ? c.reduce((s, v) => s + v.width, 0) : Math.max(0, ...c.map(v => v.width)),
    height: n.axis === 'height' ? c.reduce((s, v) => s + v.height, 0) : Math.max(0, ...c.map(v => v.height)) }
}
/** Water filling: pin undersized children at their minimum and redistribute the remainder. */
export function allocate(total: number, weights: number[], mins: number[]): number[] {
  const out = mins.map(() => 0), pending = new Set(mins.map((_, i) => i))
  let remaining = Math.max(total, mins.reduce((a, b) => a + b, 0))
  while (pending.size) {
    const sum = [...pending].reduce((s, i) => s + Math.max(0, weights[i] || 0), 0)
    const value = (i: number) => remaining * (sum ? Math.max(0, weights[i] || 0) / sum : 1 / pending.size)
    const clamped = [...pending].filter(i => value(i) < mins[i])
    if (!clamped.length) { for (const i of pending) out[i] = value(i); break }
    for (const i of clamped) { out[i] = mins[i]; remaining -= mins[i]; pending.delete(i) }
  }
  return out
}
export function solveLayout(tree: LayoutNode, viewport: LayoutBox, ratios: LayoutRatios, sides: Record<string, number>): { size: LayoutBox; boxes: Map<string, LayoutRect> } {
  const min = minimum(tree), size = { width: Math.max(viewport.width, min.width), height: Math.max(viewport.height, min.height) }
  const boxes = new Map<string, LayoutRect>()
  const walk = (n: LayoutNode, rect: LayoutRect): void => {
    if ('id' in n) { boxes.set(n.id, rect); return }
    const axis = n.axis
    const mins = n.children.map(c => minimum(c)[axis])
    const weights = n.children.map((c, i) => mins[i] ? (ratios[n.key]?.[i] ?? c.size[axis] ?? 1) : 0)
    const fixed = n.children.map((c, i) => {
      const loc = nodeLocation(c)
      return mins[i] && ((axis === 'width' && (loc === 'left' || loc === 'right')) || (axis === 'height' && loc === 'bottom'))
        && nodeLocation(n) !== loc ? Math.max(mins[i], sides[loc] || mins[i]) : null
    })
    const flex = n.children.map((_, i) => i).filter(i => fixed[i] === null && mins[i] > 0)
    const sizes = fixed.map(v => v ?? 0)
    if (flex.length) {
      // Side requests may exceed the available space: expand the canvas, never steal a View's minimum.
      const available = rect[axis] - sizes.reduce((a, b) => a + b, 0)
      const allocated = allocate(available, flex.map(i => weights[i]), flex.map(i => mins[i]))
      flex.forEach((i, j) => { sizes[i] = allocated[j] })
    } else if (mins.some(v => v > 0) && sizes.reduce((a, b) => a + b, 0) < rect[axis]) {
      const allocated = allocate(rect[axis], weights, mins)
      allocated.forEach((v, i) => { sizes[i] = v })
    }
    let offset = 0
    n.children.forEach((c, i) => {
      walk(c, { x: rect.x + (axis === 'width' ? offset : 0), y: rect.y + (axis === 'height' ? offset : 0),
        width: axis === 'width' ? sizes[i] : rect.width, height: axis === 'height' ? sizes[i] : rect.height })
      offset += sizes[i]
    })
  }
  // Preferred shell sizes are part of the workspace's minimum extent.
  const requestedMinimum = (n: LayoutNode): LayoutBox => {
    if ('id' in n) return minimum(n)
    const m = n.children.map(c => {
      const v = requestedMinimum(c), loc = nodeLocation(c)
      if (nodeLocation(n) !== loc && v[n.axis] && ((n.axis === 'width' && (loc === 'left' || loc === 'right')) || (n.axis === 'height' && loc === 'bottom'))) v[n.axis] = Math.max(v[n.axis], sides[loc] || 0)
      return v
    })
    return { width: n.axis === 'width' ? m.reduce((s, v) => s + v.width, 0) : Math.max(0, ...m.map(v => v.width)),
      height: n.axis === 'height' ? m.reduce((s, v) => s + v.height, 0) : Math.max(0, ...m.map(v => v.height)) }
  }
  const requested = requestedMinimum(tree)
  size.width = Math.max(size.width, requested.width); size.height = Math.max(size.height, requested.height)
  walk(tree, { x: 0, y: 0, ...size })
  return { size, boxes }
}
