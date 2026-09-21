import { describe, expect, it } from 'vitest'
import { quotaAdvisoryFor } from './accountQuota'

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
