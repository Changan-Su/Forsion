import { describe, expect, it } from 'vitest'
import { backgroundAdvisoryFor, pickQuotaAdvisory, quotaAdvisoryFor } from './accountQuota'

describe('quotaAdvisoryFor', () => {
  it('uses the tighter finite period and exact remaining values', () => {
    expect(quotaAdvisoryFor({
      dailyLimit: 100,
      dailyRemaining: 14.9,
      dailyPercent: 85,
      weeklyLimit: 1_000,
      weeklyRemaining: 104,
      weeklyPercent: 90,
    })).toMatchObject({ period: 'weekly', threshold: 15, remainingPercent: 10.4 })
  })

  it.each([
    [15, 15],
    [10, 10],
    [5, 5],
    [0, 0],
  ] as const)('maps %s%% remaining to the %s advisory level', (remaining, threshold) => {
    expect(quotaAdvisoryFor({ dailyLimit: 100, dailyRemaining: remaining, weeklyLimit: -1 }))
      .toMatchObject({ threshold, exhausted: threshold === 0, critical: threshold <= 5 })
  })

  it('does not warn above 15% or for unlimited periods', () => {
    expect(quotaAdvisoryFor({ dailyLimit: 100, dailyRemaining: 15.1, weeklyLimit: -1 })).toBeNull()
    expect(quotaAdvisoryFor({ dailyLimit: -1, weeklyLimit: -1 })).toBeNull()
  })

  it('falls back to the legacy used-percent fields', () => {
    expect(quotaAdvisoryFor({ dailyLimit: 100, dailyPercent: 96, weeklyLimit: -1 }))
      .toMatchObject({ period: 'daily', threshold: 5, remainingPercent: 4 })
  })
})

describe('background quota advisory (Muse / automations)', () => {
  const bg = (over: Record<string, unknown> = {}) => ({
    dailyLimit: 100, dailyRemaining: 60, weeklyLimit: 100, weeklyRemaining: 100,
    background: { modelId: 'm-cheap', dailyLimit: 15, dailyUsed: 14, dailyRemaining: 1, weeklyLimit: 30, weeklyUsed: 14, weeklyRemaining: 16, ...over },
  })

  it('warns once the bucket is in use and running low', () => {
    expect(backgroundAdvisoryFor(bg())).toMatchObject({ period: 'daily', threshold: 10 })
  })

  it('stays quiet when the server has no counted model or the bucket was never used this period', () => {
    expect(backgroundAdvisoryFor(bg({ modelId: null }))).toBeNull()
    expect(backgroundAdvisoryFor(bg({ dailyUsed: 0, weeklyUsed: 0, dailyRemaining: 0, dailyLimit: 0 }))).toBeNull()
    expect(backgroundAdvisoryFor({ dailyLimit: 100, weeklyLimit: -1 })).toBeNull()
  })

  it('shares the single chat-box slot: the tighter bucket wins, ties go to the main quota', () => {
    const main = quotaAdvisoryFor({ dailyLimit: 100, dailyRemaining: 12, weeklyLimit: -1 })
    const back = backgroundAdvisoryFor(bg())
    expect(pickQuotaAdvisory(main, back)?.bucket).toBe('background')
    expect(pickQuotaAdvisory(quotaAdvisoryFor({ dailyLimit: 100, dailyRemaining: 3, weeklyLimit: -1 }), back)?.bucket).toBe('main')
    expect(pickQuotaAdvisory(back, back)?.bucket).toBe('main')
    expect(pickQuotaAdvisory(null, back)?.bucket).toBe('background')
    expect(pickQuotaAdvisory(null, null)).toBeNull()
  })
})
