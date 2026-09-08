/** Basic Unit owns the listener, packages, and backend plugin lifecycle. */
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startUnitWeb } from '../desktop/electron/unitWeb'
import { resolveProduct } from '../desktop/shared/product'
import basic from '../desktop/products/basic.json'
import { readPackage, type InstalledPackage } from './packages'
import { startBackend, migrateBackend } from './backendRunner'
import { createAccountHttp } from './accountHttp'
export { loadPackages } from './packages'

export interface PluginInstallation { path: string; enabled?: boolean; config?: Record<string, unknown>; env?: Record<string, string> }
export interface UnitConfig {
  instanceId: string; name: string; version: string; port: number; bindHost?: string
  basePath: string; webDist: string; plugins: Array<string | PluginInstallation>
  defaultSpace?: string; dataDir?: string; workerFile?: string
}
type Backend = Awaited<ReturnType<typeof startBackend>>
type State = 'disabled' | 'starting' | 'active' | 'stopping' | 'failed'
interface RecordState { package: InstalledPackage; installation: PluginInstallation; state: State; backend?: Backend; mounts: string[] }
const matches = (path: string, prefix: string) => prefix === '/' || path === prefix || path.startsWith(prefix + '/')
const pathname = (url: string | undefined) => (url || '/').split('?')[0]

export async function startBasicUnit(config: UnitConfig) {
  if (!config.instanceId || !config.name || !config.version) throw new Error('Unit identity is required')
  await readFile(resolve(config.webDist, 'index.html'))
  const dataDir = resolve(config.dataDir || resolve(homedir(), '.forsion', 'units', config.instanceId))
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const workerFile = config.workerFile || fileURLToPath(new URL('./backendWorker.mjs', import.meta.url))
  const records = new Map<string, RecordState>()
  const prefix = config.basePath.replace(/\/$/, '') || '/'
  const protectedPaths = ['unit', 'vault', 'engine'].map((name) => (prefix === '/' ? '' : prefix) + '/' + name)
  for (const entry of config.plugins) {
    const installation = typeof entry === 'string' ? { path: entry } : { ...entry }
    const pack = await readPackage(installation.path, config.version)
    if (records.has(pack.manifest.id)) throw new Error('Duplicate plugin id')
    records.set(pack.manifest.id, { package: pack, installation, state: 'disabled', mounts: [] })
  }
  const ordered: string[] = [], spaceOwners = new Set<string>()
  const mustGet = (id: string) => {
    const r = records.get(id)
    if (!r) throw new Error(`Plugin is not installed: ${id}`)
    return r
  }
  const dependencyOrder = (replacement?: { id: string; package: InstalledPackage }) => {
    const order: string[] = [], visiting = new Set<string>()
    const visit = (id: string) => {
      if (order.includes(id)) return
      if (visiting.has(id)) throw new Error('Cyclic plugin dependency')
      visiting.add(id)
      const pack = replacement?.id === id ? replacement.package : mustGet(id).package
      for (const dep of pack.manifest.requires || []) visit(dep)
      visiting.delete(id); order.push(id)
    }
    for (const id of records.keys()) visit(id)
    return order
  }
  ordered.push(...dependencyOrder())
  for (const record of records.values()) for (const id of record.package.spaceIds) {
    if (spaceOwners.has(id)) throw new Error('Duplicate Space id')
    spaceOwners.add(id)
  }
  if (config.defaultSpace && !spaceOwners.has(config.defaultSpace)) throw new Error('The default Space must be supplied by an installed plugin')
  const product = resolveProduct(undefined, { ...basic, market: false, onboarding: false })
  const refreshProduct = () => {
    const spaces = [...records.values()].filter((r) => r.state === 'active').flatMap((r) => [...r.package.spaceIds])
    product.spaces = spaces.length ? [] : ['home']
    product.defaultSpace = spaces.includes(config.defaultSpace || '') ? config.defaultSpace! : spaces[0] || 'home'
  }
  let chain = Promise.resolve(), closing = false
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const job = chain.then(action)
    chain = job.then(() => {}, () => {})
    return job
  }
  const bindAddress = config.bindHost === '::' ? '::1' : config.bindHost === '0.0.0.0' || !config.bindHost ? '127.0.0.1' : config.bindHost
  const localHost = bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress
  const options = (id: string, rec: RecordState) => ({ id, entry: rec.package.backendEntry!,
    packageDir: rec.package.root, dataDir: resolve(dataDir, 'plugins', id), config: rec.installation.config || {},
    env: { ...(rec.installation.config?.env as Record<string, string> || {}), ...rec.installation.env,
      PORT: String(web.port), UNIT_HTTP_ORIGIN: `http://${localHost}:${web.port}` }, workerFile, startTimeoutMs: 120_000,
    onLog: (message: string) => console.log(`[plugin:${id}] ${message}`),
    onRestart: () => { if (!closing) void serialize(() => restart(id)).catch(() => console.error(`[unit] Plugin ${id} restart failed`)) },
    onFailure: (error: Error) => { console.error(`[unit] Plugin ${id}: ${error.message}`); rec.state = 'failed'; rec.backend = undefined; refreshProduct() },
  })
  async function activate(id: string) {
    if (closing) throw new Error('Unit is stopping')
    const rec = mustGet(id)
    if (rec.state === 'active') return
    for (const dep of rec.package.manifest.requires || []) if (mustGet(dep).state !== 'active') throw new Error(`Plugin dependency is not active: ${dep}`)
    rec.state = 'starting'
    let backend: Backend | undefined
    try {
      if (rec.package.backendEntry) {
        await mkdir(resolve(dataDir, 'plugins', id), { recursive: true, mode: 0o700 })
        backend = await startBackend(options(id, rec))
        if (backend.account && [...records.values()].some((r) => r !== rec && r.state === 'active' && r.backend?.account)) {
          throw new Error('A Unit can activate only one account authority')
        }
        if (rec.state as State === 'failed') throw new Error('Plugin stopped during startup')
        const mounts = backend.mounts.map((p) => p === '/' ? p : p.replace(/\/$/, ''))
        for (const mount of mounts) {
          if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(mount) || mount.split('/').includes('..') || mount === prefix
            || protectedPaths.some((p) => matches(mount, p))) throw new Error('Plugin claims an invalid or reserved route')
          if ([...records.values()].some((r) => r !== rec && r.state === 'active' && r.mounts.includes(mount))) throw new Error('Plugin route conflict')
        }
        rec.mounts = [...new Set(mounts)]
      }
      rec.backend = backend; rec.state = 'active'; rec.installation.enabled = true
    } catch (error) {
      rec.state = 'failed'; rec.backend = undefined
      if (backend) await backend.stop()
      throw error
    } finally { refreshProduct() }
  }
  async function deactivate(id: string, force = false) {
    const rec = mustGet(id)
    if (!force && [...records.values()].some((r) => r.state === 'active' && r.package.manifest.requires?.includes(id))) throw new Error('Disable dependent plugins first')
    const backend = rec.backend
    rec.backend = undefined; rec.state = 'stopping'; refreshProduct()
    try { await backend?.stop() } finally { rec.state = 'disabled'; rec.installation.enabled = false; refreshProduct() }
  }
  async function restart(id: string) { await deactivate(id); await activate(id) }
  const select = (path: string) => {
    if (protectedPaths.some((p) => matches(path, p))) return undefined
    const candidates = [...records.values()].filter((r) => r.state === 'active' && r.backend)
      .flatMap((r) => r.mounts.filter((m) => matches(path, m)).map((m) => ({ rec: r, length: m.length })))
      .sort((a, b) => b.length - a.length)
    const winner = candidates[0]
    return winner && (!matches(path, prefix) || winner.length > prefix.length) ? winner.rec.backend : undefined
  }
  refreshProduct()
  const accountProvider = () => {
    const record = [...records.entries()].find(([, r]) => r.state === 'active' && r.backend?.account)
    return record ? { id: record[0], account: record[1].backend!.account! } : undefined
  }
  const accountHttp = createAccountHttp({ dataDir, provider: accountProvider,
    pluginActive: (id) => records.get(id)?.state === 'active' })
  const web = await startUnitWeb({
    account: { metadata: () => accountProvider()?.account.metadata, handle: accountHttp },
    meta: { instanceId: config.instanceId, name: config.name, version: config.version },
    projection: { mode: 'public', basePath: config.basePath, product },
    routeRequest: (req, res) => {
      const path = pathname(req.url), backend = select(path)
      if (backend) { backend.handle(req, res); return true }
      // Preserve UI-only gateways. Composed Units project under their declared prefix.
      if ([...records.values()].some((r) => r.package.backendEntry) && !matches(path, prefix)) {
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"detail":"No active plugin route"}'); return true
      }
      return false
    },
    routeUpgrade: (req, socket, head) => { const backend = select(pathname(req.url)); if (!backend?.upgrade) return false; backend.upgrade(req, socket, head); return true },
    getEngine: () => ({ url: null, token: '' }),
    pairedDevices: { list: () => [], add: async () => { throw new Error('Pairing is disabled') } },
    confirmPair: async () => false,
    readPlugins: async () => [...records.values()].flatMap((r) => r.state === 'active' && r.package.ui ? [r.package.ui] : []),
    readSpaces: async () => [...records.values()].flatMap((r) => r.state === 'active' ? r.package.spaces : []),
    readConfig: async () => ({}), writeConfig: async () => { throw new Error('Host configuration is not published') },
    readProviders: async () => [], readHostFile: async () => null, readHostDir: async () => null, readHostStat: async () => null,
    webDistDir: () => config.webDist, vault: () => null, log: (message) => console.log(message),
  }, { port: config.port, bindHost: config.bindHost ?? '127.0.0.1' })
  for (const id of ordered) if (mustGet(id).installation.enabled !== false) {
    try { await activate(id) } catch { console.error(`[unit] Plugin ${id} failed to activate; Unit remains available`) }
  }
  return { ...web,
    status: () => [...records.values()].map((r) => ({ id: r.package.manifest.id, version: r.package.manifest.version, state: r.state })),
    enable: (id: string) => serialize(() => activate(id)), disable: (id: string) => serialize(() => deactivate(id)),
    restart: (id: string) => serialize(() => restart(id)),
    update: (id: string, path: string) => serialize(async () => {
      const rec = mustGet(id), next = await readPackage(path, config.version)
      if (next.manifest.id !== id) throw new Error('Update changes plugin identity')
      for (const dep of next.manifest.requires || []) if (mustGet(dep).state !== 'active') throw new Error('New dependency is not active')
      for (const other of records.values()) if (other !== rec) for (const space of next.spaceIds) if (other.package.spaceIds.has(space)) throw new Error('Duplicate Space id')
      const nextOrder = dependencyOrder({ id, package: next })
      if (config.defaultSpace && rec.package.spaceIds.has(config.defaultSpace) && !next.spaceIds.has(config.defaultSpace)) throw new Error('Update removes the Unit default Space')
      const previous = rec.package, active = rec.state === 'active'
      if (active) await deactivate(id)
      rec.package = next
      try { if (active) await activate(id); rec.installation.path = next.root; ordered.splice(0, ordered.length, ...nextOrder) }
      catch (error) { rec.package = previous; if (active) await activate(id); throw error }
      finally { refreshProduct() }
    }),
    migrate: (id: string) => serialize(async () => {
      const rec = mustGet(id)
      if (rec.state === 'active') throw new Error('Disable the plugin before migrating')
      if (!rec.package.backendEntry) throw new Error('Plugin has no backend migration')
      await migrateBackend(options(id, rec))
    }),
    close: () => serialize(async () => {
      if (closing) return
      closing = true
      await web.close()
      const errors: unknown[] = []
      for (const id of [...ordered].reverse()) { try { await deactivate(id, true) } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, 'Some plugins failed to stop cleanly')
    }),
  }
}
