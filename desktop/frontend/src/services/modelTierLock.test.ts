import { describe, expect, it } from 'vitest'
import { isModelTierLocked, isTierLockedError, modelMultiplierCapOf, tierLockedModelName } from './modelTierLock'

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
