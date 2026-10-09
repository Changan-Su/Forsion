import { describe, expect, it } from 'vitest'
import { dayBucket, withSections } from './phoneList'

describe('phone list sections', () => {
  const now = new Date(2026, 9, 9, 15, 0).getTime() // Friday afternoon
  const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h).getTime()

  it('buckets by calendar day, not by 24-hour distance', () => {
    expect(dayBucket(at(2026, 9, 9, 0), now)).toBe('today')
    expect(dayBucket(at(2026, 9, 8, 23), now)).toBe('yesterday') // 16 hours ago, but yesterday
    expect(dayBucket(at(2026, 9, 3, 0), now)).toBe('week') // the row's time reads as a weekday up to six days back
    expect(dayBucket(at(2026, 9, 2, 23), now)).toBe('earlier')
    expect(dayBucket(0, now)).toBe('earlier') // never active
  })

  it('opens a section where the bucket changes and nowhere else', () => {
    const rows = withSections(['a', 'b', 'c', 'd'], (x) => (x === 'a' ? 'pinned' : x === 'd' ? 'earlier' : 'today'))
    expect(rows.map((r) => ('section' in r ? `#${r.section}` : r.item))).toEqual(['#pinned', 'a', '#today', 'b', 'c', '#earlier', 'd'])
    expect(withSections([], () => 'today')).toEqual([])
  })
})
