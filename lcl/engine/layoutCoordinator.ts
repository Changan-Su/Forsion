import type { DockviewApi } from 'dockview-react'
import type { DockSide } from './types'
import { getView, subscribeViews } from './viewRegistry'
import { reducedMotion } from './spring'
import { nodeKey, nodeLocation, solveLayout, type LayoutBox, type LayoutNode, type LayoutRatios, type LayoutRect } from './layoutGeometry'

export interface ViewLayoutHints { minWidth?: number; minHeight?: number; preferredWidth?: number; preferredHeight?: number }
export const layoutHints = (value: ViewLayoutHints | undefined, loc = 'main'): Required<ViewLayoutHints> => {
  const valid = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(n, 4096) : fallback
  const minWidth = valid(value?.minWidth, loc === 'main' ? 320 : loc === 'left' ? 220 : 240)
  const minHeight = valid(value?.minHeight, loc === 'bottom' ? 140 : 180)
  return { minWidth, minHeight, preferredWidth: Math.max(minWidth, valid(value?.preferredWidth, minWidth)), preferredHeight: Math.max(minHeight, valid(value?.preferredHeight, minHeight)) }
}
const coordinators = new WeakMap<DockviewApi, LayoutCoordinator>()
export const layoutCoordinator = (api: DockviewApi | null | undefined): LayoutCoordinator | undefined => api ? coordinators.get(api) : undefined
const sides: DockSide[] = ['left', 'right', 'bottom']
type LayoutGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>
const location = (g: LayoutGroup): string => g.panels[0]?.params?.__loc ?? 'main'
const box = (g: LayoutGroup): LayoutRect => ({ x: 0, y: 0, width: g.api.width, height: g.api.height })
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** One clock for the entire workspace. Dockview remains the geometry/hit-testing authority:
 * every frame sizes its real grid, with exact frame constraints, then releases them for sash input.
 * No screenshot layers, transforms, opacity, DOM reparenting or content remounts. */
export class LayoutCoordinator {
  private ratios: LayoutRatios = {}
  private ratioBranches = new Map<string, { axis: string; children: string[] }>()
  private activeRatioKeys = new Set<string>()
  private intent = new Map<DockSide, boolean>()
  private rendered = new Map<string, LayoutRect>()
  private frame = 0
  private generation = 0
  private queued = false
  private ready = false
  private applying = false
  private dragging = false
  private disposed = false
  private observer: ResizeObserver
  private panelSubscriptions = new Map<string, { dispose(): void }>()
  private subscriptions: Array<{ dispose(): void }> = []
  private completions = new Map<DockSide, () => void>()
  private skipMotion = false
  private dragSide: DockSide | null = null
  private dragKey: string | null = null
  private dragStart = new Map<string, LayoutRect>()
  private targetSignature = ''
  private clippedContent = new Map<string, Partial<LayoutBox>>()
  private extent: LayoutBox = { width: 0, height: 0 }
  constructor(readonly api: DockviewApi, private viewport: HTMLElement, private canvas: HTMLElement,
    private options: { sideSize(side: DockSide, viewport: LayoutBox): number; didResize(side: DockSide | null): void; settled(): void }) {
    coordinators.set(api, this)
    this.observer = new ResizeObserver(() => { if (this.ready && !this.applying) this.refresh(false) })
    this.observer.observe(viewport)
    this.subscriptions.push(api.onWillMutateLayout(e => {
      if (this.applying) return
      if (e.kind === 'clear' || e.kind === 'load') { this.cancel(); this.skipMotion = true; this.ratios = {}; this.ratioBranches.clear(); this.activeRatioKeys.clear(); this.intent.clear(); this.rendered.clear() }
    }), api.onDidMutateLayout(() => this.request()), api.onDidActivePanelChange(() => { this.updateOverlays(); this.request() }),
      api.onDidLayoutChange(() => this.updateOverlays()))
    const watch = (panel: DockviewApi['panels'][number]) => {
      this.panelSubscriptions.get(panel.id)?.dispose()
      this.panelSubscriptions.set(panel.id, panel.api.onDidParametersChange(() => this.request()))
    }
    api.panels.forEach(watch)
    this.subscriptions.push(api.onDidAddPanel(watch), api.onDidRemovePanel(panel => { this.panelSubscriptions.get(panel.id)?.dispose(); this.panelSubscriptions.delete(panel.id) }),
      { dispose: subscribeViews(() => this.request()) })
    viewport.addEventListener('pointerdown', this.pointerDown, true)
    window.addEventListener('pointerup', this.pointerUp, true)
    window.addEventListener('pointercancel', this.pointerUp, true)
  }
  get busy(): boolean { return this.applying || !!this.frame || this.queued }
  get userResizing(): boolean { return this.dragging }
  visible(side: DockSide): boolean {
    const intended = this.intent.get(side)
    return intended !== false && this.api.groups.some(g => location(g) === side && g.panels.length && (intended === true || g.api.isVisible))
  }
  initialize(): void { this.ready = true; this.refresh(false) }
  private cancel(): void { ++this.generation; cancelAnimationFrame(this.frame); this.frame = 0; this.targetSignature = '' }
  private pointerDown = (e: PointerEvent): void => {
    if (!(e.target instanceof Element) || !e.target.closest('.dv-sash')) return
    this.cancel(); this.dragging = true
    this.dragStart = new Map(this.api.groups.map(g => [g.id, box(g)]))
    const split = e.target.closest('.dv-split-view-container')
    const ids = this.api.groups.filter(g => g.panels.length && split?.contains(g.element)).map(g => g.id).sort().join(',')
    const tree = this.readTree()
    const leafIds = (n: LayoutNode): string[] => 'id' in n ? [n.id] : n.children.flatMap(leafIds)
    const axis = split?.classList.contains('dv-horizontal') ? 'width' : 'height'
    const find = (n: LayoutNode): Exclude<LayoutNode, { id: string }> | null => 'id' in n ? null : n.axis === axis && leafIds(n).sort().join(',') === ids ? n : n.children.map(find).find(Boolean) ?? null
    const branch = tree ? find(tree) : null
    this.dragKey = branch?.key ?? null
    const sash = e.target.closest('.dv-sash')!
    const index = [...sash.parentElement!.children].indexOf(sash)
    const adjacent = branch?.children.slice(index, index + 2).map(nodeLocation) ?? []
    this.dragSide = sides.find(side => adjacent.includes(side) && branch && nodeLocation(branch) !== side && (side === 'bottom' ? axis === 'height' : axis === 'width')) ?? null
  }
  private pointerUp = (): void => {
    if (!this.dragging) return
    this.dragging = false
    const moved = this.api.groups.some(g => { const before = this.dragStart.get(g.id); return before && (Math.abs(before.width - g.api.width) > 0.5 || Math.abs(before.height - g.api.height) > 0.5) })
    this.dragStart.clear()
    const saved = this.ratios
    this.ratios = {}; this.readTree(true)
    const changed = this.dragKey ? this.ratios[this.dragKey] : undefined
    this.ratios = saved
    if (moved && this.dragKey && changed && !this.dragSide) this.ratios[this.dragKey] = changed
    this.dragKey = null // Only the branch whose sash was dragged replaces the person's ratios.
    this.rendered = new Map(this.api.groups.map(g => [g.id, box(g)]))
    if (moved) this.options.didResize(this.dragSide)
    this.dragSide = null
    this.refresh(false)
  }
  /** Queue synchronous compound changes once, before the next paint. */
  request(): void {
    if (!this.ready || this.applying || this.dragging || this.queued || this.disposed) return
    this.queued = true
    queueMicrotask(() => { this.queued = false; if (!this.disposed) this.refresh(true) })
  }
  setVisible(side: DockSide, visible: boolean, done?: () => void): void {
    this.intent.set(side, visible)
    if (done) this.completions.set(side, done)
    if (visible) for (const g of this.api.groups) if (location(g) === side && !g.api.isVisible) g.api.setVisible(true)
    this.request()
  }
  /** Explicit opens in a parked group reveal it, using the same transaction as the +/toggle path. */
  reveal(side: DockSide): void { if (!this.visible(side)) this.setVisible(side, true) }
  exportRatios(): LayoutRatios { return structuredClone(this.ratios) }
  restoreRatios(value: unknown, sidebars?: Partial<Record<DockSide, { visible: boolean }>>): void {
    if (sidebars) for (const side of sides) {
      const visible = sidebars[side]?.visible ?? false
      this.intent.set(side, visible)
      for (const g of this.api.groups) if (location(g) === side) g.api.setVisible(visible)
    }
    this.ratios = {}
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, weights] of Object.entries(value)) {
      if (Array.isArray(weights) && weights.length <= 100 && weights.every(w => typeof w === 'number' && Number.isFinite(w) && w >= 0) && weights.some(w => w > 0)) this.ratios[key] = weights
    }
    this.request()
  }
  private readTree(capture = false): LayoutNode | null {
    const grid = this.api.toJSON().grid
    if (!grid?.root) return null
    const nextKeys = new Set<string>()
    const walk = (n: typeof grid.root, axis: 'width' | 'height'): LayoutNode | null => {
      if (Array.isArray(n.data)) {
        const children = n.data.map(c => walk(c, axis === 'width' ? 'height' : 'width')).filter((c): c is LayoutNode => !!c)
        if (!children.length) return null
        const key = `${axis}(${children.map(nodeKey).join(',')})`
        const size = { width: axis === 'width' ? children.reduce((s, c) => s + c.size.width, 0) : Math.max(...children.map(c => c.size.width)),
          height: axis === 'height' ? children.reduce((s, c) => s + c.size.height, 0) : Math.max(...children.map(c => c.size.height)) }
        nextKeys.add(key)
        if (capture || !this.ratios[key] || this.ratios[key].length !== children.length || (this.rendered.size && !this.skipMotion && !this.activeRatioKeys.has(key))) {
          const childKeys = children.map(nodeKey), weights = children.map(c => Math.max(1, c.size[axis]))
          const flexibleKeys = children.filter(c => { const loc = nodeLocation(c); return !(axis === 'width' ? loc === 'left' || loc === 'right' : loc === 'bottom') }).map(nodeKey)
          // A sidebar insertion/removal can change a branch key while its Main children survive.
          // Transfer their remembered proportions, never seed them from a clamped viewport.
          const candidates = capture ? [] : [...this.ratioBranches].filter(([old, b]) => b.axis === axis && this.ratios[old] && this.activeRatioKeys.has(old))
            .map(([old, b]) => ({ old, children: b.children, shared: flexibleKeys.filter(k => b.children.includes(k)) }))
            .filter(b => b.shared.length >= 2 && b.shared.length === flexibleKeys.length).sort((a, b) => b.shared.length - a.shared.length)
          const prior = candidates[0]
          if (prior) {
            const priorTotal = prior.shared.reduce((sum, k) => sum + this.ratios[prior.old][prior.children.indexOf(k)], 0)
            const currentTotal = prior.shared.reduce((sum, k) => sum + weights[childKeys.indexOf(k)], 0)
            if (priorTotal > 0) for (const k of prior.shared) weights[childKeys.indexOf(k)] = currentTotal * this.ratios[prior.old][prior.children.indexOf(k)] / priorTotal
          }
          this.ratios[key] = weights
        }
        this.ratioBranches.set(key, { axis, children: children.map(nodeKey) })
        return { key, axis, children, size }
      }
      const g = this.api.getGroup(n.data.id)
      if (!g || !g.panels.length) return null
      const loc = location(g), hints = g.panels.map(p => layoutHints(getView(p.params?.__type)?.layout, loc))
      const size = box(g)
      if (this.ready && !this.skipMotion && !this.rendered.has(g.id)) {
        const declarations = g.panels.map(p => getView(p.params?.__type)?.layout)
        if (declarations.some(h => h?.preferredWidth)) size.width = Math.max(...hints.map(h => h.preferredWidth))
        if (declarations.some(h => h?.preferredHeight)) size.height = Math.max(...hints.map(h => h.preferredHeight))
      }
      return { id: g.id, loc, visible: loc === 'main' ? g.api.isVisible : this.visible(loc as DockSide), size,
        min: { width: Math.max(...hints.map(v => v.minWidth)), height: Math.max(...hints.map(v => v.minHeight)) } }
    }
    const tree = walk(grid.root, grid.orientation === 'HORIZONTAL' ? 'width' : 'height')
    this.activeRatioKeys = nextKeys
    return tree
  }
  refresh(animate = true): void {
    if (!this.ready || this.disposed || this.dragging || this.applying) return
    animate = animate && !this.skipMotion
    const tree = this.readTree()
    this.skipMotion = false
    if (!tree) return
    // client sizes are logical CSS pixels, including under application zoom.
    const viewport = { width: this.viewport.clientWidth, height: this.viewport.clientHeight }
    if (!viewport.width || !viewport.height) return
    const target = solveLayout(tree, viewport, this.ratios, Object.fromEntries(sides.map(s => [s, this.options.sideSize(s, viewport)])))
    const signature = JSON.stringify([...target.boxes]) + JSON.stringify(target.size)
    if (signature === this.targetSignature && this.rendered.size && !this.completions.size) { this.updateOverlays(); return }
    this.targetSignature = signature
    const start = this.rendered, startExtent = this.extent.width ? this.extent : target.size
    const from = new Map<string, LayoutRect>()
    for (const [id, rect] of target.boxes) {
      const g = this.api.getGroup(id)!, loc = location(g), prior = start.get(id)
      // A new split grows on its own split axis; a new side grows from the corresponding edge.
      const current = box(g)
      const parentAxis = (n: LayoutNode): string | undefined => 'id' in n ? undefined : n.children.some(c => 'id' in c && c.id === id) ? n.axis : n.children.map(parentAxis).find(Boolean)
      const collapsed = { ...current, ...(loc === 'bottom' || (loc === 'main' && parentAxis(tree) === 'height') ? { height: 0 } : { width: 0 }) }
      from.set(id, prior ?? (animate && start.size ? collapsed : rect))
    }
    // Entering/leaving content keeps its readable dimensions behind the moving boundary.
    // Existing neighbours really reflow; there is no scaled or crossfaded content layer.
    this.clippedContent = new Map([...target.boxes].map(([id, b]) => {
      const a = from.get(id)!, prior = this.clippedContent.get(id)
      return [id, { ...(!a.width || !b.width || prior?.width ? { width: Math.max(a.width, b.width, prior?.width ?? 0) } : {}), ...(!a.height || !b.height || prior?.height ? { height: Math.max(a.height, b.height, prior?.height ?? 0) } : {}) }]
    }))
    ++this.generation; const generation = this.generation
    cancelAnimationFrame(this.frame); this.frame = 0
    const style = getComputedStyle(this.viewport)
    const token = style.getPropertyValue('--collapse-duration').trim()
    const duration = Math.max(0, parseFloat(token) * (token.endsWith('ms') ? 1 : 1000)) || 200
    const curve = style.getPropertyValue('--collapse-ease').match(/cubic-bezier\(([^)]+)\)/)?.[1].split(',').map(Number) ?? [0.32, 0.72, 0, 1]
    const ease = bezier(curve)
    const different = [...target.boxes].some(([id, r]) => Math.abs(r.width - from.get(id)!.width) > 0.5 || Math.abs(r.height - from.get(id)!.height) > 0.5)
    const finish = (): void => {
      this.frame = 0
      this.applying = true
      try { for (const g of this.api.groups) { const loc = location(g); if (loc !== 'main' && !this.visible(loc as DockSide)) g.api.setVisible(false) } }
      finally { this.applying = false }
      // Re-evaluate sash affordances after releasing exact frame constraints.
      this.applying = true
      try { this.api.layout(this.extent.width, this.extent.height, true); this.updateOverlays() } finally { this.applying = false }
      this.clippedContent.clear(); this.updateOverlays()
      this.viewport.dataset.layoutPhase = 'settled'
      const callbacks = [...this.completions.values()]; this.completions.clear(); callbacks.forEach(f => f())
      this.options.settled()
    }
    if (!animate || reducedMotion() || !different) { this.apply(tree, target.boxes, target.size); finish(); return }
    this.viewport.dataset.layoutPhase = 'transition'
    const started = performance.now()
    const tick = (now: number): void => {
      if (generation !== this.generation || this.disposed) return
      const progress = Math.min(1, Math.max(0, (now - started) / duration)), k = ease(progress)
      const boxes = new Map([...target.boxes].map(([id, b]) => { const a = from.get(id)!; return [id, { x: mix(a.x, b.x, k), y: mix(a.y, b.y, k), width: mix(a.width, b.width, k), height: mix(a.height, b.height, k) }] }))
      this.apply(tree, boxes, { width: mix(startExtent.width, target.size.width, k), height: mix(startExtent.height, target.size.height, k) })
      if (progress < 1) this.frame = requestAnimationFrame(tick); else finish()
    }
    tick(started)
  }
  private apply(tree: LayoutNode, boxes: Map<string, LayoutRect>, size: LayoutBox): void {
    this.applying = true
    try {
      this.canvas.style.width = `${size.width}px`; this.canvas.style.height = `${size.height}px`
      for (const [id, r] of boxes) this.api.getGroup(id)?.api.setConstraints({ minimumWidth: r.width, maximumWidth: r.width, minimumHeight: r.height, maximumHeight: r.height })
      this.api.layout(size.width, size.height, true)
      // Commit native split proportions while exact frame constraints still hold.
      // Otherwise Dockview's next layout restores its pre-transaction proportions.
      for (const [id, r] of boxes) this.api.getGroup(id)?.api.setSize({ width: r.width, height: r.height })
      this.updateOverlays()
      const release = (n: LayoutNode): void => {
        if ('id' in n) this.api.getGroup(n.id)?.api.setConstraints({ minimumWidth: n.visible ? n.min.width : 0, minimumHeight: n.visible ? n.min.height : 0, maximumWidth: Number.MAX_SAFE_INTEGER, maximumHeight: Number.MAX_SAFE_INTEGER })
        else n.children.forEach(release)
      }
      release(tree)
      this.rendered = boxes; this.extent = size
    } finally { this.applying = false }
  }
  /** Dockview 7 always-renderer positions in physical pixels on a later RAF. Keep its stable
   * containers, but own their logical-pixel geometry in the same frame as their native groups.
   * CSS properties are non-inheriting: heavy View subtrees are not restyled by every frame. */
  private updateOverlays(): void {
    for (const panel of this.api.panels) {
      const overlay = panel.view.content.element.closest<HTMLElement>('.dv-render-overlay')
      const group = panel.group, reference = group.element.querySelector<HTMLElement>('.dv-content-container')
      if (!overlay || !reference) continue
      const content = overlay.firstElementChild as HTMLElement | null, clipped = this.clippedContent.get(group.id)
      if (content) { content.style.minWidth = clipped?.width ? `${clipped.width}px` : ''; content.style.minHeight = clipped?.height ? `${Math.max(0, clipped.height - (group.api.height - reference.clientHeight))}px` : '' }
      overlay.dataset.lclGroup = group.id
      overlay.dataset.lclLoc = location(group)
      overlay.dataset.lclVisible = String(panel.api.isVisible)
      overlay.dataset.lclActive = String(panel.api.isVisible && this.api.activePanel === panel)
      overlay.inert = !panel.api.isVisible
      if (!panel.api.isVisible) continue
      const root = overlay.parentElement!, rr = root.getBoundingClientRect(), r = reference.getBoundingClientRect()
      const zoom = root.offsetWidth ? rr.width / root.offsetWidth : 1
      for (const [name, value] of Object.entries({ x: (r.left - rr.left) / zoom, y: (r.top - rr.top) / zoom, w: r.width / zoom, h: r.height / zoom })) overlay.style.setProperty(`--lcl-panel-${name}`, `${value}px`)
      // Dockview hides a new overlay until its own next-frame placement. A panel rebuilt under the same id inside
      // that frame never gets one: the pending placement stays bound to the removed element and blocks a new
      // request, so the View stays blank until the next resize. Geometry is already owned here; reveal it.
      if (overlay.style.visibility === 'hidden') { overlay.style.visibility = ''; overlay.style.pointerEvents = '' }
    }
  }
  dispose(): void {
    this.disposed = true; this.cancel(); this.observer.disconnect(); this.subscriptions.forEach(s => s.dispose())
    this.viewport.removeEventListener('pointerdown', this.pointerDown, true)
    window.removeEventListener('pointerup', this.pointerUp, true); window.removeEventListener('pointercancel', this.pointerUp, true)
    this.panelSubscriptions.forEach(s => s.dispose()); this.panelSubscriptions.clear()
    const completions = [...this.completions.values()]; this.completions.clear(); completions.forEach(done => done())
    coordinators.delete(this.api)
  }
}
/** CSS cubic-bezier evaluated by x, not by its parameter. */
export function bezier(points: number[]): (x: number) => number {
  const [x1, y1, x2, y2] = points.length === 4 && points.every(Number.isFinite) ? points : [0.32, 0.72, 0, 1]
  const curve = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
  return x => { let lo = 0, hi = 1; for (let i = 0; i < 16; i++) { const t = (lo + hi) / 2; if (curve(t, x1, x2) < x) lo = t; else hi = t } return curve((lo + hi) / 2, y1, y2) }
}
