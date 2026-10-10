/** Optional native bottom-sheet host (Android Compose) for menus, text prompts and confirmations.
 *
 *  Same shape as `modelPickerHost`: ONE module-level presenter slot, installed by a platform entry
 *  (mobile/src/nativeSheet.ts on Android) and absent everywhere else (Electron, web, Unit, mobile-web), in
 *  which case every helper reports `{ handled: false }` and the caller renders its existing web UI.
 *  JS stays the single owner of state: the presenter only receives JSON (labels already translated, icons
 *  already serialized, colours read from the live theme tokens) and returns a choice that is re-validated
 *  here against the request. Unknown / malformed answers are treated as a cancel; a presenter that throws
 *  or rejects is treated as "not handled" so the caller falls back to the web UI. */
import type { ReactNode } from 'react'
import { renderNativeIcons, type NativeIcon, type NativeIconSource } from './nativeIcon'

/** Colours are `#AARRGGBB` (Android `Color.parseColor` order), read from the active skin at request time. */
export interface NativeSheetTheme {
  dark: boolean
  background: string
  surface: string
  text: string
  muted: string
  border: string
  accent: string
  onAccent: string
  danger: string
  /** "Waiting for you" (the attention dot of the Space bar). Hosts older than this field fall back to `danger`. */
  warning: string
}

export interface NativeMenuTrailing<I = NativeIconSource> { id: string; label: string; icon?: I }
/** Native-side filtering (label + detail, case-insensitive) of one page. */
export interface NativeMenuSearch { placeholder: string; empty: string }
export interface NativeMenuItem<I = NativeIconSource> {
  id: string
  label: string
  detail?: string
  icon?: I
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  /** Nested sections → pushed page with a back button. */
  children?: NativeMenuSection<I>[]
  /** Search field on the nested page opened by this item (only meaningful with `children`). */
  search?: NativeMenuSearch
  /** A secondary action button at the end of the row (e.g. close ×). */
  trailing?: NativeMenuTrailing<I>
}
/** `footer` = a short muted note under the section's rows (e.g. what a rewind keeps / cannot restore).
 *  `grid` = the items are places to go, drawn as tiles (icon over name) four to a row instead of rows. */
export interface NativeMenuSection<I = NativeIconSource> { title?: string; items: NativeMenuItem<I>[]; footer?: string; grid?: boolean }
export interface NativeMenuRequest<I = NativeIconSource> {
  kind: 'menu'
  title?: string
  sections: NativeMenuSection<I>[]
  /** Search field on the ROOT page (nested pages declare their own via `NativeMenuItem.search`). */
  search?: NativeMenuSearch
  /** Accessible label of the nested-page back button. */
  back?: string
}
export interface NativePromptRequest {
  kind: 'prompt'
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirm: string
  cancel: string
}
export interface NativeConfirmRequest {
  kind: 'confirm'
  title: string
  message?: string
  confirm: string
  cancel: string
  danger?: boolean
}
export type NativeSheetRequest = NativeMenuRequest | NativePromptRequest | NativeConfirmRequest
/** What the presenter receives: JSON only. */
export type NativeSheetPayload = (NativeMenuRequest<NativeIcon> | NativePromptRequest | NativeConfirmRequest) & { theme: NativeSheetTheme }
/** Resolve with the raw native answer, or null on cancel. Throw / reject = "cannot present" (caller falls back). */
export type NativeSheetPresenter = (payload: NativeSheetPayload, signal: AbortSignal) => Promise<unknown>

export interface NativeMenuResult { id: string; trailing?: boolean }
export interface NativePromptResult { text: string }
export interface NativeConfirmResult { ok: true }
/** `handled:false` = no host / host failed → render the web UI. `value:null` = the user cancelled. */
export type NativeSheetOutcome<T> = { handled: false } | { handled: true; value: T | null }

let presenter: NativeSheetPresenter | undefined
export function installNativeSheetPresenter(next: NativeSheetPresenter): () => void {
  presenter = next
  return () => { if (presenter === next) presenter = undefined }
}
export function nativeSheetPresenter(): NativeSheetPresenter | undefined { return presenter }

// ── result validation ──────────────────────────────────────────────────────────

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const onlyKeys = (o: Record<string, unknown>, allowed: string[]): boolean => Object.keys(o).every((k) => allowed.includes(k))

function findItem<I>(sections: NativeMenuSection<I>[], id: string): NativeMenuItem<I> | undefined {
  for (const s of sections) for (const it of s.items) {
    if (it.id === id) return it
    const nested = it.children ? findItem(it.children, id) : undefined
    if (nested) return nested
  }
  return undefined
}

/** A menu answer must name an enabled, selectable item of THIS request (rows that only open a nested page
 *  are not results); `trailing:true` only when that item declared a trailing action. Anything else → null. */
export function menuResult<I>(request: Pick<NativeMenuRequest<I>, 'sections'>, raw: unknown): NativeMenuResult | null {
  if (!plainObject(raw) || !onlyKeys(raw, ['id', 'trailing'])) return null
  const { id, trailing } = raw
  if (typeof id !== 'string' || (trailing !== undefined && typeof trailing !== 'boolean')) return null
  const item = findItem(request.sections, id)
  if (!item || item.disabled) return null
  if (trailing) return item.trailing ? { id, trailing: true } : null
  if (item.children?.length) return null
  return { id }
}
export function promptResult(raw: unknown): NativePromptResult | null {
  if (!plainObject(raw) || !onlyKeys(raw, ['text']) || typeof raw.text !== 'string' || raw.text.length > 100_000) return null
  return { text: raw.text }
}
export function confirmResult(raw: unknown): NativeConfirmResult | null {
  return plainObject(raw) && onlyKeys(raw, ['ok']) && raw.ok === true ? { ok: true } : null
}

/** Ids must be unique across the whole tree (including nested pages), or the answer would be ambiguous. */
function idsUnique<I>(sections: NativeMenuSection<I>[], seen = new Set<string>()): boolean {
  for (const s of sections) for (const it of s.items) {
    if (!it.id || it.id.length > MAX_ID || seen.has(it.id)) return false
    seen.add(it.id)
    if (it.children && !idsUnique(it.children, seen)) return false
  }
  return true
}
function itemCount<I>(sections: NativeMenuSection<I>[]): number {
  let n = 0
  for (const s of sections) for (const it of s.items) n += 1 + (it.children ? itemCount(it.children) : 0)
  return n
}

// Native parser caps (NativeSheetPayload.kt). Text is clipped here so ONE long session title cannot make the
// whole request invalid (which would silently drop the user back to the web menu); ids are never clipped.
const MAX_ID = 160
const MAX_TEXT = 256
const MAX_DETAIL = 1024
const MAX_BACK = 64
export const NATIVE_MENU_MAX_ITEMS = 600
/** Clip to `max` UTF-16 units (what Kotlin's String.length counts) with an ellipsis, never splitting a pair. */
export function clipNativeText(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = max - 1
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return text.slice(0, cut) + '…'
}
const clipSearch = (s: NativeMenuSearch): NativeMenuSearch => ({ placeholder: clipNativeText(s.placeholder, MAX_TEXT), empty: clipNativeText(s.empty, MAX_TEXT) })

// ── theme ──────────────────────────────────────────────────────────────────────

type Rgba = [number, number, number, number]
const LIGHT: Record<keyof Omit<NativeSheetTheme, 'dark'>, Rgba> = {
  background: [248, 247, 246, 1], surface: [255, 255, 255, 1], text: [32, 33, 36, 1], muted: [110, 112, 118, 1],
  border: [0, 0, 0, 0.1], accent: [77, 135, 148, 1], onAccent: [255, 255, 255, 1], danger: [208, 64, 64, 1],
  warning: [128, 96, 0, 1],
}
const DARK: typeof LIGHT = {
  background: [32, 34, 36, 1], surface: [40, 42, 44, 1], text: [236, 238, 240, 1], muted: [160, 164, 170, 1],
  border: [255, 255, 255, 0.12], accent: [95, 163, 178, 1], onAccent: [255, 255, 255, 1], danger: [232, 96, 96, 1],
  warning: [224, 184, 91, 1],
}
const TOKENS: Record<keyof typeof LIGHT, string> = {
  background: '--bg', surface: '--bg-card', text: '--text', muted: '--text-muted',
  border: '--border', accent: '--accent', onAccent: '--on-accent', danger: '--danger', warning: '--warning',
}

let canvasCtx: CanvasRenderingContext2D | null | undefined
function canvasRgba(color: string): Rgba | null {
  try {
    if (canvasCtx === undefined) {
      const c = document.createElement('canvas')
      c.width = c.height = 1
      canvasCtx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
    }
    const ctx = canvasCtx
    if (!ctx || typeof ctx.getImageData !== 'function') return null
    // An unparsable value leaves fillStyle untouched: set it from two different sentinels and compare.
    ctx.fillStyle = '#000000'
    ctx.fillStyle = color
    const a = String(ctx.fillStyle)
    ctx.fillStyle = '#ffffff'
    ctx.fillStyle = color
    if (String(ctx.fillStyle) !== a) return null
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  } catch { return null }
}
/** Parses what browsers report for computed colours (`rgb()` / `rgba()` / hex); canvas covers the rest. */
export function parseCssColor(color: string): Rgba | null {
  const s = color.trim()
  const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i)
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), Math.max(0, Math.min(1, a))]
  }
  const h = s.match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (h && [3, 4, 6, 8].includes(h.length)) {
    const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
    const v = (i: number): number => parseInt(full.slice(i, i + 2), 16)
    return [v(0), v(2), v(4), full.length === 8 ? v(6) / 255 : 1]
  }
  return typeof document === 'undefined' ? null : canvasRgba(s)
}
const over = (top: Rgba, base: Rgba): Rgba => {
  const a = top[3]
  return [0, 1, 2].map((i) => Math.round(top[i] * a + base[i] * (1 - a))).concat(1) as Rgba
}
export const toArgbHex = ([r, g, b, a]: Rgba): string =>
  '#' + [Math.round(a * 255), r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('').toUpperCase()

/** Live theme → native colours. Resolves each token through a probe element (handles `var()`/`color-mix()`),
 *  composites translucent backgrounds so native containers are opaque, and falls back per token. */
export function readNativeTheme(): NativeSheetTheme {
  let dark = false
  try { dark = document.documentElement.dataset.mode === 'dark' } catch { /* no DOM */ }
  const base = dark ? DARK : LIGHT
  const read: Partial<Record<keyof typeof LIGHT, Rgba>> = {}
  if (typeof document !== 'undefined' && document.body) {
    const probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    try {
      const declared = getComputedStyle(document.documentElement)
      for (const key of Object.keys(TOKENS) as Array<keyof typeof LIGHT>) {
        // An undeclared token would make the probe inherit the text colour silently → keep the fallback.
        if (!declared.getPropertyValue(TOKENS[key]).trim()) continue
        probe.style.color = ''
        probe.style.color = `var(${TOKENS[key]})`
        const v = getComputedStyle(probe).color
        const rgba = v ? parseCssColor(v) : null
        if (rgba) read[key] = rgba
      }
    } finally { probe.remove() }
  }
  const pick = (k: keyof typeof LIGHT): Rgba => read[k] ?? base[k]
  const ground: Rgba = dark ? [0, 0, 0, 1] : [255, 255, 255, 1]
  const background = over(pick('background'), ground)
  const surface = over(pick('surface'), background)
  return {
    dark,
    background: toArgbHex(background),
    surface: toArgbHex(surface),
    text: toArgbHex(pick('text')),
    muted: toArgbHex(pick('muted')),
    border: toArgbHex(pick('border')),
    accent: toArgbHex(over(pick('accent'), surface)),
    onAccent: toArgbHex(pick('onAccent')),
    danger: toArgbHex(pick('danger')),
    warning: toArgbHex(over(pick('warning'), background)),
  }
}

// ── presentation ───────────────────────────────────────────────────────────────

async function serializeMenu(req: NativeMenuRequest): Promise<NativeMenuRequest<NativeIcon>> {
  const sources: NativeIconSource[] = []
  const collect = (sections: NativeMenuSection[]): void => {
    for (const s of sections) for (const it of s.items) {
      sources.push(it.icon, it.trailing?.icon)
      if (it.children) collect(it.children)
    }
  }
  collect(req.sections)
  const icons = await renderNativeIcons(sources)
  let i = 0
  const map = (sections: NativeMenuSection[]): NativeMenuSection<NativeIcon>[] => sections.map((s) => ({
    ...(s.title ? { title: clipNativeText(s.title, MAX_TEXT) } : {}),
    ...(s.footer ? { footer: clipNativeText(s.footer, MAX_DETAIL) } : {}),
    ...(s.grid ? { grid: true } : {}),
    items: s.items.map((it) => {
      const icon = icons[i++]
      const trailingIcon = icons[i++]
      const out: NativeMenuItem<NativeIcon> = { id: it.id, label: clipNativeText(it.label, MAX_TEXT) }
      if (it.detail) out.detail = clipNativeText(it.detail, MAX_DETAIL)
      if (icon) out.icon = icon
      if (it.checked) out.checked = true
      if (it.danger) out.danger = true
      if (it.disabled) out.disabled = true
      if (it.children?.length) {
        out.children = map(it.children)
        if (it.search) out.search = clipSearch(it.search)
      }
      if (it.trailing) out.trailing = { id: it.trailing.id, label: clipNativeText(it.trailing.label, MAX_TEXT), ...(trailingIcon ? { icon: trailingIcon } : {}) }
      return out
    }),
  }))
  return {
    kind: 'menu',
    ...(req.title ? { title: clipNativeText(req.title, MAX_TEXT) } : {}),
    sections: map(req.sections),
    ...(req.search ? { search: clipSearch(req.search) } : {}),
    ...(req.back ? { back: clipNativeText(req.back, MAX_BACK) } : {}),
  }
}

async function present<T>(build: () => Promise<NativeSheetPayload> | NativeSheetPayload, validate: (raw: unknown) => T | null, signal?: AbortSignal): Promise<NativeSheetOutcome<T>> {
  const host = presenter
  if (!host) return { handled: false }
  if (signal?.aborted) return { handled: true, value: null }
  const ctl = new AbortController()
  const forward = (): void => ctl.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const payload = await build()
    if (ctl.signal.aborted) return { handled: true, value: null }
    const raw = await host(payload, ctl.signal)
    if (ctl.signal.aborted) return { handled: true, value: null }
    return { handled: true, value: raw == null ? null : validate(raw) }
  } catch {
    return ctl.signal.aborted ? { handled: true, value: null } : { handled: false }
  } finally {
    signal?.removeEventListener('abort', forward)
  }
}

export function presentNativeMenu(request: Omit<NativeMenuRequest, 'kind'>, signal?: AbortSignal): Promise<NativeSheetOutcome<NativeMenuResult>> {
  const req: NativeMenuRequest = { ...request, kind: 'menu' }
  if (!presenter) return Promise.resolve({ handled: false })
  if (!idsUnique(req.sections) || !req.sections.some((s) => s.items.length) || itemCount(req.sections) > NATIVE_MENU_MAX_ITEMS) return Promise.resolve({ handled: false })
  return present(async () => ({ ...(await serializeMenu(req)), theme: readNativeTheme() }), (raw) => menuResult(req, raw), signal)
}
export function presentNativePrompt(request: Omit<NativePromptRequest, 'kind'>, signal?: AbortSignal): Promise<NativeSheetOutcome<NativePromptResult>> {
  return present(() => ({ ...request, kind: 'prompt' as const, theme: readNativeTheme() }), promptResult, signal)
}
export function presentNativeConfirm(request: Omit<NativeConfirmRequest, 'kind'>, signal?: AbortSignal): Promise<NativeSheetOutcome<NativeConfirmResult>> {
  return present(() => ({ ...request, kind: 'confirm' as const, theme: readNativeTheme() }), confirmResult, signal)
}

// ── callback-style menus (the desktop `ContextMenu` item shape) ────────────────

/** Structural twin of desktop `CtxItem` (RightPanel.tsx); `shortcut` has no meaning on touch and is dropped. */
export interface NativeCtxItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
  shortcut?: string
  run: () => void
}

/** Map callback items to a native menu (sections split at `separatorBefore`) and return the picked item.
 *  The item array is captured at call time, so the answer can never point into a newer list. */
export async function pickNativeCtxItem<T extends NativeCtxItem>(items: readonly T[], opts: { title?: string; signal?: AbortSignal } = {}): Promise<NativeSheetOutcome<T>> {
  if (!presenter || !items.length) return { handled: false }
  const snapshot = [...items]
  const sections: NativeMenuSection[] = []
  snapshot.forEach((it, i) => {
    if (!sections.length || (it.separatorBefore && sections[sections.length - 1].items.length)) sections.push({ items: [] })
    sections[sections.length - 1].items.push({
      id: String(i), label: it.label, icon: it.icon,
      ...(it.danger ? { danger: true } : {}), ...(it.disabled ? { disabled: true } : {}),
    })
  })
  const out = await presentNativeMenu({ ...(opts.title ? { title: opts.title } : {}), sections }, opts.signal)
  if (!out.handled) return out
  return { handled: true, value: out.value ? snapshot[Number(out.value.id)] ?? null : null }
}

/** Present natively and invoke the picked item's `run`. Returns false when no host could present it —
 *  the caller then renders its web menu. A cancel counts as handled (returns true, runs nothing). */
export async function runNativeCtxMenu(items: readonly NativeCtxItem[], opts: { title?: string; signal?: AbortSignal } = {}): Promise<boolean> {
  const out = await pickNativeCtxItem(items, opts)
  if (!out.handled) return false
  out.value?.run()
  return true
}
