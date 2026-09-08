import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBasicUnit, loadPackages } from '../../unit/host'

describe('Basic Unit public projection', () => {
  it('serves an installed plugin and its default Space while refusing host capabilities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'basic-unit-'))
    await mkdir(join(root, 'plugin/spaces/admin'), { recursive: true })
    await mkdir(join(root, 'web/assets'), { recursive: true })
    await writeFile(join(root, 'web/index.html'), '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body></body></html>')
    await writeFile(join(root, 'web/assets/app.js'), 'console.log("shared shell")')
    await writeFile(join(root, 'plugin/manifest.json'), JSON.stringify({ id: 'test-admin', name: 'Admin', main: 'main.js', apiVersion: 1, token: 'PRIVATE_MANIFEST_VALUE' }))
    await writeFile(join(root, 'plugin/main.js'), 'ctx.registerView({id:"admin"})')
    await writeFile(join(root, 'plugin/secrets.json'), 'PRIVATE_PACKAGE_DATA')
    await symlink(join(root, 'plugin/secrets.json'), join(root, 'web/private.json'))
    await writeFile(join(root, 'plugin/spaces/admin/space.json'), JSON.stringify({ id: 'admin', layout: { main: [] } }))
    const handle = await startBasicUnit({ instanceId: 'test-unit', name: '</script><script>bad()</script>', version: '3.0.0',
      port: 0, basePath: '/admin/', plugins: [join(root, 'plugin')], webDist: join(root, 'web'), defaultSpace: 'admin' })
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

  it('rejects a plugin entry that escapes the installed package, including symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-plugin-'))
    await mkdir(join(root, 'plugin'))
    await writeFile(join(root, 'private.js'), 'SECRET')
    await writeFile(join(root, 'plugin/manifest.json'), JSON.stringify({ id: 'test', main: '../private.js' }))
    try {
      await expect(loadPackages([join(root, 'plugin')])).rejects.toThrow('escapes')
      await writeFile(join(root, 'plugin/manifest.json'), JSON.stringify({ id: 'test', main: 'linked.js' }))
      await symlink(join(root, 'private.js'), join(root, 'plugin/linked.js'))
      await expect(loadPackages([join(root, 'plugin')])).rejects.toThrow('escapes')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
