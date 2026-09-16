/** Basic Unit owns the listener, packages, and backend plugin lifecycle. */
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startUnitWeb } from '../desktop/electron/unitWeb'
import { resolveProduct } from '../desktop/shared/product'
import basic from '../desktop/products/basic.json'
import { readPackage, type InstalledPackage, type CloudServices } from './packages'
import { startBackend, migrateBackend } from './backendRunner'
import { createAccountHttp } from './accountHttp'
import { createLocalWorkspace } from './localWorkspace'
import type { LocalRuntime, RuntimeFactory } from './runtimeTypes'
export { loadPackages } from './packages'

export interface PluginInstallation { path: string; enabled?: boolean; publish?: boolean; config?: Record<string, unknown>; env?: Record<string, string> }
export interface UnitConfig {
  instanceId: string; name: string; version: string; port: number; bindHost?: string
  basePath: string; webDist: string; plugins: Array<string | PluginInstallation>
  defaultSpace?: string; dataDir?: string; workerFile?: string
  workspace?: { mode: 'local'; path?: string }
}
type Backend = Awaited<ReturnType<typeof startBackend>>
type State = 'disabled' | 'starting' | 'active' | 'stopping' | 'failed'
interface RecordState { package: InstalledPackage; installation: PluginInstallation; state: State; backend?: Backend; runtime?: LocalRuntime; mounts: string[] }
const matches = (path: string, prefix: string) => prefix === '/' || path === prefix || path.startsWith(prefix + '/')
const pathname = (url: string | undefined) => (url || '/').split('?')[0]

export async function startBasicUnit(config: UnitConfig) {
  if (!config.instanceId || !config.name || !config.version) throw new Error('Unit identity is required')
  await readFile(resolve(config.webDist, 'index.html'))
  const dataDir = resolve(config.dataDir || resolve(homedir(), '.forsion', 'units', config.instanceId))
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const workerFile = config.workerFile || fileURLToPath(new URL('./backendWorker.mjs', import.meta.url))
  if (config.workspace && config.workspace.mode !== 'local') throw new Error('Invalid workspace mode')
  const local = config.workspace?.mode === 'local'
  const workspaceDir = resolve(config.workspace?.path || resolve(dataDir, 'workspace'))
  const records = new Map<string, RecordState>()
  const runtimeVault = () => [...records.values()].find((r) => usable(r) && r.runtime?.vault)?.runtime?.vault || null
  const runtimeEngine = () => [...records.values()].find((r) => usable(r) && r.runtime?.engine)?.runtime?.engine
  const localWorkspace = local ? await createLocalWorkspace(dataDir, workspaceDir, () => runtimeVault()?.root() || null) : null
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
  // Native features belong to installed packages, never to the Basic profile.
  const validateFeatures = (replacement?: { id: string; package: InstalledPackage }) => {
    const packs = [...records.entries()].map(([id, rec]) => replacement?.id === id ? replacement.package : rec.package)
    const features = new Set(packs.flatMap((p) => p.manifest.frontend?.features || []))
    if (features.has('calendar') && !features.has('amadeus')) throw new Error('Calendar requires the Amadeus frontend')
    if (features.has('automation') && !features.has('tangu')) throw new Error('Automation requires the Tangu frontend')
    for (const pack of packs) {
      const owns = pack.manifest.frontend?.features || []
      for (const [feature, dependency] of [['calendar', 'amadeus'], ['automation', 'tangu']] as const) {
        if (!owns.includes(feature) || owns.includes(dependency)) continue
        const owner = packs.find((p) => p.manifest.frontend?.features.includes(dependency))!
        if (!pack.manifest.requires?.includes(owner.manifest.id)) throw new Error(`${feature} must require the ${dependency} package`)
      }
    }
  }
  validateFeatures()
  const usable = (rec: RecordState): boolean => rec.state === 'active'
    && (rec.package.manifest.requires || []).every((id) => usable(mustGet(id)))
  const visible = (rec: RecordState): boolean => usable(rec) && rec.installation.publish !== false
    && (rec.package.manifest.requires || []).every((id) => !mustGet(id).package.manifest.frontend || visible(mustGet(id)))
  const published = () => [...records.values()].filter(visible)
  const product = resolveProduct(undefined, { ...basic, market: false, onboarding: false, nativeFeatures: [] })
  const capabilities = (): CloudServices => {
    const services: CloudServices = {}
    if (local) return services
    for (const rec of published()) Object.assign(services, rec.package.manifest.frontend?.services)
    // A cloud adapter is only usable with an active authority on this Unit.
    const account = [...records.values()].find((r) => usable(r) && r.backend?.account)?.backend?.account
    if (!account?.metadata) return {}
    for (const [id, service] of Object.entries(services)) {
      const base = account.metadata.apiBase.replace(/\/$/, '')
      if (service.apiBase !== base && !service.apiBase.startsWith(base + '/')) delete services[id as keyof CloudServices]
    }
    return services
  }
  const refreshProduct = () => {
    const visible = published()
    const spaces = visible.flatMap((r) => [...r.package.spaceIds])
    product.nativeFeatures = visible.flatMap((r) => r.package.manifest.frontend?.features || [])
    product.agentBackend = product.nativeFeatures.includes('tangu')
    product.spaces = spaces.length ? [] : ['home']
    product.defaultSpace = spaces.includes(config.defaultSpace || '') ? config.defaultSpace! : spaces[0] || 'home'
  }
  let chain = Promise.resolve(), closing = false, started = false
  const syncRuntimes = async () => {
    const roots = [...records.values()].filter(usable).map((r) => r.package.root)
    for (const rec of records.values()) if (usable(rec)) await rec.runtime?.setPackages?.(roots, [...records.values()].map((r) => r.package.root))
  }
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
    let backend: Backend | undefined, runtime: LocalRuntime | undefined
    try {
      if (local && rec.package.runtimeEntry) {
        const module = await import(pathToFileURL(rec.package.runtimeEntry).href + '?generation=' + randomUUID())
        const factory: RuntimeFactory = module.createRuntime || module.default
        if (typeof factory !== 'function') throw new Error('Local runtime has no factory')
        await mkdir(resolve(dataDir, 'plugins', id), { recursive: true, mode: 0o700 })
        runtime = await factory({ packageDir: rec.package.root, dataDir: resolve(dataDir, 'plugins', id), workspaceDir, config: rec.installation.config || {}, log: (m) => console.log(`[plugin:${id}] ${m}`) })
        if (!runtime || typeof runtime.close !== 'function') throw new Error('Invalid local runtime')
        if ((runtime.vault && runtimeVault()) || (runtime.engine && runtimeEngine())) throw new Error('Local capability already has a provider')
      }
      if (rec.package.backendEntry) {
        await mkdir(resolve(dataDir, 'plugins', id), { recursive: true, mode: 0o700 })
        backend = await startBackend(options(id, rec))
        if (backend.account && [...records.values()].some((r) => r !== rec && usable(r) && r.backend?.account)) {
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
      rec.backend = backend; rec.runtime = runtime; rec.state = 'active'; rec.installation.enabled = true
      if (started) await syncRuntimes()
    } catch (error) {
      rec.state = 'failed'; rec.backend = undefined; rec.runtime = undefined
      try { if (typeof runtime?.close === 'function') await runtime.close() } finally { await backend?.stop() }
      throw error
    } finally { refreshProduct() }
  }
  async function deactivate(id: string, force = false, preserveIntent = false) {
    const rec = mustGet(id)
    if (!force && [...records.values()].some((r) => r.state === 'active' && r.package.manifest.requires?.includes(id))) throw new Error('Disable dependent plugins first')
    const backend = rec.backend, runtime = rec.runtime
    rec.backend = undefined; rec.runtime = undefined; rec.state = 'stopping'; refreshProduct()
    try { try { await runtime?.close() } finally { await backend?.stop() } } finally { rec.state = 'disabled'; if (!preserveIntent) rec.installation.enabled = false; refreshProduct(); if (started && !closing) await syncRuntimes() }
  }
  const activeTree = (id: string) => {
    const affected = new Set([id])
    for (const candidate of ordered) if (mustGet(candidate).package.manifest.requires?.some((dep) => affected.has(dep))) affected.add(candidate)
    return ordered.filter((candidate) => affected.has(candidate) && (mustGet(candidate).state === 'active' || mustGet(candidate).installation.enabled !== false))
  }
  async function restart(id: string) {
    mustGet(id)
    const active = activeTree(id)
    for (const candidate of [...active].reverse()) await deactivate(candidate, false, true)
    for (const candidate of ordered.filter((candidate) => candidate === id || active.includes(candidate))) await activate(candidate)
  }
  const select = (path: string) => {
    if (protectedPaths.some((p) => matches(path, p))) return undefined
    const candidates = [...records.values()].filter((r) => usable(r) && r.backend)
      .flatMap((r) => r.mounts.filter((m) => matches(path, m)).map((m) => ({ rec: r, length: m.length })))
      .sort((a, b) => b.length - a.length)
    const winner = candidates[0]
    return winner && (!matches(path, prefix) || winner.length > prefix.length) ? winner.rec.backend : undefined
  }
  refreshProduct()
  const accountProvider = () => {
    const record = [...records.entries()].find(([, r]) => usable(r) && r.backend?.account)
    return record ? { id: record[0], account: record[1].backend!.account! } : undefined
  }
  const accountHttp = createAccountHttp({ dataDir, provider: accountProvider,
    pluginActive: (id) => { const rec = records.get(id); return !!rec && usable(rec) } })
  const web = await startUnitWeb({
    account: local ? undefined : { metadata: () => accountProvider()?.account.metadata, handle: accountHttp },
    meta: { instanceId: config.instanceId, name: config.name, version: config.version },
    projection: { mode: local ? 'local' : 'public', basePath: config.basePath, product, capabilities, localCapabilities: () => ({ vault: !!runtimeVault(), engine: !!runtimeEngine()?.endpoint().url, host: !!runtimeEngine()?.endpoint().url }) },
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
    getEngine: () => runtimeEngine()?.endpoint() || { url: null, token: '' },
    pairedDevices: { list: () => localWorkspace ? [localWorkspace.device] : [], add: async () => { throw new Error('Pairing is disabled') } },
    confirmPair: async () => false,
    readPlugins: async () => published().flatMap((r) => r.package.ui ? [r.package.ui] : []),
    readSpaces: async () => published().flatMap((r) => r.package.spaces),
    readConfig: localWorkspace?.readConfig || (async () => ({})), writeConfig: localWorkspace?.writeConfig || (async () => { throw new Error('Host configuration is not published') }),
    readProviders: async () => { const rec = [...records.values()].find((r) => usable(r) && r.runtime?.readProviders); return await rec?.runtime?.readProviders?.() || [] },
    readHostFile: localWorkspace?.readHostFile || (async () => null), readHostDir: localWorkspace?.readHostDir || (async () => null), readHostStat: localWorkspace?.readHostStat || (async () => null),
    webDistDir: () => config.webDist, vault: runtimeVault, log: (message) => console.log(message),
  }, { port: config.port, bindHost: config.bindHost ?? '127.0.0.1' })
  for (const id of ordered) if (mustGet(id).installation.enabled !== false) {
    try { await activate(id) } catch { console.error(`[unit] Plugin ${id} failed to activate; Unit remains available`) }
  }
  started = true
  try { await syncRuntimes() } catch (error) {
    await web.close()
    await Promise.allSettled([...records.values()].map(async (rec) => { try { await rec.runtime?.close() } finally { await rec.backend?.stop() } }))
    throw error
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
      validateFeatures({ id, package: next })
      if (config.defaultSpace && rec.package.spaceIds.has(config.defaultSpace) && !next.spaceIds.has(config.defaultSpace)) throw new Error('Update removes the Unit default Space')
      const previous = rec.package, active = activeTree(id)
      for (const candidate of [...active].reverse()) await deactivate(candidate, false, true)
      rec.package = next
      try {
        for (const candidate of nextOrder.filter((candidate) => active.includes(candidate))) await activate(candidate)
        rec.installation.path = next.root; ordered.splice(0, ordered.length, ...nextOrder)
      } catch (error) {
        for (const candidate of [...nextOrder].reverse().filter((candidate) => active.includes(candidate))) await deactivate(candidate, true, true)
        rec.package = previous
        for (const candidate of active) await activate(candidate)
        throw error
      }
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
