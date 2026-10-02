/**
 * Android 插件宿主的最小文件接缝(纯接口 + 编解码,**不 import Capacitor**):pluginHost / mobileMarket 只认它,
 * 单测(scripts/plugin-host.test.cjs)给内存实现,真机给 capacitorPluginFs.ts(Filesystem,Directory.Data)。
 *
 * (bytesToBase64 复用「存到下载」那份:src/saveDownload.ts,纯函数、已有逐字对拍单测。)
 *
 * 一律按**字节**读写(Capacitor 侧走 base64,不带 encoding):Filesystem 的 Web 实现 readFile 无视 encoding、
 * 原样回存进去的串,文本 / 二进制分两套编码会在浏览器台架与真机上读出两种东西。文本由本模块用 UTF-8 编解码。
 */
export interface PluginFsEntry {
  name: string
  type: 'file' | 'directory'
}

export interface PluginFs {
  /** 读整个文件;不存在 → 抛错。 */
  readBytes(path: string): Promise<Uint8Array>
  /** 覆盖写(父目录自动建)。 */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  /** 列目录(不递归);目录不存在 → 抛错。 */
  list(dir: string): Promise<PluginFsEntry[]>
  /** 不存在 → null。 */
  stat(path: string): Promise<{ type: 'file' | 'directory'; size: number } | null>
  /** 递归删目录;不存在 = 已删。 */
  removeDir(path: string): Promise<void>
}

// ignoreBOM:true = 保留 BOM(与桌面 fs.readFile 'utf8' 同口径:带 BOM 的 manifest.json 两端都 JSON.parse 失败、同样被跳过)。
export { bytesToBase64 } from '../saveDownload'

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
const encoder = new TextEncoder()

export const utf8Decode = (bytes: Uint8Array): string => decoder.decode(bytes)
export const utf8Encode = (text: string): Uint8Array => encoder.encode(text)

export async function readText(fs: PluginFs, path: string): Promise<string> {
  return utf8Decode(await fs.readBytes(path))
}

export function writeText(fs: PluginFs, path: string, text: string): Promise<void> {
  return fs.writeBytes(path, utf8Encode(text))
}

/** 不存在 / 读失败 → undefined(调用方一律当「没有」处理)。 */
export async function readTextOr(fs: PluginFs, path: string): Promise<string | undefined> {
  try {
    return await readText(fs, path)
  } catch {
    return undefined
  }
}

/** base64 → Uint8Array(容忍 data URL 前缀与空白)。 */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = (b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64).replace(/\s+/g, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
