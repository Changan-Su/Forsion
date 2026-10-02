// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketPluginAutoUpdate } from './MarketPluginAutoUpdate'
import { LocaleProvider } from '../i18n'
import type { MarketPluginUpdate } from '../../../shared/marketPluginUpdates'
let host: HTMLElement, root: Root
const onError = vi.fn()
const entry: MarketPluginUpdate = { id: 'market-id', type: 'amadeus-plugin', slug: 'test', name: 'Test', autoUpdate: false, phase: 'idle' }
const render = (item = entry) => act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(MarketPluginAutoUpdate, { id: entry.id, item, onError }) })))
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); onError.mockReset()
  window.tangu = { marketSetAutoUpdate: vi.fn(async () => ({ checking: false, items: [entry] })) } as any
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.tangu })
it('defaults to off, sends the per-item option and reflects host state', async () => {
  await render(); const input = host.querySelector('input')!; expect(input.checked).toBe(false)
  await act(async () => input.click()); expect(window.tangu!.marketSetAutoUpdate).toHaveBeenCalledWith(entry.id, true)
  await render({ ...entry, autoUpdate: true, phase: 'staged', pendingVersion: '1.1.0' })
  expect(input.checked).toBe(true); expect(host.textContent).toContain('1.1.0'); expect(host.textContent).toContain('重启后启用')
  await act(async () => input.click()); expect(window.tangu!.marketSetAutoUpdate).toHaveBeenLastCalledWith(entry.id, false)
})
it('failed persistence retains the previous choice and surfaces the error', async () => {
  window.tangu!.marketSetAutoUpdate = vi.fn(async () => { throw new Error('disk full') })
  await render(); await act(async () => host.querySelector('input')!.click())
  expect(host.querySelector('input')!.checked).toBe(false); expect(host.querySelector('input')!.disabled).toBe(false)
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('disk full'))
})
