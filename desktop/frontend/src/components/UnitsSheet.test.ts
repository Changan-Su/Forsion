// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOME_REF } from '@/services/engine/target'

vi.mock('@lcl/engine', () => ({ addRibbonIcon: vi.fn() }))
vi.mock('@/services/engine/targets', () => ({
  focusRef: () => HOME_REF,
  onFocusChange: () => () => {},
}))
vi.mock('@/stores/appStore', () => ({ useApp: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('@/amadeus/store/pageStore', () => ({ usePageStore: (select: (s: { vaultSide: string }) => unknown) => select({ vaultSide: 'cloud' }) }))
vi.mock('@/stores/runLocationStore', () => ({ installRunLocationChooser: vi.fn(), setDraftLocation: vi.fn() }))
vi.mock('@/services/deviceMarks', () => ({ clearDeviceSticky: vi.fn(), noteDeviceProbe: vi.fn(), noteDeviceSticky: vi.fn() }))

const mobileSource = '../../../../mobile/src/UnitsSheet'
const { MobileUnitsSheet, useUnitsSheet } = await import(mobileSource) as {
  MobileUnitsSheet: React.ComponentType
  useUnitsSheet: { getState(): { setOpen(open: boolean): void } }
}

let root: Root
let host: HTMLDivElement
const switchSide = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('tangu', { unitsList: async () => ({ status: 200, json: { units: [] } }) })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useUnitsSheet.getState().setOpen(true)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useUnitsSheet.getState().setOpen(false)
  vi.unstubAllGlobals()
})

it('leaves the Capacitor local side in the device sheet and calls its existing bridge', async () => {
  vi.stubGlobal('amadeusVaultMode', { switch: switchSide })
  await act(async () => root.render(React.createElement(MobileUnitsSheet)))
  expect(host.querySelector('[role=dialog]')?.classList.contains('mb-sheet')).toBe(true)
  expect(host.querySelector('[data-vault-row=cloud]')?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-vault-row=local]')!.click())
  expect(switchSide).toHaveBeenCalledWith('local')
  const back = new Event('forsion:mobile-back', { cancelable: true })
  await act(async () => { window.dispatchEvent(back) })
  expect(back.defaultPrevented).toBe(true)
  expect(host.querySelector('[data-units-sheet]')).toBeNull()
})

it('has no local-vault section on the web mobile shell without the Capacitor bridge', async () => {
  await act(async () => root.render(React.createElement(MobileUnitsSheet)))
  expect(host.querySelector('[data-run-on]')).toBeTruthy()
  expect(host.querySelector('[data-vault-side]')).toBeNull()
  expect(switchSide).not.toHaveBeenCalled()
})
