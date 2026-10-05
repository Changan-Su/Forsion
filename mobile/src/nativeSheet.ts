import { Capacitor, registerPlugin } from '@capacitor/core'
import { installNativeSelect, installNativeSheetPresenter, type NativeSheetPayload } from '@lcl/engine'

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
  installNativeSheetPresenter(async (payload, signal) => {
    if (signal.aborted) return null
    const requestId = crypto.randomUUID()
    const cancel = (): void => { void plugin.dismiss({ requestId }).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      // A rejection (invalid / oversized request, plugin missing) propagates → the caller renders its web UI.
      const out = await plugin.present({ ...payload, requestId })
      return signal.aborted || out.cancelled ? null : out.result ?? null
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  })
  // 下拉框(<select>)也走这张半屏:WebView 自带的那块是白底居中对话框,不跟主题(深色下尤其扎眼)。
  // 设置行的下拉没有自己的 label,标题取所在行的名字。
  installNativeSelect({ titleOf: (select) => select.closest('.settings-setting-row')?.querySelector('.settings-control-copy strong')?.textContent })
}
