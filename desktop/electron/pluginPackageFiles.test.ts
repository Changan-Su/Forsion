import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pluginPackageFiles } from './pluginPackageFiles'
const temps: string[] = []
afterEach(async () => { await Promise.all(temps.splice(0).map((x) => fs.rm(x, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-package-')); temps.push(root)
  const dir = path.join(root, 'different-folder'); await fs.mkdir(path.join(dir, 'plugins', 'child'), { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'bridge-test' }))
  await fs.writeFile(path.join(dir, 'plugins/child/main.js'), 'module.exports = 42')
  return { root, dir }
}
describe('installed plugin package resources', () => {
  it('resolves manifest identity and reads unchanged nested files', async () => {
    const { root } = await fixture()
    expect(await pluginPackageFiles(root, 'bridge-test', 'plugins', true)).toEqual(['child'])
    expect(await pluginPackageFiles(root, 'bridge-test', 'plugins/child/main.js')).toBe('module.exports = 42')
  })
  it('rejects traversal, unknown identities, symlinks and oversized files', async () => {
    const { root, dir } = await fixture()
    for (const rel of ['../manifest.json', '/etc/passwd', 'plugins/../../manifest.json', 'plugins\\child']) await expect(pluginPackageFiles(root, 'bridge-test', rel)).rejects.toThrow()
    await expect(pluginPackageFiles(root, 'other', 'manifest.json')).rejects.toThrow('not found')
    await fs.symlink(root, path.join(dir, 'escape'))
    await expect(pluginPackageFiles(root, 'bridge-test', 'escape', true)).rejects.toThrow('symlinks')
    await fs.writeFile(path.join(dir, 'large'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(pluginPackageFiles(root, 'bridge-test', 'large')).rejects.toThrow('8 MiB')
  })
})
