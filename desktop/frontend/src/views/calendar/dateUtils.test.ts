import { describe, expect, it, beforeEach } from 'vitest'
import { setLocaleGlobal } from '../../i18n'
import { toLocalDate, monthGridDays, coversDay, eventBox, sameDay, startOfWeek, WEEK_START, eventTimeSummary, fmtDur } from './dateUtils'

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

describe('fmtDur', () => {
  // fmtDur 已跟随界面语言 → 显式钉住 zh,断言才有确定含义(en 侧由 dateUtilsLocale.test.ts 钉)
  beforeEach(() => { setLocaleGlobal('zh') })

  it('分 / 时 / 时分 / 天', () => {
    expect(fmtDur(30)).toBe('30分钟')
    expect(fmtDur(60)).toBe('1小时')
    expect(fmtDur(90)).toBe('1小时30分钟')
    expect(fmtDur(1440)).toBe('1天')
    expect(fmtDur(0)).toBe('')
  })
})

describe('eventTimeSummary', () => {
  it('定时同日 → 时段主行 + 日期星期副行 + 时长徽章', () => {
    const r = eventTimeSummary('2026-07-08T14:30/2026-07-08T15:00')!
    expect(r.head).toBe('14:30 → 15:00')
    expect(r.badge).toBe('30分钟')
    expect(r.date).toBe('7月8日 周三') // 2026-07-08 是周三,且不偏 UTC
  })
  it('无结束 → 只时刻主行,无徽章', () => {
    const r = eventTimeSummary('2026-07-08T14:30')!
    expect(r.head).toBe('14:30')
    expect(r.badge).toBe('')
  })
  it('全天 → 徽章=全天', () => {
    const r = eventTimeSummary('2026-07-08')!
    expect(r.badge).toBe('全天')
    expect(r.date).toBe('')
  })
  it('非法/空 → null', () => {
    expect(eventTimeSummary('')).toBeNull()
    expect(eventTimeSummary('not-a-date')).toBeNull()
  })
})
