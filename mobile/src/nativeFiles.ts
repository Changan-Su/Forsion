import { Capacitor, registerPlugin } from '@capacitor/core'
import { registerMessages, translate } from '@/i18n'
import { useApp } from '@/stores/appStore'
import { loadPickedFiles } from './pickedFiles'

/** Android-only `window.tangu.pickFiles` (Kotlin: NativeFilePickerPlugin, the system document picker).
 *  The chat "Add files" entry needs it when picked from a native sheet: that tap happens in another window,
 *  so the WebView has no user activation and `<input type=file>.click()` is silently dropped by Chromium.
 *  Refused files (too large / too many / unreadable, on either side) are reported, never dropped silently. */
registerMessages({
  'mobile.files.skipped': { zh: '有 {n} 个文件太大、太多或无法读取，没有添加：{names}', en: '{n} file(s) were too large, too many or unreadable and were not added: {names}' },
})

interface NativeFilePicker { pick(): Promise<{ files?: unknown; skipped?: unknown }> }

let installed = false
export function installNativeFilePicker(): void {
  const host = (window as { tangu?: { pickFiles?: () => Promise<File[]> } }).tangu
  if (installed || !host || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeFilePicker')) return
  installed = true
  const plugin = registerPlugin<NativeFilePicker>('NativeFilePicker')
  host.pickFiles = async () => {
    // 原生只回 { uri, name, type, size };字节由 WebView 经 Capacitor 本地服务器流式取(见 pickedFiles.ts)。
    // 读权限是 ACTION_OPEN_DOCUMENT 授给本 Activity 的,pick() 一返回就取,不持久化、也无须释放。
    const out = await plugin.pick()
    const loaded = await loadPickedFiles(out.files, {
      toUrl: (uri) => Capacitor.convertFileSrc(uri),
      fetch: (url) => window.fetch(url),
    })
    const refused = Array.isArray(out.skipped) ? out.skipped.filter((x): x is string => typeof x === 'string') : []
    const skipped = [...refused, ...loaded.skipped]
    if (skipped.length) useApp.getState().toast(translate('mobile.files.skipped', { n: skipped.length, names: skipped.slice(0, 5).join(', ') }), true)
    return loaded.files
  }
}
