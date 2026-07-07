// calendarDate 存储编码纯逻辑:parse / serialize round-trip / allDay 判定 / 显示格式化。
import { describe, expect, it } from 'vitest'
import { parseCalDate, calDateToValue, fmtCalDate } from './calDate'
import { seedCalendarDb, dbFileSchema } from './schema'

describe('parseCalDate', () => {
  it('全天(仅日期)', () => {
    expect(parseCalDate('2026-07-06')).toEqual({ start: '2026-07-06', end: undefined, allDay: true })
  })
  it('带时刻', () => {
    expect(parseCalDate('2026-07-06T10:00')).toEqual({ start: '2026-07-06T10:00', end: undefined, allDay: false })
  })
  it('起止范围', () => {
    expect(parseCalDate('2026-07-06T10:00/2026-07-06T11:30')).toEqual({
      start: '2026-07-06T10:00',
      end: '2026-07-06T11:30',
      allDay: false,
    })
  })
  it('无效/空 → null', () => {
    expect(parseCalDate('')).toBeNull()
    expect(parseCalDate('not-a-date')).toBeNull()
    expect(parseCalDate(null)).toBeNull()
    expect(parseCalDate(42)).toBeNull()
  })
  it('结束段非法则丢弃', () => {
    expect(parseCalDate('2026-07-06/garbage')).toEqual({ start: '2026-07-06', end: undefined, allDay: true })
  })
})

describe('calDateToValue round-trip', () => {
  it.each(['2026-07-06', '2026-07-06T10:00', '2026-07-06T10:00/2026-07-06T11:30'])('%s', (s) => {
    expect(calDateToValue(parseCalDate(s)!)).toBe(s)
  })
})

describe('fmtCalDate', () => {
  it('全天', () => expect(fmtCalDate(parseCalDate('2026-07-06'))).toBe('7月6日'))
  it('单点带时刻', () => expect(fmtCalDate(parseCalDate('2026-07-06T10:00'))).toBe('7月6日 10:00'))
  it('同日范围', () => expect(fmtCalDate(parseCalDate('2026-07-06T10:00/2026-07-06T11:30'))).toBe('7月6日 10:00–11:30'))
  it('跨日范围', () =>
    expect(fmtCalDate(parseCalDate('2026-07-06T10:00/2026-07-08T09:00'))).toBe('7月6日 10:00 → 7月8日 09:00'))
  it('null → 空串', () => expect(fmtCalDate(null)).toBe(''))
})

describe('seedCalendarDb', () => {
  it('过 dbFileSchema(含 calendarDate/todo 自定义 type)', () => {
    expect(dbFileSchema.safeParse(seedCalendarDb()).success).toBe(true)
  })
  it('日期列的值能被 parseCalDate 解析', () => {
    const db = seedCalendarDb()
    const dateCol = db.columns.find((c) => c.type === 'calendarDate')!
    for (const r of db.rows) {
      const v = r.cells[dateCol.id]
      if (v != null) expect(parseCalDate(v as string)).not.toBeNull()
    }
  })
})
