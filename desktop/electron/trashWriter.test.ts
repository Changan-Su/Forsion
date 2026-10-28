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

it('a reinstalled plugin is not restored over; a taken settings file lands beside it as <name>-2', async () => {
  const { dir, settings } = await plugin()
  const e = await moveToDesktopTrash({ ref: 'demo', name: 'Demo', paths: [{ path: dir, role: 'files' }, { path: settings, role: 'settings' }] })
  await fs.mkdir(dir, { recursive: true })
  await expect(restoreDesktopTrash(e!.id)).rejects.toThrow('plugin-reinstalled')
  expect(existsSync(path.join(env.root, 'tangu', 'trash', e!.id, 'meta.json'))).toBe(true) // 条目还在,卸掉新装的再恢复
  await fs.rm(dir, { recursive: true }); await fs.writeFile(settings, 'new')
  await restoreDesktopTrash(e!.id)
  expect(existsSync(path.join(dir, 'manifest.json'))).toBe(true)
  expect(await fs.readFile(path.join(env.root, 'settings', 'demo-2.json'), 'utf8')).toBe('{"a":1}')
  expect(await fs.readFile(settings, 'utf8')).toBe('new') // 新写的那份没被盖
})

it('a failed move puts earlier items back; if that also fails the entry stays and restores', async () => {
  const { dir, settings } = await plugin()
  const real = fs.rename.bind(fs)
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from) === settings || String(from).endsWith(`items${path.sep}0`)) throw Object.assign(new Error('EIO'), { code: 'EIO' })
    return real(from, to)
  })
  await expect(moveToDesktopTrash({ ref: 'demo', name: 'Demo', paths: [{ path: dir, role: 'files' }, { path: settings, role: 'settings' }] })).rejects.toThrow('EIO')
  spy.mockRestore()
  const [id] = await fs.readdir(path.join(env.root, 'tangu', 'trash'))
  expect(existsSync(dir)).toBe(false) // 没挪回去的那份留在回收站里,不是删了
  await restoreDesktopTrash(id)
  expect(existsSync(path.join(dir, 'manifest.json')) && existsSync(settings)).toBe(true)
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
