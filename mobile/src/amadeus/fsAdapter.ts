/**
 * node:fs/promises 形状的薄壳,底层是 @capacitor/filesystem(Directory.Data)。
 * 让移植进来的 VaultManager/VaultIndex 只需把 `import {promises as fs} from 'node:fs'` 换成本模块,逻辑照搬。
 *
 * 路径约定:VaultManager 用**虚拟绝对路径** `/vault/...` 做根(path-browserify 的 resolve/relative 照常算),
 * 本壳把绝对路径去前导 `/` 得 Capacitor Data 相对路径(vault 落 Data/vault/...)。
 */
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'

const DIR = Directory.Data

/** 虚拟绝对路径 → Capacitor Data 相对路径。 */
function cap(abs: string): string { return abs.replace(/^\/+/, '') }

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

export interface Dirent { name: string; isDirectory(): boolean; isFile(): boolean }

export const fs = {
  /** 'utf8' → string;否则 Uint8Array(readVaultBytes / 读数据库走这条)。
   *  图片 / 音视频的显示不走这里:WebView 直接按 webUrl 给的地址去取(见 localAssets.ts)。 */
  async readFile(abs: string, encoding?: 'utf8'): Promise<any> {
    const path = cap(abs)
    if (encoding === 'utf8') {
      const r = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
      return r.data as string
    }
    const r = await Filesystem.readFile({ path, directory: DIR })
    return b64ToBytes(r.data as string)
  },
  /** string → UTF8;Uint8Array → base64。recursive 建父目录。 */
  async writeFile(abs: string, data: string | Uint8Array, _enc?: string): Promise<void> {
    const path = cap(abs)
    if (typeof data === 'string') {
      await Filesystem.writeFile({ path, directory: DIR, data, encoding: Encoding.UTF8, recursive: true })
    } else {
      await Filesystem.writeFile({ path, directory: DIR, data: bytesToB64(data), recursive: true })
    }
  },
  async readdir(abs: string, opts?: { withFileTypes?: boolean }): Promise<any> {
    const r = await Filesystem.readdir({ path: cap(abs), directory: DIR })
    if (opts?.withFileTypes) {
      return r.files.map((f) => ({ name: f.name, isDirectory: () => f.type === 'directory', isFile: () => f.type === 'file' } as Dirent))
    }
    return r.files.map((f) => f.name)
  },
  async mkdir(abs: string, _opts?: { recursive?: boolean }): Promise<void> {
    try { await Filesystem.mkdir({ path: cap(abs), directory: DIR, recursive: true }) }
    catch (e: any) { if (!/exist/i.test(String(e?.message || e))) throw e } // recursive 已存在不算错
  },
  async rename(src: string, dst: string): Promise<void> {
    await Filesystem.rename({ from: cap(src), to: cap(dst), directory: DIR, toDirectory: DIR })
  },
  /** 删文件或目录;force 时吞不存在错误。 */
  async rm(abs: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const path = cap(abs)
    try {
      const st = await Filesystem.stat({ path, directory: DIR })
      if (st.type === 'directory') await Filesystem.rmdir({ path, directory: DIR, recursive: opts?.recursive ?? true })
      else await Filesystem.deleteFile({ path, directory: DIR })
    } catch (e) { if (!opts?.force) throw e }
  },
  async unlink(abs: string): Promise<void> {
    await Filesystem.deleteFile({ path: cap(abs), directory: DIR })
  },
  /** 不存在即抛(= node fs.access 语义)。 */
  async access(abs: string): Promise<void> {
    await Filesystem.stat({ path: cap(abs), directory: DIR })
  },
  async stat(abs: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    const st = await Filesystem.stat({ path: cap(abs), directory: DIR })
    return { isDirectory: () => st.type === 'directory', isFile: () => st.type === 'file' }
  },
  /** 虚拟绝对路径 → WebView 里能直接加载的地址(无尾斜杠)。安卓:getUri 给应用私有目录下的 file:// 地址,
   *  convertFileSrc 换成 `https://localhost/_capacitor_file_/…` —— Capacitor 自带的本地文件服务,与页面同源(原生层的实测行为见 npm run emu:localasset)。
   *  浏览器里(开发 / 台架)文件系统是 IndexedDB,拿到的只是 `/DATA/vault` 这样一个路径,没有人服务它。 */
  async webUrl(abs: string): Promise<string> {
    const r = await Filesystem.getUri({ path: cap(abs), directory: DIR })
    return Capacitor.convertFileSrc(r.uri).replace(/\/+$/, '')
  },
}
