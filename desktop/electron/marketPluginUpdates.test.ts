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
