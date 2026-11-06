import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { createMarketPluginUpdater, type MarketUpdateItem } from './marketPluginUpdates'
import { compareMarketVersions, type MarketPluginType } from '../shared/marketPluginUpdates'
import { MARKET_MANIFEST, marketItemDir } from './marketInstall'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true }))) })
async function fixture(type: MarketPluginType = 'amadeus-plugin') {
  const home = await mkdtemp(join(tmpdir(), 'market-updates-test-')); homes.push(home)
  const item: MarketUpdateItem = { id: 'market-id', name: 'Test Plugin', type, installSlug: 'test-plugin', latestVersion: '1.1.0' }
  const target = marketItemDir(home, type, item.installSlug)!
  const manifest = { id: 'different-id', version: '1.0.0', apiVersion: 1, ...(type === 'plugin' ? { entry: 'main.js' } : {}) }
  await mkdir(target, { recursive: true }); await writeFile(join(target, MARKET_MANIFEST[type][0]), JSON.stringify(manifest)); await writeFile(join(target, 'main.js'), 'old')
  let offered: Record<string, unknown> = { ...manifest, version: '1.1.0' }
  const lookup = vi.fn(async (_id: string) => ({ ...item })), download = vi.fn(async (_item: MarketUpdateItem) => new JSZip().file(MARKET_MANIFEST[type][0], JSON.stringify(offered)).file('main.js', 'new').generateAsync({ type: 'nodebuffer' }))
  const options = { home, appVersion: '2.12.1', protectedIds: () => new Set<string>(), lookup, download, broadcast: vi.fn() }
  const updater = createMarketPluginUpdater(options); await updater.init()
  return { home, item, target, updater, options, lookup, download, offer: (next: Record<string, unknown>) => { offered = next } }
}
it.each(['plugin', 'amadeus-plugin'] as const)('opt-in %s updates stage once, preserve active code and apply on the next startup', async (type) => {
  const f = await fixture(type)
  await f.updater.check(); expect(f.download).not.toHaveBeenCalled()
  await mkdir(join(f.home, 'plugins-data')); await writeFile(join(f.home, 'plugins-data', 'different-id.json'), '{"enabled":false,"secret":"kept"}')
  await writeFile(join(f.home, 'config.json'), '{"plugins":{"global":{"different-id":{"__enabled":false}}}}')
  await f.updater.setAutoUpdate(f.item.id, true)
  const a = f.updater.check(), b = f.updater.check(); expect(a).toBe(b); await a
  expect(f.download).toHaveBeenCalledTimes(1)
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old')
  expect(f.updater.snapshot().items[0]).toMatchObject({ autoUpdate: true, phase: 'staged', pendingVersion: '1.1.0' })
  await f.updater.check(); expect(f.download).toHaveBeenCalledTimes(1)
  const next = createMarketPluginUpdater(f.options); await next.init()
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('new')
  expect(next.snapshot().items[0]).toMatchObject({ autoUpdate: true, installedVersion: '1.1.0' }); expect(next.snapshot().items[0].pendingVersion).toBeUndefined()
  expect(await readFile(join(f.home, 'plugins-data', 'different-id.json'), 'utf8')).toContain('kept')
  expect(await readFile(join(f.home, 'config.json'), 'utf8')).toContain('"__enabled":false')
})
it('turning off persists and prevents future downloads', async () => {
  const f = await fixture(); await f.updater.setAutoUpdate(f.item.id, true); await f.updater.setAutoUpdate(f.item.id, false)
  const next = createMarketPluginUpdater(f.options); await next.init(); await next.check()
  expect(next.snapshot().items[0].autoUpdate).toBe(false); expect(f.download).not.toHaveBeenCalled()
})
it('disabling during a download prevents publishing it', async () => {
  const f = await fixture(); await f.updater.setAutoUpdate(f.item.id, true)
  const original = f.options.download
  let release!: () => void, started!: () => void
  const start = new Promise<void>((r) => { started = r }), pause = new Promise<void>((r) => { release = r })
  f.options.download = vi.fn(async (item) => { started(); await pause; return original(item) })
  const run = f.updater.check(); await start; await f.updater.setAutoUpdate(f.item.id, false); release(); await run
  expect(f.updater.snapshot().items[0]).toMatchObject({ autoUpdate: false, phase: 'idle' }); expect(f.updater.snapshot().items[0].pendingVersion).toBeUndefined()
})
it('an opt-in added while another download is running is checked in the same run', async () => {
  const f = await fixture(); await f.updater.setAutoUpdate(f.item.id, true)
  const second = { ...f.item, id: 'second-market-id', installSlug: 'second-plugin' }
  const target = marketItemDir(f.home, second.type, second.installSlug)!
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'manifest.json'), '{"id":"different-id","version":"1.0.0"}'); await writeFile(join(target, 'main.js'), 'old')
  f.options.lookup = vi.fn(async (id: string) => id === second.id ? second : f.item)
  const original = f.options.download
  let release!: () => void, started!: () => void
  const start = new Promise<void>((r) => { started = r }), pause = new Promise<void>((r) => { release = r })
  f.options.download = vi.fn(async (item) => { if (item.id === f.item.id) { started(); await pause }; return original(item) })
  const run = f.updater.check(); await start; await f.updater.setAutoUpdate(second.id, true); release(); await run
  expect(f.updater.snapshot().items.filter((x) => x.pendingVersion === '1.1.0')).toHaveLength(2)
})
it.each([
  { id: 'another-plugin', version: '1.1.0' },
  { id: 'different-id', version: '1.1.0', apiVersion: 99 },
  { id: 'different-id', version: '1.1.0', minAppVersion: '9.0.0' },
  { id: 'different-id', version: '1.0.9' },
  { id: 'different-id', version: '1.1.0', main: 'missing.js' },
])('rejects an invalid update and leaves the installed package usable: %j', async (offered) => {
  const f = await fixture(); f.offer(offered); await f.updater.setAutoUpdate(f.item.id, true); await f.updater.check()
  expect(f.updater.snapshot().items[0].phase).toBe('error'); expect(f.updater.snapshot().items[0].pendingVersion).toBeUndefined()
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old')
})
it('failed rechecks retain a previously staged version and recover on retry', async () => {
  const f = await fixture(); await f.updater.setAutoUpdate(f.item.id, true); await f.updater.check()
  f.lookup.mockRejectedValueOnce(new Error('offline')); await f.updater.check()
  expect(f.updater.snapshot().items[0]).toMatchObject({ phase: 'error', pendingVersion: '1.1.0', error: 'offline' })
  await f.updater.check(); expect(f.updater.snapshot().items[0].phase).toBe('staged')
})
it('uninstall clearing removes the preference and pending package; deleted plugins are never resurrected', async () => {
  const f = await fixture(); await f.updater.setAutoUpdate(f.item.id, true); await f.updater.check()
  await f.updater.exclusive(async () => { await rm(f.target, { recursive: true }); await f.updater.forget(f.item.type, f.item.installSlug) })
  const next = createMarketPluginUpdater(f.options); await next.init(); await next.check()
  expect(next.snapshot().items).toEqual([]); await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('startup rejects a tampered pending identity and restores interrupted package activation', async () => {
  const f = await fixture(); await f.updater.setAutoUpdate(f.item.id, true); await f.updater.check()
  const pending = join(f.home, '.market-updates', f.item.type, f.item.installSlug)
  await writeFile(join(pending, 'manifest.json'), '{"id":"impostor","version":"1.1.0"}')
  await rename(f.target, join(f.home, '.market-updates', f.item.type, '.test-plugin.previous'))
  const next = createMarketPluginUpdater(f.options); await next.init()
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old'); expect(next.snapshot().items[0].phase).toBe('error')
})
it('core packages, uninstalled items, non-plugin content and linked dev roots cannot opt in', async () => {
  const f = await fixture(); f.options.protectedIds = () => new Set(['different-id'])
  await expect(f.updater.setAutoUpdate(f.item.id, true)).rejects.toThrow('protected')
  f.options.protectedIds = () => new Set(); f.item.type = 'skill'
  await expect(f.updater.setAutoUpdate(f.item.id, true)).rejects.toThrow('not a market plugin')
  f.item.type = 'amadeus-plugin'; await rename(f.target, `${f.target}-dev`); await symlink(`${f.target}-dev`, f.target)
  await expect(f.updater.setAutoUpdate(f.item.id, true)).rejects.toThrow('protected')
})
it('version comparison rejects unknown versions and respects prerelease order', () => {
  expect(compareMarketVersions('HEAD', '1.0.0')).toBeNull()
  expect(compareMarketVersions('1.1.0-rc.2', '1.1.0-rc.1')).toBe(1)
  expect(compareMarketVersions('1.1.0', '1.1.0-rc.2')).toBe(1)
  expect(compareMarketVersions('v1.1.0+build', '1.1.0')).toBe(0)
  expect(compareMarketVersions('1.0.0', '2.0.0')).toBe(-1)
})

// ── 11-06: default on, global switch, version store, rollback and pin ──
async function installed(home: string, type: MarketPluginType, slug: string, manifest: Record<string, unknown>, body = 'code') {
  const dir = marketItemDir(home, type, slug)!
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true })
  await writeFile(join(dir, MARKET_MANIFEST[type][0]), JSON.stringify(manifest)); await writeFile(join(dir, 'main.js'), body)
  return dir
}
const kept = (home: string, type: MarketPluginType, slug: string, version: string) => join(home, '.plugin-versions', type, slug, version)
async function catalogFixture() {
  const f = await fixture()
  const options = { ...f.options, catalog: vi.fn(async () => [{ ...f.item }, { id: 'other', name: 'Other', type: 'skill', installSlug: 'test-plugin' }]) }
  const updater = createMarketPluginUpdater(options); await updater.init()
  return { ...f, options, updater }
}
it('default on: a store install without its own choice is found through the catalog and updated', async () => {
  const f = await catalogFixture()
  await f.updater.check()
  expect(f.download).toHaveBeenCalledTimes(1)
  expect(f.updater.snapshot()).toMatchObject({ autoUpdateAll: true, items: [{ id: 'market-id', autoUpdate: true, pendingVersion: '1.1.0' }] })
  expect(f.updater.snapshot().items[0].autoUpdateChoice).toBeUndefined()
})
it('an explicit per-plugin off from an older build stays off; the global switch only moves plugins without a choice', async () => {
  const f = await fixture()
  await mkdir(join(f.home, '.market-updates'), { recursive: true })
  await writeFile(join(f.home, '.market-updates', 'state.json'), JSON.stringify({ items: [{ id: 'market-id', name: 'Test', type: 'amadeus-plugin', slug: 'test-plugin', autoUpdate: false, phase: 'idle' }] }))
  const a = createMarketPluginUpdater(f.options); await a.init(); await a.check()
  expect(a.snapshot().items[0]).toMatchObject({ autoUpdate: false, autoUpdateChoice: false }); expect(f.download).not.toHaveBeenCalled()
  const g = await catalogFixture(); await g.updater.setAutoUpdateAll(false); await g.updater.check()
  expect(g.download).not.toHaveBeenCalled(); expect(g.updater.snapshot().items[0]).toMatchObject({ autoUpdate: false })
  const again = createMarketPluginUpdater(g.options); await again.init(); expect(again.snapshot().autoUpdateAll).toBe(false)
  await again.setAutoUpdateAll(true); await again.check(); expect(g.download).toHaveBeenCalledTimes(1)
})
it('an unreadable state file is not rewritten from defaults', async () => {
  const f = await fixture()
  await mkdir(join(f.home, '.market-updates'), { recursive: true }); await writeFile(join(f.home, '.market-updates', 'state.json'), '{"items":[{"id":')
  const u = createMarketPluginUpdater({ ...f.options, catalog: async () => [f.item] })
  await expect(u.init()).rejects.toThrow(); await u.check()
  expect(f.download).not.toHaveBeenCalled(); expect(await readFile(join(f.home, '.market-updates', 'state.json'), 'utf8')).toBe('{"items":[{"id":')
})
it('an applied update keeps the old version; rollback swaps it back, pins, and resuming auto-update releases the pin', async () => {
  const f = await catalogFixture(); await f.updater.check()
  const next = createMarketPluginUpdater(f.options); await next.init()
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('new')
  expect(await readFile(join(kept(f.home, 'amadeus-plugin', 'test-plugin', '1.0.0'), 'main.js'), 'utf8')).toBe('old')
  expect(next.snapshot().items[0].keptVersions).toMatchObject([{ version: '1.0.0', compatible: true }])
  const r = await next.rollback('amadeus-plugin', 'test-plugin', '1.0.0')
  expect(r).toEqual({ ok: true, type: 'amadeus-plugin', slug: 'test-plugin', version: '1.0.0' })
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old')
  expect(next.snapshot().items[0]).toMatchObject({ pinnedVersion: '1.0.0', autoUpdate: false, installedVersion: '1.0.0', keptVersions: [{ version: '1.1.0', compatible: true }] })
  await next.check(); expect(f.download).toHaveBeenCalledTimes(1) // pinned: no download
  await next.setAutoUpdateAll(true); await next.check(); expect(f.download).toHaveBeenCalledTimes(1) // the global switch does not unpin
  await next.setAutoUpdate('market-id', true); expect(next.snapshot().items[0].pinnedVersion).toBeUndefined()
  await next.check(); expect(f.download).toHaveBeenCalledTimes(2)
})
it('pinning by installing an older version drops an update staged before it', async () => {
  const f = await catalogFixture(); await f.updater.check()
  expect(f.updater.snapshot().items[0].pendingVersion).toBe('1.1.0')
  await f.updater.exclusive(() => f.updater.recordInstall({ id: 'market-id', type: 'amadeus-plugin', slug: 'test-plugin', pinned: true }))
  expect(f.updater.snapshot().items[0]).toMatchObject({ pinnedVersion: '1.0.0', autoUpdate: false }); expect(f.updater.snapshot().items[0].pendingVersion).toBeUndefined()
  await expect(lstat(join(f.home, '.market-updates', 'amadeus-plugin', 'test-plugin'))).rejects.toMatchObject({ code: 'ENOENT' })
  const next = createMarketPluginUpdater(f.options); await next.init()
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old')
})
it('a staged update is discarded at startup when the plugin was pinned after it was downloaded', async () => {
  const f = await catalogFixture(); await f.updater.check()
  const state = JSON.parse(await readFile(join(f.home, '.market-updates', 'state.json'), 'utf8'))
  state.items[0].pinnedVersion = '1.0.0'
  await writeFile(join(f.home, '.market-updates', 'state.json'), JSON.stringify(state))
  const next = createMarketPluginUpdater(f.options); await next.init()
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old'); expect(next.snapshot().items[0].pendingVersion).toBeUndefined()
})
it('manual installs keep the replaced version, the store keeps the two most recent, and uninstall removes it', async () => {
  const f = await catalogFixture()
  for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
    await f.updater.exclusive(() => f.updater.keepBeforeInstall('amadeus-plugin', 'test-plugin', `${v}-next`))
    await installed(f.home, 'amadeus-plugin', 'test-plugin', { id: 'different-id', version: `${v}-next` }, v)
    await new Promise((r) => setTimeout(r, 15))
  }
  await f.updater.exclusive(() => f.updater.recordInstall({ id: 'market-id', type: 'amadeus-plugin', slug: 'test-plugin', pinned: false }))
  expect(f.updater.snapshot().items[0].keptVersions!.map((v) => v.version)).toEqual(['1.2.0-next', '1.1.0-next'])
  await f.updater.exclusive(() => f.updater.forget('amadeus-plugin', 'test-plugin'))
  await expect(lstat(join(f.home, '.plugin-versions', 'amadeus-plugin', 'test-plugin'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('a kept version this Forsion cannot run is listed as incompatible and refused', async () => {
  const f = await catalogFixture()
  await mkdir(kept(f.home, 'amadeus-plugin', 'test-plugin', '0.9.0'), { recursive: true })
  await writeFile(join(kept(f.home, 'amadeus-plugin', 'test-plugin', '0.9.0'), 'manifest.json'), JSON.stringify({ id: 'different-id', version: '0.9.0', minAppVersion: '9.0.0' }))
  await writeFile(join(kept(f.home, 'amadeus-plugin', 'test-plugin', '0.9.0'), 'main.js'), 'ancient')
  await f.updater.check(); await f.updater.refresh()
  expect(f.updater.snapshot().items[0].keptVersions).toMatchObject([{ version: '0.9.0', compatible: false }])
  await expect(f.updater.rollback('amadeus-plugin', 'test-plugin', '0.9.0')).rejects.toThrow('incompatible')
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old')
})
it('hand-copied plugins keep each version they show and can roll back; linked dev roots and core packages are left alone', async () => {
  const f = await fixture()
  const dir = await installed(f.home, 'amadeus-plugin', 'hand-made', { id: 'hand-made', version: '1.0.0' }, 'v1')
  await installed(f.home, 'amadeus-plugin', 'core-pkg', { id: 'core-pkg', version: '1.0.0' })
  await mkdir(join(f.home, 'dev-src'), { recursive: true }); await writeFile(join(f.home, 'dev-src', 'manifest.json'), '{"id":"dev","version":"1.0.0"}'); await writeFile(join(f.home, 'dev-src', 'main.js'), 'x')
  await symlink(join(f.home, 'dev-src'), marketItemDir(f.home, 'amadeus-plugin', 'dev')!)
  const u = createMarketPluginUpdater({ ...f.options, protectedIds: () => new Set(['core-pkg']) }); await u.init()
  await u.exclusive(() => u.keepLocalVersions())
  await installed(f.home, 'amadeus-plugin', 'hand-made', { id: 'hand-made', version: '1.1.0' }, 'v2')
  await u.exclusive(() => u.keepLocalVersions())
  expect(u.snapshot().local.map((x) => x.slug).sort()).toEqual(['hand-made', 'test-plugin'])
  expect(u.snapshot().local.find((x) => x.slug === 'hand-made')).toMatchObject({ version: '1.1.0', keptVersions: [{ version: '1.0.0', compatible: true }] })
  await expect(lstat(join(f.home, '.plugin-versions', 'amadeus-plugin', 'dev'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(f.home, '.plugin-versions', 'amadeus-plugin', 'core-pkg'))).rejects.toMatchObject({ code: 'ENOENT' })
  await u.exclusive(() => u.rollback('amadeus-plugin', 'hand-made', '1.0.0'))
  expect(await readFile(join(dir, 'main.js'), 'utf8')).toBe('v1')
  expect(u.snapshot().local.find((x) => x.slug === 'hand-made')).toMatchObject({ version: '1.0.0', keptVersions: [{ version: '1.1.0', compatible: true }] })
})
it('startup puts back a live folder left mid-rollback, and files a finished one as a kept version', async () => {
  const f = await fixture()
  const store = join(f.home, '.plugin-versions', 'amadeus-plugin', 'test-plugin')
  await mkdir(store, { recursive: true }); await rename(f.target, join(store, '.swap-crash'))
  const a = createMarketPluginUpdater(f.options); await a.init()
  expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe('old')
  await installed(f.home, 'amadeus-plugin', 'stray', { id: 'stray', version: '2.0.0' }, 'live')
  const strayStore = join(f.home, '.plugin-versions', 'amadeus-plugin', 'stray'); await mkdir(join(strayStore, '.swap-done'), { recursive: true })
  await writeFile(join(strayStore, '.swap-done', 'manifest.json'), '{"id":"stray","version":"2.1.0"}'); await writeFile(join(strayStore, '.swap-done', 'main.js'), 'replaced')
  const b = createMarketPluginUpdater(f.options); await b.init()
  expect(await readFile(join(strayStore, '2.1.0', 'main.js'), 'utf8')).toBe('replaced')
  expect(b.snapshot().local.find((x) => x.slug === 'stray')?.keptVersions).toMatchObject([{ version: '2.1.0' }])
})
it('a normal reinstall keeps the plugin pinned (at the version now installed)', async () => {
  const f = await catalogFixture()
  await f.updater.exclusive(() => f.updater.recordInstall({ id: 'market-id', type: 'amadeus-plugin', slug: 'test-plugin', pinned: true }))
  await installed(f.home, 'amadeus-plugin', 'test-plugin', { id: 'different-id', version: '1.0.5' })
  await f.updater.exclusive(() => f.updater.recordInstall({ id: 'market-id', type: 'amadeus-plugin', slug: 'test-plugin', pinned: false }))
  expect(f.updater.snapshot().items[0]).toMatchObject({ pinnedVersion: '1.0.5', autoUpdate: false })
})
