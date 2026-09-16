import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPackage } from '../../unit/install'
import { readPackage } from '../../unit/packages'
import { writeConfig, readConfig, installations } from '../../unit/config'
import { controlAddress, startControl, sendControl } from '../../unit/control'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'unit-install-'))
  const source = join(root, 'source'), file = join(root, 'state/unit.json')
  await mkdir(source)
  await writeFile(join(source, 'main.js'), 'ui v1')
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ id: 'fixture', version: '1.0.0', apiVersion: 1, main: 'main.js' }))
  await writeConfig(file, { instanceId: 'installation', name: 'Test', version: '3.0.0', plugins: [], port: 0, basePath: '/admin/', webDist: '../web', dataDir: 'data' })
  return { root, source, file }
}
describe('portable Unit installation', () => {
  it('copies a version independently, relocates internal absolute links, and replaces the configured version offline', async () => {
    const { root, source, file } = await fixture()
    try {
      await symlink(join(source, 'main.js'), join(source, 'alias.js'))
      const first = await installPackage(file, source)
      expect(await realpath(join(first.path, 'alias.js'))).toBe(await realpath(join(first.path, 'main.js')))
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ id: 'fixture', version: '1.1.0', apiVersion: 1, main: 'main.js' }))
      await writeFile(join(source, 'main.js'), 'ui v2')
      const second = await installPackage(file, source)
      await rm(source, { recursive: true })
      expect(await readFile(join(first.path, 'main.js'), 'utf8')).toBe('ui v1')
      expect(await readFile(join(second.path, 'main.js'), 'utf8')).toBe('ui v2')
      expect(installations(await readConfig(file)).map((p) => p.path)).toEqual([second.path])
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('rejects private environment files and external symlinks before changing configuration', async () => {
    const { root, source, file } = await fixture()
    try {
      await writeFile(join(source, '.env'), 'private')
      await expect(installPackage(file, source)).rejects.toThrow('private environment')
      await rm(join(source, '.env'))
      await symlink(file, join(source, 'external.json'))
      await expect(installPackage(file, source)).rejects.toThrow('symlink escapes')
      expect(installations(await readConfig(file))).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('gates package API, minimum Unit version and bundled native runtime compatibility', async () => {
    const { root, source } = await fixture()
    const manifest = { id: 'fixture', version: '1.0.0', apiVersion: 1, main: 'main.js' }
    try {
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, minAppVersion: '9.0.0' }))
      await expect(readPackage(source, '3.0.0')).rejects.toThrow('requires Unit')
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, backend: { main: 'main.js', apiVersion: 1, dependencies: { mode: 'bundled', nodeAbi: 'impossible' } } }))
      await expect(readPackage(source)).rejects.toThrow('different OS')
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, apiVersion: 2 }))
      await expect(readPackage(source)).rejects.toThrow('unsupported plugin API')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('uses a short owner-only socket even when the data path is long', async () => {
    const { root } = await fixture()
    const data = join(root, 'nested'.repeat(30), 'data')
    const control = await startControl(data, async (command) => ({ action: command.action }))
    try {
      expect(await sendControl(data, { action: 'status' })).toEqual({ action: 'status' })
      if (process.platform !== 'win32') { expect(controlAddress(data).length).toBeLessThan(104); expect((await stat(controlAddress(data))).mode & 0o777).toBe(0o600) }
      await expect(startControl(data, async () => ({}))).rejects.toThrow('already running')
    } finally { await control.close(); await rm(root, { recursive: true, force: true }) }
  })
})
