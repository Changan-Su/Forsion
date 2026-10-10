/** Optional native top app bar ("NativeChrome") seam.
 *
 *  The engine never imports a platform: a platform entry (mobile/src/nativeChrome.ts on Android) installs a
 *  host; without one the single-column shell keeps rendering its web `.mb-topbar` exactly as before.
 *  JS owns all state. Two producers feed the bar:
 *    - the shell (`setNativeChromeShell`): title, drawer availability, tab count + its action handlers;
 *    - full-screen overlays (`claimNativeChrome` / `useNativeChromeClaim`): 'hidden' while they cover the
 *      shell, or 'page' (title + back) for overlays that want a native back bar. Last claim wins.
 *  The host receives the effective state (deduplicated) and reports user actions via
 *  `dispatchNativeChromeAction`.
 *  A host may also draw the Space switcher as a bottom navigation bar (`spaces: true`): the shell then sends
 *  the Space list with its state and drops the web Space row from the drawer foot; taps come back through
 *  `dispatchNativeChromeSpace`. With such a host the shell navigates in two levels (SingleColumnHost,
 *  `listFirstNow`): the Space list is sent only on a Space's first level, so the bar is gone one level down.
 *  The bar holds a handful of Spaces (`pinned`, see spaceDock.ts); the rest are behind its "all" cell (`spacesAll`).
 *  A view on screen may add to the shell's bar (`useNativeChromeExtras`): a search button, a second title part. */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export type NativeChromeAction = 'left' | 'right' | 'tabs' | 'more' | 'back' | 'close' | 'search' | 'title' | 'spacesAll'
export interface NativeChromeShellLabels { left: string; right: string; tabs: string; more: string }
/** One destination of the bottom navigation bar. Data only: the host resolves the icon from the Space registry. */
export interface NativeChromeSpace {
  id: string; label: string; active: boolean
  /** Opaque identity of the Space's icon component: changes when only the icon was replaced, so the state is re-sent. */
  iconRev?: number
  /** The user keeps it in the bar; the others are reached through the bar's "all" cell. */
  pinned?: boolean
}
export interface NativeChromeShellState {
  mode: 'shell'
  title: string
  /** Left button shown: the left drawer is reachable, or (two-level navigation) there is a list to go back to. */
  left: boolean
  /** The left button is "back to the Space's list" (two-level navigation, detail level): hosts draw a back arrow. */
  leftBack?: boolean
  right: boolean
  tabCount: number
  labels: NativeChromeShellLabels
  /** Sent only to hosts that draw the Space switcher (see `NativeChromeHost.spaces`); fewer than two = no bar. */
  spaces?: NativeChromeSpace[]
  /** With `spaces`: what the bar's "all Spaces" cell is called. */
  allLabel?: string
  /** Label of a search button (the view on screen has something to search); absent = no button. */
  search?: string
  /** A second, quieter part of the title (which vault); `titleTap` = the title is a button. */
  titleSub?: string
  titleTap?: boolean
}
/** `close` = label of an optional trailing × (e.g. a settings sub-page: back = settings home, × = leave settings). */
export interface NativeChromePageState { mode: 'page'; title: string; back: string; close?: string }
export interface NativeChromeHiddenState { mode: 'hidden' }
export type NativeChromeState = NativeChromeShellState | NativeChromePageState | NativeChromeHiddenState

/** Touch feedback a page moment may ask for: 'tick' = something small went through (a message was sent).
 *  A long-press needs none from here: the WebView gives its own as soon as the page takes `contextmenu`
 *  (measured on Android 15: one LONG_PRESS per long-press; a second one from the page only cut the first short). */
export type NativeHaptic = 'tick'
export interface NativeChromeHost {
  /** Receives every change of the effective state (already deduplicated). */
  render(state: NativeChromeState): void
  /** The host draws the Space switcher itself (bottom navigation bar). */
  spaces?: boolean
  /** The device can give touch feedback (see `nativeHaptic`). */
  haptic?(kind: NativeHaptic): void
}
export type NativeChromeShellHandlers = Partial<Record<Exclude<NativeChromeAction, 'back' | 'close'>, () => void>>
  & { space?: (id: string) => void; spaceLong?: (id: string) => void }
export type NativeChromeClaim = NativeChromeHiddenState | (NativeChromePageState & { onBack: () => void; onClose?: () => void })
export interface NativeChromeClaimHandle { update(next: NativeChromeClaim): void; release(): void }

const HIDDEN: NativeChromeHiddenState = { mode: 'hidden' }
let host: NativeChromeHost | undefined
let shell: { state: NativeChromeShellState; handlers: NativeChromeShellHandlers } | null = null
const claims: Array<{ claim: NativeChromeClaim }> = []
let lastSent = ''
const subscribers = new Set<() => void>()

function effective(): NativeChromeState {
  const top = claims[claims.length - 1]?.claim
  if (top) return top.mode === 'page' ? { mode: 'page', title: top.title, back: top.back, ...(top.close && top.onClose ? { close: top.close } : {}) } : HIDDEN
  return shell?.state ?? HIDDEN
}
function flush(): void {
  if (!host) return
  const state = effective()
  const key = JSON.stringify(state)
  if (key === lastSent) return
  lastSent = key
  try { host.render(state) } catch { /* a broken host must not break the shell */ }
}

export function installNativeChromeHost(next: NativeChromeHost): () => void {
  host = next
  lastSent = ''
  subscribers.forEach((fn) => fn())
  flush()
  return () => {
    if (host !== next) return
    host = undefined
    lastSent = ''
    subscribers.forEach((fn) => fn())
  }
}
export function nativeChromeInstalled(): boolean { return !!host }
/** Touch feedback, where a host offers it; a no-op everywhere else (desktop, web, a phone browser). Never throws. */
export function nativeHaptic(kind: NativeHaptic): void {
  try { host?.haptic?.(kind) } catch { /* feedback is never worth an error */ }
}
/** Whether the installed host draws the Space switcher (non-React callers: store subscriptions). */
export function nativeChromeDrawsSpaces(): boolean { return !!host?.spaces }
/** React: true while the installed host draws the Space switcher — the drawer foot then omits its web Space row. */
export function useNativeChromeSpaces(): boolean {
  return useSyncExternalStore(
    (fn) => { subscribers.add(fn); return () => { subscribers.delete(fn) } },
    () => !!host?.spaces,
    () => false,
  )
}
/** React: re-renders when a host is installed / removed (the shell hides its web bar while one exists). */
export function useNativeChromeInstalled(): boolean {
  return useSyncExternalStore(
    (fn) => { subscribers.add(fn); return () => { subscribers.delete(fn) } },
    () => !!host,
    () => false,
  )
}

/** The shell's own bar state; null when the shell unmounts. */
export function setNativeChromeShell(state: Omit<NativeChromeShellState, 'mode'> | null, handlers: NativeChromeShellHandlers = {}): void {
  shell = state ? { state: { mode: 'shell', ...state }, handlers } : null
  flush()
}

export function claimNativeChrome(claim: NativeChromeClaim): NativeChromeClaimHandle {
  const entry = { claim }
  claims.push(entry)
  flush()
  return {
    update(next) { entry.claim = next; flush() },
    release() {
      const i = claims.indexOf(entry)
      if (i >= 0) { claims.splice(i, 1); flush() }
    },
  }
}

/** Hold a claim while `claim` is non-null. `onBack` / `onClose` may change between renders without re-claiming. */
export function useNativeChromeClaim(claim: NativeChromeClaim | null): void {
  const onBack = useRef<(() => void) | undefined>(undefined)
  const onClose = useRef<(() => void) | undefined>(undefined)
  onBack.current = claim && claim.mode === 'page' ? claim.onBack : undefined
  onClose.current = claim && claim.mode === 'page' ? claim.onClose : undefined
  const key = claim ? JSON.stringify(claim.mode === 'page'
    ? { m: 'page', t: claim.title, b: claim.back, c: claim.close && claim.onClose ? claim.close : '' }
    : { m: 'hidden' }) : ''
  const handle = useRef<NativeChromeClaimHandle | null>(null)
  useEffect(() => {
    if (!key) return
    const parsed = JSON.parse(key) as { m: string; t?: string; b?: string; c?: string }
    const next: NativeChromeClaim = parsed.m === 'page'
      ? {
        mode: 'page', title: parsed.t ?? '', back: parsed.b ?? '', onBack: () => onBack.current?.(),
        ...(parsed.c ? { close: parsed.c, onClose: () => onClose.current?.() } : {}),
      }
      : HIDDEN
    if (handle.current) handle.current.update(next)
    else handle.current = claimNativeChrome(next)
  }, [key])
  useEffect(() => () => { handle.current?.release(); handle.current = null }, [])
  useEffect(() => { if (!key && handle.current) { handle.current.release(); handle.current = null } }, [key])
}

/** Called by the host for user actions. Returns whether something handled it. */
export function dispatchNativeChromeAction(action: NativeChromeAction): boolean {
  const top = claims[claims.length - 1]?.claim
  if (top) {
    if (action === 'back' && top.mode === 'page') { top.onBack(); return true }
    if (action === 'close' && top.mode === 'page' && top.close && top.onClose) { top.onClose(); return true }
    return false
  }
  if (action === 'back' || action === 'close' || !shell) return false
  const fn = shell.handlers[action]
  if (!fn) return false
  fn()
  return true
}

/** Called by the host when a Space of the bottom bar is tapped (or long-pressed). Ignored while an overlay claims the bar. */
export function dispatchNativeChromeSpace(id: string, long = false): boolean {
  if (claims.length || !shell) return false
  const fn = long ? shell.handlers.spaceLong : shell.handlers.space
  if (!fn) return false
  fn(id)
  return true
}

/** Current effective state (tests / diagnostics). */
export function nativeChromeState(): NativeChromeState { return effective() }

// ── what a view adds to the shell's bar ────────────────────────────────────────

/** `where` = the level the view lives on in two-level navigation: a Space's list (the left panel) or its main area.
 *  The shell shows the additions of the level that is on screen; the last view to ask wins. */
export interface NativeChromeExtras {
  where: 'list' | 'main'
  search?: { label: string; run: () => void }
  /** `sub` = second part of the title; `run` = the title is a button. */
  title?: { sub: string; run?: () => void }
}
const extras: Array<{ value: NativeChromeExtras }> = []
const extrasSubscribers = new Set<() => void>()
export function nativeChromeExtras(where: NativeChromeExtras['where']): NativeChromeExtras | undefined {
  for (let i = extras.length - 1; i >= 0; i--) if (extras[i].value.where === where) return extras[i].value
  return undefined
}
export function subscribeNativeChromeExtras(fn: () => void): () => void {
  extrasSubscribers.add(fn)
  return () => { extrasSubscribers.delete(fn) }
}
/** Hold additions while `value` is non-null. Handlers may change between renders without the bar being re-sent. */
export function useNativeChromeExtras(value: NativeChromeExtras | null): void {
  const latest = useRef(value)
  latest.current = value
  const key = value ? JSON.stringify({ w: value.where, s: value.search?.label ?? null, t: value.title?.sub ?? null, r: !!value.title?.run }) : ''
  useEffect(() => {
    if (!key) return
    const parsed = JSON.parse(key) as { w: NativeChromeExtras['where']; s: string | null; t: string | null; r: boolean }
    const entry = { value: {
      where: parsed.w,
      ...(parsed.s !== null ? { search: { label: parsed.s, run: () => latest.current?.search?.run() } } : {}),
      ...(parsed.t !== null ? { title: { sub: parsed.t, ...(parsed.r ? { run: () => latest.current?.title?.run?.() } : {}) } } : {}),
    } satisfies NativeChromeExtras }
    extras.push(entry)
    extrasSubscribers.forEach((fn) => fn())
    return () => {
      const i = extras.indexOf(entry)
      if (i >= 0) extras.splice(i, 1)
      extrasSubscribers.forEach((fn) => fn())
    }
  }, [key])
}
