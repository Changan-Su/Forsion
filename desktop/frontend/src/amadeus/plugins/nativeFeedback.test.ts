// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeChromeHost, dispatchNativeChromeAction, nativeChromeState } from '@lcl/engine'
import { usePluginStore } from './pluginStore'
import type { PluginContext } from './types'

vi.mock('../api', () => ({ amadeus: undefined }))
let off: (() => void) | undefined
afterEach(() => { usePluginStore.getState().disable('feedback-probe'); off?.(); off = undefined })
function setup(): PluginContext {
  localStorage.removeItem('amadeus.plugins.disabled')
  let ctx: PluginContext | undefined
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id: 'feedback-probe', name: 'Probe', version: '1', setup: (c) => { ctx = c } }])
  return ctx!
}
describe('public native feedback seam', () => {
  it('desktop/browser has no fake haptic capability', () => { expect(setup().ui?.haptic).toBeUndefined() })
  it('native ticks and header callbacks are revoked on disable', () => {
    const tick = vi.fn(), back = vi.fn()
    off = installNativeChromeHost({ render: () => {}, haptic: tick })
    const ctx = setup()
    ctx.ui!.haptic!('tick')
    expect(tick).toHaveBeenCalledExactlyOnceWith('tick')
    const header = ctx.ui!.claimHeader!({ title: 'Task', back: 'Back', onBack: back })
    expect(nativeChromeState()).toMatchObject({ mode: 'page', title: 'Task' })
    dispatchNativeChromeAction('back'); expect(back).toHaveBeenCalledTimes(1)
    usePluginStore.getState().disable('feedback-probe')
    ctx.ui!.haptic!('tick'); dispatchNativeChromeAction('back'); header.dispose()
    expect(tick).toHaveBeenCalledTimes(1); expect(back).toHaveBeenCalledTimes(1)
    expect(nativeChromeState().mode).not.toBe('page')
  })
})
