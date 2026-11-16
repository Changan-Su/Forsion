// ctx.app.stat 的主进程底座 VaultManager.statEntry(2026-11-16):种类 / 大小 / 修改时间 / 创建时间;
// 不存在(含父路径是文件)= null,越界与别的 IO 错照抛 —— 「读不到」不许长得像「不存在」。
import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { VaultManager } from './vaultManager'

let root = ''
afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }) })

it('文件 / 文件夹 / 库根的种类、大小与时间;不存在给 null', async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'vault-stat-'))
  await fs.mkdir(path.join(root, 'Notes'))
  await fs.writeFile(path.join(root, 'Notes', 'a.md'), 'hello')
  const when = new Date('2026-01-02T03:04:05Z')
  await fs.utimes(path.join(root, 'Notes', 'a.md'), when, when)
  const v = new VaultManager()
  v.setRoot(root)
  const file = await v.statEntry('Notes/a.md')
  expect(file).toMatchObject({ kind: 'file', size: 5, mtime: when.getTime() })
  expect(file!.ctime === null || (typeof file!.ctime === 'number' && file!.ctime > 0)).toBe(true)
  expect(await v.statEntry('Notes')).toMatchObject({ kind: 'folder', size: 0 })
  expect(await v.statEntry('')).toMatchObject({ kind: 'folder' })
  expect(await v.statEntry('Notes/missing.md')).toBeNull()
  expect(await v.statEntry('Notes/a.md/child')).toBeNull() // ENOTDIR
})

it('越界与别的 IO 错 reject,不当成不存在', async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'vault-stat-'))
  const v = new VaultManager()
  v.setRoot(root)
  await expect(v.statEntry('../outside')).rejects.toThrow(/escapes vault/)
  const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  vi.spyOn(fs, 'stat').mockRejectedValueOnce(err)
  await expect(v.statEntry('x.md')).rejects.toThrow(/EACCES/)
})
