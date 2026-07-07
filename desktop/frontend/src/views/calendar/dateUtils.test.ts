import { describe, expect, it } from 'vitest'
import { toLocalDate, monthGridDays, coversDay, eventBox, sameDay, startOfWeek, WEEK_START } from './dateUtils'

describe('toLocalDate', () => {
  it('全天 = 本地午夜(不偏 UTC)', () => {
    const d = toLocalDate('2026-07-06')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)
    expect(d.getDate()).toBe(6)
    expect(d.getHours()).toBe(0)
  })
  it('带时刻', () => {
    const d = toLocalDate('2026-07-06T14:30')
    expect(d.getHours()).toBe(14)
    expect(d.getMinutes()).toBe(30)
  })
})

describe('monthGridDays', () => {
  it('恒 42 格且从周首开始', () => {
    const days = monthGridDays(new Date(2026, 6, 15))
    expect(days).toHaveLength(42)
    expect(days[0].getDay()).toBe(WEEK_START)
  })
  it('含目标月 1 号', () => {
    const days = monthGridDays(new Date(2026, 6, 1))
    expect(days.some((d) => sameDay(d, new Date(2026, 6, 1)))).toBe(true)
  })
})

describe('coversDay', () => {
  const s = toLocalDate('2026-07-06')
  const e = toLocalDate('2026-07-08')
  it('起止之间为真', () => {
    expect(coversDay(s, e, new Date(2026, 6, 7))).toBe(true)
    expect(coversDay(s, e, new Date(2026, 6, 6))).toBe(true)
    expect(coversDay(s, e, new Date(2026, 6, 8))).toBe(true)
  })
  it('区间外为假', () => {
    expect(coversDay(s, e, new Date(2026, 6, 9))).toBe(false)
    expect(coversDay(s, null, new Date(2026, 6, 7))).toBe(false)
  })
})

describe('eventBox', () => {
  it('无 end → 1 小时高', () => {
    const { top, height } = eventBox(toLocalDate('2026-07-06T10:00'), null, 48)
    expect(top).toBe(480) // 10h * 48
    expect(height).toBe(48)
  })
  it('有 end → 时长成比例', () => {
    const { height } = eventBox(toLocalDate('2026-07-06T10:00'), toLocalDate('2026-07-06T11:30'), 48)
    expect(height).toBe(72) // 1.5h * 48
  })
  it('极短事件保底 20 分钟高', () => {
    const { height } = eventBox(toLocalDate('2026-07-06T10:00'), toLocalDate('2026-07-06T10:05'), 48)
    expect(height).toBeCloseTo((20 / 60) * 48)
  })
})

describe('startOfWeek', () => {
  it('落在 WEEK_START', () => {
    expect(startOfWeek(new Date(2026, 6, 15)).getDay()).toBe(WEEK_START)
  })
})
