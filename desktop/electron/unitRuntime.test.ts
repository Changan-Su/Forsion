import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { startBasicUnit, type PluginInstallation } from '../../unit/host'

type Unit = Awaited<ReturnType<typeof startBasicUnit>>
let root: string
let workerFile: string
let webDist: string
let sequence = 0
const live = new Set<Unit>()
const PRIVATE = 'UNIT_RUNTIME_PRIVATE_SENTINEL'

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'unit-runtime-test-'))
  workerFile = join(root, 'backendWorker.mjs')
  webDist = join(root, 'web')
  await mkdir(webDist)
  await writeFile(join(webDist, 'index.html'), '<html><head></head><body>Shared Unit projection</body></html>')
  await build({ entryPoints: [resolve('../unit/backendWorker.ts')], outfile: workerFile,
    bundle: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'silent' })
})
afterAll(async () => {
  for (const unit of live) await unit.close()
  await rm(root, { recursive: true, force: true })
})

interface FixtureOptions {
  version?: string
  mounts?: string[]
  requires?: string[]
  failStart?: boolean
  ui?: boolean
  account?: boolean
}

async function fixture(id: string, options: FixtureOptions = {}): Promise<string> {
  const dir = join(root, `package-${++sequence}`)
  await mkdir(dir)
  const version = options.version ?? '1.0.0'
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id, version, apiVersion: 1,
    name: id, ...(options.ui === false ? {} : { main: 'main.js' }), requires: options.requires,
    backend: { apiVersion: 1, main: 'backend.mjs', privateToken: PRIVATE }, privateConfig: PRIVATE }))
  if (options.ui !== false) {
    await writeFile(join(dir, 'main.js'), `globalThis.publicFixture = ${JSON.stringify(id)};`)
    await mkdir(join(dir, 'spaces', id), { recursive: true })
    await writeFile(join(dir, 'spaces', id, 'space.json'), JSON.stringify({ id, layout: { main: [] } }))
  }
  await writeFile(join(dir, 'private.json'), JSON.stringify({ secret: PRIVATE }))
  await writeFile(join(dir, 'backend.mjs'), `
    import { appendFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { isMainThread } from 'node:worker_threads';
    const privateBackendValue = ${JSON.stringify(PRIVATE)};
    export default (ctx) => {
      const event = (kind) => appendFile(ctx.config.eventLog || join(ctx.dataDir, 'events'), ${JSON.stringify(id)} + ':' + kind + '\\n');
      return {
        account: ${options.account ? `{ metadata: { apiBase: '/api', loginPath: '/auth' }, async resolve(token) {
          if (token !== 'alice' && token !== 'bob') return null;
          return { userId: token, username: token, role: 'USER', tenantId: 'personal:' + token, workspaceId: 'personal:' + token };
        } }` : 'undefined'},
        mounts: ${JSON.stringify(options.mounts ?? ['/api'])},
        async start() {
          await event('start');
          if (${!!options.failStart}) throw new Error(privateBackendValue);
        },
        stop: () => event('stop'),
        handle(req, res) {
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => { body += chunk; });
          req.once('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ plugin: ${JSON.stringify(id)}, version: ${JSON.stringify(version)},
              method: req.method, url: req.url, body, pid: process.pid, isMainThread,
              unitPort: process.env.PORT, unitOrigin: process.env.UNIT_HTTP_ORIGIN,
              configured: ctx.config.secret === privateBackendValue,
              envConfigured: process.env.UNIT_RUNTIME_TEST_SECRET === privateBackendValue }));
          });
        }
      };
    };
  `)
  return dir
}

async function unit(plugins: Array<string | PluginInstallation>, defaultSpace?: string): Promise<Unit> {
  const handle = await startBasicUnit({ instanceId: `runtime-${++sequence}`, name: 'Unit runtime fixture', version: '3.0.0',
    port: 0, bindHost: '127.0.0.1', basePath: '/admin/', webDist, workerFile,
    dataDir: join(root, `data-${sequence}`), plugins, defaultSpace })
  live.add(handle)
  return handle
}

async function close(handle: Unit): Promise<void> { await handle.close(); live.delete(handle) }
const base = (handle: Unit) => `http://127.0.0.1:${handle.port}`
const get = (handle: Unit, path: string) => fetch(base(handle) + path)
const metadata = (handle: Unit) => get(handle, '/admin/unit/meta').then((r) => r.json())

describe('composed Unit package lifecycle', () => {
  it('keeps two visitor accounts and plugin data separate across concurrent writes and plugin restart', async () => {
    const pack = await fixture('accounts', { account: true })
    const app = await unit([pack])
    const request = (token: string, path: string, body?: unknown, headers?: Record<string, string>) =>
      fetch(base(app) + '/admin/unit/' + path, { method: body ? 'PUT' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined })
    try {
      expect((await metadata(app)).account).toEqual({ apiBase: '/api', loginPath: '/auth' })
      expect((await request('', 'account')).status).toBe(401)
      expect((await request('forged', 'plugin-data/accounts')).status).toBe(401)
      const identities = await Promise.all(['alice', 'bob'].map((id) => request(id, 'account').then((r) => r.json())))
      expect(identities.map((r) => r.workspaceId)).toEqual(['personal:alice', 'personal:bob'])
      await Promise.all(['alice', 'bob'].flatMap((id) => [
        request(id, 'config', { modelId: id, token: 'DO_NOT_STORE', homeDir: '/private' }),
        request(id, 'plugin-data/accounts', { data: id }),
      ]))
      await app.restart('accounts')
      expect(await request('alice', 'config').then((r) => r.json())).toEqual({ config: { modelId: 'alice' } })
      expect(await request('bob', 'config').then((r) => r.json())).toEqual({ config: { modelId: 'bob' } })
      expect(await request('bob', 'plugin-data/accounts?userId=alice', undefined,
        { 'x-user-id': 'alice', 'x-tenant-id': 'personal:alice' }).then((r) => r.json())).toEqual({ data: 'bob' })
      expect((await request('alice', 'plugin-data/not-installed')).status).toBe(404)
      expect((await request('alice', 'hostfile?path=/private')).status).toBe(403)
    } finally { await close(app) }
  })
  it('owns one port and identity across disable/enable while keeping projection and backend configuration separate', async () => {
    const pack = await fixture('server-fixture', { mounts: ['/', '/admin/legacy', '/admin/panel-lib.js'] })
    const app = await unit([{ path: pack, config: { secret: PRIVATE }, env: { UNIT_RUNTIME_TEST_SECRET: PRIVATE } }], 'server-fixture')
    const identity = await metadata(app)
    try {
      const reply = await fetch(base(app) + '/api/action?mode=one', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"fixture"}',
      }).then((r) => r.json())
      expect(reply).toMatchObject({ plugin: 'server-fixture', method: 'POST', url: '/api/action?mode=one',
        body: '{"action":"fixture"}', pid: process.pid, isMainThread: false, configured: true, envConfigured: true,
        unitPort: String(app.port), unitOrigin: base(app) })
      expect(process.env.UNIT_RUNTIME_TEST_SECRET).toBeUndefined()

      const html = await get(app, '/admin/').then((r) => r.text())
      expect(html).toContain('Shared Unit projection')
      expect(html).toContain('"defaultSpace":"server-fixture"')
      expect(await get(app, '/admin/legacy/').then((r) => r.json())).toMatchObject({ plugin: 'server-fixture' })
      expect(await get(app, '/admin/panel-lib.js').then((r) => r.json())).toMatchObject({ plugin: 'server-fixture' })
      for (const path of ['/admin/unit/plugins', '/admin/unit/spaces', '/admin/unit/config', '/admin/unit/meta']) {
        const text = await get(app, path).then((r) => r.text())
        expect(text).not.toContain(PRIVATE)
        expect(text).not.toContain('backend.mjs')
        expect(text).not.toContain('privateConfig')
      }
      expect(await get(app, '/admin/unit/config').then((r) => r.json())).toEqual({ config: {} })
      for (const path of ['/admin/unit/hostfile?path=/private.json', '/admin/vault/rpc', '/admin/engine/health']) {
        expect((await fetch(base(app) + path, { headers: { 'X-Unit-Internal': app.internalSecret } })).status).toBe(403)
      }
      expect((await fetch(base(app) + '/admin/unit/config', { method: 'POST', body: '{}' })).status).toBe(405)
      expect((await get(app, '/admin/private.json')).status).toBe(404)

      await app.disable('server-fixture')
      expect(app.status()).toEqual([{ id: 'server-fixture', version: '1.0.0', state: 'disabled' }])
      expect((await get(app, '/api/action')).status).toBe(404)
      expect(await metadata(app)).toEqual(identity)
      expect(await get(app, '/admin/unit/plugins').then((r) => r.json())).toMatchObject({ plugins: [] })
      expect(await get(app, '/admin/').then((r) => r.text())).toContain('"defaultSpace":"home"')

      await app.enable('server-fixture')
      expect(await get(app, '/api/action').then((r) => r.json())).toMatchObject({ plugin: 'server-fixture', unitPort: String(app.port) })
      expect(await metadata(app)).toEqual(identity)
      expect((await get(app, '/admin/unit/plugins').then((r) => r.json())).plugins.map((p: any) => p.id)).toEqual(['server-fixture'])
    } finally { await close(app) }
  })

  it('contains failed activation and keeps the healthy plugin and projection available', async () => {
    const good = await fixture('healthy', { mounts: ['/api'] })
    const bad = await fixture('failed', { mounts: ['/broken'], failStart: true })
    const app = await unit([bad, good])
    try {
      expect(app.status()).toEqual([
        { id: 'failed', version: '1.0.0', state: 'failed' },
        { id: 'healthy', version: '1.0.0', state: 'active' },
      ])
      expect(await get(app, '/api/ping').then((r) => r.json())).toMatchObject({ plugin: 'healthy' })
      expect((await get(app, '/broken')).status).toBe(404)
      expect(await get(app, '/admin/').then((r) => r.text())).toContain('Shared Unit projection')
      const projected = await get(app, '/admin/unit/plugins').then((r) => r.json())
      expect(projected.plugins.map((p: any) => p.id)).toEqual(['healthy'])
      expect(JSON.stringify(projected)).not.toContain(PRIVATE)
      await expect(app.enable('failed')).rejects.toThrow()
      expect(await get(app, '/api/ping').then((r) => r.json())).toMatchObject({ plugin: 'healthy' })
    } finally { await close(app) }
  })

  it('restores the previous backend after a rejected live update, then accepts a valid replacement', async () => {
    const original = await fixture('updatable')
    const bad = await fixture('updatable', { version: '2.0.0', failStart: true })
    const replacement = await fixture('updatable', { version: '2.0.1' })
    const app = await unit([original])
    const identity = await metadata(app)
    try {
      await expect(app.update('updatable', bad)).rejects.toThrow()
      expect(app.status()).toEqual([{ id: 'updatable', version: '1.0.0', state: 'active' }])
      expect(await get(app, '/api/version').then((r) => r.json())).toMatchObject({ version: '1.0.0' })
      expect(await metadata(app)).toEqual(identity)
      await app.update('updatable', replacement)
      expect(app.status()).toEqual([{ id: 'updatable', version: '2.0.1', state: 'active' }])
      expect(await get(app, '/api/version').then((r) => r.json())).toMatchObject({ version: '2.0.1' })
      expect(await metadata(app)).toEqual(identity)
    } finally { await close(app) }
  })

  it.each(['/admin', '/admin/unit', '/admin/vault', '/admin/engine'])('rejects a backend claiming reserved route %s', async (mount) => {
    const pack = await fixture('reserved', { mounts: [mount] })
    const app = await unit([{ path: pack, enabled: false }])
    try {
      await expect(app.enable('reserved')).rejects.toThrow(/reserved route/)
      expect(app.status()[0].state).toBe('failed')
      expect((await get(app, '/admin/')).status).toBe(200)
      expect(await get(app, '/admin/unit/plugins').then((r) => r.json())).toMatchObject({ plugins: [] })
    } finally { await close(app) }
  })

  it('rejects conflicting route ownership without interrupting the existing backend', async () => {
    const first = await fixture('first', { mounts: ['/api'] })
    const conflict = await fixture('conflict', { mounts: ['/api'] })
    const app = await unit([first, { path: conflict, enabled: false }])
    try {
      await expect(app.enable('conflict')).rejects.toThrow(/route conflict/)
      expect(await get(app, '/api/ping').then((r) => r.json())).toMatchObject({ plugin: 'first' })
      expect(app.status()).toMatchObject([{ id: 'first', state: 'active' }, { id: 'conflict', state: 'failed' }])
    } finally { await close(app) }
  })

  it('starts dependencies first, guards dependency disable, and closes in reverse order', async () => {
    const eventLog = join(root, `dependencies-${++sequence}.log`)
    const dependency = await fixture('dependency', { mounts: ['/dependency'], ui: false })
    const dependent = await fixture('dependent', { mounts: ['/dependent'], requires: ['dependency'] })
    const app = await unit([{ path: dependent, config: { eventLog } }, { path: dependency, config: { eventLog } }])
    try {
      expect(await readFile(eventLog, 'utf8')).toBe('dependency:start\ndependent:start\n')
      expect((await get(app, '/admin/unit/plugins').then((r) => r.json())).plugins.map((p: any) => p.id)).toEqual(['dependent'])
      await expect(app.disable('dependency')).rejects.toThrow(/dependent plugins/)
      expect(await get(app, '/dependent/ping').then((r) => r.json())).toMatchObject({ plugin: 'dependent' })
      expect(await readFile(eventLog, 'utf8')).toBe('dependency:start\ndependent:start\n')
    } finally { await close(app) }
    expect(await readFile(eventLog, 'utf8')).toBe('dependency:start\ndependent:start\ndependent:stop\ndependency:stop\n')
  })
  it('reorders teardown after an update adds a dependency and rejects a new cycle', async () => {
    const eventLog = join(root, `updated-dependencies-${++sequence}.log`)
    const first = await fixture('consumer', { mounts: ['/consumer'] })
    const dependency = await fixture('provider', { mounts: ['/provider'] })
    const update = await fixture('consumer', { mounts: ['/consumer'], requires: ['provider'], version: '2.0.0' })
    const cycle = await fixture('provider', { mounts: ['/provider'], requires: ['consumer'], version: '2.0.0' })
    const app = await unit([{ path: first, config: { eventLog } }, { path: dependency, config: { eventLog } }])
    try {
      await app.update('consumer', update)
      await expect(app.update('provider', cycle)).rejects.toThrow('Cyclic')
      expect(await get(app, '/consumer').then((r) => r.json())).toMatchObject({ version: '2.0.0' })
      await writeFile(eventLog, '')
    } finally { await close(app) }
    expect(await readFile(eventLog, 'utf8')).toBe('consumer:stop\nprovider:stop\n')
  })

  it('rejects an update that would leave the persisted default Space missing', async () => {
    const first = await fixture('default-space')
    const update = await fixture('default-space', { ui: false, version: '2.0.0' })
    const app = await unit([first], 'default-space')
    try {
      await expect(app.update('default-space', update)).rejects.toThrow('default Space')
      expect(await get(app, '/api').then((r) => r.json())).toMatchObject({ version: '1.0.0' })
    } finally { await close(app) }
  })

})
