/**
 * P1-DL:原生「存到下载」的门控与调用口(叶子模块:只依赖 i18n 与通知 store)。
 *
 * 病根:安卓 App 的 Capacitor WebView 没有 DownloadListener,`<a download href=blob:>` 点了什么都不发生 ——
 * 手机上「本会话的文件」的下载键是哑弹,而浏览器台架是绿的(浏览器自己会存)。
 * 所以 downloadWorkspaceFile 先问 host 有没有 `window.tangu?.saveDownload`(只有 mobileShim 的 native 路径注入,
 * 原生半身 = mobile/android …/DownloadsPlugin.java,写 MediaStore.Downloads),有就走它,没有(desktop / web /
 * 移动端 dev)照旧 `<a download>`。
 *
 * 上限 {@link NATIVE_DOWNLOAD_MAX_BYTES} = 50 MB:整份字节要先落进 WebView 的一个 Blob 再分块递给原生,
 * 更大的文件该走流式下载(未做)。响应头 Content-Length 超限时**在读 body 之前**就拒,别为了拒绝先吞 500 MB。
 *
 * ⚠️ 门控字面量逐字写成 `window.tangu?.saveDownload`:本文件在 check:parity 的 GATE_FILES 里,别解构、别起别名。
 */
import { registerMessages, translate } from '../i18n'
import { notifyApp } from '../stores/notificationStore'

/** 与原生 DownloadsPlugin.MAX_BYTES、mobile/src/saveDownload.ts 同值。 */
export const NATIVE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024

registerMessages({
  'nativedl.saved': { zh: '已保存到「下载」: {name}', en: 'Saved to Downloads: {name}' },
  'nativedl.tooLarge': {
    zh: '文件太大（{size} MB），手机上一次最多保存 {max} MB',
    en: 'File is too large ({size} MB); the phone can save up to {max} MB at a time',
  },
  'nativedl.unsupportedOs': { zh: '保存到「下载」需要 Android 10 及以上', en: 'Saving to Downloads requires Android 10 or later' },
  'nativedl.failed': { zh: '保存到「下载」失败：{err}', en: 'Could not save to Downloads: {err}' },
})

export type SaveDownloadFn = (name: string, mime: string, data: Blob) => Promise<{ name: string }>

/** host 门控:安卓 App 才有;vitest(environment: node)下没有 window。 */
export function nativeSaveDownload(): SaveDownloadFn | null {
  return (typeof window !== 'undefined' ? window.tangu?.saveDownload : undefined) ?? null
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)

function tooLarge(size: number): Error {
  return Object.assign(new Error(translate('nativedl.tooLarge', { size: mb(size), max: String(NATIVE_DOWNLOAD_MAX_BYTES / 1024 / 1024) })), { code: 'too_large' })
}

/** 原生 reject(Capacitor 的 code)→ 本地化的一句话。 */
function localize(err: unknown): Error {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'unsupported_os') return Object.assign(new Error(translate('nativedl.unsupportedOs')), { code })
  const detail = String((err as { message?: unknown } | null)?.message || err || '')
  return Object.assign(new Error(translate('nativedl.failed', { err: detail })), { code: typeof code === 'string' ? code : undefined })
}

/**
 * 把一个已经 ok 的下载响应交给原生存进「下载」,成功弹「已保存到『下载』: <实际文件名>」。
 * 失败一律抛本地化的 Error(调用方照旧 toast err.message)。返回实际落下的文件名(MediaStore 可能去重成 `x (1).txt`)。
 */
export async function saveResponseNative(save: SaveDownloadFn, name: string, r: Response): Promise<string> {
  const declared = Number(r.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > NATIVE_DOWNLOAD_MAX_BYTES) {
    try { await r.body?.cancel() } catch { /* 已经断了 */ }
    throw tooLarge(declared)
  }
  const blob = await r.blob()
  if (blob.size > NATIVE_DOWNLOAD_MAX_BYTES) throw tooLarge(blob.size)
  let saved: string
  try {
    saved = (await save(name, blob.type || '', blob)).name || name
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'too_large') throw tooLarge(blob.size)
    throw localize(err)
  }
  // 用户刚点的下载键的即时回执:只在应用内弹,不跟发系统横幅
  notifyApp({ text: translate('nativedl.saved', { name: saved }), level: 'info', inAppOnly: true })
  return saved
}
