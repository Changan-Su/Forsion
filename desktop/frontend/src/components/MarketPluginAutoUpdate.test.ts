// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AutoUpdateAllRow, PinnedChip, PluginVersionBlock } from './MarketPluginAutoUpdate'
import { LocaleProvider } from '../i18n'
import type { KeptPluginVersion, MarketPluginUpdate } from '../../../shared/marketPluginUpdates'
let host: HTMLElement, root: Root
const onError = vi.fn(), onRollback = vi.fn(async (_v: string) => {})
const entry: MarketPluginUpdate = { id: 'market-id', type: 'amadeus-plugin', slug: 'test', name: 'Test', autoUpdate: true, phase: 'idle', installedVersion: '1.3.0' }
const kept: KeptPluginVersion[] = [{ version: '1.2.1', compatible: true, keptAt: Date.UTC(2026, 9, 11) }, { version: '0.9.0', compatible: false }]
const mount = (el: React.ReactElement) => act(async () => root.render(React.createElement(LocaleProvider, { children: el })))
const block = (props: Partial<React.ComponentProps<typeof PluginVersionBlock>> = {}) =>
  mount(React.createElement(PluginVersionBlock, { id: entry.id, item: entry, kept, autoUpdateAll: true, onError, onRollback, ...props }))
const sw = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); onError.mockReset(); onRollback.mockClear()
  window.tangu = { marketSetAutoUpdate: vi.fn(async () => ({})), marketSetAutoUpdateAll: vi.fn(async () => ({})) } as any
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.tangu })

it('auto-update is on by default, sends the per-plugin choice and shows a staged version', async () => {
  await block({ item: undefined })
  expect(sw().getAttribute('aria-checked')).toBe('true')
  await block({ item: { ...entry, phase: 'staged', pendingVersion: '1.4.2' } })
  expect(host.textContent).toContain('已安装 v1.3.0'); expect(host.textContent).toContain('v1.4.2 已下载，重启后启用')
  await act(async () => sw().click()); expect(window.tangu!.marketSetAutoUpdate).toHaveBeenCalledWith(entry.id, false)
})
it('kept versions roll back; an incompatible one is disabled; a newer kept one reads "switch back"', async () => {
  await block({ item: { ...entry, installedVersion: '1.2.1', pinnedVersion: '1.2.1', autoUpdate: false }, kept: [{ version: '1.3.0', compatible: true }, ...kept.slice(1)] })
  expect(host.textContent).toContain('已固定在 v1.2.1，不会自动更新。')
  const [back, old] = host.querySelectorAll<HTMLButtonElement>('[data-plugin-rollback]')
  expect(back.textContent).toBe('换回'); expect(old.disabled).toBe(true); expect(host.textContent).toContain('需要更新的 Forsion')
  await act(async () => back.click()); expect(onRollback).toHaveBeenCalledWith('1.3.0')
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '恢复自动更新')!.click())
  expect(window.tangu!.marketSetAutoUpdate).toHaveBeenCalledWith(entry.id, true)
})
it('hand-copied plugins show only the kept versions, without a switch', async () => {
  await block({ id: undefined, item: undefined, installedVersion: '1.3.0' })
  expect(host.querySelector('[role="switch"]')).toBeNull(); expect(host.querySelectorAll('[data-plugin-rollback]')).toHaveLength(2)
  expect(host.textContent).not.toContain('「版本」页')
  await block({ id: undefined, item: undefined, kept: [] }); expect(host.querySelector('.pvb')).toBeNull()
})
it('a failed save keeps the previous state and reports it', async () => {
  window.tangu!.marketSetAutoUpdate = vi.fn(async () => { throw new Error('disk full') })
  await block(); await act(async () => sw().click())
  expect(sw().getAttribute('aria-checked')).toBe('true'); expect(sw().disabled).toBe(false)
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('disk full'))
})
it('the pinned chip shows only when pinned; the global switch sends its value', async () => {
  await mount(React.createElement(PinnedChip, { item: entry })); expect(host.textContent).toBe('')
  await mount(React.createElement(PinnedChip, { item: { ...entry, pinnedVersion: '1.2.1' } })); expect(host.textContent).toBe('已固定 v1.2.1')
  await mount(React.createElement(AutoUpdateAllRow, { state: { checking: false, autoUpdateAll: true, items: [], local: [] }, onError }))
  expect(host.textContent).toContain('自动更新所有插件'); await act(async () => sw().click())
  expect(window.tangu!.marketSetAutoUpdateAll).toHaveBeenCalledWith(false)
})
