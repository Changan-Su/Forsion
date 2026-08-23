import { describe, expect, it } from 'vitest'
import { layoutTimedEvents } from './eventLayout'

const at = (h: number, m = 0) => new Date(2026, 7, 22, h, m)

describe('layoutTimedEvents', () => {
  it('重叠事件分栏，首尾相接不算重叠', () => {
    const got = layoutTimedEvents([
      { key: 'a', start: at(9), end: at(10) },
      { key: 'b', start: at(9, 30), end: at(10, 30) },
      { key: 'c', start: at(10, 30), end: at(11) },
    ])
    expect(got.get('a')).toMatchObject({ lane: 0, laneCount: 2, leftPct: 0, widthPct: 50 })
    expect(got.get('b')).toMatchObject({ lane: 1, laneCount: 2, leftPct: 50, widthPct: 50 })
    expect(got.get('c')).toMatchObject({ lane: 0, laneCount: 1, leftPct: 0, widthPct: 100 })
  })

  it('无结束时间按一小时参与碰撞', () => {
    const got = layoutTimedEvents([
      { key: 'a', start: at(9), end: null },
      { key: 'b', start: at(9, 45), end: at(10, 15) },
    ])
    expect(got.get('a')?.laneCount).toBe(2)
    expect(got.get('b')?.laneCount).toBe(2)
  })
})
