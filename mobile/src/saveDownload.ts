/**
 * P1-DL:window.tangu.saveDownload 的移动端实现 —— 把一个 Blob 分块递给原生插件 `ForsionDownloads`
 * (android …/DownloadsPlugin.java),写进系统公共「下载」(MediaStore.Downloads)。
 *
 * 纯逻辑、**不 import capacitor**(同 unitBridge.ts):原生插件由 mobileShim 用 registerPlugin 造好注入,
 * 这样 scripts/save-download.test.cjs 能直接在 node 里跑(分块顺序 / 出错必 abort / 上限)。
 *
 * 为什么分块:Capacitor 桥把一次调用整个当一条 JSON 字符串递进 Java 堆、再解析、再解 base64 —— 单发 50 MB 在手机上
 * 峰值几百 MB 必 OOM。每块 {@link DL_CHUNK_BYTES}(3 的倍数,base64 不带中途填充),Java 那侧只占 O(块)。
 * 上限在这里再卡一道(调用方 services/nativeDownload.ts 已按 Content-Length / blob.size 卡过;直接调的也绕不过去)。
 * maxBytes 由 mobileShim 传 NATIVE_DOWNLOAD_MAX_BYTES —— 这里不 import 它,免得 node 台架把 i18n / store 整串打包进来。
 */
/** 原生插件 `ForsionDownloads` 的 JS 形状(DownloadsPlugin.java 的 @PluginMethod)。 */
export interface ForsionDownloadsPlugin {
  begin(o: { name: string; mime: string; size: number }): Promise<{ id: string }>
  append(o: { id: string; data: string }): Promise<{ written: number }>
  finish(o: { id: string }): Promise<{ name: string; size?: number }>
  abort(o: { id: string }): Promise<{ ok: boolean }>
}

/** 1.5 MB 原始字节 → 2 MB base64 一块。 */
export const DL_CHUNK_BYTES = 1536 * 1024

/** 字节 → base64。按 32 KB 小段拼 binary string(apply 一次塞太多参数会爆栈)。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
  }
  return btoa(bin)
}

export function createSaveDownload(
  plugin: ForsionDownloadsPlugin,
  opts: { maxBytes: number; chunkBytes?: number },
): (name: string, mime: string, data: Blob) => Promise<{ name: string }> {
  const max = opts.maxBytes
  const chunk = opts.chunkBytes ?? DL_CHUNK_BYTES
  return async (name, mime, data) => {
    if (data.size > max) throw Object.assign(new Error(`File exceeds ${max} bytes`), { code: 'too_large' })
    const { id } = await plugin.begin({ name, mime: mime || '', size: data.size })
    try {
      for (let off = 0; off < data.size; off += chunk) {
        const buf = new Uint8Array(await data.slice(off, off + chunk).arrayBuffer())
        await plugin.append({ id, data: bytesToBase64(buf) })
      }
      const done = await plugin.finish({ id })
      return { name: done.name || name }
    } catch (err) {
      // 原生那侧多半已经删了待定行(append / finish 失败都会);再 abort 一次是幂等的兜底
      await plugin.abort({ id }).catch(() => undefined)
      throw err
    }
  }
}
