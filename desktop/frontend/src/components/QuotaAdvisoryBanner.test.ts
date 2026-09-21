// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

it('requires confirmation before consuming a reset card and hides after recovery', async () => {
  await mount()
  await act(async () => button('使用重置卡 (2)').click())
  expect(window.tangu!.accountUseResetCard).not.toHaveBeenCalled()
  expect(host.textContent).toContain('再次点击确认')
  await act(async () => button('再次点击确认').click())
  await tick()
  expect(window.tangu!.accountUseResetCard).toHaveBeenCalledWith('both')
  expect(host.querySelector('.t2-quota-advisory')).toBeNull()
  expect(onToast).toHaveBeenCalledWith('已恢复今日与本周额度')
})

it('stays hidden for signed-out users', async () => {
  await mount(false)
  expect(window.tangu!.accountQuota).not.toHaveBeenCalled()
  expect(host.querySelector('.t2-quota-advisory')).toBeNull()
})
