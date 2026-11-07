// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reloadWindow } from './reloadWindow'

const reload = vi.fn()
const setBridge = (bridge: object): void => { (window as unknown as { tangu?: object }).tangu = bridge }
const realLocation = window.location

function stubLocation(): void {
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } })
}

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  delete (window as { tangu?: unknown }).tangu
  reload.mockReset()
})

describe('reloadWindow', () => {
  it('asks the main process when the desktop bridge is there (location.reload is blocked on file: pages)', () => {
    stubLocation()
    const viaHost = vi.fn(() => Promise.resolve())
    setBridge({ reloadWindow: viaHost })
    reloadWindow()
    expect(viaHost).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })
  it('falls back to location.reload on web / mobile, where there is no bridge', () => {
    stubLocation()
    setBridge({ platform: 'darwin' })
    reloadWindow()
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('falls back to location.reload if the bridge call fails', async () => {
    stubLocation()
    setBridge({ reloadWindow: () => Promise.reject(new Error('no handler')) })
    reloadWindow()
    await Promise.resolve()
    await Promise.resolve()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
