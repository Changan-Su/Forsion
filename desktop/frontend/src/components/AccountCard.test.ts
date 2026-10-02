// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@lcl/engine', () => ({ OverlayAt: ({ children }: any) => React.createElement('div', {}, children) }))
vi.mock('../achievements/store', () => ({ track: vi.fn() }))
const { AccountCard } = await import('./AccountCard')
const { LocaleProvider } = await import('../i18n')
const { usePluginStore } = await import('../amadeus/plugins/pluginStore')
const originalPlugins = usePluginStore.getState()

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
  usePluginStore.setState({ activeIds: ['forsion-extend'], settingsViews: [{ pluginId: 'forsion-extend', item: { id: 'backpack', category: 'forsion', mount() {} } }] })
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
  usePluginStore.setState({ activeIds: originalPlugins.activeIds, settingsViews: originalPlugins.settingsViews })
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

const QUOTA = { dailyLimit: 1000, dailyRemaining: 4, dailyPercent: 99.6, weeklyLimit: 1000, weeklyRemaining: 725, weeklyPercent: 27.5, weeklyResetAt: '2026-10-05', resetCards: 2 }

// 09-29:额度详情与用卡回到菜单(09-28 曾收进设置页,用户要回)。收起一行摘要,点开看各项、用卡、升级、去「额度与积分」。
it('expands the AI quota row into today, this week, a reset card, upgrade and the quota page', async () => {
  const { useApp } = await import('../stores/appStore')
  const openSettings = vi.fn()
  useApp.setState({ openSettings } as any)
  ;(window.tangu as any).cloudInvoke = vi.fn()
  window.tangu!.openPayCenter = vi.fn() as any
  window.tangu!.accountUseResetCard = vi.fn() as any
  window.tangu!.accountQuota = vi.fn().mockResolvedValue({ status: 200, json: QUOTA }) as any
  await mount()
  await click('Alice')
  await tick()
  expect(document.body.textContent).toContain('今日 <1% · 本周 72%') // 统一口径:剩 0.4% 写 <1%
  expect(document.querySelector('[data-testid="account-quota-detail"]')).toBeNull()
  await click('AI 额度')
  const detail = document.querySelector('[data-testid="account-quota-detail"]')!
  expect(detail.textContent).toContain('<1%')
  expect(detail.textContent).toContain('72%')
  expect(detail.textContent).toContain('10/5 重置')
  expect(detail.textContent).toContain('使用额度重置卡（2 张）')
  expect(detail.textContent).toContain('升级会员')
  expect(document.body.textContent).not.toContain('今日 <1% · 本周 72%') // 展开后摘要收起,每个数字只出现一次
  await click('升级会员')
  expect(window.tangu!.openPayCenter).toHaveBeenCalledOnce()
  await click('Alice')
  await tick()
  await click('AI 额度')
  await click('额度与积分')
  expect(openSettings).toHaveBeenLastCalledWith('forsion/fx:forsion-extend:quota')
  await click('Alice')
  await tick()
  await click('背包')
  expect(openSettings).toHaveBeenLastCalledWith('forsion/fx:forsion-extend:backpack')
  await click('Alice')
  await tick()
  await act(async () => { document.querySelector<HTMLElement>('.ap-head--link')!.click() })
  expect(openSettings).toHaveBeenLastCalledWith('forsion/fx:forsion-extend:account')
})

it('uses a reset card only on the second click and plays the ceremony', async () => {
  window.tangu!.accountQuota = vi.fn().mockResolvedValue({ status: 200, json: QUOTA }) as any
  window.tangu!.accountUseResetCard = vi.fn().mockResolvedValue({
    status: 200, json: { success: true, resetCards: 1, quota: { dailyLimit: 1000, dailyRemaining: 1000, weeklyLimit: 1000, weeklyRemaining: 1000 } },
  }) as any
  const published: unknown[] = []
  const onQuota = (e: Event) => published.push((e as CustomEvent).detail)
  window.addEventListener('tangu:account-quota', onQuota)
  await mount()
  await click('Alice')
  await tick()
  await click('AI 额度')
  await click('使用额度重置卡')
  expect(window.tangu!.accountUseResetCard).not.toHaveBeenCalled()
  await click('再点一次确认使用')
  await tick()
  expect(window.tangu!.accountUseResetCard).toHaveBeenCalledWith('both')
  expect(document.querySelector('.account-pop')).toBeNull() // 用完关菜单
  const dialog = document.querySelector('.reset-ceremony[role="dialog"]')!
  expect(dialog.textContent).toContain('额度已焕新')
  expect(dialog.textContent).toContain('<1%')
  expect(dialog.textContent).toContain('100%')
  expect(dialog.textContent).toContain('额度重置卡剩余 1 张')
  expect(published.at(-1)).toMatchObject({ dailyRemaining: 1000, resetCards: 1 })
  window.removeEventListener('tangu:account-quota', onQuota)
  await click('继续使用')
  await tick()
  expect(document.querySelector('.reset-ceremony')).toBeNull()
})

// Codex 评审 P1:用卡在途时关掉再开菜单(开菜单会作废在途请求代次),原来回包被丢 → 不弹动画、菜单还是旧张数,
// 用户照旧张数再点就多耗一张。现在只在换了账号时丢。负对照:结果守卫改回 quotaRequest → 红
it('keeps the reset card result when the menu is closed and reopened while it is in flight', async () => {
  let settle!: (v: any) => void
  window.tangu!.accountQuota = vi.fn().mockResolvedValue({ status: 200, json: QUOTA }) as any
  window.tangu!.accountUseResetCard = vi.fn(() => new Promise((r) => { settle = r })) as any
  await mount()
  await click('Alice')
  await tick()
  await click('AI 额度')
  await click('使用额度重置卡')
  await click('再点一次确认使用')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(document.querySelector('.account-pop')).toBeNull()
  await click('Alice') // 重开:额度 GET 又发一次,还按旧张数
  await tick()
  await click('AI 额度')
  const pending = [...document.querySelectorAll<HTMLButtonElement>('.ap-sub-item')].find((b) => b.textContent?.includes('使用额度重置卡'))
  expect(pending?.disabled).toBe(true) // 在途期间锁着,不能再点一次
  await act(async () => { settle({ status: 200, json: { success: true, resetCards: 1, quota: { dailyLimit: 1000, dailyRemaining: 1000, weeklyLimit: 1000, weeklyRemaining: 1000 } } }) })
  await tick()
  expect(document.querySelector('.reset-ceremony[role="dialog"]')?.textContent).toContain('额度重置卡剩余 1 张')
  expect(window.tangu!.accountUseResetCard).toHaveBeenCalledOnce()
  await click('继续使用')
  await tick()
})

it('says so when the reset card could not be used, without a ceremony', async () => {
  window.tangu!.accountQuota = vi.fn().mockResolvedValue({ status: 200, json: QUOTA }) as any
  window.tangu!.accountUseResetCard = vi.fn().mockResolvedValue({ status: 400, json: { error: 'no_reset_card' } }) as any
  await mount()
  await click('Alice')
  await tick()
  await click('AI 额度')
  await click('使用额度重置卡')
  await click('再点一次确认使用')
  await tick()
  expect(onToast).toHaveBeenCalledWith('没有可用的额度重置卡', true)
  expect(document.querySelector('.reset-ceremony')).toBeNull()
})

it('does not offer the Forsion Cloud pages where Extend is not loaded (device page, old host)', async () => {
  window.tangu!.accountQuota = vi.fn().mockResolvedValue({ status: 200, json: { dailyLimit: 100, dailyRemaining: 50, weeklyLimit: 100, weeklyRemaining: 50 } }) as any
  await mount() // 没有 cloudInvoke
  await click('Alice')
  await tick()
  expect(document.querySelector('.ap-head--link')).toBeNull()
  expect(document.body.textContent).not.toContain('背包')
  expect(document.body.textContent).toContain('今日 50% · 本周 50%')
  await click('AI 额度')
  expect(document.querySelector('[data-testid="account-quota-detail"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('额度与积分')
  expect(document.body.textContent).not.toContain('使用额度重置卡') // 没有 accountUseResetCard 桥
})

it('waits for the backpack page contribution when an older Extend is loaded', async () => {
  ;(window.tangu as any).cloudInvoke = vi.fn()
  usePluginStore.setState({ settingsViews: [] })
  await mount()
  await click('Alice')
  await tick()
  expect(document.body.textContent).not.toContain('背包')
  await act(async () => usePluginStore.setState({ settingsViews: [{ pluginId: 'forsion-extend', item: { id: 'backpack', category: 'forsion', mount() {} } }] }))
  expect(document.body.textContent).toContain('背包')
  await act(async () => usePluginStore.setState({ activeIds: [] }))
  expect(document.body.textContent).not.toContain('背包')
})

it('opens the contributed backpack page from the account menu', async () => {
  const { useApp } = await import('../stores/appStore')
  const openSettings = vi.fn()
  useApp.setState({ openSettings } as any)
  ;(window.tangu as any).cloudInvoke = vi.fn()
  await mount()
  await click('Alice')
  await click('背包')
  expect(openSettings).toHaveBeenCalledWith('forsion/fx:forsion-extend:backpack')
})
