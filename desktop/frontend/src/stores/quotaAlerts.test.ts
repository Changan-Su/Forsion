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
    expect(keys(pendingQuotaAlerts(codex([fiveH(82, H), week(40, 3 * 24 * H)]), prefs, now, {}))).toEqual(['codex:18000:used'])
    expect(pendingQuotaAlerts(codex([fiveH(79, H)]), prefs, now, {})).toEqual([])
  })

  it('还剩很多:只看 ≥24 小时的窗口,续期前 24 小时内、已用不到 85%', () => {
    const prefs = { threshold: 0, weeklyLeft: true } as const
    expect(keys(pendingQuotaAlerts(codex([fiveH(10, H), week(38, 20 * H)]), prefs, now, {}))).toEqual(['codex:604800:left'])
    expect(pendingQuotaAlerts(codex([week(38, 30 * H)]), prefs, now, {})).toEqual([]) // 还没进 24 小时
    expect(pendingQuotaAlerts(codex([week(85, 20 * H)]), prefs, now, {})).toEqual([]) // 已用不少
  })

  it('同一次重置只提醒一次:重置时刻差 ±10 分钟算同一次;下一轮重置再提醒', () => {
    const prefs = { threshold: 80, weeklyLeft: false } as const
    const seen = { 'codex:18000:used': now + H }
    expect(pendingQuotaAlerts(codex([fiveH(90, H + 9 * 60_000)]), prefs, now, seen)).toEqual([])
    expect(keys(pendingQuotaAlerts(codex([fiveH(90, 6 * H)]), prefs, now, seen))).toEqual(['codex:18000:used'])
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
