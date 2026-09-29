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

it('shows working sign-in and sign-out actions for a minimal Unit without unavailable account services', async () => {
  delete window.tangu!.accountQuota
  delete window.tangu!.authAccounts
  delete window.tangu!.forsionSwitchAccount
  await mount()
  await click('Alice')
  await tick()
  expect(document.body.textContent).not.toContain('额度剩余')
  expect(document.body.textContent).not.toContain('邀请好友')
  expect(document.body.textContent).not.toContain('用户中心')
  expect(document.body.textContent).toContain('登录其他账号')
  expect(document.querySelector<HTMLButtonElement>('.ap-danger')).not.toBeNull()
  await click('登录其他账号')
  expect(window.tangu!.forsionLogin).toHaveBeenCalledOnce()
  await click('Alice')
  await act(async () => { document.querySelector<HTMLButtonElement>('.ap-danger')!.click() })
  expect(window.tangu!.forsionLogout).toHaveBeenCalledOnce()
})

// 2026-09-28:菜单只留四样(头部 → 账号页、一行 AI 额度摘要 → 额度与积分、切换账号、退出登录);
// 升级 / 重置卡 / 邀请 / 网页个人中心都收进「Forsion 云端」里 Extend 画的页,菜单里不再各放一份。
it('keeps four things in the menu and sends account and quota to the Forsion Cloud pages', async () => {
  const { useApp } = await import('../stores/appStore')
  const openSettings = vi.fn()
  useApp.setState({ openSettings } as any)
  ;(window.tangu as any).cloudInvoke = vi.fn()
  window.tangu!.openAccountCenter = vi.fn() as any
  window.tangu!.openPayCenter = vi.fn() as any
  window.tangu!.accountQuota = vi.fn().mockResolvedValue({
    status: 200,
    json: { dailyLimit: 1000, dailyRemaining: 4, dailyPercent: 99.6, weeklyLimit: 1000, weeklyRemaining: 725, weeklyPercent: 27.5, resetCards: 2 },
  }) as any
  await mount()
  await click('Alice')
  await tick()
  const text = document.body.textContent || ''
  expect(text).toContain('今日 <1% · 本周 72%') // 统一口径:剩 0.4% 写 <1%(原来菜单写 0%)
  for (const gone of ['额度剩余', '邀请好友', '用户中心', '升级会员', '重置卡']) expect(text).not.toContain(gone)
  await click('AI 额度')
  expect(openSettings).toHaveBeenLastCalledWith('forsion/fx:forsion-extend:quota')
  await click('Alice')
  await tick()
  await act(async () => { document.querySelector<HTMLElement>('.ap-head--link')!.click() })
  expect(openSettings).toHaveBeenLastCalledWith('forsion/fx:forsion-extend:account')
})

it('does not offer the Forsion Cloud pages where Extend is not loaded (device page, old host)', async () => {
  window.tangu!.accountQuota = vi.fn().mockResolvedValue({ status: 200, json: { dailyLimit: 100, dailyRemaining: 50, weeklyLimit: 100, weeklyRemaining: 50 } }) as any
  await mount() // 没有 cloudInvoke
  await click('Alice')
  await tick()
  expect(document.querySelector('.ap-head--link')).toBeNull()
  const quotaRow = [...document.querySelectorAll<HTMLButtonElement>('.ap-item')].find((b) => b.textContent?.includes('AI 额度'))
  expect(quotaRow?.disabled).toBe(true)
  expect(quotaRow?.textContent).toContain('今日 50% · 本周 50%')
})
