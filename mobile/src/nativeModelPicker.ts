import { Capacitor, registerPlugin } from '@capacitor/core'
import { installModelPickerPresenter, type ModelPickerRequest, type ModelPickerValues } from '@/components/modelPickerHost'

interface NativePicker {
  setAppearance(options: { dark: boolean; background: string }): Promise<void>
  present(request: ModelPickerRequest & { requestId: string }): Promise<{ values?: ModelPickerValues; cancelled?: boolean }>
  dismiss(options: { requestId: string }): Promise<void>
}
const plugin = registerPlugin<NativePicker>('NativeModelPicker')
let installed = false
/** Shared ModelPill includes plugin ctx.ui.mountChatBox consumers. Desktop and browser keep their presenter. */
export function installNativeModelPicker(): void {
  if (installed || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeModelPicker')) return
  installed = true
  const updateAppearance = (): void => {
    const root = document.documentElement
    void plugin.setAppearance({ dark: root.dataset.mode === 'dark', background: getComputedStyle(root).getPropertyValue('--bg').trim() }).catch(() => {})
  }
  new MutationObserver(updateAppearance).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-bg', 'data-skin'] })
  updateAppearance()
  installModelPickerPresenter(async (request, signal) => {
    if (signal.aborted) return null
    const requestId = crypto.randomUUID()
    const cancel = (): void => { void plugin.dismiss({ requestId }).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await plugin.present({ ...request, requestId })
      return signal.aborted || result.cancelled ? null : result.values ?? null
    } finally { signal.removeEventListener('abort', cancel) }
  })
}
