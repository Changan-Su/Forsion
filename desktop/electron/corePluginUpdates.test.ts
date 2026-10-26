import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCorePluginUpdater, prefetchOnFirstBoot } from './corePluginUpdates'
import { isCorePlugin, type CorePluginUpdates } from '../shared/corePlugins'

describe('core plugin update coordination', () => {
  it('joins concurrent manual/timer checks and preserves per-package results', async () => {
    let finish!: () => void
    const wait = new Promise<void>((resolve) => { finish = resolve })
    const statuses: CorePluginUpdates[] = []
    const run = vi.fn(async (report) => { await wait; report({ id: 'forsion-extend', packageName: '@forsion/extend', phase: 'staged', installedVersion: '1.0.0', pendingVersion: '1.1.0' }) })
    const updater = createCorePluginUpdater({ items: [{ id: 'forsion-extend', packageName: '@forsion/extend', phase: 'idle' }], enabled: true, run, broadcast: (s) => statuses.push(s) })
    const a = updater.check(), b = updater.check()
    expect(a).toBe(b)
    expect(updater.snapshot().checking).toBe(true)
    finish(); await a
    expect(run).toHaveBeenCalledTimes(1)
    expect(updater.snapshot()).toMatchObject({ checking: false, items: [{ phase: 'staged', pendingVersion: '1.1.0' }] })
    statuses[0].items[0].phase = 'error'
    expect(updater.snapshot().items[0].phase).toBe('staged')
  })
  it('surfaces an outer failure and allows retry', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
    const updater = createCorePluginUpdater({ items: [{ id: 'x', packageName: 'x', phase: 'idle' }], enabled: true, run, broadcast: () => {} })
    await updater.check()
    expect(updater.snapshot()).toMatchObject({ checking: false, items: [{ phase: 'error', error: 'offline' }] })
    await updater.check(); expect(run).toHaveBeenCalledTimes(2)
  })
  it('does not download into a development installation', async () => {
    const run = vi.fn()
    const updater = createCorePluginUpdater({ items: [{ id: 'x', packageName: 'x', phase: 'idle' }], enabled: false, run, broadcast: () => {} })
    await updater.check()
    expect(run).not.toHaveBeenCalled()
    expect(updater.snapshot().items[0].phase).toBe('development')
  })
  it('keeps a verified pending update visible while the next network check starts', async () => {
    const statuses: any[] = []
    const updater = createCorePluginUpdater({
      items: [{ id: 'x', packageName: 'x', phase: 'staged', installedVersion: '1.0.0', pendingVersion: '1.1.0' }],
      enabled: true, broadcast: (s) => statuses.push(s),
      run: async (report) => { report({ id: 'x', packageName: 'x', phase: 'checking' }); throw new Error('offline') },
    })
    await updater.check()
    expect(statuses.every((s) => s.items[0].pendingVersion === '1.1.0')).toBe(true)
    expect(updater.snapshot().items[0].phase).toBe('error')
  })
  it('classifies only trusted host core bundles', () => {
    expect(isCorePlugin({ id: 'forsion-extend', builtin: true })).toBe(true)
    expect(isCorePlugin({ id: 'forsion-extend', preinstalled: true })).toBe(true)
    expect(isCorePlugin({ id: 'forsion-extend' })).toBe(false)
    expect(isCorePlugin({ id: 'word-count', builtin: true })).toBe(false)
  })
})

describe('first-boot prefetch', () => {
  const marker = async (): Promise<string> => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'core-prefetch-')), 'core-prefetch-version')

  it('checks once per app version, then skips', async () => {
    const file = await marker()
    const check = vi.fn().mockResolvedValue(undefined)
    expect(await prefetchOnFirstBoot({ markerFile: file, version: '2.13.9', timeoutMs: 1000, check })).toBe('done')
    expect(await prefetchOnFirstBoot({ markerFile: file, version: '2.13.9', timeoutMs: 1000, check })).toBe('skipped')
    expect(check).toHaveBeenCalledTimes(1)
    expect(await prefetchOnFirstBoot({ markerFile: file, version: '2.13.10', timeoutMs: 1000, check })).toBe('done') // upgraded
    expect(check).toHaveBeenCalledTimes(2)
  })
  it('stops waiting at the deadline and still records the version (offline users do not wait again)', async () => {
    const file = await marker()
    const started = Date.now()
    expect(await prefetchOnFirstBoot({ markerFile: file, version: '2.13.9', timeoutMs: 50, check: () => new Promise(() => {}) })).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(await fs.readFile(file, 'utf8')).toBe('2.13.9')
  })
  it('a failed check counts as done', async () => {
    expect(await prefetchOnFirstBoot({ markerFile: await marker(), version: '2.13.9', timeoutMs: 1000, check: () => Promise.reject(new Error('offline')) })).toBe('done')
  })
  it('reset clears a staged result that seeding already applied', async () => {
    const updater = createCorePluginUpdater({
      items: [{ id: 'x', packageName: 'x', phase: 'idle' }], enabled: true, broadcast: () => {},
      run: async (report) => { report({ id: 'x', packageName: 'x', phase: 'staged', installedVersion: '1.0.0', pendingVersion: '1.1.0' }) },
    })
    await updater.check()
    updater.reset()
    expect(updater.snapshot().items).toEqual([{ id: 'x', packageName: 'x', phase: 'idle' }])
  })
  it('drops reports from a run that started before reset, then re-checks from current disk state', async () => {
    let finish!: () => void
    const wait = new Promise<void>((resolve) => { finish = resolve })
    const run = vi.fn()
      .mockImplementationOnce(async (report) => { await wait; report({ id: 'x', packageName: 'x', phase: 'staged', installedVersion: '1.0.0', pendingVersion: '1.1.0' }) })
      .mockImplementationOnce(async (report) => { report({ id: 'x', packageName: 'x', phase: 'current', installedVersion: '1.1.0' }) })
    const updater = createCorePluginUpdater({ items: [{ id: 'x', packageName: 'x', phase: 'idle' }], enabled: true, broadcast: () => {}, run })
    const stale = updater.check() // first-boot prefetch timed out; seeding applied 1.1.0 meanwhile
    updater.reset()
    finish(); await stale
    expect(updater.snapshot().items[0].phase).not.toBe('staged')
    await vi.waitFor(() => expect(updater.snapshot()).toMatchObject({ checking: false, items: [{ phase: 'current', installedVersion: '1.1.0' }] }))
    expect(run).toHaveBeenCalledTimes(2)
  })
})
