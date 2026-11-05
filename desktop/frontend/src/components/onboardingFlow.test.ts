import { describe, expect, it } from 'vitest'
import { needsFullGuide, stepOrder, updateOrder } from './onboardingFlow'

describe('stepOrder', () => {
  it('桌面四屏:开始 → 外观 → 关于你 → 团队', () => {
    expect(stepOrder({ host: true })).toEqual(['start', 'theme', 'you', 'team'])
  })
  it('网页 / 手机只有外观', () => {
    expect(stepOrder({ host: false })).toEqual(['theme'])
  })
})

describe('needsFullGuide', () => {
  it('没有记录、或上次看引导早于 2.13.8 → 完整走一遍', () => {
    expect(needsFullGuide(null)).toBe(true)
    expect(needsFullGuide('2.13.7')).toBe(true)
    expect(needsFullGuide('2.12.0')).toBe(true)
  })
  it('2.13.8 及以后 → 只看新增的', () => {
    expect(needsFullGuide('2.13.8')).toBe(false)
    expect(needsFullGuide('2.13.8-beta.3')).toBe(true) // 预发版排在正式版之前
    expect(needsFullGuide('2.14.0')).toBe(false)
  })
})

describe('updateOrder', () => {
  const full = stepOrder({ host: true })
  it('2.13.8 升上来:更新内容 + 关于你 + 团队', () => {
    expect(updateOrder(full, '2.13.8')).toEqual(['welcome', 'you', 'team'])
  })
  it('已经看过 2.14.0 的:只有更新内容', () => {
    expect(updateOrder(full, '2.14.0')).toEqual(['welcome'])
  })
  it('本机没有这一屏的内容就不列', () => {
    expect(updateOrder(full, '2.13.8', (s) => s !== 'team')).toEqual(['welcome', 'you'])
  })
  it('开始和外观老用户都看过,不进短引导', () => {
    expect(updateOrder(full, '2.13.8')).not.toContain('start')
    expect(updateOrder(full, '2.13.8')).not.toContain('theme')
  })
})
