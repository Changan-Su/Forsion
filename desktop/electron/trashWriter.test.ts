/** 回收站桌面这一半:挪进去 / 放回原处 / 原处被占落到「-2」/ 回收站是软链就拒绝(否则插件和库里的数据会被挪到链接指向的地方)。 */
import { promises as fs, existsSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '' }))
vi.mock('./forsionHome', () => ({ tanguDataDir: () => path.join(env.root, 'tangu') }))
const { moveToDesktopTrash, restoreDesktopTrash } = await import('./trashWriter')

beforeEach(() => { env.root = mkdtempSync(path.join(os.tmpdir(), 'trash-writer-')) })

async function plugin(): Promise<{ dir: string; settings: string }> {
  const dir = path.join(env.root, 'plugins', 'demo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), '{"id":"demo"}')
  const settings = path.join(env.root, 'settings', 'demo.json')
  await fs.mkdir(path.dirname(settings), { recursive: true })
  await fs.writeFile(settings, '{"a":1}')
  return { dir, settings }
}

it('moves everything in, restores everything back to where it was', async () => {
  const { dir, settings } = await plugin()
  const e = await moveToDesktopTrash({ ref: 'demo', name: 'Demo', paths: [{ path: dir, role: 'files' }, { path: settings, role: 'settings' }, { path: path.join(env.root, 'missing'), role: 'vault' }], extra: { pluginId: 'demo' } })
  expect(e?.items.map((i) => i.role)).toEqual(['files', 'settings']) // 不存在的那件不记
  expect(existsSync(dir) || existsSync(settings)).toBe(false)
  const back = await restoreDesktopTrash(e!.id)
  expect(back.extra).toEqual({ pluginId: 'demo' })
  expect(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')).toBe('{"id":"demo"}')
  expect(await fs.readFile(settings, 'utf8')).toBe('{"a":1}')
  expect(existsSync(path.join(env.root, 'tangu', 'trash', e!.id))).toBe(false)
})

it('a taken path restores beside it as <name>-2 (files keep their extension)', async () => {
  const { dir, settings } = await plugin()
  const e = await moveToDesktopTrash({ ref: 'demo', name: 'Demo', paths: [{ path: dir, role: 'files' }, { path: settings, role: 'settings' }] })
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(settings, 'new')
  await restoreDesktopTrash(e!.id)
  expect(existsSync(path.join(env.root, 'plugins', 'demo-2', 'manifest.json'))).toBe(true)
  expect(await fs.readFile(path.join(env.root, 'settings', 'demo-2.json'), 'utf8')).toBe('{"a":1}')
  expect(await fs.readFile(settings, 'utf8')).toBe('new') // 新装的那份没被盖
})

it('nothing present = no entry; a symlinked trash dir is refused and nothing moves', async () => {
  expect(await moveToDesktopTrash({ ref: 'x', name: 'X', paths: [{ path: path.join(env.root, 'nope'), role: 'files' }] })).toBeNull()
  const { dir } = await plugin()
  const elsewhere = path.join(env.root, 'elsewhere')
  await fs.mkdir(elsewhere); await fs.mkdir(path.join(env.root, 'tangu'), { recursive: true })
  await fs.symlink(elsewhere, path.join(env.root, 'tangu', 'trash'))
  await expect(moveToDesktopTrash({ ref: 'demo', name: 'Demo', paths: [{ path: dir, role: 'files' }] })).rejects.toThrow(/regular directory/)
  expect(existsSync(path.join(dir, 'manifest.json'))).toBe(true)
  expect(await fs.readdir(elsewhere)).toEqual([])
})

it('restore refuses ids that could walk out of the trash', async () => {
  await expect(restoreDesktopTrash('../../etc')).rejects.toThrow(/invalid trash id/)
})
