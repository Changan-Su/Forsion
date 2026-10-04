// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import type { CorePluginUpdates } from '../../../shared/corePlugins'
const mock = vi.hoisted(() => ({ core: { checking: false, items: [] } as CorePluginUpdates, notify: vi.fn(), dismiss: vi.fn() }))
vi.mock('./CorePluginUpdates', () => ({ useCorePluginUpdates: () => mock.core }))
vi.mock('../stores/notificationStore', () => ({ notifyApp: mock.notify, useNotifications: { getState: () => ({ dismiss: mock.dismiss }) } }))
const { RestartUpdateButton, readyUpdateNames } = await import('./RestartUpdateButton')
const { LocaleProvider } = await import('../i18n')
let root: Root, host: HTMLElement
let emitApp: (state: any) => void
let emitMarket: (state: any) => void
const ready = { id: 'forsion-extend', packageName: '@forsion/extend', phase: 'staged' as const, installedVersion: '0.7.0', pendingVersion: '0.7.1' }
const render = () => act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(RestartUpdateButton, { expanded: true }) })))
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  mock.core = { checking: false, items: [] }; mock.notify.mockReset(); mock.dismiss.mockReset()
  window.tangu = { restartForUpdate: vi.fn(async () => ({ ok: false })), onUpdaterStatus: (fn: (state: any) => void) => { emitApp = fn; return () => {} }, onMarketUpdateStatus: (fn: (state: any) => void) => { emitMarket = fn; return () => {} } } as any
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.tangu })
it('only appears for ready updates and notifies once per version even after a failed recheck', async () => {
  await render(); expect(host.querySelector('button')).toBeNull()
  mock.core = { checking: false, items: [ready] }; await render()
  expect(host.textContent).toContain('重启更新'); expect(mock.notify).toHaveBeenCalledTimes(1)
  mock.core = { checking: true, items: [{ ...ready, phase: 'checking' }] }; await render()
  expect(host.querySelector('button')).not.toBeNull()
  mock.core = { checking: false, items: [{ ...ready, phase: 'error' }] }; await render()
  expect(mock.notify).toHaveBeenCalledTimes(1)
  mock.core = { checking: false, items: [{ ...ready, pendingVersion: '0.7.2' }] }; await render()
  expect(mock.notify).toHaveBeenCalledTimes(2)
})
it('cancelling restart retains the action; notification action uses the same guarded bridge', async () => {
  mock.core.items = [ready]; await render()
  await act(async () => host.querySelector('button')!.click())
  expect(window.tangu!.restartForUpdate).toHaveBeenCalledTimes(1)
  expect(host.querySelector('button')!.disabled).toBe(false)
  await act(async () => mock.notify.mock.calls[0][0].action.run())
  expect(window.tangu!.restartForUpdate).toHaveBeenCalledTimes(2)
})
it('also handles a downloaded app and removes the action when nothing is pending', async () => {
  await render(); await act(async () => emitApp({ phase: 'available', version: '3.0.0' }))
  expect(host.querySelector('button')).toBeNull()
  await act(async () => emitApp({ phase: 'downloaded', version: '3.0.0' }))
  expect(host.querySelector('button')).not.toBeNull()
  expect(readyUpdateNames({ checking: false, items: [ready] }, { phase: 'downloaded', version: '3.0.0' })).toEqual(['Forsion 3.0.0', 'Forsion Extend 0.7.1'])
  await act(async () => emitApp({ phase: 'idle' }))
  expect(host.querySelector('button')).toBeNull()
})
it('marketplace staging uses the shared restart action and survives failed rechecks', async () => {
  await render()
  const item = { id: 'market-id', name: 'Market Plugin', type: 'plugin', slug: 'market-plugin', autoUpdate: true, phase: 'staged', pendingVersion: '1.1.0' }
  await act(async () => emitMarket({ checking: false, items: [item] }))
  expect(host.querySelector('button')).not.toBeNull(); expect(mock.notify.mock.calls[0][0].text).toContain('Market Plugin 1.1.0')
  await act(async () => emitMarket({ checking: false, items: [{ ...item, phase: 'error' }] }))
  expect(mock.notify).toHaveBeenCalledTimes(1)
  await act(async () => host.querySelector('button')!.click()); expect(window.tangu!.restartForUpdate).toHaveBeenCalledTimes(1)
})
