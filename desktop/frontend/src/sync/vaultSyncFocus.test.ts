// 智库同步 H3 清单第 8 件:主窗切回前台时告诉 Extend(vaultsync:run {reason:'focus'},契约 step34 E3L-2)。
// 节流在 Extend(1 分钟);宿主每次 focus 都发,但只主窗、只 v2 完整模式。老 Extend / 兼容 / Extend 不在不发,出错不报。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncMode, type SyncUiMode } from './v2/mode'
import { ensureVaultSyncSubscribed, kickVaultSyncOnFocus } from './vaultSyncStore'

const invoke = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, value: null }))
let focusListeners: Array<() => void> = []

function stubWindow(search = ''): void {
  vi.stubGlobal('location', { search })
  vi.stubGlobal('window', {
    tangu: { cloudInvoke: invoke },
    addEventListener: (type: string, fn: () => void) => { if (type === 'focus') focusListeners.push(fn) },
  })
}
const setMode = (mode: SyncUiMode): void => useSyncMode.setState({ mode, compatReason: undefined, error: undefined })
const focusRuns = (): unknown[][] => invoke.mock.calls.filter((c) => c[0] === 'vaultsync:run')

beforeEach(() => { invoke.mockClear(); focusListeners = []; stubWindow() })
afterEach(() => { vi.unstubAllGlobals(); setMode('unknown') })

describe('telling Extend the main window came back', () => {
  it('main window + full mode → vaultsync:run { reason: "focus" }, every time (Extend throttles)', async () => {
    setMode('full')
    kickVaultSyncOnFocus()
    kickVaultSyncOnFocus()
    await Promise.resolve()
    expect(focusRuns()).toEqual([['vaultsync:run', { reason: 'focus' }], ['vaultsync:run', { reason: 'focus' }]])
  })

  it('not full mode (old Extend, compat, Extend absent, not asked yet, unreadable) → nothing is sent', () => {
    for (const mode of ['legacy', 'off', 'unknown', 'unreadable'] as const) {
      setMode(mode)
      kickVaultSyncOnFocus()
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('other windows (detached / mini / floating / pip) do not send', () => {
    setMode('full')
    for (const kind of ['detached', 'mini', 'floating', 'pip']) {
      stubWindow(`?window=${kind}&id=x`)
      kickVaultSyncOnFocus()
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('the channel going away (Extend downgraded) is silent: no throw, no log', async () => {
    setMode('full')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'cloud:invoke': Error: vaultsync:run is not a Forsion Extend channel"))
    expect(() => kickVaultSyncOnFocus()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    err.mockRestore(); warn.mockRestore()
  })

  it('wired into the store: a focus event on the main window sends it', async () => {
    invoke.mockImplementation(async () => ({ ok: false, error: 'not a Forsion Extend channel' }))
    ensureVaultSyncSubscribed()
    expect(focusListeners.length).toBeGreaterThan(0)
    invoke.mockClear()
    setMode('full')
    for (const fn of focusListeners) fn()
    await Promise.resolve()
    expect(focusRuns()).toEqual([['vaultsync:run', { reason: 'focus' }]])
  })
})
