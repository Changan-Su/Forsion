// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ uiMode: 'desktop' as string, presenter: undefined as unknown }))
vi.mock('@lcl/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@lcl/engine')>()
  return {
    ...real,
    get UI_MODE() { return engine.uiMode },
    nativeSheetPresenter: () => engine.presenter,
  }
})
const { unitPanelAvailable } = await import('./AccountUnitSection')
const { useUnitRoster } = await import('./unitRoster')

const desktop = () => ({ unitsList: vi.fn(), unitHostStatus: vi.fn() })

beforeEach(() => {
  engine.uiMode = 'desktop'
  engine.presenter = undefined
  history.replaceState(null, '', '/')
})
afterEach(() => { delete (window as any).tangu })

describe('unitPanelAvailable', () => {
  it('real desktop main window → yes', () => {
    window.tangu = desktop() as any
    expect(unitPanelAvailable()).toBe(true)
  })
  it('web entry (no device bridges, public entry) → no', () => {
    window.tangu = { authStatus: vi.fn(), unitPublicEntry: true } as any
    expect(unitPanelAvailable()).toBe(false)
    window.tangu = { authStatus: vi.fn() } as any
    expect(unitPanelAvailable()).toBe(false)
  })
  it('device page, phone shell, single-column UI, Android native sheet → no', () => {
    window.tangu = { ...desktop(), unitPage: true } as any
    expect(unitPanelAvailable()).toBe(false)
    window.tangu = { ...desktop(), mobile: true } as any
    expect(unitPanelAvailable()).toBe(false)
    window.tangu = desktop() as any
    engine.uiMode = 'mobile'
    expect(unitPanelAvailable()).toBe(false)
    engine.uiMode = 'desktop'
    engine.presenter = () => true
    expect(unitPanelAvailable()).toBe(false)
  })
  it('detached / floating / mini windows → no', () => {
    window.tangu = desktop() as any
    for (const kind of ['detached', 'floating', 'mini']) {
      history.replaceState(null, '', `/?window=${kind}&id=x`)
      expect(unitPanelAvailable()).toBe(false)
    }
  })
})

describe('useUnitRoster', () => {
  const units = [{ id: 'a', name: 'A', platform: 'darwin', icon: null, online: true, lanUrl: 'http://10.0.0.2:8791' }]
  beforeEach(() => useUnitRoster.getState().clear())

  it('keeps the cached roster when a refresh fails (read failure is not empty)', async () => {
    window.tangu = { unitsList: vi.fn().mockResolvedValue({ status: 200, json: { units } }), unitHostStatus: vi.fn().mockResolvedValue({ unitId: 'me' }), unitsProbeLan: vi.fn().mockResolvedValue({ instanceId: 'i', name: 'A' }) } as any
    await useUnitRoster.getState().refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(useUnitRoster.getState()).toMatchObject({ units, hostUnitId: 'me', lanOk: { a: true } })
    ;(window.tangu as any).unitsList = vi.fn().mockRejectedValue(new Error('offline'))
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toEqual(units)
    ;(window.tangu as any).unitsList = vi.fn().mockResolvedValue({ status: 502, json: null })
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toEqual(units)
  })

  it('401 → signed out (null); no roster bridge → only this computer ([])', async () => {
    window.tangu = { unitsList: vi.fn().mockResolvedValue({ status: 401, json: null }) } as any
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toBeNull()
    window.tangu = { unitHostStatus: vi.fn().mockResolvedValue({ unitId: null }) } as any
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toEqual([])
  })
})
