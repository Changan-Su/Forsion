/**
 * node:fs/promises 形状的薄壳,底层是 @capacitor/filesystem(Directory.Data)。
 * 让移植进来的 VaultManager/VaultIndex 只需把 `import {promises as fs} from 'node:fs'` 换成本模块,逻辑照搬。
 *
 * 路径约定:VaultManager 用**虚拟绝对路径** `/vault/...` 做根(path-browserify 的 resolve/relative 照常算),
 * 本壳把绝对路径去前导 `/` 得 Capacitor Data 相对路径(vault 落 Data/vault/...)。
 */
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
  /** 'utf8' → string;否则 Uint8Array(实际 JS 侧只用 utf8,图片由原生 amadeus-asset 拦截读)。 */
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
}
