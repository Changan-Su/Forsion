import { Capacitor, registerPlugin } from '@capacitor/core'
import { installNativeSheetPresenter, type NativeSheetPayload } from '@lcl/engine'

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
}
