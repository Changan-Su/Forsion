/**
 * PluginFs 的 Capacitor 实现(Directory.Data = 应用私有目录;浏览器台架里是 Filesystem 的 IndexedDB 实现)
 * + 原生下载(Filesystem.downloadFile 流式落到 Cache,先 stat 判大小再读,超限的包永远不进 WebView 内存)。
 * ⚠️ 只许 mobile/src/main.tsx 的装配链引用:web 包图没有 @capacitor/filesystem 的桩。
 */
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { base64ToBytes, bytesToBase64, type PluginFs, type PluginFsEntry } from './pluginFs'
import type { MarketDownload } from './mobileMarket'

const DIR = Directory.Data

export function capacitorPluginFs(): PluginFs {
  return {
    async readBytes(path) {
      const r = await Filesystem.readFile({ path, directory: DIR })
      return typeof r.data === 'string' ? base64ToBytes(r.data) : new Uint8Array(await r.data.arrayBuffer())
    },
    async writeBytes(path, bytes) {
      await Filesystem.writeFile({ path, directory: DIR, data: bytesToBase64(bytes), recursive: true })
    },
    async list(dir) {
      const r = await Filesystem.readdir({ path: dir, directory: DIR })
      return r.files.map((f): PluginFsEntry => ({ name: f.name, type: f.type === 'directory' ? 'directory' : 'file' }))
    },
    async stat(path) {
      try {
        const s = await Filesystem.stat({ path, directory: DIR })
        return { type: s.type === 'directory' ? 'directory' : 'file', size: Number(s.size) || 0 }
      } catch {
        return null
      }
    },
    async removeDir(path) {
      try {
        await Filesystem.stat({ path, directory: DIR })
      } catch {
        return // 不存在 = 已删
      }
      await Filesystem.rmdir({ path, directory: DIR, recursive: true })
    },
  }
}

/**
 * 原生下载:不经 WebView 的 fetch(GitHub archive / codeload 不给 CORS 头),HttpURLConnection 跟随重定向、
 * 流式写进 Cache;连接 / 读超时由原生层管。下载完先 stat:超过上限直接删掉报 `too large`,不读进内存。
 * HTTP 4xx/5xx 时原生层的 inputStream 抛 IOException → 这里 reject(消息里通常带状态码)。
 */
export function nativeMarketDownload(): MarketDownload {
  return async (url, { maxBytes, onProgress }) => {
    const path = `forsion-market-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`
    const sub = await Filesystem.addListener('progress', (p) => {
      if (p.url === url) onProgress(p.bytes, p.contentLength > 0 ? p.contentLength : null)
    })
    try {
      await Filesystem.downloadFile({ url, path, directory: Directory.Cache, progress: true, connectTimeout: 15_000, readTimeout: 20_000 })
      const st = await Filesystem.stat({ path, directory: Directory.Cache })
      if ((Number(st.size) || 0) > maxBytes) throw new Error('too large')
      const r = await Filesystem.readFile({ path, directory: Directory.Cache })
      return typeof r.data === 'string' ? base64ToBytes(r.data) : new Uint8Array(await r.data.arrayBuffer())
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      throw new Error(/timed? ?out/i.test(msg) ? 'timeout' : msg.slice(0, 160))
    } finally {
      void sub.remove().catch(() => {})
      void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {})
    }
  }
}

/** 真机(Android)走原生下载;浏览器台架 / dev 预览返回 null,由调用方退回 fetch。 */
export const isNativeAndroid = (): boolean => Capacitor.getPlatform() === 'android'
