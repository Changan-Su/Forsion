/** Opt-in selection paint for reading surfaces and editors. Never changes Selection, focus or content DOM.
 * The SVG lives outside the surface, below popovers. Native selection is hidden only after geometry is ready.
 * Coarse pointers and custom PDF/code-editor selection layers retain their native selection/handles.
 */
import './lineSelection.css'

export interface SelectionRect { left: number; top: number; right: number; bottom: number }
export interface SelectionFragment extends SelectionRect { group: unknown; lineHeight: number; clip: SelectionRect; atomic?: boolean; display?: boolean }
export interface LineSelectionOptions {
  editable?: boolean
  /** Popover content paints above its own card; reading surfaces stay below popovers. */
  zIndex?: number
  suspended?: () => boolean
  /** E.g. a note's pending AI target after its native selection collapses. */
  retained?: () => Range | null
}
export interface LineSelectionHandle { refresh: () => void; dispose: () => void }

const intersect = (a: SelectionRect, b: SelectionRect): SelectionRect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })
const valid = (r: SelectionRect): boolean => [r.left, r.top, r.right, r.bottom].every(Number.isFinite) && r.right - r.left > 0.2 && r.bottom - r.top > 0.2

/** One height per visual line, separate runs for disjoint bidi ranges/cells/columns. */
export function selectionLineRects(fragments: SelectionFragment[]): SelectionRect[] {
  const groups = new Map<unknown, SelectionFragment[]>()
  for (const f of fragments) { const group = groups.get(f.group) ?? []; group.push(f); groups.set(f.group, group) }
  const out: SelectionRect[] = []
  for (const group of groups.values()) {
    const rows: Array<{ cy: number; height: number; parts: SelectionFragment[] }> = []
    // Ordinary glyphs establish the baseline. Fractions/superscripts cannot create extra rows.
    for (const f of group.sort((a, b) => Number(!!a.atomic) - Number(!!b.atomic) || a.top - b.top)) {
      const cy = (f.top + f.bottom) / 2
      let row = rows.find((r) => Math.abs(r.cy - cy) <= Math.max(3, Math.min(r.height, f.lineHeight) * 0.3))
      if (!row) { row = { cy, height: f.display ? f.bottom - f.top + 2 : f.lineHeight, parts: [] }; rows.push(row) }
      row.parts.push(f)
      row.height = Math.max(row.height, f.display ? f.bottom - f.top + 2 : f.lineHeight)
    }
    for (const row of rows) {
      let run: SelectionRect | null = null
      for (const f of row.parts.sort((a, b) => a.left - b.left)) {
        const band = intersect({ left: f.left, right: f.right, top: row.cy - (row.height - 1) / 2, bottom: row.cy + (row.height - 1) / 2 }, f.clip)
        if (!valid(band)) continue
        if (run && band.left - run.right <= 2 && Math.abs(run.top - band.top) < 1 && Math.abs(run.bottom - band.bottom) < 1) run.right = Math.max(run.right, band.right)
        else { if (run) out.push(run); run = { ...band } }
      }
      if (run) out.push(run)
    }
  }
  return out
}

const entries = new Map<HTMLElement, Entry>()
let serial = 0
const excluded = 'input, textarea, select, button, [data-native-selection], .textLayer, .cm-editor, .monaco-editor, [data-blocksel="true"], [data-dragging="true"]'
const blockSelector = 'p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote,.katex-display'
const elementOf = (n: Node): Element | null => n.nodeType === 1 ? n as Element : n.parentElement

function measure(root: HTMLElement, range: Range): SelectionRect[] {
  const doc = root.ownerDocument, win = doc.defaultView!
  const viewport = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight }
  const clips = new Map<Element, SelectionRect>(), styles = new Map<Element, CSSStyleDeclaration>()
  const style = (el: Element): CSSStyleDeclaration => { let cs = styles.get(el); if (!cs) { cs = win.getComputedStyle(el); styles.set(el, cs) } return cs }
  const clipOf = (el: Element): SelectionRect => {
    const cached = clips.get(el); if (cached) return cached
    let clip = el.parentElement ? { ...clipOf(el.parentElement) } : { ...viewport }
    const cs = style(el)
    // A display:contents ancestor has no clipping box (notes retain these canvas wrappers).
    if (cs.display !== 'contents' && /(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) {
      const box = el.getBoundingClientRect(), html = el as HTMLElement
      const sx = html.offsetWidth ? box.width / html.offsetWidth : 1, sy = html.offsetHeight ? box.height / html.offsetHeight : 1
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX)) { clip.left = Math.max(clip.left, box.left + html.clientLeft * sx); clip.right = Math.min(clip.right, box.left + (html.clientLeft + html.clientWidth) * sx) }
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowY)) { clip.top = Math.max(clip.top, box.top + html.clientTop * sy); clip.bottom = Math.min(clip.bottom, box.top + (html.clientTop + html.clientHeight) * sy) }
    }
    clips.set(el, clip); return clip
  }
  // Bounds are not a clip when overflow is visible (canvas cards can extend beyond their PM root).
  const rootClip = clipOf(root)
  const fragments: SelectionFragment[] = []
  const add = (box: DOMRect, el: Element, atomic = false): void => {
    if (!valid(box) || style(el).visibility !== 'visible' || style(el).writingMode !== 'horizontal-tb') return
    const block = el.closest(blockSelector) ?? root
    const blockBox = block.getBoundingClientRect(), width = (block as HTMLElement).offsetWidth
    const scale = width ? blockBox.width / width : (root as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1
    const cs = style(block), lineHeight = (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5) * scale
    fragments.push({ left: box.left, top: box.top, right: box.right, bottom: box.bottom, group: block, lineHeight, clip: intersect(rootClip, clipOf(el)), atomic, display: !!el.closest('.katex-display') })
  }
  const scope = range.commonAncestorContainer
  const math = new Set<Element>()
  const commonMath = elementOf(scope)?.closest('.katex')
  if (commonMath && root.contains(commonMath)) math.add(commonMath)
  if (scope.nodeType === 1) for (const el of (scope as Element).querySelectorAll('.katex')) if (range.intersectsNode(el)) math.add(el)
  // Live editor previews float above their source; they are decorations, not a second selected formula.
  for (const el of math) if (!el.closest('.math-preview')) for (const box of el.getClientRects()) add(box, el, true)
  const visit = (node: Node): void => {
    const el = node.parentElement
    if (!el || !node.textContent || el.closest('.katex, .math-preview, script, style, svg, button, [aria-hidden="true"]') || !range.intersectsNode(node)) return
    const piece = doc.createRange(); piece.selectNodeContents(node)
    if (node === range.startContainer) piece.setStart(node, range.startOffset)
    if (node === range.endContainer) piece.setEnd(node, range.endOffset)
    if (!piece.collapsed) for (const box of piece.getClientRects()) add(box, el)
  }
  if (scope.nodeType === 3) visit(scope)
  else {
    const walker = doc.createTreeWalker(scope, 4)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      visit(node)
      // Very large selections fall back to native paint instead of blocking typing/scrolling.
      if (fragments.length > 6000) return []
    }
  }
  return selectionLineRects(fragments)
}

class Entry {
  readonly options = new Set<LineSelectionOptions>()
  readonly id = `line-selection-${++serial}`
  private layer: SVGSVGElement | null = null
  private frame = 0
  private disposed = false
  private blurred = false
  private observers: Array<{ disconnect: () => void }> = []
  private removers: Array<() => void> = []
  constructor(readonly root: HTMLElement) {
    const doc = root.ownerDocument, win = doc.defaultView!
    const listen = (target: EventTarget, name: string, fn: EventListener, capture = false): void => {
      target.addEventListener(name, fn, capture); this.removers.push(() => target.removeEventListener(name, fn, capture))
    }
    listen(doc, 'selectionchange', this.refresh)
    listen(doc, 'scroll', this.refresh, true)
    listen(win, 'resize', this.refresh)
    listen(win.matchMedia('(pointer: coarse)'), 'change', this.refresh)
    if (doc.fonts) listen(doc.fonts, 'loadingdone', this.refresh)
    listen(win, 'blur', () => { this.blurred = true; this.clear() })
    listen(win, 'focus', () => { this.blurred = false; this.refresh() })
    listen(root, 'selbar:viewport-moved', this.refresh)
    listen(root, 'compositionstart', this.refresh)
    listen(root, 'compositionend', this.refresh)
    const ro = new ResizeObserver(this.refresh); ro.observe(root); this.observers.push(ro)
    const mo = new MutationObserver(this.refresh); mo.observe(root, { childList: true, characterData: true, subtree: true }); this.observers.push(mo)
    const appearance = new MutationObserver(this.refresh)
    for (let el: HTMLElement | null = root; el; el = el.parentElement) appearance.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'data-mode', 'data-skin', 'data-bg'] })
    this.observers.push(appearance)
  }
  refresh = (): void => {
    if (this.disposed || this.frame) return
    this.frame = this.root.ownerDocument.defaultView!.requestAnimationFrame(() => { this.frame = 0; this.paint() })
  }
  private clear(): void { this.root.removeAttribute('data-line-selection'); this.root.removeAttribute('data-line-selection-retained'); this.layer?.remove(); this.layer = null }
  private paint(): void {
    const root = this.root, doc = root.ownerDocument, win = doc.defaultView!
    if (!root.isConnected || this.blurred || win.matchMedia('(pointer: coarse)').matches || Array.from(this.options).some((o) => o.suspended?.())) { this.clear(); return }
    const selection = doc.getSelection()
    let retainedPaint = false
    let range: Range | null = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
    if (range && (!root.contains(range.commonAncestorContainer) || Array.from(entries.keys()).some((other) => other !== root && root.contains(other) && other.contains(range!.commonAncestorContainer)))) range = null
    if (!range) for (const o of this.options) {
      try { const retained = o.retained?.(); if (retained && !retained.collapsed) { range = retained; retainedPaint = true; break } } catch { /* stale editor target: native fallback */ }
    }
    const at = range && elementOf(range.commonAncestorContainer)
    if (!range || !at || at.closest(excluded) || (!Array.from(this.options).some((o) => o.editable) && at.closest('[contenteditable]:not([contenteditable="false"])'))) { this.clear(); return }
    try {
      // A mixed selection crossing a custom editor must keep that editor's native paint too.
      if (Array.from(at.querySelectorAll('.textLayer, .cm-editor, .monaco-editor, [data-native-selection]')).some((el) => range!.intersectsNode(el))) { this.clear(); return }
      const boxes = measure(root, range)
      if (!boxes.length) { this.clear(); return }
      const svg = this.layer ?? doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.classList.add('line-selection-layer'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('data-owner', this.id)
      svg.style.zIndex = String(Math.max(70, ...Array.from(this.options, (o) => o.zIndex ?? 70)))
      const mode = root.closest('[data-mode]')?.getAttribute('data-mode')
      svg.setAttribute('data-mode', mode ?? (doc.documentElement.classList.contains('dark') ? 'dark' : 'light'))
      svg.setAttribute('viewBox', `0 0 ${win.innerWidth} ${win.innerHeight}`)
      const rects = boxes.map((b) => { const r = doc.createElementNS(svg.namespaceURI, 'rect'); r.setAttribute('x', String(b.left)); r.setAttribute('y', String(b.top)); r.setAttribute('width', String(b.right - b.left)); r.setAttribute('height', String(b.bottom - b.top)); r.setAttribute('rx', '2'); return r })
      svg.replaceChildren(...rects)
      if (!svg.isConnected) doc.documentElement.append(svg)
      this.layer = svg
      root.setAttribute('data-line-selection', this.id)
      root.toggleAttribute('data-line-selection-retained', retainedPaint)
    } catch { this.clear() } // Unsupported/custom DOM keeps native selection paint.
  }
  dispose(): void {
    this.disposed = true
    this.root.ownerDocument.defaultView!.cancelAnimationFrame(this.frame)
    this.observers.forEach((o) => o.disconnect()); this.removers.forEach((remove) => remove()); this.clear()
  }
}

export function mountLineSelection(root: HTMLElement, options: LineSelectionOptions = {}): LineSelectionHandle {
  let entry = entries.get(root)
  if (!entry) { entry = new Entry(root); entries.set(root, entry) }
  entry.options.add(options)
  for (const current of entries.values()) current.refresh()
  let disposed = false
  return { refresh: entry.refresh, dispose: () => {
    if (disposed) return; disposed = true
    entry!.options.delete(options)
    if (!entry!.options.size) { entry!.dispose(); entries.delete(root) }
    for (const current of entries.values()) current.refresh()
  } }
}
