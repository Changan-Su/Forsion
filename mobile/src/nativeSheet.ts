import { Capacitor, registerPlugin } from '@capacitor/core'
import { installNativeSelect, installNativeSheetPresenter, whileNativeSheetUp, type NativeSheetPayload } from '@lcl/engine'

/** Android-only presenter for the generic native sheet seam (lcl/engine/nativeSheet.ts).
 *  Kotlin: NativeSheetPlugin + NativeSheetUi (Compose ModalBottomSheet). Desktop / web keep their web UI. */
interface NativeSheetPlugin {
  present(request: NativeSheetPayload & { requestId: string }): Promise<{ result?: unknown; cancelled?: boolean }>
  dismiss(options: { requestId: string }): Promise<void>
}

let installed = false
export function installNativeSheet(): void {
  if (installed || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeSheet')) return
  installed = true
  const plugin = registerPlugin<NativeSheetPlugin>('NativeSheet')
  const focusReturn = installFocusReturn()
  installNativeSheetPresenter(async (payload, signal) => {
    if (signal.aborted) return null
    const requestId = crypto.randomUUID()
    const cancel = (): void => { void plugin.dismiss({ requestId }).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    focusReturn.covered(requestId)
    try {
      // A rejection (invalid / oversized request, plugin missing) propagates → the caller renders its web UI.
      // While the call is pending the shell carries data-native-sheet="open" (the page is covered; see lcl nativeSheet.ts).
      const out = await whileNativeSheetUp(() => plugin.present({ ...payload, requestId }))
      return signal.aborted || out.cancelled ? null : out.result ?? null
    } finally {
      signal.removeEventListener('abort', cancel)
      focusReturn.settled(requestId)
    }
  })
  // 下拉框(<select>)也走这张半屏:WebView 自带的那块是白底居中对话框,不跟主题(深色下尤其扎眼)。
  // 设置行的下拉没有自己的 label,标题取所在行的名字。
  installNativeSelect({ titleOf: (select) => select.closest('.settings-setting-row')?.querySelector('.settings-control-copy strong')?.textContent })
}

/** The keyboard for a text field that took the caret while a sheet was going away (walk 2026-11-19, f: avatar → command
 *  panel — the caret in its field, no keyboard). The sheet is a view over the WebView; an answer settles the call while
 *  it still animates out, and what the answer opens focuses its field at once. Android raises no keyboard for that
 *  focus while the sheet's view is there; the same focus once it is gone does (measured on the emulator: not before
 *  800 ms, at 1.5 s yes — it follows the exit). The plugin says when it is gone (`forsion:native-sheet-gone`).
 *  Only a field focused from a sheet's start until it is gone counts: one the person was already typing in when the sheet
 *  came up is left as it is (what they picked was most likely not "go on typing"). An app without the event: nothing. */
function installFocusReturn(): { covered(id: string): void; settled(id: string): void } {
  // Matched by request, not counted: the gone that counts is the latest sheet's. One that comes from a sheet that left
  // while the next is already up (opened straight away, or replacing it) is that one's business, and a request that
  // never settles cannot leave the watch stuck (Codex review; a counter could).
  let latest = ''
  let watching = false
  let grabbed: HTMLElement | null = null
  let lapse = 0
  const textField = (el: EventTarget | null): el is HTMLElement =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type))
  document.addEventListener('focusin', (e) => { if (watching && textField(e.target)) grabbed = e.target }, true)
  window.addEventListener('forsion:native-sheet-gone', (e) => {
    const id = (e as Event & { requestId?: unknown }).requestId
    if (typeof id === 'string' && id !== latest) return // an earlier sheet's (an app without the id: the latest)
    window.clearTimeout(lapse)
    watching = false
    const el = grabbed
    grabbed = null
    if (!el || el !== document.activeElement || !el.isConnected) return
    el.blur()
    el.focus({ preventScroll: true })
  })
  return {
    covered: (id) => { window.clearTimeout(lapse); latest = id; watching = true },
    // the event normally comes within the exit animation; a sheet taken down without one (replaced, aborted) or an
    // app that never sends it must not leave the watch on. Only the latest sheet's settling starts the clock.
    settled: (id) => {
      if (id !== latest) return
      window.clearTimeout(lapse)
      lapse = window.setTimeout(() => { watching = false; grabbed = null }, 4000)
    },
  }
}
const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'])
