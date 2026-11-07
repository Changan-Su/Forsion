// @vitest-environment happy-dom
/** 主页「电脑历史还没开」那一行:只给跳过引导、电脑历史从没动过的人;✕ 记本机;「开启…」走同意说明。真应用里的一遍在 check:first-run。 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal, translate } from '../i18n'

vi.mock('./ComputerHistoryAbout', () => ({ ComputerHistoryAbout: () => null }))

const { ComputerHistoryAsk } = await import('./ComputerHistoryAsk')
const { CH_ASK_KEY, markChAskSkipped } = await import('./computerHistoryAskMark')

let host: HTMLDivElement
let root: Root
const view = (state: Record<string, unknown> = {}, rev = 1) => ({
  state: { v: 1, enabled: false, pausedUntil: null, status: 'off', since: 0, updatedAt: 0, platform: 'darwin', dataGen: 0, ...state },
  exclude: { apps: [], domains: [] }, root: '/Users/me/.forsion/computer-history', keepDays: 7, rev,
})
function withHistory(state: Record<string, unknown> = {}) {
  const ch = {
    get: vi.fn().mockResolvedValue(view(state)),
    setEnabled: vi.fn().mockImplementation(async (on: boolean) => view({ ...state, enabled: on, status: on ? 'no_permission' : 'off' }, 2)),
    onChanged: vi.fn().mockReturnValue(() => {}),
  }
  window.tangu = { platform: 'darwin', computerHistory: ch, desktopPermissionsStatus: vi.fn(), desktopPermissionRequest: vi.fn().mockResolvedValue({}) } as unknown as Window['tangu']
  return ch
}
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  setLocaleGlobal('zh')
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open') }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
})
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) })
async function render() {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ComputerHistoryAsk) })))
  await flush()
}
const row = () => host.querySelector('[data-ch-ask]')

it('shows nothing unless the guide was skipped', async () => {
  withHistory()
  await render()
  expect(row()).toBeNull()
})

it('skipped + untouched: the row shows, and ✕ hides it for good', async () => {
  withHistory()
  markChAskSkipped()
  await render()
  expect(row()?.textContent).toContain(translate('chAsk.title'))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-ch-ask-dismiss]')!.click())
  await flush()
  expect(row()).toBeNull()
  expect(localStorage.getItem(CH_ASK_KEY)).toBe('dismissed')
})

it('appears as soon as the guide on top is skipped (Home is already mounted underneath)', async () => {
  withHistory()
  await render()
  expect(row()).toBeNull()
  await act(async () => markChAskSkipped())
  await flush()
  expect(row()).not.toBeNull()
})

it.each([
  ['already on', { enabled: true, status: 'recording' }],
  ['turned off before', { userTurnedOff: true }],
  ['ever cleared (dataGen > 0)', { dataGen: 1 }],
  ['unsupported platform', { platform: 'linux', status: 'unsupported' }],
])('%s: no row', async (_name, state) => {
  withHistory(state)
  markChAskSkipped()
  await render()
  expect(row()).toBeNull()
})

it('no computer history on this host (web / phone): no row', async () => {
  window.tangu = { platform: 'darwin' } as unknown as Window['tangu']
  markChAskSkipped()
  await render()
  expect(row()).toBeNull()
})

it('"Turn on…" shows the consent first; agreeing turns it on and asks for Accessibility on macOS', async () => {
  const ch = withHistory()
  markChAskSkipped()
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-ch-ask-enable]')!.click())
  await flush()
  const dialog = host.querySelector('.ob-history-dialog')!
  expect(dialog.hasAttribute('open')).toBe(true)
  expect(dialog.querySelector('.ob-history-consent')?.textContent).toBe(translate('computerHistory.enableConfirm.body', { days: 7 }))
  expect(ch.setEnabled).not.toHaveBeenCalled()
  await act(async () => dialog.querySelector<HTMLButtonElement>('.ob-history-dialog-foot .btn.primary')!.click())
  await flush()
  expect(ch.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(window.tangu!.desktopPermissionRequest).toHaveBeenCalledWith('computerAccessibility', expect.objectContaining({ locale: 'zh' }))
  expect(row()).toBeNull()
})

it('cancelling the consent writes nothing and keeps the row', async () => {
  const ch = withHistory()
  markChAskSkipped()
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-ch-ask-enable]')!.click())
  await flush()
  await act(async () => host.querySelector<HTMLButtonElement>('.ob-history-dialog-foot .btn.ghost')!.click())
  await flush()
  expect(ch.setEnabled).not.toHaveBeenCalled()
  expect(host.querySelector('.ob-history-dialog')?.hasAttribute('open')).toBe(false)
  expect(row()).not.toBeNull()
  expect(localStorage.getItem(CH_ASK_KEY)).toBe('pending')
})
