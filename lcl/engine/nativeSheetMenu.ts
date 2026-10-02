/** Callback-style menus that feed BOTH a web render and the optional native sheet (one source of items).
 *
 *  A consumer builds `SheetMenu` data (labels already translated, handlers in `run`); its web menu renders
 *  from the same items, and on Android (native presenter installed) the same items go to the Compose sheet.
 *  Two entry points, both no-ops without a native host (Electron / web / Unit / mobile browser):
 *    - `openNativeSheetMenu(build, …)`: synchronous gate for click-triggered menus. Returns false at once when
 *      no host is installed, so the caller's existing web path runs unchanged; true = presenting natively.
 *    - `useNativeSheetMenu(open, build, onClose)`: for menus driven by an "open" state (context menus opened
 *      by right-click / long-press). Returns whether the caller should render its web menu right now.
 *  The picked id is resolved against the snapshot that was presented — never a newer list. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { nativeSheetPresenter, presentNativeMenu, type NativeMenuItem, type NativeMenuSearch, type NativeMenuSection } from './nativeSheet'

export interface SheetMenuItem {
  /** Stable within one menu; also the native test anchor (`nativeSheet.item.<id>`). */
  id: string
  label: string
  detail?: string
  icon?: ReactNode
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  /** Web-only anchor (`data-act`) kept for existing harnesses; never sent to the native side. */
  act?: string
  /** Nested page on the native sheet (web menus render their own sub-pane / flyout). */
  children?: SheetMenuSection[]
  /** Search field on that nested page. */
  search?: NativeMenuSearch
  /** What picking the item does. Items with neither `run` nor `children` are informational (shown disabled). */
  run?: () => void
}
/** `footer`: muted note under the rows (native sheet; web menus place their own note). */
export interface SheetMenuSection { title?: string; items: SheetMenuItem[]; footer?: string }
export interface SheetMenu {
  title?: string
  sections: SheetMenuSection[]
  /** Root-page search (e.g. a long project list). */
  search?: NativeMenuSearch
  /** Accessible label of the nested-page back button. */
  back?: string
}

const toNative = (sections: SheetMenuSection[]): NativeMenuSection[] => sections
  .filter((s) => s.items.length)
  .map((s) => ({
    ...(s.title ? { title: s.title } : {}),
    ...(s.footer ? { footer: s.footer } : {}),
    items: s.items.map((it): NativeMenuItem => {
      const kids = it.children?.filter((c) => c.items.length)
      return {
        id: it.id,
        label: it.label,
        ...(it.detail ? { detail: it.detail } : {}),
        ...(it.icon != null && it.icon !== false ? { icon: it.icon } : {}),
        ...(it.checked ? { checked: true } : {}),
        ...(it.danger ? { danger: true } : {}),
        ...(it.disabled || (!it.run && !kids?.length) ? { disabled: true } : {}),
        ...(kids?.length ? { children: toNative(kids), ...(it.search ? { search: it.search } : {}) } : {}),
      }
    }),
  }))

function findItem(sections: SheetMenuSection[], id: string): SheetMenuItem | undefined {
  for (const s of sections) for (const it of s.items) {
    if (it.id === id) return it
    const nested = it.children ? findItem(it.children, id) : undefined
    if (nested) return nested
  }
  return undefined
}
const hasItems = (m: SheetMenu): boolean => m.sections.some((s) => s.items.length > 0)

/** Present `menu` natively and run the picked item. Returns false when no host could present it (the caller
 *  renders its web menu). A cancel counts as handled. `onClose` runs once the sheet is answered (pick or
 *  cancel), BEFORE the picked item's `run`, so handlers that open dialogs see the menu already closed.
 *  A request withdrawn through `opts.signal` is over for its caller: it returns true and runs NEITHER
 *  `onClose` NOR an item. The caller aborted because the menu was closed or replaced, and `onClose` usually
 *  clears "the open menu" — which by then is the next one. */
export async function runNativeSheetMenu(menu: SheetMenu, opts: { signal?: AbortSignal; onClose?: () => void } = {}): Promise<boolean> {
  if (!nativeSheetPresenter() || !hasItems(menu)) return false
  const out = await presentNativeMenu({
    ...(menu.title ? { title: menu.title } : {}),
    sections: toNative(menu.sections),
    ...(menu.search ? { search: menu.search } : {}),
    ...(menu.back ? { back: menu.back } : {}),
  }, opts.signal)
  if (opts.signal?.aborted) return true
  if (!out.handled) return false
  try { opts.onClose?.() } catch (e) { console.error('[native sheet] onClose failed', e) }
  const picked = out.value && !out.value.trailing ? findItem(menu.sections, out.value.id) : undefined
  if (picked && !picked.disabled && picked.run) {
    try { picked.run() } catch (e) { console.error('[native sheet] menu action failed', e) }
  }
  return true
}

/** Synchronous gate for click-triggered menus. No host (or nothing to show) → false and nothing happens: the
 *  caller opens its web menu exactly as before. Host installed → presents and returns true; if the host then
 *  fails to present, `onFallback` opens the web menu instead. */
export function openNativeSheetMenu(build: () => SheetMenu | null, opts: { onFallback?: () => void; onClose?: () => void } = {}): boolean {
  if (!nativeSheetPresenter()) return false
  const menu = build()
  if (!menu || !hasItems(menu)) return false
  void runNativeSheetMenu(menu, { onClose: opts.onClose }).then((handled) => { if (!handled) opts.onFallback?.() })
  return true
}

/** State-driven menus: while `open` is set (null / undefined / false = closed) and a native host exists, the
 *  menu is presented natively and this returns false (do not render the web menu); `onClose` is called when
 *  the sheet is answered — clear the open state there. Without a host, or if presenting fails, returns true.
 *  `open` is the identity of one opening (e.g. the menu state object): a new value presents again.
 *  ⚠️ The native sheet is a separate window: the WebView loses focus while it is up. Callers that close their
 *  menu on `window` blur / pointerdown must skip those listeners while this returns false. */
export function useNativeSheetMenu(open: unknown, build: () => SheetMenu | null, onClose: () => void): boolean {
  const [failed, setFailed] = useState<unknown>(null)
  const latest = useRef({ build, onClose })
  latest.current = { build, onClose }
  const active = open != null && open !== false
  const native = active && failed !== open && !!nativeSheetPresenter()
  useEffect(() => {
    if (!active) { if (failed !== null) setFailed(null); return }
    if (failed === open || !nativeSheetPresenter()) return
    const menu = latest.current.build()
    if (!menu || !hasItems(menu)) { setFailed(open); return }
    const ctl = new AbortController()
    void runNativeSheetMenu(menu, { signal: ctl.signal, onClose: () => latest.current.onClose() }).then((handled) => {
      if (!handled && !ctl.signal.aborted) setFailed(open)
    })
    return () => ctl.abort()
  }, [open, failed, active])
  return !native
}
