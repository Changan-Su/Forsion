/**
 * PluginFs 的 Capacitor 实现(Directory.Data = 应用私有目录;浏览器台架里是 Filesystem 的 IndexedDB 实现)
 * + 原生封顶下载的装配(MarketDownloadPlugin.kt:流式落到应用缓存、超过上限当场中止,超限的包永远不进 WebView 内存、
 *   也不会把存储写满)。
 * ⚠️ 只许 mobile/src/main.tsx 的装配链引用:web 包图没有 @capacitor/filesystem 的桩。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { base64ToBytes, bytesToBase64, type PluginFs, type PluginFsEntry } from './pluginFs'
import { createNativeDownload, type MarketDownload } from './mobileMarket'

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
    // Android:目标目录已存在 → 抛 DestinationDirectoryExists(不覆盖);先试 File.renameTo,失败才退到复制 + 删源。
    async rename(from, to) {
      await Filesystem.rename({ from, to, directory: DIR, toDirectory: DIR })
    },
  }
}

/** 原生插件 `ForsionMarketDownload` 的 JS 形状(MarketDownloadPlugin.kt 的 @PluginMethod)。 */
interface MarketDownloadPlugin {
  download(o: { id: string; url: string; maxBytes: number }): Promise<{ name: string; size: number }>
  discard(o: { name: string }): Promise<void>
  addListener(event: 'progress', cb: (p: { id: string; received: number; total: number }) => void): Promise<PluginListenerHandle>
}
const MARKET_DOWNLOAD_PLUGIN = 'ForsionMarketDownload'

/**
 * 原生下载(策略与单测都在 CappedDownload.kt):HttpURLConnection 流式写进应用缓存,字节上限在传输中强制;
 * 只认 https、重定向只跟到 https、不带应用的头与 cookie、连接 / 断流超时。下完由这里按 Directory.Cache 读回,读没读成都删。
 */
export function nativeMarketDownload(): MarketDownload {
  const plugin = registerPlugin<MarketDownloadPlugin>(MARKET_DOWNLOAD_PLUGIN)
  return createNativeDownload({
    download: (o) => plugin.download(o),
    onProgress: async (cb) => {
      const sub = await plugin.addListener('progress', cb)
      return () => { void sub.remove().catch(() => {}) }
    },
    read: async (name) => {
      const r = await Filesystem.readFile({ path: name, directory: Directory.Cache })
      return typeof r.data === 'string' ? base64ToBytes(r.data) : new Uint8Array(await r.data.arrayBuffer())
    },
    discard: (name) => plugin.discard({ name }),
  })
}

/** 真机(Android)且原生下载插件在 → 走原生下载;浏览器台架 / dev 预览返回 false,由调用方退回 fetch。 */
export const hasNativeMarketDownload = (): boolean => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable(MARKET_DOWNLOAD_PLUGIN)

/** debug 包(原生桥按 FLAG_DEBUGGABLE 注入 `Capacitor.DEBUG`):台架从宿主机回环发安装包,见 mobileMarket 的 allowLoopbackHttp。 */
export const isDebuggableAndroid = (): boolean => Capacitor.getPlatform() === 'android' && Capacitor.DEBUG === true
