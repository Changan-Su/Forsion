import { assertMarketplaceRequirements, type MarketplaceRequirements } from '../shared/marketplace'
/**
 * Marketplace plugin updates and the local version store.
 *
 * - Updates download off the live plugin roots and activate before any host starts (init).
 * - Auto-update is on by default (11-06): a plugin without its own choice follows the global switch; an explicit
 *   per-plugin `autoUpdate: false` (older builds wrote it when the box was unticked) is kept.
 * - Rolling back, or installing an older store version, pins the plugin: no automatic update until the user turns
 *   auto-update back on. The global switch never clears a pin.
 * - Every replaced package is kept under <home>/.plugin-versions/<type>/<slug>/<version>/ (2 newest per plugin),
 *   so a rollback is a local directory swap. Plugin folders copied in by hand get a copy of each version they show.
 * - Core packages (protectedIds), development links and folders without a valid manifest are never touched.
 */
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gatePluginManifest } from '@amadeus-shared/ipc'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { detectMarketType, extractZipToDir, isSafeSlug, marketItemDir, MARKET_MANIFEST, MARKET_SUBDIR } from './marketInstall'
import {
  compareMarketVersions, type KeptPluginVersion, type LocalPluginVersions, type MarketPluginType, type MarketPluginUpdate,
  type MarketPluginUpdates, type PluginRollbackResult,
} from '../shared/marketPluginUpdates'

export interface MarketUpdateItem { id: string; name: string; type: string; installSlug: string; latestVersion?: string | null }
const pluginType = (type: unknown): type is MarketPluginType => type === 'plugin' || type === 'amadeus-plugin'
const PLUGIN_TYPES: MarketPluginType[] = ['amadeus-plugin', 'plugin']
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const exists = (p: string) => lstat(p).then(() => true, () => false)
/** Old versions kept per plugin, besides a copy of the installed version (hand-copied plugins). */
export const KEPT_VERSIONS = 2
/** Hand-copied plugins larger than this are not copied into the version store. */
const LOCAL_COPY_CAP = 200 * 1024 * 1024
/** A version string doubles as a directory name in the store. */
export const isKeepableVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && /^[0-9A-Za-z.+-]+$/.test(v) && compareMarketVersions(v, v) === 0

/** Persisted entry. `autoUpdate` is the explicit per-plugin choice (absent = follow the global switch). */
type Entry = Omit<MarketPluginUpdate, 'autoUpdate' | 'autoUpdateChoice' | 'keptVersions'> & { autoUpdate?: boolean }
type Manifest = { id: string; version: string; apiVersion?: unknown; minAppVersion?: unknown } & MarketplaceRequirements

export function createMarketPluginUpdater(o: {
  home: string
  appVersion: string
  protectedIds: () => ReadonlySet<string>
  lookup: (id: string) => Promise<MarketUpdateItem>
  /** Approved store items, used to recognise store installs that predate this state file. */
  catalog?: () => Promise<MarketUpdateItem[]>
  download: (item: MarketUpdateItem) => Promise<Buffer>
  broadcast: (state: MarketPluginUpdates) => void
  platform?: string
}) {
  const root = join(o.home, '.market-updates'), stateFile = join(root, 'state.json')
  const versionsRoot = join(o.home, '.plugin-versions')
  const platform = o.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux')
  const disk = createSerialQueue(), exclusive = createSerialQueue()
  let items: Entry[] = [], autoUpdateAll = true, checking = false, running: Promise<void> | undefined
  // A state file that exists but cannot be read is "unknown", not "empty": never rewrite it from defaults.
  let stateReadable = true
  let recheck = false
  let local: Array<Omit<LocalPluginVersions, 'keptVersions'>> = []
  const kept = new Map<string, KeptPluginVersion[]>()
  const key = (type: string, slug: string) => `${type}/${slug}`
  const effective = (x: Entry) => !x.pinnedVersion && (x.autoUpdate ?? autoUpdateAll)
  const snapshot = (): MarketPluginUpdates => ({
    checking, autoUpdateAll,
    items: items.map(({ autoUpdate, ...x }) => ({ ...x, autoUpdate: effective({ ...x, autoUpdate }), ...(autoUpdate !== undefined ? { autoUpdateChoice: autoUpdate } : {}), keptVersions: kept.get(key(x.type, x.slug)) ?? [] })),
    local: local.map((x) => ({ ...x, keptVersions: kept.get(key(x.type, x.slug)) ?? [] })),
  })
  const emit = () => o.broadcast(snapshot())
  const pending = (x: { type: MarketPluginType; slug: string }) => join(root, x.type, x.slug)
  const dest = (x: { type: MarketPluginType; slug: string }) => marketItemDir(o.home, x.type, x.slug)!
  const storeDir = (type: MarketPluginType, slug: string) => join(versionsRoot, type, slug)
  const manifest = async (type: MarketPluginType, dir: string): Promise<Manifest> => {
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
    return m as Manifest
  }
  const assertCompatible = (type: MarketPluginType, m: Manifest) => {
    if (type === 'amadeus-plugin' && gatePluginManifest(m, o.appVersion)) throw new Error('install: incompatible plugin')
    assertMarketplaceRequirements(m, o.appVersion, platform)
  }
  const validate = (x: Entry, old: Manifest, next: Manifest, downgrade = false) => {
    if (o.protectedIds().has(x.slug) || next.id !== old.id) throw new Error('install: plugin identity changed')
    if (!downgrade && (compareMarketVersions(next.version, old.version) ?? 0) <= 0) throw new Error('install: version is not newer')
    assertCompatible(x.type, next)
  }
  const write = (next: Entry[]) => {
    if (!stateReadable) throw new Error('install: update state unreadable')
    return writePrivateJson(stateFile, { autoUpdateAll, items: next })
  }
  const patch = (id: string, value: Partial<Entry>) => disk(async () => {
    const next = items.map((x) => x.id === id ? { ...x, ...value } : x)
    await write(next); items = next; emit()
  })
  const active = (id: string) => { const x = items.find((it) => it.id === id); return !!x && effective(x) }

  /** Installed plugin folders in both plugin roots (real directories with a valid, non-core manifest). */
  async function scanInstalled(): Promise<Array<{ type: MarketPluginType; slug: string; id: string; version: string }>> {
    const out: Array<{ type: MarketPluginType; slug: string; id: string; version: string }> = []
    for (const type of PLUGIN_TYPES) {
      const base = join(o.home, MARKET_SUBDIR[type])
      const ents = await readdir(base, { withFileTypes: true }).catch(() => [])
      for (const e of ents) {
        if (!e.isDirectory() || !isSafeSlug(e.name)) continue // symlinks (development loads) are not directories here
        try { const m = await manifest(type, join(base, e.name)); out.push({ type, slug: e.name, id: m.id, version: m.version }) } catch { /* core, broken or foreign */ }
      }
    }
    return out
  }

  // ── Version store ──
  async function prune(type: MarketPluginType, slug: string): Promise<void> {
    const store = storeDir(type, slug)
    const current = await manifest(type, dest({ type, slug })).then((m) => m.version, () => undefined)
    const ents = await readdir(store, { withFileTypes: true }).catch(() => [])
    const versions = await Promise.all(ents.filter((e) => e.isDirectory() && isKeepableVersion(e.name))
      .map(async (e) => ({ version: e.name, at: (await stat(join(store, e.name)).catch(() => null))?.mtimeMs ?? 0 })))
    const older = versions.filter((v) => !current || compareMarketVersions(v.version, current) !== 0).sort((a, b) => b.at - a.at)
    for (const v of older.slice(KEPT_VERSIONS)) await rm(join(store, v.version), { recursive: true, force: true })
  }
  /** Move a complete package directory into the store as `version` (newest copy wins). */
  async function stash(type: MarketPluginType, slug: string, dir: string, version: string): Promise<void> {
    if (!isKeepableVersion(version)) { await rm(dir, { recursive: true, force: true }); return }
    const store = storeDir(type, slug), at = join(store, version), was = join(store, `.old-${randomUUID()}`)
    await mkdir(store, { recursive: true })
    // Keep the existing copy until the replacement is in place; a failure leaves `dir` for the next startup.
    let had = false
    try { await rename(at, was); had = true } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    try { await rename(dir, at) } catch (e) { if (had) await rename(was, at).catch(() => {}); throw e }
    if (had) await rm(was, { recursive: true, force: true }).catch(() => {})
    const now = new Date(); await utimes(at, now, now).catch(() => {})
    await prune(type, slug)
  }
  /** A rollback interrupted between its two renames leaves `.swap-*` in the store: put the live folder back. */
  async function recoverSwaps(): Promise<void> {
    for (const type of PLUGIN_TYPES) {
      const slugs = await readdir(join(versionsRoot, type), { withFileTypes: true }).catch(() => [])
      for (const s of slugs) {
        if (!s.isDirectory() || !isSafeSlug(s.name)) continue
        const store = storeDir(type, s.name), target = dest({ type, slug: s.name })
        for (const e of await readdir(store, { withFileTypes: true }).catch(() => [])) {
          if (!e.isDirectory() || !/^\.(swap|old|copy)-/.test(e.name)) continue
          const dir = join(store, e.name)
          try {
            if (e.name.startsWith('.swap-') && !await exists(target)) { await rename(dir, target); continue }
            if (e.name.startsWith('.swap-')) { await stash(type, s.name, dir, (await manifest(type, dir)).version); continue }
            // `.old-*` is a kept copy whose replacement never landed; `.copy-*` an unfinished copy.
            const m = e.name.startsWith('.old-') ? await manifest(type, dir).catch(() => null) : null
            if (m && !await exists(join(store, m.version))) await rename(dir, join(store, m.version))
            else await rm(dir, { recursive: true, force: true })
          } catch (err) { console.warn('[market-updates] recover version store:', errorText(err)) }
        }
      }
    }
  }
  async function sizeWithin(dir: string, cap: number): Promise<boolean> {
    let total = 0
    const walk = async (d: string): Promise<boolean> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) { if (!await walk(p)) return false }
        else if (e.isFile()) { total += (await stat(p)).size; if (total > cap) return false }
      }
      return true
    }
    return walk(dir).catch(() => false)
  }
  /** Copy the live package into the store (the live folder stays). Skips a version already kept. */
  async function copyIntoStore(type: MarketPluginType, slug: string, dir: string, version: string): Promise<void> {
    if (!isKeepableVersion(version)) return
    const store = storeDir(type, slug), at = join(store, version)
    if (await exists(at)) return
    if (!await sizeWithin(dir, LOCAL_COPY_CAP)) return
    const tmp = join(store, `.copy-${randomUUID()}`)
    await mkdir(store, { recursive: true })
    try {
      await cp(dir, tmp, { recursive: true, verbatimSymlinks: true })
      await rename(tmp, at)
      const now = new Date(); await utimes(at, now, now).catch(() => {})
    } finally { await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
    await prune(type, slug)
  }
  async function readKept(type: MarketPluginType, slug: string): Promise<KeptPluginVersion[]> {
    const store = storeDir(type, slug)
    const current = await manifest(type, dest({ type, slug })).then((m) => m.version, () => undefined)
    const ents = await readdir(store, { withFileTypes: true }).catch(() => [])
    const out: Array<KeptPluginVersion & { at: number }> = []
    for (const e of ents) {
      if (!e.isDirectory() || !isKeepableVersion(e.name) || (current && compareMarketVersions(e.name, current) === 0)) continue
      try {
        const m = await manifest(type, join(store, e.name))
        if (m.version !== e.name) continue
        let compatible = true
        try { assertCompatible(type, m) } catch { compatible = false }
        out.push({ version: e.name, compatible, at: (await stat(join(store, e.name))).mtimeMs })
      } catch { /* incomplete copy */ }
    }
    return out.sort((a, b) => b.at - a.at).map(({ at, ...v }) => ({ ...v, keptAt: Math.round(at) }))
  }
  async function refresh(): Promise<void> {
    const installed = await scanInstalled()
    local = installed.filter((x) => !items.some((it) => it.type === x.type && it.slug === x.slug))
      .map((x) => ({ ...x }))
    kept.clear()
    for (const x of [...items, ...local]) kept.set(key(x.type, x.slug), await readKept(x.type, x.slug))
  }

  async function init(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(stateFile, 'utf8'))
      if (!Array.isArray(data.items)) throw new Error('Invalid market update state')
      autoUpdateAll = data.autoUpdateAll !== false
      items = data.items.filter((x: Entry) => x && typeof x.id === 'string' && typeof x.name === 'string' && pluginType(x.type) && isSafeSlug(x.slug))
        .map((x: Entry): Entry => ({
          ...x,
          autoUpdate: typeof x.autoUpdate === 'boolean' ? x.autoUpdate : undefined,
          pinnedVersion: isKeepableVersion(x.pinnedVersion) ? x.pinnedVersion : undefined,
          pendingRollback: x.pendingRollback === true ? true : undefined,
          phase: 'idle',
        }))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { stateReadable = false; throw e }
    }
    await recoverSwaps()
    // Activation happens before engine/renderer discovery. Keep a recoverable old directory until commit.
    for (const x of items) {
      const target = dest(x), backup = join(root, x.type, `.${x.slug}.previous`)
      try {
        // Recover an interrupted rename before inspecting the update.
        if (await exists(backup)) {
          if (!await exists(target)) await rename(backup, target)
          else {
            const was = await manifest(x.type, backup).then((m) => m.version, () => '')
            await stash(x.type, x.slug, backup, was)
          }
        }
        const old = await manifest(x.type, target)
        x.installedVersion = old.version
        // A pin outranks an update downloaded before it was set.
        if (x.pendingVersion && x.pinnedVersion && !x.pendingRollback) {
          await rm(pending(x), { recursive: true, force: true }); x.pendingVersion = undefined; x.phase = 'current'; continue
        }
        if (!x.pendingVersion) continue
        const next = await manifest(x.type, pending(x))
        if (compareMarketVersions(next.version, old.version) === 0) {
          await rm(pending(x), { recursive: true, force: true }); x.pendingVersion = undefined; x.pendingRollback = undefined; x.phase = 'current'; continue
        }
        validate(x, old, next, x.pendingRollback)
        if (next.version !== x.pendingVersion) throw new Error('install: pending version mismatch')
        // Same home/filesystem, atomic names. Plugin settings/data live outside these package roots.
        await mkdir(join(root, x.type), { recursive: true })
        try {
          await rename(target, backup)
          try { await rename(pending(x), target) }
          catch (e) { await rename(backup, target); throw e }
        } catch (e) {
          // A busy folder is worth retrying at the next launch; keep the staged package and its intent.
          x.phase = 'error'; x.error = errorText(e); continue
        }
        x.installedVersion = next.version; x.pendingVersion = undefined; x.pendingRollback = undefined; x.phase = 'current'; x.error = undefined
        // A failed move leaves `.previous` behind; the recovery above files it on the next startup.
        await stash(x.type, x.slug, backup, old.version).catch((e) => console.warn('[market-updates] keep old version:', errorText(e)))
      } catch (e) { x.phase = 'error'; x.error = errorText(e); x.pendingVersion = undefined; x.pendingRollback = undefined }
    }
    if (items.length) await write(items)
    await refresh().catch((e) => console.warn('[market-updates] version store:', e))
    emit()
  }

  async function setAutoUpdate(id: string, on: boolean): Promise<MarketPluginUpdates> {
    if (typeof id !== 'string' || !id || typeof on !== 'boolean') throw new Error('invalid market update option')
    const known = items.find((x) => x.id === id)
    if (known) {
      if (on && known.pendingRollback) await rm(pending(known), { recursive: true, force: true })
      // Turning auto-update on is how a pin is released ("Resume auto-update").
      await patch(id, on ? { autoUpdate: true, pinnedVersion: undefined, ...(known.pendingRollback ? { pendingRollback: undefined, pendingVersion: undefined, phase: 'idle' as const } : {}) } : { autoUpdate: false })
      if (on && running) recheck = true
      return snapshot()
    }
    const item = await o.lookup(id)
    if (item.id !== id || !pluginType(item.type) || !isSafeSlug(item.installSlug)) throw new Error('install: not a market plugin')
    const entry = await locate(item)
    await disk(async () => {
      // Registered meanwhile (discovery, a rollback): change only the choice, never drop its pin or staged rollback.
      const now = items.find((x) => x.id === id)
      if (now) {
        const next = items.map((x) => x.id === id ? { ...x, autoUpdate: on, ...(on && !x.pendingRollback ? { pinnedVersion: undefined } : {}) } : x)
        await write(next); items = next; return
      }
      // One installed directory belongs to one marketplace identity; never auto-replace an ambiguous collision.
      if (items.some((x) => x.id !== id && x.type === entry.type && x.slug === entry.slug)) throw new Error('install: ambiguous market identity')
      const next = [...items.filter((x) => x.id !== id), { ...entry, autoUpdate: on }]
      await write(next); items = next
    })
    await refresh().catch(() => {}); emit()
    if (on && running) recheck = true
    return snapshot()
  }
  /** Find the installed folder of a store item (its category may be historically mislabeled). */
  async function locate(item: MarketUpdateItem): Promise<Entry> {
    const types: MarketPluginType[] = item.type === 'plugin' ? ['plugin', 'amadeus-plugin'] : ['amadeus-plugin', 'plugin']
    for (const type of types) {
      try {
        const x: Entry = { id: item.id, name: item.name, type, slug: item.installSlug, phase: 'idle' }
        const m = await manifest(type, dest(x))
        if (o.protectedIds().has(x.slug)) throw new Error('install: builtin')
        return { ...x, installedVersion: m.version }
      } catch { /* try the other plugin root */ }
    }
    throw new Error('install: plugin is not installed or is protected')
  }

  async function setAutoUpdateAll(on: boolean): Promise<MarketPluginUpdates> {
    if (typeof on !== 'boolean') throw new Error('invalid market update option')
    await disk(async () => { const was = autoUpdateAll; autoUpdateAll = on; try { await write(items) } catch (e) { autoUpdateAll = was; throw e } })
    emit()
    if (on && running) recheck = true
    return snapshot()
  }

  /** Register store installs that predate this state (default on means every store plugin is a candidate). */
  async function discover(): Promise<void> {
    if (!o.catalog) return
    const unregistered = (await scanInstalled()).filter((x) => !items.some((it) => it.type === x.type && it.slug === x.slug))
    if (!unregistered.length) return
    const catalog = await o.catalog()
    const found: Entry[] = []
    for (const u of unregistered) {
      // Install folders are only unique per store item since uuid-v1 (market-<id>); older names can collide.
      const hits = catalog.filter((c) => pluginType(c.type) && c.installSlug === u.slug && typeof c.id === 'string' && c.id)
      if (hits.length !== 1 || items.some((it) => it.id === hits[0].id) || found.some((f) => f.id === hits[0].id)) continue
      found.push({ id: hits[0].id, name: hits[0].name || u.slug, type: u.type, slug: u.slug, phase: 'idle', installedVersion: u.version })
    }
    if (!found.length) return
    await disk(async () => {
      const next = [...items, ...found.filter((f) => !items.some((x) => x.id === f.id || (x.type === f.type && x.slug === f.slug)))]
      await write(next); items = next
    })
    await refresh().catch(() => {})
  }

  function check(): Promise<void> {
    if (running) return running
    if (!stateReadable) return Promise.resolve()
    checking = true; emit()
    running = exclusive(async () => {
      await discover().catch((e) => console.warn('[market-updates] discover:', errorText(e)))
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

  // ── Calls below run inside `exclusive` (the caller holds it), like manual installation. ──

  /** Before a manual install overwrites the folder in place, keep the version that is there now. */
  async function keepBeforeInstall(type: string, slug: string, incoming?: string | null): Promise<void> {
    if (!pluginType(type) || !isSafeSlug(slug)) return
    const dir = dest({ type, slug })
    const m = await manifest(type, dir).catch(() => null)
    if (!m || (incoming && compareMarketVersions(m.version, incoming) === 0)) return
    await copyIntoStore(type, slug, dir, m.version).catch((e) => console.warn('[market-updates] keep before install:', errorText(e)))
  }

  /** A manual install from the store: remember the identity; installing an older version pins it. */
  async function recordInstall(r: { id: string; name?: string; type: string; slug: string; pinned: boolean }): Promise<void> {
    if (!pluginType(r.type) || !isSafeSlug(r.slug)) return
    const type = r.type
    const m = await manifest(type, dest({ type, slug: r.slug })).catch(() => null)
    for (const x of items.filter((it) => it.type === type && it.slug === r.slug)) await rm(pending(x), { recursive: true, force: true })
    if (stateReadable) await disk(async () => {
      const others = items.filter((x) => x.type === type && x.slug === r.slug && x.id !== r.id)
      const reset = (x: Entry): Entry => ({ ...x, pendingVersion: undefined, pendingRollback: undefined, phase: 'idle', error: undefined })
      let next = items.map((x) => others.includes(x) ? reset(x) : x)
      if (m && !others.length) {
        const before = next.find((x) => x.id === r.id)
        const entry: Entry = {
          ...before, id: r.id, name: r.name || before?.name || r.slug, type, slug: r.slug, installedVersion: m.version, phase: 'current',
          pendingVersion: undefined, pendingRollback: undefined, error: undefined,
          // Still pinned after a manual install: the pin follows what is installed until auto-update is resumed.
          pinnedVersion: r.pinned || before?.pinnedVersion ? m.version : undefined,
        }
        next = [...next.filter((x) => x.id !== r.id), entry]
      }
      await write(next); items = next
    })
    // The copy made before the install was spared as "current"; now that the new version is live, trim to 2.
    await prune(type, r.slug).catch(() => {})
    await refresh().catch(() => {}); emit()
  }

  /** Swap the installed package with a kept version. Market plugins become pinned at that version. */
  async function rollback(type: string, slug: string, version: string): Promise<PluginRollbackResult> {
    if (!pluginType(type) || !isSafeSlug(slug) || !isKeepableVersion(version)) throw new Error('rollback: invalid target')
    const target = dest({ type, slug }), store = storeDir(type, slug), stored = join(store, version)
    const x = items.find((it) => it.type === type && it.slug === slug)
    const old = await manifest(type, target)
    if (compareMarketVersions(old.version, version) === 0) throw new Error('rollback: already installed')
    const next = await manifest(type, stored).catch(() => { throw new Error('rollback: version not kept') })
    if (next.version !== version || next.id !== old.id) throw new Error('install: plugin identity changed')
    assertCompatible(type, next)
    // Persist the pin (and drop any staged update) before touching the live folder, so no later check undoes it.
    const before = x ? { pinnedVersion: x.pinnedVersion } : null
    if (x) {
      if (!x.pendingRollback) await rm(pending(x), { recursive: true, force: true })
      await patch(x.id, { pinnedVersion: version, ...(x.pendingRollback ? {} : { pendingVersion: undefined, phase: 'current' as const }), error: undefined })
    }
    const aside = join(store, `.swap-${randomUUID()}`)
    let deferred = false
    try {
      try { await rename(target, aside) } catch (e) {
        // Windows: a loaded native module keeps the folder busy. Stage it and swap at the next launch.
        if (!x || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
        deferred = true
      }
      if (!deferred) {
        try { await rename(stored, target) } catch (e) { await rename(aside, target); throw e }
      } else {
        // Publish a complete copy under the pending name; the previous staged package stays until then.
        const tmp = `${pending(x!)}.rb-${randomUUID()}`, prev = `${pending(x!)}.old-${randomUUID()}`
        await mkdir(join(root, type), { recursive: true })
        try {
          await cp(stored, tmp, { recursive: true, verbatimSymlinks: true })
          let had = false
          try { await rename(pending(x!), prev); had = true } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
          try {
            await rename(tmp, pending(x!))
            await patch(x!.id, { pendingVersion: version, pendingRollback: true, phase: 'staged' })
          } catch (e) {
            await rm(pending(x!), { recursive: true, force: true }).catch(() => {})
            if (had) await rename(prev, pending(x!)).catch(() => {})
            throw e
          }
          if (had) await rm(prev, { recursive: true, force: true }).catch(() => {})
        } finally { await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
      }
    } catch (e) {
      if (x && before) await patch(x.id, { pinnedVersion: before.pinnedVersion }).catch(() => {})
      throw e
    }
    if (!deferred) {
      if (x) await patch(x.id, { installedVersion: version, pendingVersion: undefined, pendingRollback: undefined, phase: 'current' })
      // A failed move leaves `.swap-*` in the store; startup files it as a kept version.
      await stash(type, slug, aside, old.version).catch((e) => console.warn('[market-updates] keep replaced version:', errorText(e)))
      if (x?.pendingRollback) await rm(pending(x), { recursive: true, force: true }).catch(() => {})
    }
    await refresh().catch(() => {}); emit()
    return { ok: true, type, slug, version, ...(deferred ? { deferred } : {}) }
  }

  /** Hand-copied plugins: keep a copy of each version that shows up, so a later replacement can be undone. */
  async function keepLocalVersions(): Promise<void> {
    // Store installs from before this state file are not "hand-copied": recognise them first so they are not copied.
    if (stateReadable) await discover().catch((e) => console.warn('[market-updates] discover:', errorText(e)))
    await refresh()
    for (const x of local) await copyIntoStore(x.type, x.slug, dest(x), x.version).catch((e) => console.warn('[market-updates] keep local version:', errorText(e)))
    await refresh(); emit()
  }

  /** Manual installation/uninstallation shares the same package mutation queue as automatic downloads. */
  async function forget(type: string, slug: string, remove = true): Promise<void> {
    const hits = items.filter((x) => x.type === type && x.slug === slug)
    for (const x of hits) await rm(pending(x), { recursive: true, force: true })
    if (remove && pluginType(type) && isSafeSlug(slug)) await rm(storeDir(type, slug), { recursive: true, force: true })
    if (hits.length && stateReadable) await disk(async () => {
      const next = remove ? items.filter((x) => !hits.some((h) => h.id === x.id)) : items.map((x) => hits.some((h) => h.id === x.id) ? { ...x, pendingVersion: undefined, pendingRollback: undefined, phase: 'idle' as const, error: undefined } : x)
      await write(next); items = next
    })
    await refresh().catch(() => {}); emit()
  }
  return { init, snapshot, setAutoUpdate, setAutoUpdateAll, check, exclusive, forget, keepBeforeInstall, recordInstall, rollback, keepLocalVersions, refresh: () => refresh().then(emit) }
}
