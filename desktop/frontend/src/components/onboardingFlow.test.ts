import { describe, expect, it } from 'vitest'
import { FULL_GUIDE_BEFORE, STEP_SINCE, needsFullGuide, stepOrder, updateOrder } from './onboardingFlow'

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
  it('关于你 / 团队和新引导同一版出现:2.13.8 及以后看过引导的人升级只看更新内容(不再看一遍)', () => {
    expect(updateOrder(full, '2.13.8')).toEqual(['welcome'])
    expect(updateOrder(full, '2.14.0')).toEqual(['welcome'])
  })
  it('以后新加的屏:记了版本才在短引导里出现,本机没有这一屏的内容就不列', () => {
    const later = (seen: string, available?: (s: 'welcome' | 'start' | 'theme' | 'you' | 'team') => boolean) => {
      const since = { ...STEP_SINCE }
      try { STEP_SINCE.team = '2.14.0'; return updateOrder(full, seen, available) } finally { Object.assign(STEP_SINCE, since) }
    }
    expect(later('2.13.9')).toEqual(['welcome', 'team'])
    expect(later('2.13.9', (s) => s !== 'team')).toEqual(['welcome'])
    expect(later('2.14.0')).toEqual(['welcome'])
  })
  it('开始和外观不进短引导', () => {
    expect(updateOrder(full, '2.0.0')).not.toContain('start')
    expect(updateOrder(full, '2.0.0')).not.toContain('theme')
  })
  it('STEP_SINCE 里引导自带的屏和完整引导的分界是同一个版本', () => {
    expect(STEP_SINCE.you).toBe(FULL_GUIDE_BEFORE)
    expect(STEP_SINCE.team).toBe(FULL_GUIDE_BEFORE)
  })
})
