import { describe, expect, it } from 'vitest'
import { isModelTierLocked, isTierLockedError, modelMultiplierCapOf, modelTrialsOf, recentlyEndedTrial, tierLockedModelName, trialEndsAt, visibleModelTags } from './modelTierLock'
import { resetAccountQuotaScope } from './accountQuota'

const cloud = (multiplier?: number | null) => ({ source: 'forsion', multiplier })

describe('模型倍率门槛判定', () => {
  it('严格大于上限才用不了;等于上限能用', () => {
    expect(isModelTierLocked(cloud(5), 2.5)).toBe(true)
    expect(isModelTierLocked(cloud(2.5), 2.5)).toBe(false)
    expect(isModelTierLocked(cloud(1), 2.5)).toBe(false)
  })
  it('cap = -1(不限)/ 读不到(null / undefined / NaN)→ 一个都不锁', () => {
    expect(isModelTierLocked(cloud(99), -1)).toBe(false)
    expect(isModelTierLocked(cloud(99), null)).toBe(false)
    expect(isModelTierLocked(cloud(99), undefined)).toBe(false)
    expect(isModelTierLocked(cloud(99), Number.NaN)).toBe(false)
  })
  it('没有倍率(第三方 / 自带 key)与非云端来源不受影响', () => {
    expect(isModelTierLocked(cloud(undefined), 0)).toBe(false)
    expect(isModelTierLocked(cloud(null), 0)).toBe(false)
    expect(isModelTierLocked({ source: 'direct', multiplier: 9 }, 1)).toBe(false)
    expect(isModelTierLocked({ multiplier: 9 }, 1)).toBe(true) // 选项没带 source 时只看倍率
    expect(isModelTierLocked(undefined, 1)).toBe(false)
  })
  it('额度视图里的上限:没有字段 / 非数 / -1 = null', () => {
    expect(modelMultiplierCapOf(null)).toBeNull()
    expect(modelMultiplierCapOf({ dailyLimit: 1, weeklyLimit: 1 })).toBeNull()
    expect(modelMultiplierCapOf({ dailyLimit: 1, weeklyLimit: 1, modelMultiplierCap: -1 })).toBeNull()
    expect(modelMultiplierCapOf({ dailyLimit: 1, weeklyLimit: 1, modelMultiplierCap: 2.5 })).toBe(2.5)
    expect(modelMultiplierCapOf({ dailyLimit: 1, weeklyLimit: 1, modelMultiplierCap: 0 })).toBe(0)
  })
})

describe('model_tier_locked 报错识别', () => {
  it('裸码与 JSON 回包都认;拿得到模型名就取出来', () => {
    expect(isTierLockedError('model_tier_locked')).toBe(true)
    expect(isTierLockedError('LLM 403 {"detail":"model_tier_locked"}')).toBe(true)
    expect(isTierLockedError('token_quota_exceeded')).toBe(false)
    expect(tierLockedModelName('{"detail":"model_tier_locked","modelName":"X 1"}')).toBe('X 1')
    expect(tierLockedModelName('{"error":"model_tier_locked","detail":{"modelName":"Y"}}')).toBe('Y')
    expect(tierLockedModelName('model_tier_locked')).toBe('')
  })
})

describe('限时开放(2026-11-15)', () => {
  const fable = { id: 'fable', source: 'forsion', multiplier: 5 }
  const now = Date.parse('2026-11-20T00:00:00Z')
  it('正开放着的不锁;到点(now ≥ 到期)翻回锁住;别的模型不受影响', () => {
    const trials = { fable: now + 60_000 }
    expect(isModelTierLocked(fable, 2.5, trials, now)).toBe(false)
    expect(isModelTierLocked(fable, 2.5, trials, now + 60_000)).toBe(true)
    expect(isModelTierLocked({ ...fable, id: 'astra' }, 2.5, trials, now)).toBe(true)
    expect(isModelTierLocked(fable, 2.5, {}, now)).toBe(true)
  })
  it('trialEndsAt 只在开放真解锁了它时给到期时间(倍率本来就在上限内 / 不限 / 非云端 = null)', () => {
    const trials = { fable: now + 60_000, cheap: now + 60_000 }
    expect(trialEndsAt(fable, 2.5, trials, now)).toBe(now + 60_000)
    expect(trialEndsAt({ id: 'cheap', source: 'forsion', multiplier: 1 }, 2.5, trials, now)).toBeNull()
    expect(trialEndsAt(fable, null, trials, now)).toBeNull()
    expect(trialEndsAt({ ...fable, source: 'direct' }, 2.5, trials, now)).toBeNull()
    expect(trialEndsAt(fable, 2.5, trials, now + 60_000)).toBeNull()
  })
  it('额度视图 → 开放表:脏项丢掉;见过的开放到期 7 天内认得出,换号清空', () => {
    const quota = { dailyLimit: 1, weeklyLimit: 1, modelTrials: [
      { modelId: 'fable', endsAt: '2026-11-30T15:59:00Z' }, { modelId: '', endsAt: '2026-11-30T15:59:00Z' }, { modelId: 'x', endsAt: 'soon' },
    ] }
    const end = Date.parse('2026-11-30T15:59:00Z')
    expect(modelTrialsOf(quota)).toEqual({ fable: end })
    expect(modelTrialsOf(null)).toEqual({})
    expect(modelTrialsOf({ dailyLimit: 1, weeklyLimit: 1 })).toEqual({})
    expect(recentlyEndedTrial('fable', end - 1)).toBeNull() // 还没结束
    expect(recentlyEndedTrial('fable', end + 86_400_000)).toBe(end)
    expect(recentlyEndedTrial('fable', end + 8 * 86_400_000)).toBeNull() // 超过 7 天
    expect(recentlyEndedTrial('astra', end + 1)).toBeNull()
    resetAccountQuotaScope()
    expect(recentlyEndedTrial('fable', end + 86_400_000)).toBeNull()
  })
  it('旧版标签(kind: trial)不显示,别的标签原样', () => {
    const tags = [{ text: '限时 Trial', color: 'amber', kind: 'trial' }, { text: 'new', color: 'green' }]
    expect(visibleModelTags(tags)).toEqual([{ text: 'new', color: 'green' }])
    expect(visibleModelTags(undefined)).toEqual([])
  })
})
