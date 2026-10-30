import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBasicUnit, loadPackages } from '../../unit/host'

describe('Basic Unit public projection', () => {
  it('rejects unsigned code claiming the official Extend identity before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-untrusted-extend-'))
    try {
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ id: 'forsion-extend', version: '0.9.3', apiVersion: 1, name: 'Impersonator', main: 'main.js' }))
      await writeFile(join(root, 'main.js'), 'globalThis.untrustedCode = true')
      await expect(loadPackages([root])).rejects.toThrow('Untrusted official plugin')
      await writeFile(join(root, 'SIGNATURE'), JSON.stringify({ alg: 'ed25519', files: { 'main.js': '0'.repeat(64) }, sig: 'AA==' }))
      await expect(loadPackages([root])).rejects.toThrow('Untrusted official plugin')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('serves an installed plugin and its default Space while refusing host capabilities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'basic-unit-'))
    await mkdir(join(root, 'plugin/spaces/admin'), { recursive: true })
    await mkdir(join(root, 'web/assets'), { recursive: true })
    await writeFile(join(root, 'web/index.html'), '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body></body></html>')
    await writeFile(join(root, 'web/assets/app.js'), 'console.log("shared shell")')
    await writeFile(join(root, 'plugin/manifest.json'), JSON.stringify({ id: 'test-admin', version: '1.0.0', name: 'Admin', main: 'main.js', apiVersion: 1, token: 'PRIVATE_MANIFEST_VALUE' }))
    await writeFile(join(root, 'plugin/main.js'), 'ctx.registerView({id:"admin"})')
    await writeFile(join(root, 'plugin/secrets.json'), 'PRIVATE_PACKAGE_DATA')
    await symlink(join(root, 'plugin/secrets.json'), join(root, 'web/private.json'))
    await writeFile(join(root, 'plugin/spaces/admin/space.json'), JSON.stringify({ id: 'admin', layout: { main: [] } }))
    const handle = await startBasicUnit({ instanceId: 'test-unit', name: '</script><script>bad()</script>', version: '3.0.0',
      dataDir: join(root, 'data'), port: 0, basePath: '/admin/', plugins: [join(root, 'plugin')], webDist: join(root, 'web'), defaultSpace: 'admin' })
    const base = `http://127.0.0.1:${handle.port}`
    try {
      const html = await fetch(base + '/admin/models/detail').then((r) => r.text())
      expect(html).toContain('<base href="/admin/">')
      expect(html).toContain('"id":"basic"')
      expect(html).toContain('"defaultSpace":"admin"')
      expect(html).toContain('"spaces":[]')
      expect(html).toContain("'unsafe-eval'")
      expect(html).not.toContain('<script>bad()')
      const plugins = await fetch(base + '/admin/unit/plugins').then((r) => r.json())
      expect(plugins.plugins[0].code).toContain('registerView')
      expect(JSON.stringify(plugins)).not.toContain('PRIVATE')
      expect((await fetch(base + '/admin/unit/spaces').then((r) => r.json())).spaces[0].plugin).toBe('test-admin')
      for (const path of ['/engine/health', '/vault/rpc', '/unit/hostfile?path=/etc/passwd', '/unit/hostdir', '/unit/pair/poll', '/unit/p2p/offer']) {
        expect((await fetch(base + '/admin' + path, { headers: { 'X-Unit-Internal': handle.internalSecret } })).status).toBe(403)
      }
      expect((await fetch(base + '/admin/unit/config', { method: 'PUT', body: '{"token":"secret"}' })).status).toBe(405)
      expect(await fetch(base + '/admin/unit/config').then((r) => r.json())).toEqual({ config: {} })
      expect((await fetch(base + '/admin/assets/missing.js')).status).toBe(404)
      expect((await fetch(base + '/admin/plugins/secrets.json')).status).toBe(404)
      expect((await fetch(base + '/admin/private.json')).status).toBe(404)
      expect(await fetch(base + '/admin/assets/app.js').then((r) => r.text())).toContain('shared shell')
      expect((await fetch(base + '/admin?q=1', { redirect: 'manual' })).headers.get('location')).toBe('/admin/?q=1')
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('installs and uninstalls plugins live without leaving a configuration the next start would reject', async () => {
    const root = await mkdtemp(join(tmpdir(), 'basic-unit-install-'))
    await mkdir(join(root, 'web'))
    await writeFile(join(root, 'web/index.html'), '<html><head></head><body></body></html>')
    const plugin = async (id: string, options: { requires?: string[]; space?: string } = {}) => {
      const dir = join(root, 'plugins', id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id, version: '1.0.0', apiVersion: 1, main: 'main.js', ...(options.requires ? { requires: options.requires } : {}) }))
      await writeFile(join(dir, 'main.js'), `ctx.registerView({id:${JSON.stringify(id)}})`)
      if (options.space) {
        await mkdir(join(dir, 'spaces', options.space), { recursive: true })
        await writeFile(join(dir, 'spaces', options.space, 'space.json'), JSON.stringify({ id: options.space, layout: { main: [] } }))
      }
      return dir
    }
    const home = await plugin('home-owner', { space: 'landing' }), published = await plugin('published')
    const handle = await startBasicUnit({ instanceId: 'install-unit', name: 'Install', version: '3.0.0', dataDir: join(root, 'data'), port: 0,
      basePath: '/admin/', plugins: [home, published], webDist: join(root, 'web'), defaultSpace: 'landing',
      webEntries: [{ basePath: '/site/', plugins: ['published'] }] })
    const ids = () => handle.status().map((p) => p.id)
    try {
      await handle.install(await plugin('base'))
      await handle.install(await plugin('child', { requires: ['base'] }))
      expect(handle.status()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'child', state: 'active' })]))
      const listed = await fetch(`http://127.0.0.1:${handle.port}/admin/unit/plugins`).then((r) => r.json())
      expect(listed.plugins.map((p: { id: string }) => p.id)).toContain('child')
      await expect(handle.install(await plugin('base-copy'))).resolves.toBe('base-copy')
      await expect(handle.install(join(root, 'plugins', 'base'))).rejects.toThrow('already installed')
      await expect(handle.install(await plugin('clash', { space: 'landing' }))).rejects.toThrow('Duplicate Space id')
      await expect(handle.install(await plugin('orphan', { requires: ['missing'] }))).rejects.toThrow('Required plugin is not installed: missing')
      await handle.disable('child')
      // A disabled dependent still blocks: the next start would fail on its missing requirement.
      await expect(handle.uninstall('base')).rejects.toThrow('require it first: child')
      await expect(handle.uninstall('published')).rejects.toThrow('web entry')
      await expect(handle.uninstall('home-owner')).rejects.toThrow('default Space')
      await handle.disable('base')
      await expect(handle.install(await plugin('late', { requires: ['base'] }))).rejects.toThrow('Required plugin is not active: base')
      expect(ids()).not.toContain('late')
      await handle.uninstall('child'); await handle.uninstall('base')
      expect(ids().sort()).toEqual(['base-copy', 'home-owner', 'published'])
      await expect(handle.install(join(root, 'plugins', 'child'), { activate: false })).rejects.toThrow('Required plugin is not installed: base')
      expect(ids()).not.toContain('child')
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a plugin entry that escapes the installed package, including symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-plugin-'))
    await mkdir(join(root, 'plugin'))
    await writeFile(join(root, 'private.js'), 'SECRET')
    await writeFile(join(root, 'plugin/manifest.json'), JSON.stringify({ id: 'test', version: '1.0.0', apiVersion: 1, main: '../private.js' }))
    try {
      await expect(loadPackages([join(root, 'plugin')])).rejects.toThrow('escapes')
      await writeFile(join(root, 'plugin/manifest.json'), JSON.stringify({ id: 'test', version: '1.0.0', apiVersion: 1, main: 'linked.js' }))
      await symlink(join(root, 'private.js'), join(root, 'plugin/linked.js'))
      await expect(loadPackages([join(root, 'plugin')])).rejects.toThrow('escapes')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
