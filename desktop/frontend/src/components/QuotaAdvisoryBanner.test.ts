// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { QuotaAdvisoryBanner } from './QuotaAdvisoryBanner'
import { resetPointsAutoDeductBridge } from '../tangu/pointsAutoDeduct'

let host: HTMLDivElement
let root: Root
const onToast = vi.fn()
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  onToast.mockReset()
  resetPointsAutoDeductBridge()
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
  expect(host.textContent).toContain('本周 AI 额度即将用尽，仅剩 8%')
  expect(button('升级会员')).toBeTruthy()
  expect(button('使用额度重置卡（2）')).toBeTruthy()
  await act(async () => button('升级会员').click())
  expect(window.tangu!.openPayCenter).toHaveBeenCalledOnce()
})

it('requires confirmation, then shows the restored quotas after success', async () => {
  await mount()
  await act(async () => button('使用额度重置卡（2）').click())
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
  await act(async () => button('使用额度重置卡（2）').click())
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
    expect(host.textContent).toContain('今日后台额度已用尽，Muse 与自动化已暂停')
    expect(host.textContent).not.toContain('使用额度重置卡')
    await act(async () => button('从 AI 额度转入 10%').click())
    expect((window.tangu as any).accountBgConvert).not.toHaveBeenCalled()
    await act(async () => button('再次点击确认').click())
    await tick()
    expect((window.tangu as any).accountBgConvert).toHaveBeenCalledWith(10)
    expect(onToast).toHaveBeenCalledWith('已从 AI 额度转入 10%，本周期有效')
    expect(host.querySelector('.t2-quota-advisory')).toBeNull()
  })

  it('says so when the exhausted bucket is continuing on the main quota', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(bgQuota({ autoMain: true })) as any
    ;(window.tangu as any).backendStatus = vi.fn()
    await mount()
    expect(host.textContent).toContain('今日后台额度已用尽，正在用 AI 额度继续')
  })

  it('never shows the background bucket where Muse cannot run (no local engine)', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(bgQuota()) as any
    await mount()
    expect(host.querySelector('.t2-quota-advisory')).toBeNull()
  })
})

describe('额度用完:用重置卡 / 用积分继续两条路', () => {
  const exhausted = (over: Record<string, unknown> = {}) => ({
    status: 200,
    json: { dailyLimit: 100, dailyRemaining: 40, weeklyLimit: 100, weeklyRemaining: 0, resetCards: 2, pointsAutoDeduct: false, pointsBalance: 500, modelMultiplierCap: 2.5, ...over },
  })
  const has = (text: string) => [...host.querySelectorAll('button')].some((el) => el.textContent?.includes(text))
  const banner = () => host.querySelector<HTMLElement>('.t2-quota-advisory')

  it('开关没开、有卡有积分:两条路都给;用积分要再点一次确认,成功后变成普通提示带余额', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted()) as any
    const cloudInvoke = vi.fn().mockResolvedValue({ status: 200, json: { success: true, pointsAutoDeduct: true, quota: exhausted({ pointsAutoDeduct: true, resetCards: undefined, pointsBalance: undefined }).json } })
    ;(window.tangu as any).cloudInvoke = cloudInvoke
    await mount()
    expect(host.textContent).toContain('本周 AI 额度已用尽')
    expect(has('使用额度重置卡（2）')).toBe(true)
    await act(async () => button('用积分继续').click())
    expect(cloudInvoke).not.toHaveBeenCalled()
    expect(has('确认用积分继续')).toBe(true)
    await act(async () => button('确认用积分继续').click())
    await tick()
    expect(cloudInvoke).toHaveBeenCalledWith('account:pointsAutoDeduct', true)
    expect(host.textContent).toContain('本周 AI 额度已用完，正在用积分继续')
    expect(host.textContent).toContain('积分余额 500') // 回包不含余额,沿用读到的那份
    expect(banner()?.dataset.level).toBe('info')
    expect(has('用积分继续')).toBe(false)
    expect(has('使用额度重置卡（2）')).toBe(true) // 卡张数也没被回包冲掉
  })

  it('没卡、积分为 0:不挂灰色的重置卡按钮,积分那条换成「充值积分」打开支付中心', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted({ resetCards: 0, pointsBalance: 0 })) as any
    ;(window.tangu as any).cloudInvoke = vi.fn()
    await mount()
    expect(has('重置卡')).toBe(false)
    expect(has('用积分继续')).toBe(false)
    await act(async () => button('充值积分').click())
    expect(window.tangu!.openPayCenter).toHaveBeenCalledOnce()
  })

  it('开关开着但积分也用完了:提示充值积分 / 升级会员', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted({ pointsAutoDeduct: true, pointsBalance: 0, resetCards: 0 })) as any
    await mount()
    expect(host.textContent).toContain('本周 AI 额度已用完，积分也用完了')
    expect(banner()?.dataset.level).toBe('critical')
    expect(has('充值积分')).toBe(true)
    expect(has('升级会员')).toBe(true)
  })

  it('没有扩展通道(网页 / 手机 / 没装扩展):不给「用积分继续」,只留用卡与升级', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted()) as any
    await mount()
    expect(has('用积分继续')).toBe(false)
    expect(has('使用额度重置卡（2）')).toBe(true)
    expect(has('升级会员')).toBe(true)
  })

  it('旧服务端(额度视图没有 pointsBalance / modelMultiplierCap):不给积分那条路,也不当余额 0 去提示充值', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted({ pointsBalance: undefined, modelMultiplierCap: undefined })) as any
    ;(window.tangu as any).cloudInvoke = vi.fn()
    await mount()
    expect(has('用积分继续')).toBe(false)
    expect(has('充值积分')).toBe(false)
  })

  it('宿主比扩展新(通道不存在 → No handler):按钮消失并说一句', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted()) as any
    ;(window.tangu as any).cloudInvoke = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'account:pointsAutoDeduct': Error: No handler registered for 'account:pointsAutoDeduct'"))
    await mount()
    await act(async () => button('用积分继续').click())
    await act(async () => button('确认用积分继续').click())
    await tick()
    expect(has('用积分继续')).toBe(false)
    expect(onToast).toHaveBeenCalledWith('积分继续暂时开不了，请稍后再试', true)
  })

  it('503 / 老服务端 410:提示稍后再试;status 0 没收到结果:重读额度视图以服务端为准', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted()) as any
    const cloudInvoke = vi.fn().mockResolvedValueOnce({ status: 503, json: { error: 'points_fallback_unavailable' } })
    ;(window.tangu as any).cloudInvoke = cloudInvoke
    await mount()
    await act(async () => button('用积分继续').click())
    await act(async () => button('确认用积分继续').click())
    await tick()
    expect(onToast).toHaveBeenCalledWith('积分继续暂时开不了，请稍后再试', true)
    onToast.mockReset()
    cloudInvoke.mockResolvedValueOnce({ status: 0, error: 'network' })
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted({ pointsAutoDeduct: true })) as any
    await act(async () => button('用积分继续').click())
    await act(async () => button('确认用积分继续').click())
    await tick()
    expect(onToast).not.toHaveBeenCalled()
    expect(window.tangu!.accountQuota).toHaveBeenCalled()
    expect(host.textContent).toContain('正在用积分继续')
  })

  const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
  const confirmPoints = async () => {
    await act(async () => button('用积分继续').click())
    await act(async () => button('确认用积分继续').click())
  }

  it('不乐观翻转:在途时保持原样、禁用、忙碌;回包说没开就照回包显示没开', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue(exhausted()) as any
    const d = deferred<any>()
    ;(window.tangu as any).cloudInvoke = vi.fn().mockReturnValue(d.promise)
    await mount()
    await confirmPoints()
    expect(host.textContent).toContain('本周 AI 额度已用尽')
    expect(host.textContent).not.toContain('正在用积分继续')
    const busy = [...host.querySelectorAll<HTMLButtonElement>('button.points')][0]
    expect(busy.disabled).toBe(true)
    expect(busy.querySelector('svg')?.classList.contains('spin')).toBe(true)
    await act(async () => { d.resolve({ status: 200, json: { success: true, pointsAutoDeduct: false, quota: exhausted({ pointsAutoDeduct: false }).json } }) })
    await tick()
    expect(host.textContent).not.toContain('正在用积分继续')
    expect(banner()?.dataset.points).toBe('off')
  })

  it('确定不了(5xx 非明确 503):不当没开,重读以服务端为准;重读也失败 → 状态未知 + 重试,不显示成关', async () => {
    const quotaRead = vi.fn().mockResolvedValueOnce(exhausted()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(exhausted({ pointsAutoDeduct: true }))
    window.tangu!.accountQuota = quotaRead as any
    ;(window.tangu as any).cloudInvoke = vi.fn().mockResolvedValue({ status: 502, json: null })
    await mount()
    await confirmPoints()
    await tick()
    expect(quotaRead).toHaveBeenCalledTimes(2)
    expect(banner()?.dataset.points).toBe('unknown')
    expect(host.textContent).toContain('暂时确认不了「用积分继续」开没开')
    expect(has('用积分继续')).toBe(false) // 不给一颗「看起来没开」的按钮
    expect(onToast).not.toHaveBeenCalled()
    await act(async () => button('重试').click())
    await tick()
    expect(host.textContent).toContain('正在用积分继续')
  })

  it('503 没带 points_fallback_unavailable 也算确定不了:重读', async () => {
    const quotaRead = vi.fn().mockResolvedValueOnce(exhausted()).mockResolvedValueOnce(exhausted({ pointsAutoDeduct: true }))
    window.tangu!.accountQuota = quotaRead as any
    ;(window.tangu as any).cloudInvoke = vi.fn().mockResolvedValue({ status: 503, json: { error: 'bad_gateway' } })
    await mount()
    await confirmPoints()
    await tick()
    expect(host.textContent).toContain('正在用积分继续')
    expect(onToast).not.toHaveBeenCalled()
  })

  it('开关请求之前发出的读取晚到:丢掉它的开关值,不把已确认的「开」盖回「关」', async () => {
    const stale = deferred<any>()
    const quotaRead = vi.fn().mockResolvedValueOnce(exhausted()).mockReturnValueOnce(stale.promise)
    window.tangu!.accountQuota = quotaRead as any
    ;(window.tangu as any).cloudInvoke = vi.fn().mockResolvedValue({ status: 200, json: { success: true, pointsAutoDeduct: true, quota: exhausted({ pointsAutoDeduct: true }).json } })
    await mount()
    await act(async () => { window.dispatchEvent(new Event('focus')) }) // 一次读取在途(读到的是开关之前的状态)
    await confirmPoints()
    await tick()
    expect(host.textContent).toContain('正在用积分继续')
    await act(async () => { stale.resolve(exhausted({ pointsAutoDeduct: false })) })
    await tick()
    expect(host.textContent).toContain('正在用积分继续')
  })
})

