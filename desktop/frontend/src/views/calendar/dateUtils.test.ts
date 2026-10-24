import { describe, expect, it, beforeEach } from 'vitest'
import { setLocaleGlobal } from '../../i18n'
import { toLocalDate, addMinutes, wallDiffMin, monthGridDays, coversDay, eventBox, sameDay, startOfWeek, weekStart, useWeekStartPref, eventTimeSummary, fmtDur } from './dateUtils'
import { draftValue } from './draft'

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
    expect(days[0].getDay()).toBe(weekStart())
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
  it('落在 weekStart()', () => {
    expect(startOfWeek(new Date(2026, 6, 15)).getDay()).toBe(weekStart())
  })
  it('周首日按语言缺省,用户覆盖优先;两套月格(日历 / 数据库日历视图)都从同一个周首日起', () => {
    setLocaleGlobal('zh')
    expect(weekStart()).toBe(1)
    // 2026-07-15 是周三:zh 周首 = 07-13(周一)
    expect(startOfWeek(new Date(2026, 6, 15)).getDate()).toBe(13)
    setLocaleGlobal('en')
    expect(weekStart()).toBe(0)
    expect(startOfWeek(new Date(2026, 6, 15)).getDate()).toBe(12)
    useWeekStartPref.getState().setPref(1)
    expect(weekStart()).toBe(1)
    expect(monthGridDays(new Date(2026, 6, 1))[0].getDay()).toBe(1)
    useWeekStartPref.getState().setPref('auto')
    setLocaleGlobal('zh')
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

describe('isoWeek', () => {
  it('matches ISO 8601 week numbers, including year edges', async () => {
    const { isoWeek } = await import('./dateUtils')
    expect(isoWeek(new Date(2026, 9, 16))).toBe(42)
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1)
    expect(isoWeek(new Date(2021, 0, 3))).toBe(53)
    expect(isoWeek(new Date(2024, 11, 30))).toBe(1)
  })
})

describe('addMinutes / wallDiffMin', () => {
  it('夏令时切换日按墙钟算(Europe/London 2026-10-25 / 2026-03-29)', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Europe/London'
    try {
      expect(new Date(2026, 9, 25, 13).getTimezoneOffset()).not.toBe(new Date(2026, 9, 25).getTimezoneOffset())
      expect(addMinutes(new Date(2026, 9, 25), 13 * 60).getHours()).toBe(13)
      expect(addMinutes(new Date(2026, 2, 29), 13 * 60).getHours()).toBe(13)
      expect(addMinutes(new Date(2026, 9, 25, 13), -13 * 60).getHours()).toBe(0)
      expect(addMinutes(new Date(2026, 9, 24, 23, 30), 60).getDate()).toBe(25)
      // 互逆:墙钟差,不是毫秒差(那天 13:00 距零点实际过了 14 小时)
      expect(wallDiffMin(new Date(2026, 9, 25, 13), new Date(2026, 9, 25))).toBe(13 * 60)
      expect(wallDiffMin(new Date(2026, 2, 29, 3, 30), new Date(2026, 2, 29))).toBe(210)
      expect(wallDiffMin(new Date(2026, 9, 26, 1), new Date(2026, 9, 25))).toBe(25 * 60)
      // 起点落进拨快空档被顺延,终点不能因此早于起点
      expect(draftValue({ day: '2026-03-29', startMin: 105, endMin: 135, endDay: '2026-03-29', title: '', dbPath: null })).toBe('2026-03-29T02:45/2026-03-29T03:15')
      expect(draftValue({ day: '2026-10-25', startMin: 780, endMin: 840, endDay: '2026-10-25', title: '', dbPath: null })).toBe('2026-10-25T13:00/2026-10-25T14:00')
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})
