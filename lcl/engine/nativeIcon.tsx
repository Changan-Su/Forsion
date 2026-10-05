/** Icons for optional native hosts (Android Compose sheets / top bar).
 *
 *  Web icons are React components (lucide-react, hook-driven ones such as the note tab emoji or the theme
 *  mode icon). Static evaluation would throw on hooks, so every icon of one request is rendered once into a
 *  detached React root, its `<svg>` primitives are flattened into path `d` strings here (Kotlin only needs
 *  `PathParser`), and the root is unmounted. Non-SVG text content (emoji / short glyphs) is sent as text.
 *  No per-icon mapping table exists on either side. */
import { Component, createElement, isValidElement, useLayoutEffect, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

/** What callers hand in: an element (`<Trash2 size={14} />`), a component (`PanelLeft`), or an emoji string. */
export type NativeIconSource = ReactNode | ComponentType<{ size?: number }>
export interface NativeVectorPath { d: string; fill: boolean; stroke: boolean }
export type NativeIcon =
  | { kind: 'text'; text: string }
  | { kind: 'vector'; viewBox: [number, number, number, number]; strokeWidth: number; paths: NativeVectorPath[] }

const MAX_PATHS = 32
const MAX_D = 8192
const MAX_TEXT = 16
const RENDER_TIMEOUT_MS = 300
const SKIP_PARENTS = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker'])

const num = (v: string | null | undefined, fallback = 0): number => {
  const n = v == null ? NaN : parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000)

function rectPath(x: number, y: number, w: number, h: number, rxIn: number, ryIn: number): string {
  if (w <= 0 || h <= 0) return ''
  let rx = rxIn > 0 ? rxIn : ryIn > 0 ? ryIn : 0
  let ry = ryIn > 0 ? ryIn : rx
  rx = Math.min(rx, w / 2)
  ry = Math.min(ry, h / 2)
  if (rx <= 0 || ry <= 0) return `M${fmt(x)} ${fmt(y)}H${fmt(x + w)}V${fmt(y + h)}H${fmt(x)}Z`
  const a = (dx: number, dy: number): string => `A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(dx)} ${fmt(dy)}`
  return `M${fmt(x + rx)} ${fmt(y)}H${fmt(x + w - rx)}${a(x + w, y + ry)}V${fmt(y + h - ry)}${a(x + w - rx, y + h)}`
    + `H${fmt(x + rx)}${a(x, y + h - ry)}V${fmt(y + ry)}${a(x + rx, y)}Z`
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return ''
  const r = `${fmt(rx)} ${fmt(ry)}`
  return `M${fmt(cx - rx)} ${fmt(cy)}A${r} 0 1 0 ${fmt(cx + rx)} ${fmt(cy)}A${r} 0 1 0 ${fmt(cx - rx)} ${fmt(cy)}Z`
}

function pointsPath(points: string | null, close: boolean): string {
  const n = (points ?? '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite)
  if (n.length < 4) return ''
  let d = `M${fmt(n[0])} ${fmt(n[1])}`
  for (let i = 2; i + 1 < n.length; i += 2) d += `L${fmt(n[i])} ${fmt(n[i + 1])}`
  return close ? d + 'Z' : d
}

/** One SVG primitive → path data in the element's own user space. */
export function primitiveToPath(el: Element): string {
  const g = (k: string): number => num(el.getAttribute(k))
  switch (el.tagName.toLowerCase()) {
    case 'path': return (el.getAttribute('d') ?? '').trim()
    case 'circle': return ellipsePath(g('cx'), g('cy'), g('r'), g('r'))
    case 'ellipse': return ellipsePath(g('cx'), g('cy'), g('rx'), g('ry'))
    case 'rect': return rectPath(g('x'), g('y'), g('width'), g('height'), g('rx'), g('ry'))
    case 'line': return `M${fmt(g('x1'))} ${fmt(g('y1'))}L${fmt(g('x2'))} ${fmt(g('y2'))}`
    case 'polyline': return pointsPath(el.getAttribute('points'), false)
    case 'polygon': return pointsPath(el.getAttribute('points'), true)
    default: return ''
  }
}

const painted = (v: string | null): boolean => !!v && v !== 'none' && v !== 'transparent'

type PaintProp = 'fill' | 'stroke' | 'stroke-width'

/** One declaration from an element's inline `style` (`style="fill: none; stroke: currentColor"`). Parsed from
 *  the attribute text, not CSSOM: the icon is serialized out of a detached tree, and this has to read the
 *  same in a browser and under the DOM shims the tests run on. `stroke` must not match `stroke-width`. */
function inlineStyle(el: Element, prop: PaintProp): string | null {
  const style = el.getAttribute('style')
  if (!style) return null
  let found: string | null = null
  for (const decl of style.split(';')) {
    const at = decl.indexOf(':')
    if (at < 0 || decl.slice(0, at).trim().toLowerCase() !== prop) continue
    found = decl.slice(at + 1).replace(/!important\s*$/i, '').trim() // later declarations win
  }
  return found || null
}

/** Paint value for `el`: on each element from `el` up to the `<svg>` root, inline style first (CSS beats a
 *  presentation attribute), then the attribute; `inherit` keeps walking. SVG initial values otherwise
 *  (fill black, stroke none, stroke-width 1). Icons styled with `style={{ fill: 'none', stroke: … }}`
 *  used to be read as filled / unstroked because only attributes were looked at. */
function inherited(el: Element, svg: Element, prop: PaintProp): string | null {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const v = inlineStyle(cur, prop) ?? cur.getAttribute(prop)
    if (v != null && v.trim().toLowerCase() !== 'inherit') return v.trim()
    if (cur === svg) break
  }
  return prop === 'fill' ? 'black' : null
}

/** Flatten an `<svg>` into the JSON shape native hosts draw. Returns undefined when nothing drawable. */
export function serializeSvg(svg: Element): NativeIcon | undefined {
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const viewBox: [number, number, number, number] = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0
    ? [vb[0], vb[1], vb[2], vb[3]]
    : [0, 0, num(svg.getAttribute('width'), 24) || 24, num(svg.getAttribute('height'), 24) || 24]
  const paths: NativeVectorPath[] = []
  let strokeWidth: number | undefined
  for (const el of Array.from(svg.querySelectorAll('path,circle,ellipse,rect,line,polyline,polygon'))) {
    let skip = false
    for (let p = el.parentElement; p && p !== svg; p = p.parentElement) if (SKIP_PARENTS.has(p.tagName.toLowerCase())) { skip = true; break }
    if (skip) continue
    const d = primitiveToPath(el)
    if (!d || d.length > MAX_D) continue
    const isLine = el.tagName.toLowerCase() === 'line' || el.tagName.toLowerCase() === 'polyline'
    const fill = !isLine && painted(inherited(el, svg, 'fill'))
    const stroke = painted(inherited(el, svg, 'stroke'))
    if (!fill && !stroke) continue
    // The native shape carries ONE stroke width per icon: the first stroked primitive's resolved width
    // (its own, else inherited up to the root; icon sets use a single width throughout).
    if (stroke && strokeWidth === undefined) strokeWidth = num(inherited(el, svg, 'stroke-width'), 1)
    paths.push({ d, fill, stroke })
    if (paths.length >= MAX_PATHS) break
  }
  if (!paths.length) return undefined
  const sw = strokeWidth ?? num(inherited(svg, svg, 'stroke-width'), 1)
  return { kind: 'vector', viewBox, strokeWidth: sw > 0 && sw <= 16 ? sw : 1, paths }
}

/** Whatever a rendered icon slot produced → native icon (svg first, else short text such as an emoji). */
export function serializeIconElement(slot: Element): NativeIcon | undefined {
  const svg = slot.querySelector('svg')
  if (svg) return serializeSvg(svg)
  const text = (slot.textContent ?? '').trim()
  return text && [...text].length <= MAX_TEXT ? { kind: 'text', text } : undefined
}

class IconBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(): void { /* an icon that throws simply has no native icon */ }
  render(): ReactNode { return this.state.failed ? null : this.props.children }
}

function Committed({ onCommit }: { onCommit: () => void }): null {
  useLayoutEffect(() => { onCommit() }, [onCommit])
  return null
}

const isComponentType = (v: unknown): v is ComponentType<{ size?: number }> =>
  typeof v === 'function' || (typeof v === 'object' && v !== null && !isValidElement(v) && '$$typeof' in v)

function toElement(src: NativeIconSource): ReactNode {
  if (isComponentType(src)) return createElement(src, { size: 24 })
  return src as ReactNode
}

/** Render + serialize a batch of icons (one detached root per batch). Order is preserved; slots without a
 *  drawable icon come back undefined. Never throws: an unavailable DOM simply yields text-only icons. */
export async function renderNativeIcons(sources: readonly NativeIconSource[]): Promise<Array<NativeIcon | undefined>> {
  const out: Array<NativeIcon | undefined> = sources.map((s) => {
    if (typeof s === 'string' || typeof s === 'number') {
      const text = String(s).trim()
      return text && [...text].length <= MAX_TEXT ? { kind: 'text', text } : undefined
    }
    return undefined
  })
  const drawable = sources.map((s, i) => ({ s, i })).filter(({ s }) => s != null && typeof s !== 'boolean' && typeof s !== 'string' && typeof s !== 'number')
  if (!drawable.length || typeof document === 'undefined') return out
  // Long lists repeat the same icon (a session list: one MessagesSquare per row). Render each distinct
  // component / simple element once and copy the result: smaller payload, fewer DOM nodes.
  const firstOf = new Map<unknown, Map<string, number>>()
  const copies: Array<{ from: number; to: number }> = []
  const pending: typeof drawable = []
  for (const entry of drawable) {
    const key = dedupeKey(entry.s)
    if (key) {
      const byProps = firstOf.get(key[0]) ?? new Map<string, number>()
      firstOf.set(key[0], byProps)
      const first = byProps.get(key[1])
      if (first !== undefined) { copies.push({ from: first, to: entry.i }); continue }
      byProps.set(key[1], entry.i)
    }
    pending.push(entry)
  }
  const host = document.createElement('div')
  let root: ReturnType<typeof createRoot> | null = null
  try {
    root = createRoot(host)
    const r = root
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RENDER_TIMEOUT_MS)
      const done = (): void => { clearTimeout(timer); resolve() }
      r.render(createElement('div', null,
        ...pending.map(({ s, i }) => createElement('span', { key: i, 'data-native-icon': i }, createElement(IconBoundary, null, toElement(s)))),
        createElement(Committed, { key: 'commit', onCommit: done }),
      ))
    })
    for (const { i } of pending) {
      const slot = host.querySelector(`[data-native-icon="${i}"]`)
      out[i] = slot ? serializeIconElement(slot) : undefined
    }
  } catch {
    /* fall through with what we have */
  } finally {
    try { root?.unmount() } catch { /* already gone */ }
  }
  for (const { from, to } of copies) out[to] = out[from]
  return out
}

/** Identity for dedupe: a component type, or an element of a component type whose props are plain JSON
 *  (`<Pencil size={13} />`). Anything else (children, callbacks, refs) is rendered on its own. */
function dedupeKey(src: NativeIconSource): [unknown, string] | null {
  if (isComponentType(src)) return [src, '']
  if (!isValidElement(src) || typeof src.type === 'string' || src.key != null) return null
  const props = src.props as Record<string, unknown>
  for (const v of Object.values(props)) {
    if (v != null && typeof v === 'object') return null
    if (typeof v === 'function' || typeof v === 'symbol') return null
  }
  try { return [src.type, JSON.stringify(props)] } catch { return null }
}
