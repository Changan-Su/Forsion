// calendarDate 存储编码纯逻辑:parse / serialize round-trip / allDay 判定 / 显示格式化。
import { describe, expect, it } from 'vitest'
import { parseCalDate, calDateToValue, fmtCalDate, shiftEnd } from './calDate'

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

describe('shiftEnd:改开始时结束跟着平移,时长不变', () => {
  it('一小时的事往后挪三天,结束也挪三天', () => {
    expect(shiftEnd('2026-11-02T11:00', '2026-11-05T11:00', '2026-11-02T12:00')).toBe('2026-11-05T12:00')
  })
  it('只改开始时刻,结束同样多挪', () => {
    expect(shiftEnd('2026-11-02T11:00', '2026-11-02T14:30', '2026-11-02T12:00')).toBe('2026-11-02T15:30')
  })
  it('跨午夜的事挪半小时,结束落在第二天', () => {
    expect(shiftEnd('2026-11-02T23:00', '2026-11-02T23:30', '2026-11-03T01:00')).toBe('2026-11-03T01:30')
    expect(shiftEnd('2026-11-02T22:00', '2026-11-02T23:30', '2026-11-02T23:00')).toBe('2026-11-03T00:30')
  })
  it('全天多日跨月平移', () => {
    expect(shiftEnd('2026-01-31', '2026-02-01', '2026-02-02')).toBe('2026-02-03')
    expect(shiftEnd('2026-11-02', '2026-10-30', '2026-11-04')).toBe('2026-11-01')
  })
  it('开始加上 / 去掉时刻时,只按天平移,结束时刻原样', () => {
    expect(shiftEnd('2026-11-02', '2026-11-02T10:00', '2026-11-03')).toBe('2026-11-03')
    expect(shiftEnd('2026-11-02T10:00', '2026-11-04', '2026-11-02T11:00')).toBe('2026-11-04T11:00')
  })
  it('没有结束就没有结束', () => {
    expect(shiftEnd('2026-11-02', '2026-11-05', undefined)).toBeUndefined()
  })
})
