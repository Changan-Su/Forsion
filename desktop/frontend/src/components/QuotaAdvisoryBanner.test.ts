// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { QuotaAdvisoryBanner } from './QuotaAdvisoryBanner'

let host: HTMLDivElement
let root: Root
const onToast = vi.fn()
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  onToast.mockReset()
  window.tangu = {
    accountQuota: vi.fn().mockResolvedValue({
      status: 200,
      json: { dailyLimit: 100, dailyRemaining: 60, weeklyLimit: 100, weeklyRemaining: 8, resetCards: 2 },
    }),
    accountUseResetCard: vi.fn().mockResolvedValue({
      status: 200,
      json: {
        success: true,
        quota: { dailyLimit: 100, dailyRemaining: 100, weeklyLimit: 100, weeklyRemaining: 100 },
        resetCards: 1,
      },
    }),
    openPayCenter: vi.fn().mockResolvedValue({ ok: true }),
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

async function mount(loggedIn = true): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, {
    children: React.createElement(QuotaAdvisoryBanner, { loggedIn, onToast }),
  })))
  await tick()
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(text))
  expect(found, `Missing button: ${text}`).toBeTruthy()
  return found!
}

it('shows the tighter quota period with upgrade and reset actions', async () => {
  await mount()
  expect(host.textContent).toContain('本周托管 AI 额度即将用尽,仅剩 8%')
  expect(button('升级会员')).toBeTruthy()
  expect(button('使用重置卡 (2)')).toBeTruthy()
  await act(async () => button('升级会员').click())
  expect(window.tangu!.openPayCenter).toHaveBeenCalledOnce()
})

it('requires confirmation, then shows the restored quotas after success', async () => {
  await mount()
  await act(async () => button('使用重置卡 (2)').click())
  expect(window.tangu!.accountUseResetCard).not.toHaveBeenCalled()
  expect(host.textContent).toContain('再次点击确认')
  await act(async () => button('再次点击确认').click())
  await tick()
  expect(window.tangu!.accountUseResetCard).toHaveBeenCalledWith('both')
  expect(host.querySelector('.t2-quota-advisory')).toBeNull()
  const dialog = document.body.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('额度已焕新')
  expect(dialog?.textContent).toContain('60%')
  expect(dialog?.textContent).toContain('8%')
  expect(dialog?.textContent).toContain('100%')
  expect(dialog?.textContent).toContain('重置卡剩余 1 张')
  expect(onToast).not.toHaveBeenCalled()
  await act(async () => document.body.querySelector<HTMLButtonElement>('.reset-ceremony-continue')?.click())
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('keeps the quota notice and skips the ceremony when consumption fails', async () => {
  window.tangu!.accountUseResetCard = vi.fn().mockResolvedValue({ status: 500, json: { detail: '服务暂不可用' } }) as any
  await mount()
  await act(async () => button('使用重置卡 (2)').click())
  await act(async () => button('再次点击确认').click())
  await tick()
  expect(host.querySelector('.t2-quota-advisory')).not.toBeNull()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(onToast).toHaveBeenCalledWith('服务暂不可用', true)
})

it('stays hidden for signed-out users', async () => {
  await mount(false)
  expect(window.tangu!.accountQuota).not.toHaveBeenCalled()
  expect(host.querySelector('.t2-quota-advisory')).toBeNull()
})

describe('background quota (Muse / automations)', () => {
  const bgQuota = (over: Record<string, unknown> = {}) => ({
    status: 200,
    json: {
      dailyLimit: 100, dailyRemaining: 80, weeklyLimit: 100, weeklyRemaining: 90, resetCards: 0,
      background: { modelId: 'm-cheap', dailyLimit: 15, dailyUsed: 15, dailyRemaining: 0, weeklyLimit: 15, weeklyUsed: 15, weeklyRemaining: 0, autoMain: false, ...over },
    },
  })

  it('takes the single slot when the background bucket runs out, and offers a confirmed move from the main quota', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(bgQuota()) as any
    ;(window.tangu as any).backendStatus = vi.fn()
    ;(window.tangu as any).accountBgConvert = vi.fn().mockResolvedValue({
      status: 200,
      json: { success: true, quota: bgQuota({ dailyLimit: 25, dailyRemaining: 10, weeklyLimit: 25, weeklyRemaining: 10 }).json },
    })
    await mount()
    const banner = host.querySelector('.t2-quota-advisory')
    expect(banner?.getAttribute('data-bucket')).toBe('background')
    expect(host.textContent).toContain('后台智能体今日额度已用尽,Muse 与自动化已暂停')
    expect(host.textContent).not.toContain('使用重置卡')
    await act(async () => button('从主额度转入 10%').click())
    expect((window.tangu as any).accountBgConvert).not.toHaveBeenCalled()
    await act(async () => button('再次点击确认').click())
    await tick()
    expect((window.tangu as any).accountBgConvert).toHaveBeenCalledWith(10)
    expect(onToast).toHaveBeenCalledWith('已从主额度转入 10%,本周期有效')
    expect(host.querySelector('.t2-quota-advisory')).toBeNull()
  })

  it('says so when the exhausted bucket is continuing on the main quota', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(bgQuota({ autoMain: true })) as any
    ;(window.tangu as any).backendStatus = vi.fn()
    await mount()
    expect(host.textContent).toContain('后台智能体今日额度已用尽,正在用主额度继续')
  })

  it('never shows the background bucket where Muse cannot run (no local engine)', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(bgQuota()) as any
    await mount()
    expect(host.querySelector('.t2-quota-advisory')).toBeNull()
  })
})
