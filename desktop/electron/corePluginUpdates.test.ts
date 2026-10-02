import { describe, it, expect, vi } from 'vitest'
import { createCorePluginUpdater } from './corePluginUpdates'
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
