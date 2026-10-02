import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { ArrowLeft, MoreHorizontal, PanelLeft, PanelRight } from 'lucide-react'
import {
  dispatchNativeChromeAction, installNativeChromeHost, readNativeTheme, renderNativeIcons,
  type NativeChromeAction, type NativeChromeState, type NativeIcon, type NativeSheetTheme,
} from '@lcl/engine'

/** Android-only host for the native top bar seam (lcl/engine/nativeChrome.ts). Kotlin: NativeChromePlugin.
 *  Pushes the effective state + live theme + serialized icons; relays bar actions back to the seam.
 *  If the plugin ever rejects, the host uninstalls itself so the shell falls back to its web top bar. */
interface ChromeIcons { left?: NativeIcon; right?: NativeIcon; more?: NativeIcon; back?: NativeIcon }
interface NativeChromePlugin {
  setState(state: NativeChromeState & { theme: NativeSheetTheme; icons: ChromeIcons }): Promise<void>
  clear(): Promise<void>
  addListener(event: 'action', cb: (e: { action: string }) => void): Promise<PluginListenerHandle>
}
const ACTIONS: readonly NativeChromeAction[] = ['left', 'right', 'tabs', 'more', 'back']

let installed = false
export function installNativeChrome(): void {
  if (installed || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeChrome')) return
  installed = true
  const plugin = registerPlugin<NativeChromePlugin>('NativeChrome')
  const icons: Promise<ChromeIcons> = renderNativeIcons([PanelLeft, PanelRight, MoreHorizontal, ArrowLeft])
    .then(([left, right, more, back]) => ({ left, right, more, back }))
  let state: NativeChromeState | null = null
  let lastSent = ''
  let chain: Promise<void> = Promise.resolve()
  let uninstall: (() => void) | null = null

  const send = (): void => {
    chain = chain.then(async () => {
      if (!state || !uninstall) return
      const payload = { ...state, theme: readNativeTheme(), icons: await icons }
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
    if ((ACTIONS as readonly string[]).includes(e.action)) dispatchNativeChromeAction(e.action as NativeChromeAction)
  }).catch(() => {})
  // Skin / mode / custom colour changes repaint the bar (same attributes the model picker watches + inline vars).
  new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-skin', 'data-bg', 'data-theme', 'style', 'class'] })
  // A reload (or the auth redirect) tears the native bar down; the new page re-installs and re-pushes.
  uninstall = installNativeChromeHost({ render: (next) => { state = next; send() } })
}
