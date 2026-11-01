import { describe, expect, it, vi } from 'vitest'

vi.mock('./notificationStore', () => ({ notifyApp: vi.fn() }))
vi.mock('../services/backendService', () => ({ getModelQuota: vi.fn() }))

const { pendingQuotaAlerts, quotaAlertText } = await import('./quotaAlerts')

const H = 3600_000
const now = new Date(2026, 9, 28, 9, 0).getTime()
const codex = (windows: Array<{ seconds: number; usedPercent: number; resetAt?: number }>, fetchedAt = now) => ({ providerId: 'codex', plan: 'plus', windows, fetchedAt })
const week = (usedPercent: number, resetIn: number) => ({ seconds: 604800, usedPercent, resetAt: now + resetIn })
const fiveH = (usedPercent: number, resetIn: number) => ({ seconds: 18000, usedPercent, resetAt: now + resetIn })
const keys = (a: Array<{ key: string }>) => a.map((x) => x.key)

describe('额度提醒判定', () => {
  it('缺省都关:什么都不提醒', () => {
    expect(pendingQuotaAlerts(codex([week(99, 2 * H), fiveH(99, H)]), { threshold: 0, weeklyLeft: false }, now, {})).toEqual([])
  })

  it('用到档位:每个窗口各提醒一次;没到档位不提醒', () => {
    const prefs = { threshold: 80, weeklyLeft: false } as const
    expect(keys(pendingQuotaAlerts(codex([fiveH(82, H), week(40, 3 * 24 * H)]), prefs, now, {}))).toEqual(['codex:18000'])
    expect(pendingQuotaAlerts(codex([fiveH(79, H)]), prefs, now, {})).toEqual([])
  })

  it('还剩很多:只看 ≥24 小时的窗口,续期前 24 小时内、已用不到 85%', () => {
    const prefs = { threshold: 0, weeklyLeft: true } as const
    expect(keys(pendingQuotaAlerts(codex([fiveH(10, H), week(38, 20 * H)]), prefs, now, {}))).toEqual(['codex:604800'])
    expect(pendingQuotaAlerts(codex([week(38, 30 * H)]), prefs, now, {})).toEqual([]) // 还没进 24 小时
    expect(pendingQuotaAlerts(codex([week(85, 20 * H)]), prefs, now, {})).toEqual([]) // 已用不少
  })

  it('同一次重置只提醒一次:重置时刻差 ±10 分钟算同一次;下一轮重置再提醒', () => {
    const prefs = { threshold: 80, weeklyLeft: false } as const
    const seen = { 'codex:18000': now + H }
    expect(pendingQuotaAlerts(codex([fiveH(90, H + 9 * 60_000)]), prefs, now, seen)).toEqual([])
    expect(keys(pendingQuotaAlerts(codex([fiveH(90, 6 * H)]), prefs, now, seen))).toEqual(['codex:18000'])
  })

  it('两种都开:同一窗口同一轮只提醒一次(够档位就说「用到了」);已经说过「用到了」的这一轮不再说「还剩很多」', () => {
    const prefs = { threshold: 80, weeklyLeft: true } as const
    const a = pendingQuotaAlerts(codex([week(82, H)]), prefs, now, {})
    expect(a.map((x) => [x.key, x.kind])).toEqual([['codex:604800', 'used']])
    expect(pendingQuotaAlerts(codex([week(82, H)]), prefs, now, { 'codex:604800': now + H })).toEqual([])
  })

  it('读失败 / 旧读数 / 没有重置时刻:不判', () => {
    const prefs = { threshold: 50, weeklyLeft: true } as const
    expect(pendingQuotaAlerts(null, prefs, now, {})).toEqual([])
    expect(pendingQuotaAlerts(codex([week(90, 20 * H)], now - 11 * 60_000), prefs, now, {})).toEqual([])
    expect(pendingQuotaAlerts(codex([{ seconds: 604800, usedPercent: 90 }]), prefs, now, {})).toEqual([])
  })

  it('文案:订阅本周还剩 / 5 小时已用', () => {
    const left = pendingQuotaAlerts(codex([week(38, 24 * H)]), { threshold: 0, weeklyLeft: true }, now, {})[0]
    expect(quotaAlertText(codex([]), left, now)).toBe('Codex 订阅本周额度还剩 62%，明天 09:00 重置')
    const used = pendingQuotaAlerts(codex([fiveH(82, 2 * H)]), { threshold: 80, weeklyLeft: false }, now, {})[0]
    expect(quotaAlertText(codex([]), used, now)).toBe('Codex 订阅的 5 小时额度已用 82%，今天 11:00 重置')
  })
})

describe('checkQuotaAlerts', () => {
  it('按 <来源>/<模型> 问;通知被关掉(notifyApp 返回 null)不记去重;去重记录读不出来不判', async () => {
    vi.resetModules()
    const notifyApp = vi.fn(() => null as string | null)
    const getModelQuota = vi.fn(async () => ({ quota: { providerId: 'codex', plan: 'plus', fetchedAt: Date.now(), windows: [{ seconds: 604800, usedPercent: 90, resetAt: Date.now() + 2 * H }] } }))
    vi.doMock('./notificationStore', () => ({ notifyApp }))
    vi.doMock('../services/backendService', () => ({ getModelQuota }))
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    const { useApp } = await import('./appStore')
    useApp.setState({ modelsResp: { models: [], defaultModelId: null, directProviders: [{ providerId: 'codex', modelIds: ['gpt-6-luna'] }, { providerId: 'openai', modelIds: ['gpt-6-luna'] }] } } as any)
    const { checkQuotaAlerts, writeQuotaPrefs } = await import('./quotaAlerts')
    writeQuotaPrefs({ threshold: 80, weeklyLeft: false })
    await checkQuotaAlerts(1e13)
    expect(getModelQuota.mock.calls.map((c: any[]) => c[1])).toEqual(['codex/gpt-6-luna', 'openai/gpt-6-luna'])
    expect(notifyApp).toHaveBeenCalled()
    expect(store.get('forsion.ntf.quotaSeen')).toBeUndefined() // 没弹出来 → 不记
    notifyApp.mockReturnValue('n1')
    store.set('forsion.ntf.quotaSeen', '{oops')
    notifyApp.mockClear()
    await checkQuotaAlerts(1e13 + 120_000)
    expect(notifyApp).not.toHaveBeenCalled() // 记录读不出来:不判
    store.delete('forsion.ntf.quotaSeen')
    await checkQuotaAlerts(1e13 + 240_000)
    expect(notifyApp).toHaveBeenCalledTimes(1) // 桩给两家回的是同一份 codex 读数:第二份被同一轮去重挡掉
    expect(Object.keys(JSON.parse(store.get('forsion.ntf.quotaSeen')!))).toEqual(['codex:604800'])
    vi.unstubAllGlobals()
  })
})
