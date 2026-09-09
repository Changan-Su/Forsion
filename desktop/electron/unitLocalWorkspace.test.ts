import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBasicUnit, type PluginInstallation } from '../../unit/host'
import { IPC } from '../shared/amadeus/ipc'

type Unit = Awaited<ReturnType<typeof startBasicUnit>>
let scratch: string
let sequence = 0
const live = new Set<Unit>()
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'unit-local-workspace-'))
  await mkdir(join(scratch, 'web'))
  await writeFile(join(scratch, 'web/index.html'), '<html><head></head><body>Generic Unit shell</body></html>')
})
afterEach(async () => { for (const unit of live) await unit.close(); live.clear(); await rm(scratch, { recursive: true, force: true }) })

interface FixtureOptions { version?: string; requires?: string[]; engine?: boolean; vault?: boolean; fail?: boolean }
async function fixture(id: string, options: FixtureOptions = {}, existing?: string) {
  const root = existing ?? join(scratch, `package-${id}-${++sequence}`)
  await mkdir(join(root, 'spaces', id), { recursive: true })
  const version = options.version ?? '1.0.0'
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    id, version, apiVersion: 1, main: 'main.js', runtime: { apiVersion: 1, main: 'runtime.mjs' }, requires: options.requires,
  }))
  await writeFile(join(root, 'main.js'), `ctx.registerCommand({id: '${id}-hello', title: 'Hello', run() {}})`)
  await writeFile(join(root, 'spaces', id, 'space.json'), JSON.stringify({ id, layout: { main: [] } }))
  await writeFile(join(root, 'runtime.mjs'), `
    import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import http from 'node:http';
    const version = ${JSON.stringify(version)};
    const id = ${JSON.stringify(id)};
    await appendFile(${JSON.stringify(join(scratch, 'imports.log'))}, id + ':' + version + '\\n');
    export default async (ctx) => {
      const event = (name, detail) => appendFile(${JSON.stringify(join(scratch, 'events.log'))}, JSON.stringify({id, version, name, detail}) + '\\n');
      await event('start');
      if (${!!options.fail}) throw new Error('fixture startup failure');
      await mkdir(ctx.workspaceDir, {recursive:true});
      await writeFile(join(ctx.workspaceDir, 'Visible.txt'), 'OWNER_WORKSPACE_CONTENT');
      await writeFile(join(ctx.dataDir, 'private.txt'), 'RUNTIME_PRIVATE_SENTINEL');
      const vault = ${!!options.vault} ? {
        root: () => ctx.workspaceDir,
        absPath: (rel) => join(ctx.workspaceDir, rel),
        assetAbs: async (_page, ref) => ref === 'Visible.txt' ? join(ctx.workspaceDir, ref) : null,
        onEvent: () => () => {},
        call: async (channel, args) => ({ version, channel, args, workspace: ctx.workspaceDir }),
      } : undefined;
      const server = ${!!options.engine} ? http.createServer((req,res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version, authorization:req.headers.authorization, url:req.url }));
      }) : undefined;
      if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return {
        vault,
        engine: server ? { endpoint: () => ({ url:'http://127.0.0.1:' + server.address().port, token:'PRIVATE_ENGINE_TOKEN' }), status: () => ({running:true}) } : undefined,
        setPackages: async roots => event('packages', roots),
        close: async () => { await event('stop'); if (server) await new Promise(resolve => server.close(resolve)); },
      };
    };
  `)
  return root
}
async function start(plugins: Array<string | PluginInstallation>, local = true, identity = `unit-${++sequence}`) {
  const dataDir = join(scratch, identity)
  const unit = await startBasicUnit({ instanceId: identity, name: 'Workspace fixture', version: '3.0.0', port: 0,
    bindHost: '127.0.0.1', basePath: '/web/', webDist: join(scratch, 'web'), dataDir, plugins,
    ...(local ? { workspace: { mode: 'local' as const } } : {}),
  })
  live.add(unit)
  const token = local ? (await readFile(join(dataDir, 'owner-token'), 'utf8')).trim() : ''
  const request = (path: string, init: RequestInit = {}, credential: string | null = token) => fetch(`http://127.0.0.1:${unit.port}/web/${path}`, {
    ...init, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...init.headers },
  })
  return { unit, token, dataDir, request }
}
const events = async () => (await readFile(join(scratch, 'events.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
const rpc = (ch: string, args: unknown[] = []): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ch, args }) })

describe('explicit local Unit workspace boundary', () => {
  it('boots a bare shell with no business runtime or Server and keeps all optional capabilities absent', async () => {
    const { request, dataDir } = await start([])
    expect(await (await request('unit/meta', {}, null)).json()).toMatchObject({ projection: 'local', pair: false, localCapabilities: { vault: false, engine: false, host: false } })
    expect((await request('', {}, null)).status).toBe(200)
    expect((await request('engine/api/tasks')).status).toBe(503)
    expect((await request('vault/rpc', rpc(IPC.restoreVault))).status).toBe(503)
    expect(await (await request('unit/plugins')).json()).toMatchObject({ plugins: [] })
    expect(await (await request('unit/spaces')).json()).toMatchObject({ spaces: [] })
    expect(await (await request('unit/config')).json()).toMatchObject({ config: { defaultWorkspaceDir: join(dataDir, 'workspace') } })
  })

  it('loads an installed runtime outside the Unit bundle and requires its owner key for data and engine access', async () => {
    const plugin = await fixture('notes', { engine: true, vault: true })
    const { request, token, dataDir } = await start([plugin])
    const html = await (await request('', {}, null)).text()
    for (const privateValue of [token, dataDir, 'PRIVATE_ENGINE_TOKEN', 'RUNTIME_PRIVATE_SENTINEL', 'runtime.mjs']) expect(html).not.toContain(privateValue)
    expect(await (await request('unit/meta', {}, null)).json()).toMatchObject({ localCapabilities: { vault: true, engine: true, host: true } })
    for (const path of ['unit/whoami', 'unit/plugins', 'unit/spaces', 'unit/config', 'unit/providers', 'unit/hostfile?path=' + encodeURIComponent(join(dataDir, 'workspace/Visible.txt')), 'engine/api/tasks']) {
      expect((await request(path, {}, null)).status, path).toBe(401)
      expect((await request(path, {}, 'wrong-owner-key')).status, path).toBe(401)
    }
    expect((await request('vault/rpc', rpc(IPC.restoreVault), null)).status).toBe(401)
    expect((await request('vault/asset-token', { method: 'POST' }, null)).status).toBe(401)
    expect((await request('unit/pair/request', { method: 'POST' }, null)).status).toBe(403)
    expect(await (await request('vault/rpc', rpc(IPC.restoreVault))).json()).toMatchObject({ ok: true, result: { version: '1.0.0', channel: IPC.restoreVault } })
    const engine = await (await request('engine/api/tasks', {}, token)).json()
    expect(engine).toMatchObject({ authorization: 'Bearer PRIVATE_ENGINE_TOKEN', url: '/api/tasks' })
    expect(engine.authorization).not.toContain(token)
    expect((await request('vault/rpc', rpc(IPC.openVault))).status).toBe(400)
  })

  it('restricts host reads to the workspace, clips preference keys, and retains owner state across restarts', async () => {
    const plugin = await fixture('notes', { vault: true })
    const current = await start([plugin], true, 'persistent')
    const visible = join(current.dataDir, 'workspace/Visible.txt')
    const privateFile = join(current.dataDir, 'plugins/notes/private.txt')
    expect(await (await current.request('unit/hostfile?path=' + encodeURIComponent(visible))).json()).toMatchObject({ content: Buffer.from('OWNER_WORKSPACE_CONTENT').toString('base64') })
    for (const location of [privateFile, join(current.dataDir, 'owner-token')]) {
      expect((await current.request('unit/hostfile?path=' + encodeURIComponent(location))).status).toBe(404)
      expect((await current.request('unit/hoststat?path=' + encodeURIComponent(location))).status).toBe(404)
    }
    const escape = join(current.dataDir, 'workspace/escape.txt')
    await symlink(privateFile, escape)
    expect((await current.request('unit/hostfile?path=' + encodeURIComponent(escape))).status).toBe(404)
    const listing = await (await current.request('unit/hostdir?path=' + encodeURIComponent(join(current.dataDir, 'workspace')))).json()
    expect(listing.entries.map((e: { name: string }) => e.name)).not.toContain('escape.txt')
    await current.request('unit/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: 'local-model', token: 'SHOULD_NOT_PERSIST', backendUrl: 'https://evil.invalid', homeDir: '/bad-root' }) })
    const preferences = await (await current.request('unit/config')).json()
    expect(preferences.config).toMatchObject({ modelId: 'local-model', homeDir: join(current.dataDir, 'workspace') })
    expect(preferences.config).not.toHaveProperty('token')
    expect(preferences.config).not.toHaveProperty('backendUrl')
    await current.unit.close(); live.delete(current.unit)
    const restarted = await start([plugin], true, 'persistent')
    expect(restarted.token).toBe(current.token)
    expect(await (await restarted.request('unit/config')).json()).toMatchObject({ config: { modelId: 'local-model' } })
  })

  it('never imports a local runtime or falls back to local files in a public projection', async () => {
    const plugin = await fixture('notes', { engine: true, vault: true })
    const { request, dataDir } = await start([plugin], false)
    await expect(readFile(join(scratch, 'imports.log'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(dataDir, 'owner-token'), 'utf8')).rejects.toThrow()
    expect(await (await request('unit/meta')).json()).toMatchObject({ projection: 'public', capabilities: {} })
    expect(await (await request('unit/config')).json()).toEqual({ config: {} })
    expect(await (await request('unit/plugins')).json()).toMatchObject({ plugins: [{ id: 'notes' }] })
    const plugins = await (await request('unit/plugins')).text()
    expect(plugins).not.toContain('runtime.mjs')
    for (const path of ['unit/hostfile?path=/tmp/example', 'engine/api/tasks', 'vault/asset?ref=Visible.txt']) expect((await request(path)).status).toBe(403)
    expect((await request('vault/rpc', rpc(IPC.restoreVault))).status).toBe(405)
  })

  it('gates dependencies before importing runtimes, reconciles enabled bundle roots, and closes before restart', async () => {
    const base = await fixture('storage', { vault: true })
    const dependent = await fixture('collector', { requires: ['storage'] })
    const { unit, request } = await start([{ path: base, enabled: false }, dependent])
    expect(await (await request('unit/spaces')).json()).toEqual({ spaces: [] })
    await expect(readFile(join(scratch, 'imports.log'), 'utf8')).rejects.toThrow()
    await expect(unit.enable('collector')).rejects.toThrow('dependency is not active')
    await unit.enable('storage')
    await unit.enable('collector')
    await expect(unit.disable('storage')).rejects.toThrow('Disable dependent plugins first')
    expect((await events()).filter((e) => e.name === 'packages').at(-1).detail).toEqual(await Promise.all([base, dependent].map((root) => realpath(root))))
    await unit.restart('storage')
    const recent = (await events()).filter((e) => e.name === 'start' || e.name === 'stop').slice(-4).map((e) => `${e.id}:${e.name}`)
    expect(recent).toEqual(['collector:stop', 'storage:stop', 'storage:start', 'collector:start'])
    await unit.disable('collector')
    expect((await events()).filter((e) => e.name === 'packages').at(-1).detail).toEqual([await realpath(base)])
    await unit.disable('storage')
    expect(await (await request('unit/meta')).json()).toMatchObject({ localCapabilities: { vault: false, engine: false, host: false } })
  })

  it('validates runtime entry paths before update and restores the prior runtime after a failed replacement', async () => {
    const old = await fixture('notes', { vault: true })
    const broken = await fixture('notes', { vault: true, fail: true, version: '2.0.0' })
    const escaped = await fixture('notes', { vault: true, version: '3.0.0' })
    await rm(join(escaped, 'runtime.mjs'))
    await symlink(join(old, 'runtime.mjs'), join(escaped, 'runtime.mjs'))
    const { unit, request } = await start([old])
    await expect(unit.update('notes', escaped)).rejects.toThrow('escapes its package')
    expect(await (await request('vault/rpc', rpc(IPC.restoreVault))).json()).toMatchObject({ result: { version: '1.0.0' } })
    await expect(unit.update('notes', broken)).rejects.toThrow('fixture startup failure')
    expect(unit.status()).toEqual([{ id: 'notes', version: '1.0.0', state: 'active' }])
    expect(await (await request('vault/rpc', rpc(IPC.restoreVault))).json()).toMatchObject({ result: { version: '1.0.0' } })
  })

  it('loads the replaced runtime implementation when an explicit update uses the same package directory', async () => {
    const plugin = await fixture('notes', { vault: true })
    const { unit, request } = await start([plugin])
    await fixture('notes', { vault: true, version: '2.0.0' }, plugin)
    await unit.update('notes', plugin)
    expect(unit.status()).toEqual([{ id: 'notes', version: '2.0.0', state: 'active' }])
    expect(await (await request('vault/rpc', rpc(IPC.restoreVault))).json()).toMatchObject({ result: { version: '2.0.0' } })
  })
})
