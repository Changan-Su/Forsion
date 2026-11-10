import { describe, it, expect } from 'vitest'
import { isEventRow } from './rowKind'

describe('isEventRow:带标记且有日期才算日程', () => {
  it('标了、日期列里有日期 = 日程(全天、带时刻、区间都算)', () => {
    for (const d of ['2026-11-10', '2026-11-10T09:00', '2026-11-10T09:00/2026-11-10T10:00']) {
      expect(isEventRow({ cells: { _kind: 'event', d } }, 'd')).toBe(true)
    }
  })
  it('没标 = 待办,哪怕有起止时间', () => {
    expect(isEventRow({ cells: { d: '2026-11-10T09:00/2026-11-10T10:00' } }, 'd')).toBe(false)
  })
  it('标了但没日期 / 日期解析不了 / 看的不是映射的日期列 = 待办', () => {
    expect(isEventRow({ cells: { _kind: 'event' } }, 'd')).toBe(false)
    expect(isEventRow({ cells: { _kind: 'event', d: '下周' } }, 'd')).toBe(false)
    expect(isEventRow({ cells: { _kind: 'event', other: '2026-11-10' } }, 'd')).toBe(false)
    expect(isEventRow({ cells: { _kind: 'event', d: '2026-11-10' } }, undefined)).toBe(false)
  })
  it('别的标记值不算', () => {
    expect(isEventRow({ cells: { _kind: 'todo', d: '2026-11-10' } }, 'd')).toBe(false)
    expect(isEventRow(null, 'd')).toBe(false)
  })
})
