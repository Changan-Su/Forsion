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
 *  `dispatchNativeChromeSpace`. */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export type NativeChromeAction = 'left' | 'right' | 'tabs' | 'more' | 'back' | 'close'
export interface NativeChromeShellLabels { left: string; right: string; tabs: string; more: string }
/** One destination of the bottom navigation bar. Data only: the host resolves the icon from the Space registry. */
export interface NativeChromeSpace { id: string; label: string; active: boolean }
export interface NativeChromeShellState {
  mode: 'shell'
  title: string
  /** Left drawer reachable. ⚠️ Same rule as the web button (it is the only way to Spaces/account/settings). */
  left: boolean
  right: boolean
  tabCount: number
  labels: NativeChromeShellLabels
  /** Sent only to hosts that draw the Space switcher (see `NativeChromeHost.spaces`); fewer than two = no bar. */
  spaces?: NativeChromeSpace[]
}
/** `close` = label of an optional trailing × (e.g. a settings sub-page: back = settings home, × = leave settings). */
export interface NativeChromePageState { mode: 'page'; title: string; back: string; close?: string }
export interface NativeChromeHiddenState { mode: 'hidden' }
export type NativeChromeState = NativeChromeShellState | NativeChromePageState | NativeChromeHiddenState

export interface NativeChromeHost {
  /** Receives every change of the effective state (already deduplicated). */
  render(state: NativeChromeState): void
  /** The host draws the Space switcher itself (bottom navigation bar). */
  spaces?: boolean
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
