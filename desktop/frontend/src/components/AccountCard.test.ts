// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@lcl/engine', () => ({ OverlayAt: ({ children }: any) => React.createElement('div', {}, children) }))
vi.mock('../achievements/store', () => ({ track: vi.fn() }))
const { AccountCard } = await import('./AccountCard')
const { LocaleProvider } = await import('../i18n')

let host: HTMLDivElement
let root: Root
const alice = { loggedIn: true, tokenValid: true, username: 'Alice' }
const signedOut = { loggedIn: false }
const onToast = vi.fn()
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
function click(text: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((el) => el.textContent?.includes(text))
  expect(button, `Missing action: ${text}`).toBeTruthy()
  return act(async () => { button!.click() })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  onToast.mockReset()
  window.tangu = {
    authStatus: vi.fn().mockResolvedValue(alice),
    authAccounts: vi.fn().mockResolvedValue([
      { id: 'a', username: 'Alice', cloudUrl: 'https://example.test', active: true },
      { id: 'b', username: 'Bob', cloudUrl: 'https://example.test', active: false },
    ]),
    forsionSwitchAccount: vi.fn().mockResolvedValue({ ok: true, cloudUrl: 'https://example.test' }),
    forsionLogin: vi.fn().mockResolvedValue({ ok: true, cloudUrl: 'https://example.test' }),
    forsionLogout: vi.fn().mockResolvedValue({ ok: true }),
    accountQuota: vi.fn().mockResolvedValue({ status: 200, json: {} }),
  } as any
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
})
async function mount() {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(AccountCard, { onToast }) })))
  await tick()
}

it('offers saved accounts and an explicit login for another account', async () => {
  await mount()
  await click('Alice')
  await tick()
  await click('Bob')
  expect(window.tangu!.forsionSwitchAccount).toHaveBeenCalledWith('b')
  expect(window.tangu!.forsionLogin).not.toHaveBeenCalled()
})

it('does not let a delayed auth refresh restore the signed-out account card', async () => {
  await mount()
  let resolveOld!: (value: any) => void
  vi.mocked(window.tangu!.authStatus!).mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue(signedOut as any)
  const logout = host.querySelector<HTMLButtonElement>('.account-logout')!
  await act(async () => { logout.click() })
  await tick()
  await act(async () => { resolveOld(alice) })
  expect(host.textContent).not.toContain('Alice')
})

it('reports a failed sign out instead of silently claiming success', async () => {
  await mount()
  vi.mocked(window.tangu!.forsionLogout!).mockRejectedValue(new Error('Cannot clear credentials'))
  await act(async () => { host.querySelector<HTMLButtonElement>('.account-logout')!.click() })
  await tick()
  expect(onToast).toHaveBeenCalledWith(expect.stringContaining('Cannot clear credentials'), true)
})
