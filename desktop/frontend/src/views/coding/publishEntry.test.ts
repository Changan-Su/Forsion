// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginStore } from '../../amadeus/plugins/pluginStore'
import { EXTEND_PLUGIN_ID, EXTEND_PUBLISH_COMMAND, extendPublishCommand, runPublish } from './publishEntry'

const TARGET = { root: '/projects/quiz', projectName: 'quiz', entry: 'index.html', htmlFiles: ['index.html', 'about.html'] }
const plugin = (id: string, locked = true) => ({ id, name: id, version: '1.0.0', locked }) as never

function seed(opts: { run?: (args?: Record<string, unknown>) => void | Promise<void>; active?: boolean; locked?: boolean; owner?: string } = {}) {
  const owner = opts.owner ?? EXTEND_PLUGIN_ID
  usePluginStore.setState({
    plugins: [plugin(EXTEND_PLUGIN_ID, opts.locked ?? true), plugin('someone-else', false)],
    activeIds: opts.active === false ? [] : [EXTEND_PLUGIN_ID, 'someone-else'],
    commands: opts.run ? [{ pluginId: owner, item: { id: EXTEND_PUBLISH_COMMAND, title: 'Publish', run: opts.run } }] : [],
  } as never)
}
const io = () => ({ openHostDialog: vi.fn(), setExtendOpen: vi.fn() })

beforeEach(() => { Object.defineProperty(window, 'tangu', { configurable: true, value: { connectPublish: vi.fn() } }) })
afterEach(() => { usePluginStore.setState({ plugins: [], activeIds: [], commands: [] } as never); delete (window as { tangu?: unknown }).tangu })

describe('Coding Studio publish entry', () => {
  it('Extend command present: runs it with the project and keeps the preview hidden until the dialog closes', async () => {
    let close!: () => void
    const run = vi.fn(() => new Promise<void>((resolve) => { close = resolve }))
    seed({ run })
    const h = io()
    const done = runPublish(TARGET, h)
    await Promise.resolve()
    expect(run).toHaveBeenCalledWith({ root: '/projects/quiz', projectName: 'quiz', entry: 'index.html', htmlFiles: ['index.html', 'about.html'] })
    expect(h.setExtendOpen).toHaveBeenLastCalledWith(true)
    close()
    expect(await done).toBe('extend')
    expect(h.setExtendOpen).toHaveBeenLastCalledWith(false)
    expect(h.openHostDialog).not.toHaveBeenCalled()
  })

  it('no Extend command (bundled Extend is older): opens the host dialog exactly as before', async () => {
    seed()
    const h = io()
    expect(await runPublish({ ...TARGET, entry: null }, h)).toBe('host')
    expect(h.openHostDialog).toHaveBeenCalledTimes(1)
    expect(h.setExtendOpen).not.toHaveBeenCalled()
  })

  it('ignores the command when Extend is disabled, not the locked first-party bundle, or registered by another plugin', () => {
    const run = vi.fn()
    seed({ run, active: false }); expect(extendPublishCommand()).toBeNull()
    seed({ run, locked: false }); expect(extendPublishCommand()).toBeNull()
    seed({ run, owner: 'someone-else' }); expect(extendPublishCommand()).toBeNull()
    seed({ run }); expect(extendPublishCommand()?.run).toBe(run)
  })

  it('a failing Extend command falls back to the host dialog; neither path available does nothing', async () => {
    seed({ run: () => Promise.reject(new Error('boom')) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = io()
    expect(await runPublish(TARGET, h)).toBe('host')
    expect(h.setExtendOpen.mock.calls).toEqual([[true], [false]])
    expect(h.openHostDialog).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    delete (window as { tangu?: unknown }).tangu
    seed()
    const h2 = io()
    expect(await runPublish(TARGET, h2)).toBe('none')
    expect(h2.openHostDialog).not.toHaveBeenCalled()
  })
})
