/** Opt-in marketplace updates. Download off the live plugin roots; activate before any host starts. */
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gatePluginManifest } from '@amadeus-shared/ipc'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { detectMarketType, extractZipToDir, isSafeSlug, marketItemDir, MARKET_MANIFEST } from './marketInstall'
import { compareMarketVersions, type MarketPluginType, type MarketPluginUpdate, type MarketPluginUpdates } from '../shared/marketPluginUpdates'

export interface MarketUpdateItem { id: string; name: string; type: string; installSlug: string; latestVersion?: string | null }
const pluginType = (type: string): type is MarketPluginType => type === 'plugin' || type === 'amadeus-plugin'
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

export function createMarketPluginUpdater(o: {
  home: string
  appVersion: string
  protectedIds: () => ReadonlySet<string>
  lookup: (id: string) => Promise<MarketUpdateItem>
  download: (item: MarketUpdateItem) => Promise<Buffer>
  broadcast: (state: MarketPluginUpdates) => void
}) {
  const root = join(o.home, '.market-updates'), stateFile = join(root, 'state.json')
  const disk = createSerialQueue(), exclusive = createSerialQueue()
  let items: MarketPluginUpdate[] = [], checking = false, running: Promise<void> | undefined
  let recheck = false
  const snapshot = (): MarketPluginUpdates => ({ checking, items: items.map((x) => ({ ...x })) })
  const emit = () => o.broadcast(snapshot())
  const pending = (x: MarketPluginUpdate) => join(root, x.type, x.slug)
  const dest = (x: MarketPluginUpdate) => marketItemDir(o.home, x.type, x.slug)!
  const manifest = async (type: MarketPluginType, dir: string) => {
    // A symlink at the installation root is a development load, not an update target.
    if (!(await lstat(dir)).isDirectory()) throw new Error('install: linked or missing plugin')
    const m = JSON.parse(await readFile(join(dir, MARKET_MANIFEST[type][0]), 'utf8'))
    if (!isSafeSlug(m.id) || typeof m.version !== 'string' || compareMarketVersions(m.version, m.version) !== 0) throw new Error('install: invalid manifest')
    if (o.protectedIds().has(m.id)) throw new Error('install: builtin')
    const entry = type === 'plugin' ? m.entry : m.main || 'main.js'
    if (typeof entry !== 'string' || !entry || isAbsolute(entry) || entry.split(/[\\/]/).some((p) => p === '..')) throw new Error('install: invalid plugin entry')
    const hasEntry = await lstat(join(dir, entry)).then((s) => s.isFile(), () => false)
    if (!hasEntry) {
      // The host also accepts a contribution-only bundle without a renderer entry.
      let bundle = false
      if (type === 'amadeus-plugin' && !m.main) {
        for (const [sub, marker] of Object.entries({ spaces: 'space.json', agents: 'config.toml', skills: 'SKILL.md', 'tangu-plugins': 'tangu-plugin.json' })) {
          const children = await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])
          for (const child of children) if (child.isDirectory() && await lstat(join(dir, sub, child.name, marker)).then((s) => s.isFile(), () => false)) bundle = true
        }
      }
      if (!bundle) throw new Error('install: plugin entry missing')
    }
    if (type === 'plugin' && m.apiVersion !== 1) throw new Error('install: incompatible plugin API')
    return m as { id: string; version: string; apiVersion?: unknown; minAppVersion?: unknown }
  }
  const validate = (x: MarketPluginUpdate, old: Awaited<ReturnType<typeof manifest>>, next: Awaited<ReturnType<typeof manifest>>) => {
    if (o.protectedIds().has(x.slug) || next.id !== old.id) throw new Error('install: plugin identity changed')
    if ((compareMarketVersions(next.version, old.version) ?? 0) <= 0) throw new Error('install: version is not newer')
    if (x.type === 'amadeus-plugin' && gatePluginManifest(next, o.appVersion)) throw new Error('install: incompatible plugin')
    if (x.type === 'plugin' && typeof next.minAppVersion === 'string' && (compareMarketVersions(next.minAppVersion, o.appVersion) ?? 1) > 0) throw new Error('install: incompatible plugin')
  }
  const patch = (id: string, value: Partial<MarketPluginUpdate>) => disk(async () => {
    const next = items.map((x) => x.id === id ? { ...x, ...value } : x)
    await writePrivateJson(stateFile, { items: next }); items = next; emit()
  })
  const active = (id: string) => items.find((x) => x.id === id)?.autoUpdate

  async function init(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(stateFile, 'utf8'))
      if (!Array.isArray(data.items)) throw new Error('Invalid market update state')
      items = data.items.filter((x: MarketPluginUpdate) => x && typeof x.id === 'string' && typeof x.name === 'string' && pluginType(x.type) && isSafeSlug(x.slug))
        .map((x: MarketPluginUpdate) => ({ ...x, autoUpdate: x.autoUpdate === true, phase: 'idle' as const }))
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    // Activation happens before engine/renderer discovery. Keep a recoverable old directory until commit.
    for (const x of items) {
      const target = dest(x), backup = join(root, x.type, `.${x.slug}.previous`)
      try {
        // Recover an interrupted rename before inspecting the update.
        const exists = (p: string) => lstat(p).then(() => true, () => false)
        if (await exists(backup)) {
          if (!await exists(target)) await rename(backup, target)
          else await rm(backup, { recursive: true, force: true })
        }
        const old = await manifest(x.type, target)
        x.installedVersion = old.version
        if (!x.pendingVersion) continue
        const next = await manifest(x.type, pending(x))
        if (compareMarketVersions(next.version, old.version) === 0) {
          await rm(pending(x), { recursive: true, force: true }); x.pendingVersion = undefined; x.phase = 'current'; continue
        }
        validate(x, old, next)
        if (next.version !== x.pendingVersion) throw new Error('install: pending version mismatch')
        // Same home/filesystem, atomic names. Plugin settings/data live outside these package roots.
        await mkdir(join(root, x.type), { recursive: true })
        await rename(target, backup)
        try { await rename(pending(x), target) }
        catch (e) { await rename(backup, target); throw e }
        x.installedVersion = next.version; x.pendingVersion = undefined; x.phase = 'current'; x.error = undefined
        await rm(backup, { recursive: true, force: true })
      } catch (e) { x.phase = 'error'; x.error = errorText(e); x.pendingVersion = undefined }
    }
    if (items.length) await writePrivateJson(stateFile, { items })
    emit()
  }

  async function setAutoUpdate(id: string, on: boolean): Promise<MarketPluginUpdates> {
    if (typeof id !== 'string' || !id || typeof on !== 'boolean') throw new Error('invalid market update option')
    if (!on && items.some((x) => x.id === id)) { await patch(id, { autoUpdate: false }); return snapshot() }
    const item = await o.lookup(id)
    if (item.id !== id || !pluginType(item.type) || !isSafeSlug(item.installSlug)) throw new Error('install: not a market plugin')
    const types: MarketPluginType[] = [item.type, item.type === 'plugin' ? 'amadeus-plugin' : 'plugin']
    let entry: MarketPluginUpdate | undefined
    for (const type of types) {
      try {
        const x: MarketPluginUpdate = { id, name: item.name, type, slug: item.installSlug, autoUpdate: on, phase: 'idle' }
        const m = await manifest(type, dest(x))
        if (o.protectedIds().has(x.slug)) throw new Error('install: builtin')
        entry = { ...x, installedVersion: m.version }; break
      } catch { /* Category may be historically mislabeled; try the other plugin root. */ }
    }
    if (!entry) throw new Error('install: plugin is not installed or is protected')
    await disk(async () => {
      const before = items.find((x) => x.id === id)
      // One installed directory belongs to one marketplace identity; never auto-replace an ambiguous collision.
      if (items.some((x) => x.id !== id && x.type === entry!.type && x.slug === entry!.slug)) throw new Error('install: ambiguous market identity')
      const next = [...items.filter((x) => x.id !== id), { ...before, ...entry!, pendingVersion: before?.pendingVersion, phase: before?.pendingVersion ? 'staged' as const : entry!.phase }]
      await writePrivateJson(stateFile, { items: next }); items = next; emit()
    })
    if (on && running) recheck = true
    return snapshot()
  }

  function check(): Promise<void> {
    if (running) return running
    checking = true; emit()
    running = exclusive(async () => {
      do {
        recheck = false
        for (const remembered of [...items]) {
          if (!active(remembered.id)) continue
          const x = items.find((it) => it.id === remembered.id)!
          const staging = join(root, x.type, `.${x.slug}.staging-${randomUUID()}`)
          try {
            await patch(x.id, { phase: 'checking', error: undefined })
            const old = await manifest(x.type, dest(x))
            const item = await o.lookup(x.id)
            if (item.id !== x.id || item.installSlug !== x.slug || !pluginType(item.type)) throw new Error('resolve: market identity changed')
            const baseline = x.pendingVersion && (compareMarketVersions(x.pendingVersion, old.version) ?? 0) > 0 ? x.pendingVersion : old.version
            if ((compareMarketVersions(item.latestVersion, baseline) ?? 0) <= 0) {
              await patch(x.id, { installedVersion: old.version, phase: x.pendingVersion ? 'staged' : 'current' }); continue
            }
            if (!active(x.id)) { await patch(x.id, { phase: x.pendingVersion ? 'staged' : 'idle' }); continue }
            await patch(x.id, { phase: 'downloading', installedVersion: old.version })
            const buf = await o.download(item)
            if (await detectMarketType(buf, item.type) !== x.type) throw new Error('install: plugin type changed')
            await extractZipToDir(buf, staging, MARKET_MANIFEST[x.type])
            const next = await manifest(x.type, staging)
            validate(x, old, next)
            if (compareMarketVersions(next.version, item.latestVersion) !== 0) throw new Error('install: advertised version mismatch')
            if (!active(x.id)) { await patch(x.id, { phase: x.pendingVersion ? 'staged' : 'idle' }); continue }
            // Save a complete package under a fresh directory, then publish the state pointer atomically.
            const previous = `${pending(x)}.old-${randomUUID()}`
            let had = false
            try { await rename(pending(x), previous); had = true } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
            try {
              await rename(staging, pending(x))
              await patch(x.id, { phase: 'staged', pendingVersion: next.version })
            } catch (e) {
              await rm(pending(x), { recursive: true, force: true }).catch(() => {})
              if (had) await rename(previous, pending(x))
              throw e
            }
            if (had) await rm(previous, { recursive: true, force: true })
          } catch (e) { await patch(x.id, { phase: 'error', error: errorText(e) }) }
          finally { await rm(staging, { recursive: true, force: true }).catch(() => {}) }
        }
      } while (recheck)
    }).finally(() => { checking = false; running = undefined; emit() })
    return running
  }

  /** Manual installation/uninstallation shares the same package mutation queue as automatic downloads. */
  async function forget(type: string, slug: string, remove = true): Promise<void> {
    const hits = items.filter((x) => x.type === type && x.slug === slug)
    if (!hits.length) return
    for (const x of hits) await rm(pending(x), { recursive: true, force: true })
    await disk(async () => {
      const next = remove ? items.filter((x) => !hits.some((h) => h.id === x.id)) : items.map((x) => hits.some((h) => h.id === x.id) ? { ...x, pendingVersion: undefined, phase: 'idle' as const, error: undefined } : x)
      await writePrivateJson(stateFile, { items: next }); items = next; emit()
    })
  }
  return { init, snapshot, setAutoUpdate, check, exclusive, forget }
}
