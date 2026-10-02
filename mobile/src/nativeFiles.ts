import { Capacitor, registerPlugin } from '@capacitor/core'
import { registerMessages, translate } from '@/i18n'
import { useApp } from '@/stores/appStore'

/** Android-only `window.tangu.pickFiles` (Kotlin: NativeFilePickerPlugin, the system document picker).
 *  The chat "Add files" entry needs it when picked from a native sheet: that tap happens in another window,
 *  so the WebView has no user activation and `<input type=file>.click()` is silently dropped by Chromium.
 *  Files the native side refuses (too large / too many) are reported, never dropped silently. */
registerMessages({
  'mobile.files.skipped': { zh: '有 {n} 个文件太大或太多，没有添加：{names}', en: '{n} file(s) were too large or too many and were not added: {names}' },
})

interface PickedFile { name: string; type: string; data: string }
interface NativeFilePicker { pick(): Promise<{ files?: PickedFile[]; skipped?: string[] }> }

function decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let installed = false
export function installNativeFilePicker(): void {
  const host = (window as { tangu?: { pickFiles?: () => Promise<File[]> } }).tangu
  if (installed || !host || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeFilePicker')) return
  installed = true
  const plugin = registerPlugin<NativeFilePicker>('NativeFilePicker')
  host.pickFiles = async () => {
    const out = await plugin.pick()
    const skipped = (out.skipped ?? []).filter((x) => typeof x === 'string')
    if (skipped.length) useApp.getState().toast(translate('mobile.files.skipped', { n: skipped.length, names: skipped.slice(0, 5).join(', ') }), true)
    return (out.files ?? [])
      .filter((f) => f && typeof f.name === 'string' && typeof f.data === 'string')
      .map((f) => new File([decode(f.data)], f.name, { type: typeof f.type === 'string' ? f.type : '' }))
  }
}
