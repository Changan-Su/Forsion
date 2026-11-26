/**
 * PluginFs 的 Capacitor 实现(Directory.Data = 应用私有目录;浏览器台架里是 Filesystem 的 IndexedDB 实现)
 * + 插件数据文件夹(ctx.storage)的 PluginStorageFs 实现与 `plugin-data/` 的可加载地址
 * + 原生封顶下载的装配(MarketDownloadPlugin.kt:流式落到应用缓存、超过上限当场中止,超限的包永远不进 WebView 内存、
 *   也不会把存储写满)。
 * ⚠️ 只许 mobile/src/main.tsx 的装配链引用:web 包图没有 @capacitor/filesystem 的桩。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { base64ToBytes, bytesToBase64, type PluginFs, type PluginFsEntry } from './pluginFs'
import { createNativeDownload, type MarketDownload } from './mobileMarket'
import { PLUGIN_STORAGE_DIR, type PluginStorageFs, type StorageFsEntry, type StorageFsStat } from './pluginStorageHost'

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

// ── 插件数据文件夹(ctx.storage)的接缝:pluginStorageHost.ts 的 PluginStorageFs ─────────────────────────────
// 和上面 PluginFs 的差别:「不存在」与「读失败」必须分开(读失败 ≠ 空)。Capacitor 的错误带 code:安卓 = OS-PLUG-FILE-0008
// (消息「… does not exist.」),浏览器台架(IndexedDB)只有消息(「File / Entry / Folder does not exist.」)。都认不出时
// 看父目录:父目录读得到、里面没有它 = 不存在;父目录也不在 = 它也不在;别的情况照原错抛(同 vaultManager.statEntry)。

const NOT_FOUND_CODE = 'OS-PLUG-FILE-0008'
const NOT_FOUND_TEXT = /does not exist|no such file|not found/i
const saysMissing = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === NOT_FOUND_CODE || NOT_FOUND_TEXT.test(String((e as Error | null)?.message ?? e))
const splitPath = (p: string): [string, string] => {
  const i = p.lastIndexOf('/')
  return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]
}

/** e 来自对 path 的一次操作:是不是因为 path 不存在。 */
async function isMissing(path: string, e: unknown): Promise<boolean> {
  if (saysMissing(e)) return true
  const [parent, name] = splitPath(path)
  if (!name) return false
  let names: string[]
  try {
    names = (await Filesystem.readdir({ path: parent, directory: DIR })).files.map((f) => f.name)
  } catch (pe) {
    return parent ? isMissing(parent, pe) : false
  }
  return !names.includes(name)
}

const toStat = (s: { type: string; size: number; mtime: number }): StorageFsStat => ({
  type: s.type === 'directory' ? 'directory' : 'file', size: Number(s.size) || 0, mtime: Number(s.mtime) || 0,
})

export function capacitorPluginStorageFs(): PluginStorageFs {
  const stat = async (path: string): Promise<StorageFsStat | null> => {
    try {
      return toStat(await Filesystem.stat({ path, directory: DIR }))
    } catch (e) {
      if (await isMissing(path, e)) return null
      throw e
    }
  }
  return {
    async readBytes(path) {
      try {
        const r = await Filesystem.readFile({ path, directory: DIR })
        return typeof r.data === 'string' ? base64ToBytes(r.data) : new Uint8Array(await r.data.arrayBuffer())
      } catch (e) {
        if (await isMissing(path, e)) return null
        throw e
      }
    },
    async writeBytes(path, bytes) {
      await Filesystem.writeFile({ path, directory: DIR, data: bytesToBase64(bytes), recursive: true })
    },
    async appendBytes(path, bytes) {
      await Filesystem.appendFile({ path, directory: DIR, data: bytesToBase64(bytes) })
    },
    stat,
    async list(dir) {
      try {
        const r = await Filesystem.readdir({ path: dir, directory: DIR })
        return r.files.map((f): StorageFsEntry => ({ name: f.name, ...toStat(f) }))
      } catch (e) {
        if (await isMissing(dir, e)) return null
        throw e
      }
    },
    async mkdir(path) {
      if (!path) return
      try {
        await Filesystem.mkdir({ path, directory: DIR, recursive: true })
      } catch (e) {
        if ((await stat(path).catch(() => null))?.type === 'directory') return // 已存在不算错
        throw e
      }
    },
    // 安卓:文件换名会先删掉已存在的目标再 renameTo(失败退到复制 + 删源);文件夹目标已存在 → 拒。调用方自己先判目标。
    async rename(from, to) {
      await Filesystem.rename({ from, to, directory: DIR, toDirectory: DIR })
    },
    async remove(path) {
      const s = await stat(path)
      if (!s) return // 不存在 = 已删
      if (s.type === 'directory') await Filesystem.rmdir({ path, directory: DIR, recursive: true })
      else await Filesystem.deleteFile({ path, directory: DIR })
    },
  }
}

/** `plugin-data/` 在 WebView 里可直接加载的地址(无尾斜杠;同 fsAdapter.webUrl:convertFileSrc 换成与页面同源的
 *  `https://localhost/_capacitor_file_/…`)。浏览器台架 / dev 预览里没有人服务这个路径 → null。启动时取一次,url() 同步用。 */
export async function pluginStorageBaseUrl(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null
  await capacitorPluginStorageFs().mkdir(PLUGIN_STORAGE_DIR)
  const r = await Filesystem.getUri({ path: PLUGIN_STORAGE_DIR, directory: DIR })
  return Capacitor.convertFileSrc(r.uri).replace(/\/+$/, '') || null
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
