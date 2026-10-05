import { Capacitor, registerPlugin } from '@capacitor/core'
import { registerMessages, translate } from '@/i18n'
import { useApp } from '@/stores/appStore'
import { loadPickedFiles } from './pickedFiles'

/** Android-only sources of the chat "+" sheet (Kotlin: NativeFilePickerPlugin): `window.tangu.pickFiles` (system
 *  document picker), `pickPhotos` (system photo picker) and `takePhoto` (the camera app).
 *  They exist because those rows are picked from a native sheet: that tap happens in another window, so the WebView
 *  has no user activation and `<input type=file>.click()` is silently dropped by Chromium.
 *  Refused files (too large / too many / unreadable, on either side) are reported, never dropped silently. */
registerMessages({
  'mobile.files.skipped': { zh: '有 {n} 个文件太大、太多或无法读取，没有添加：{names}', en: '{n} file(s) were too large, too many or unreadable and were not added: {names}' },
  'mobile.files.cameraDenied': { zh: '没有相机权限，无法拍照。可以在系统设置里允许 Forsion 使用相机。', en: 'Camera access is off, so no photo was taken. You can allow it for Forsion in system settings.' },
  'mobile.files.noCamera': { zh: '相机打不开。', en: 'The camera could not be opened.' },
  'mobile.files.noPicker': { zh: '系统的选择器打不开。', en: 'The system picker could not be opened.' },
})

type Source = 'files' | 'photos' | 'camera'
interface NativeFilePicker { pick(options: { source: Source }): Promise<{ files?: unknown; skipped?: unknown }> }
type Host = { pickFiles?: () => Promise<File[]>; pickPhotos?: () => Promise<File[]>; takePhoto?: () => Promise<File[]> }

let installed = false
export function installNativeFilePicker(): void {
  const host = (window as { tangu?: Host }).tangu
  if (installed || !host || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('NativeFilePicker')) return
  installed = true
  const plugin = registerPlugin<NativeFilePicker>('NativeFilePicker')
  const from = (source: Source) => async (): Promise<File[]> => {
    const report = (text: string): void => useApp.getState().toast(text, true)
    // 原生只回 { uri, name, type, size };字节由 WebView 经 Capacitor 本地服务器流式取(见 pickedFiles.ts)。
    // 读权限是选择器授给本 Activity 的(拍照是本 App 自己的缓存文件),pick() 一返回就取,不持久化、也无须释放。
    let out: Awaited<ReturnType<NativeFilePicker['pick']>>
    try {
      out = await plugin.pick({ source })
    } catch (e) {
      // 原生给的码:busy = 上一个选择器 / 相机还开着(用户正看着它,不用再说什么);denied = 没给相机权限;
      // 别的一律按「打不开」报,绝不静默。
      const code = (e as { code?: unknown } | null)?.code
      if (code === 'busy') return []
      if (code === 'denied') report(translate('mobile.files.cameraDenied'))
      else report(source === 'camera' ? translate('mobile.files.noCamera') : translate('mobile.files.noPicker'))
      return []
    }
    const loaded = await loadPickedFiles(out.files, {
      toUrl: (uri) => Capacitor.convertFileSrc(uri),
      fetch: (url) => window.fetch(url),
    })
    const refused = Array.isArray(out.skipped) ? out.skipped.filter((x): x is string => typeof x === 'string') : []
    const skipped = [...refused, ...loaded.skipped]
    if (skipped.length) report(translate('mobile.files.skipped', { n: skipped.length, names: skipped.slice(0, 5).join(', ') }))
    return loaded.files
  }
  host.pickFiles = from('files')
  host.pickPhotos = from('photos')
  host.takePhoto = from('camera')
}
