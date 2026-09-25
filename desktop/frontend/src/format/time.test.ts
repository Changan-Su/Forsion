import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatListTime, formatLongDate, formatMonthDay, formatRelative, formatTime, relativeParts, toDate } from './time'

const now = new Date(2026, 8, 25, 12, 0).getTime() // 2026-09-25 12:00 本地

describe('relativeParts:单位阶梯(原造物 / 版本历史 / 项目详情三份实现的并集)', () => {
  it('分钟以内归零秒;逐级 minute → hour → day → month → year', () => {
    expect(relativeParts(now - 30_000, now)).toEqual({ value: 0, unit: 'second' })
    expect(relativeParts(now - 5 * 60_000, now)).toEqual({ value: -5, unit: 'minute' })
    expect(relativeParts(now - 3 * 3_600_000, now)).toEqual({ value: -3, unit: 'hour' })
    expect(relativeParts(now - 2 * 86_400_000, now)).toEqual({ value: -2, unit: 'day' })
    expect(relativeParts(now - 40 * 86_400_000, now)).toEqual({ value: -1, unit: 'month' })
    expect(relativeParts(now - 11 * 2_592_000_000, now)).toEqual({ value: -11, unit: 'month' })
    // 一年封顶用 year:旧快照动辄跨年,不能渲成「24 个月前」
    expect(relativeParts(now - 800 * 86_400_000, now)).toEqual({ value: -2, unit: 'year' })
    expect(relativeParts(now + 5 * 60_000, now)).toEqual({ value: 5, unit: 'minute' })
  })
})

describe('formatRelative', () => {
  it('跟传入的界面语言,不跟系统区域;zh 数字与汉字之间有空格(与词条「{n} 天前」同一写法)', () => {
    expect(formatRelative(now - 3 * 86_400_000, { now, locale: 'zh' })).toBe('3 天前')
    expect(formatRelative(now - 3 * 86_400_000, { now, locale: 'en' })).toBe('3 days ago')
    expect(formatRelative(now - 3 * 60_000, { now, locale: 'zh' })).toBe('3 分钟前')
    expect(formatRelative(now - 3 * 60_000, { now, locale: 'en' })).toBe('3 minutes ago')
    expect(formatRelative(now - 2 * 3_600_000, { now, locale: 'en' })).toBe('2 hours ago')
    expect(formatRelative(now - 2 * 365 * 86_400_000, { now, locale: 'zh' })).toBe('2 年前')
    expect(formatRelative(now - 40 * 86_400_000, { now, locale: 'zh' })).toBe('上个月')
  })

  it('一分钟以内说「刚刚」,不是「0 分钟前」也不是「现在」', () => {
    expect(formatRelative(now - 400, { now, locale: 'zh' })).toBe('刚刚')
    expect(formatRelative(now - 20_000, { now, locale: 'en' })).toBe('just now')
  })

  it('接受毫秒 / ISO 串 / Date;解析不了返回空串,绝不渲出 Invalid Date', () => {
    const iso = new Date(now - 86_400_000 * 2).toISOString()
    expect(formatRelative(iso, { now, locale: 'en' })).toBe('2 days ago')
    expect(formatRelative(new Date(now - 86_400_000 * 2), { now, locale: 'en' })).toBe('2 days ago')
    expect(formatRelative(Number.NaN, { now })).toBe('')
    expect(formatRelative('not a date', { now })).toBe('')
    expect(formatRelative(null, { now })).toBe('')
    expect(toDate('')).toBeNull()
    // 纯日期按本地那一天,不是 UTC 午夜(否则西半球显示成前一天)
    expect(toDate('2026-09-17')?.getDate()).toBe(17)
    expect(formatDate('2026-09-17', { now, locale: 'zh' })).toBe('9月17日')
  })
})

describe('绝对日期', () => {
  it('今年不带年份,往年带;两种语言各有其形,不跟系统区域', () => {
    const sep17 = new Date(2026, 8, 17, 14, 5)
    expect(formatDate(sep17, { now, locale: 'zh' })).toBe('9月17日')
    expect(formatDate(sep17, { now, locale: 'en' })).toBe('Sep 17')
    const lastYear = new Date(2025, 8, 17, 14, 5)
    expect(formatDate(lastYear, { now, locale: 'zh' })).toBe('2025年9月17日')
    expect(formatDate(lastYear, { now, locale: 'en' })).toBe('Sep 17, 2025')
    expect(formatDate(sep17, { now, locale: 'zh', year: 'always' })).toBe('2026年9月17日')
  })

  it('日期 + 时刻是 24 小时制', () => {
    const t = new Date(2026, 8, 17, 14, 5)
    expect(formatDateTime(t, { now, locale: 'zh' })).toBe('9月17日 14:05')
    expect(formatDateTime(t, { now, locale: 'en' })).toBe('Sep 17, 14:05')
    expect(formatTime(new Date(2026, 8, 17, 9, 3))).toBe('09:03')
    expect(formatMonthDay(t)).toBe('9/17')
  })

  it('长日期:zh「9月17日 星期四」月日与星期间留空;en 用英语语序「Thursday, September 17」', () => {
    const t = new Date(2026, 8, 17, 14, 5)
    expect(formatLongDate(t, { locale: 'zh' })).toBe('9月17日 星期四')
    expect(formatLongDate(t, { locale: 'en' })).toBe('Thursday, September 17')
  })
})

describe('formatListTime:列表 7 天内相对时间,更早显示日期(收件箱「17/09/2026」那一类)', () => {
  it('7 天分界', () => {
    expect(formatListTime(now - 6 * 86_400_000, { now, locale: 'zh' })).toBe('6 天前')
    expect(formatListTime(now - 8 * 86_400_000, { now, locale: 'zh' })).toBe('9月17日')
    expect(formatListTime(now - 8 * 86_400_000, { now, locale: 'en' })).toBe('Sep 17')
    expect(formatListTime(now - 30_000, { now, locale: 'zh' })).toBe('刚刚')
  })
})
