// 智库同步 H3 清单第 8 件:主窗切回前台时告诉 Extend(vaultsync:run {reason:'focus'},契约 step34 E3L-2)。
// 执行与节流都归 Extend(1 分钟)。宿主只看两件事:是不是主窗、这条通道在不在(Codex P2:不按界面模式判,模式没问出来也发)。
// 通道不在(老 Extend / Extend 没装载)第一次就记住、以后不发;出错不报、不记日志。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncUiMode } from './v2/mode'

const invoke = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, value: null }))
let focusListeners: Array<() => void> = []
type Store = typeof import('./vaultSyncStore')
type Mode = typeof import('./v2/mode')
let store: Store
let mode: Mode

function stubWindow(search = '', withInvoke = true): void {
  vi.stubGlobal('location', { search })
  vi.stubGlobal('window', {
    tangu: withInvoke ? { cloudInvoke: invoke } : {},
    addEventListener: (type: string, fn: () => void) => { if (type === 'focus') focusListeners.push(fn) },
  })
}
const setMode = (m: SyncUiMode): void => mode.useSyncMode.setState({ mode: m, compatReason: undefined, error: undefined })
const focusRuns = (): unknown[][] => invoke.mock.calls.filter((c) => c[0] === 'vaultsync:run')
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  invoke.mockReset()
  invoke.mockImplementation(async () => ({ ok: true, value: null }))
  focusListeners = []
  stubWindow()
  vi.resetModules()
  store = await import('./vaultSyncStore')
  mode = await import('./v2/mode')
})
afterEach(() => { vi.unstubAllGlobals() })

describe('telling Extend the main window came back', () => {
  it('main window → vaultsync:run { reason: "focus" } every time, whatever the UI mode is (Extend decides and throttles)', async () => {
    for (const m of ['full', 'unknown', 'legacy', 'unreadable', 'off'] as const) {
      setMode(m)
      store.kickVaultSyncOnFocus()
    }
    await settle()
    expect(focusRuns()).toHaveLength(5)
    expect(focusRuns().every((c) => JSON.stringify(c) === JSON.stringify(['vaultsync:run', { reason: 'focus' }]))).toBe(true)
  })

  it('other windows (detached / mini / floating / pip / standalone Space) do not send', () => {
    for (const kind of ['detached', 'mini', 'floating', 'pip', 'standalone']) {
      stubWindow(`?window=${kind}&id=x`)
      store.kickVaultSyncOnFocus()
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('the channel is not there (old Extend): asked once, then never again; silent', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockRejectedValue(new Error('not a Forsion Extend channel: vaultsync:run'))
    expect(() => store.kickVaultSyncOnFocus()).not.toThrow()
    await settle()
    store.kickVaultSyncOnFocus()
    store.kickVaultSyncOnFocus()
    await settle()
    expect(focusRuns()).toHaveLength(1)
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    err.mockRestore(); warn.mockRestore()
  })

  it('Extend not loaded (no cloudInvoke at all): nothing to call, nothing thrown', async () => {
    stubWindow('', false)
    expect(() => store.kickVaultSyncOnFocus()).not.toThrow()
    store.kickVaultSyncOnFocus()
    await settle()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('other failures (compat_mode from Extend, a flaky call) do not stop the next focus', async () => {
    invoke.mockImplementationOnce(async () => ({ ok: false, error: 'compat_mode' }))
    invoke.mockImplementationOnce(async () => { throw new Error('boom') })
    store.kickVaultSyncOnFocus(); await settle()
    store.kickVaultSyncOnFocus(); await settle()
    store.kickVaultSyncOnFocus(); await settle()
    expect(focusRuns()).toHaveLength(3)
  })

  it('wired into the store: a focus event on the main window sends it', async () => {
    store.ensureVaultSyncSubscribed()
    expect(focusListeners.length).toBeGreaterThan(0)
    await settle()
    invoke.mockClear()
    for (const fn of focusListeners) fn()
    await settle()
    expect(focusRuns()).toEqual([['vaultsync:run', { reason: 'focus' }]])
  })
})
