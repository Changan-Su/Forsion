// 手机端 ctx.app.stat 的底座 VaultManager.statEntry(2026-11-16):Capacitor 的错没有 code,
// 「不存在」按消息认,认不出时看父目录;别的错照抛 —— 读不到 ≠ 不存在。fsAdapter 换成内存替身。
import { beforeEach, expect, it, vi } from 'vitest'

const entries = new Map<string, { type: 'file' | 'directory'; size: number; mtime: number; ctime?: number }>()
let statError: Error | null = null

vi.mock('path-browserify', async () => {
  const p = await import('node:path')
  return { default: p.posix }
})
vi.mock('../../../../mobile/src/amadeus/fsAdapter', () => ({
  fs: {
    async stat(abs: string) {
      if (statError) throw statError
      const e = entries.get(abs)
      if (!e) throw new Error('File does not exist')
      return { isDirectory: () => e.type === 'directory', isFile: () => e.type === 'file', size: e.size, mtimeMs: e.mtime, ...(e.ctime ? { birthtimeMs: e.ctime } : {}) }
    },
    async readdir(abs: string) {
      if (!entries.has(abs)) throw new Error('Directory does not exist')
      const pre = abs.endsWith('/') ? abs : `${abs}/`
      return [...entries.keys()].filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map((k) => k.slice(pre.length))
    },
  },
}))

// 经变量路径动态引:不把手机端源码(path-browserify 无类型声明)拉进桌面的 tsc 程序(同 mobileBridgeRenameLinks.test.ts)
const MOBILE_VAULT = '../../../../mobile/src/amadeus/vaultManager'
type StatResult = { kind: 'file' | 'folder'; size: number; mtime: number; ctime: number | null } | null
const { VaultManager } = (await import(/* @vite-ignore */ MOBILE_VAULT)) as {
  VaultManager: new () => { setRoot(p: string): void; statEntry(rel: string): Promise<StatResult> }
}

beforeEach(() => {
  entries.clear()
  statError = null
  entries.set('/vault', { type: 'directory', size: 0, mtime: 1 })
  entries.set('/vault/Notes', { type: 'directory', size: 0, mtime: 2 })
  entries.set('/vault/Notes/a.md', { type: 'file', size: 7, mtime: 1700000000000, ctime: 1600000000000 })
  entries.set('/vault/Notes/b.md', { type: 'file', size: 1, mtime: 5 })
})

it('种类、大小、时间;没有创建时间给 null;不存在给 null', async () => {
  const v = new VaultManager()
  v.setRoot('/vault')
  expect(await v.statEntry('Notes/a.md')).toEqual({ kind: 'file', size: 7, mtime: 1700000000000, ctime: 1600000000000 })
  expect(await v.statEntry('Notes/b.md')).toEqual({ kind: 'file', size: 1, mtime: 5, ctime: null })
  expect(await v.statEntry('Notes')).toEqual({ kind: 'folder', size: 0, mtime: 2, ctime: null })
  expect(await v.statEntry('Notes/missing.md')).toBeNull()
})

it('认不出的错:父目录读得到、里面没有它 = 不存在;它明明在 = 照抛;越界照抛', async () => {
  const v = new VaultManager()
  v.setRoot('/vault')
  statError = new Error('OS-PLUG-FILE-0008')
  expect(await v.statEntry('Notes/missing.md')).toBeNull()
  await expect(v.statEntry('Notes/a.md')).rejects.toThrow('OS-PLUG-FILE-0008')
  await expect(v.statEntry('../outside')).rejects.toThrow(/escapes vault/)
})
