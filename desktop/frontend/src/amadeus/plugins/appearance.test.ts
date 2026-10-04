// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../api', () => ({ amadeus: undefined }))
import { usePluginStore } from './pluginStore'
import { useAppearance, updateAppearance, clearPluginAppearance } from '../../appearance/store'
import { DEFAULT_APPEARANCE, APPEARANCE_KEY } from '../../../../shared/startupAppearance'
import type { PluginContext } from './types'
const image = 'data:image/png;base64,aGVsbG8='
let ctx: PluginContext
beforeEach(() => {
  localStorage.clear()
  useAppearance.setState({ value: { ...DEFAULT_APPEARANCE }, presets: [] })
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
})
afterEach(() => { for (const id of [...usePluginStore.getState().activeIds]) usePluginStore.getState().disable(id) })
function init(fail = false) {
  usePluginStore.getState().init([{ id: 'appearance-probe', name: 'Appearance', version: '1', setup(c) {
    ctx = c
    c.registerAppearance!({ id: 'blue', label: 'Blue', icon: image })
    if (fail) throw new Error('failed setup')
  } }])
}
describe('plugin appearance lifecycle', () => {
  it('registers choices without selecting; disable removes choices and cached assets, stale ctx cannot resurrect them', async () => {
    init()
    expect(useAppearance.getState().presets).toHaveLength(1)
    expect(useAppearance.getState().value.icon).toBeNull()
    await updateAppearance({ icon: { id: 'plugin:appearance-probe:blue', pluginId: 'appearance-probe', label: 'Blue', image } })
    usePluginStore.getState().disable('appearance-probe')
    expect(useAppearance.getState().presets).toHaveLength(0)
    expect(useAppearance.getState().value.icon).toBeNull()
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!).icon).toBeNull()
    ctx.registerAppearance!({ id: 'stale', label: 'Stale', icon: image })
    expect(useAppearance.getState().presets).toHaveLength(0)
  })
  it('a replaced registration cannot be removed by an old disposer; setup errors revoke contributions', () => {
    init()
    const dispose = ctx.registerAppearance!({ id: 'blue', label: 'Old', icon: image })
    ctx.registerAppearance!({ id: 'blue', label: 'New', icon: image })
    dispose()
    expect(useAppearance.getState().presets[0].label).toBe('New')
    usePluginStore.getState().disable('appearance-probe')
    usePluginStore.setState({ initialized: false })
    localStorage.clear()
    init(true)
    expect(useAppearance.getState().presets).toHaveLength(0)
  })
  it('disabling a plugin also clears the artwork of the dependents it takes down', async () => {
    const update = vi.fn().mockResolvedValue(DEFAULT_APPEARANCE)
    const previous = window.tangu
    window.tangu = { startupAppearance: { update } } as any
    try {
      usePluginStore.getState().init([
        { id: 'base', name: 'Base', version: '1', setup() {} },
        { id: 'skin', name: 'Skin', version: '1', requiresPlugins: [{ id: 'base' }], setup(c) { c.registerAppearance!({ id: 'blue', label: 'Blue', icon: image }) } },
      ])
      expect(usePluginStore.getState().activeIds).toEqual(expect.arrayContaining(['base', 'skin']))
      usePluginStore.getState().disable('base')
      await Promise.resolve()
      expect(usePluginStore.getState().activeIds).not.toContain('skin')
      expect(update).toHaveBeenCalledWith({}, 'skin')
    } finally { window.tangu = previous }
  })
  it('a setup failure in a satellite window leaves the app-wide artwork alone', async () => {
    const update = vi.fn().mockResolvedValue(DEFAULT_APPEARANCE)
    const previous = window.tangu
    window.tangu = { startupAppearance: { update } } as any
    const url = location.href
    try {
      history.replaceState(null, '', '?window=mini')
      // Its own id: a setup that already failed is not retried, which would leave this half with nothing to observe.
      usePluginStore.getState().init([{ id: 'mini-probe', name: 'Mini', version: '1', setup: () => { throw new Error('failed setup') } }])
      await Promise.resolve()
      expect(usePluginStore.getState().lastSetupError['mini-probe']).toContain('failed setup')
      expect(update).not.toHaveBeenCalled()
      history.replaceState(null, '', url)
      usePluginStore.getState().enable('mini-probe') // an explicit retry, now in the main window, still cleans up
      await Promise.resolve()
      expect(update).toHaveBeenCalledWith({}, 'mini-probe')
    } finally { history.replaceState(null, '', url); window.tangu = previous }
  })
  it('storage failure preserves the previous selection', async () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    await expect(updateAppearance({ showSplash: false })).rejects.toThrow('quota')
    expect(useAppearance.getState().value.showSplash).toBe(true)
    spy.mockRestore()
  })
  it('cleanup reaches the native writer even before another window selection becomes visible', async () => {
    const previous = window.tangu
    const update = vi.fn().mockResolvedValue(DEFAULT_APPEARANCE)
    window.tangu = { startupAppearance: { update } } as any
    try {
      clearPluginAppearance('appearance-probe')
      await Promise.resolve()
      expect(update).toHaveBeenCalledWith({}, 'appearance-probe')
    } finally { window.tangu = previous }
  })
  it('a local change merges a newer persisted choice even before its storage event', async () => {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, icon: { id: 'upload', label: 'Other tab', image } }))
    await updateAppearance({ showSplash: false })
    expect(useAppearance.getState().value.icon?.label).toBe('Other tab')
    expect(useAppearance.getState().value.showSplash).toBe(false)
  })
})
