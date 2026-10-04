import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { ArrowLeft, MoreHorizontal, PanelLeft, PanelRight, X } from 'lucide-react'
import {
  dispatchNativeChromeAction, dispatchNativeChromeSpace, installNativeChromeHost, readNativeTheme, renderNativeIcons, useSpaceStore,
  type NativeChromeAction, type NativeChromeSpace, type NativeChromeState, type NativeIcon, type NativeSheetTheme,
} from '@lcl/engine'

/** Android-only host for the native top bar seam (lcl/engine/nativeChrome.ts). Kotlin: NativeChromePlugin.
 *  Pushes the effective state + live theme + serialized icons; relays bar actions back to the seam.
 *  Also draws the Space switcher as a bottom navigation bar (`spaces: true`): the shell sends the Space list,
 *  this host adds each Space's icon (serialized once per icon component) and relays taps / long-presses.
 *  If the plugin ever rejects, the host uninstalls itself so the shell falls back to its web top bar. */
interface ChromeIcons { left?: NativeIcon; right?: NativeIcon; more?: NativeIcon; back?: NativeIcon; close?: NativeIcon }
interface NativeChromePlugin {
  setState(state: Omit<NativeChromeState, 'spaces'> & { theme: NativeSheetTheme; icons: ChromeIcons; spaces?: Array<NativeChromeSpace & { icon?: NativeIcon }> }): Promise<void>
  clear(): Promise<void>
  addListener(event: 'action', cb: (e: { action: string; id?: string }) => void): Promise<PluginListenerHandle>
}
const ACTIONS: readonly NativeChromeAction[] = ['left', 'right', 'tabs', 'more', 'back', 'close']
const MAX_SPACES = 64 // = ChromeState.MAX_SPACES (Kotlin)

let installed = false
export function installNativeChrome(): void {
  if (installed || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeChrome')) return
  installed = true
  const plugin = registerPlugin<NativeChromePlugin>('NativeChrome')
  const icons: Promise<ChromeIcons> = renderNativeIcons([PanelLeft, PanelRight, MoreHorizontal, ArrowLeft, X])
    .then(([left, right, more, back, close]) => ({ left, right, more, back, close }))
  // Space icons are React components: serialize each once (keyed by the component, so a re-registered Space re-renders).
  const spaceIcons = new Map<unknown, NativeIcon | undefined>()
  const withIcons = async (all: NativeChromeSpace[]): Promise<Array<NativeChromeSpace & { icon?: NativeIcon }>> => {
    // ponytail: the bar scrolls, but a payload is still capped (Kotlin MAX_SPACES). Past it the tail is not shown —
    // far beyond any real Space count; a rejected setState would instead take the whole native chrome down.
    const list = all.slice(0, MAX_SPACES)
    const defs = useSpaceStore.getState().spaces
    const sources = list.map((sp) => defs.find((d) => d.id === sp.id)?.icon)
    const missing = [...new Set(sources.filter((src) => src && !spaceIcons.has(src)))]
    if (missing.length) (await renderNativeIcons(missing as never[])).forEach((icon, i) => spaceIcons.set(missing[i], icon))
    return list.map((sp, i) => { const icon = sources[i] ? spaceIcons.get(sources[i]) : undefined; return icon ? { ...sp, icon } : sp })
  }
  let state: NativeChromeState | null = null
  let lastSent = ''
  let chain: Promise<void> = Promise.resolve()
  let uninstall: (() => void) | null = null

  const send = (): void => {
    chain = chain.then(async () => {
      if (!state || !uninstall) return
      const current = state
      const base = await icons
      const payload = {
        // two-level navigation, detail level: the left button goes back to the Space's list → back arrow, not the panel icon
        ...current, theme: readNativeTheme(), icons: current.mode === 'shell' && current.leftBack ? { ...base, left: base.back } : base,
        ...(current.mode === 'shell' && current.spaces ? { spaces: await withIcons(current.spaces) } : {}),
      }
      const key = JSON.stringify(payload)
      if (key === lastSent) return
      try {
        await plugin.setState(payload)
        lastSent = key
      } catch (e) {
        // Broken native side: never leave the user without a top bar.
        console.error('[tangu-mobile] native chrome failed, falling back to web top bar:', e)
        uninstall?.(); uninstall = null
        void plugin.clear().catch(() => {})
      }
    })
  }

  void plugin.addListener('action', (e) => {
    if ((e.action === 'space' || e.action === 'spaceLong') && typeof e.id === 'string') dispatchNativeChromeSpace(e.id, e.action === 'spaceLong')
    else if ((ACTIONS as readonly string[]).includes(e.action)) dispatchNativeChromeAction(e.action as NativeChromeAction)
  }).catch(() => {})
  // Skin / mode / custom colour changes repaint the bar (same attributes the model picker watches + inline vars).
  new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-skin', 'data-bg', 'data-theme', 'style', 'class'] })
  // A reload (or the auth redirect) tears the native bar down; the new page re-installs and re-pushes.
  uninstall = installNativeChromeHost({ spaces: true, render: (next) => { state = next; send() } })
}
