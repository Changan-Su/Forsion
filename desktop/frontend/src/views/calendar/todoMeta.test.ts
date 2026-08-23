import { describe, expect, it } from 'vitest'
import { todoDueMeta } from './todoMeta'

const now = new Date(2026, 7, 22, 12)

describe('todoDueMeta', () => {
  it('区分逾期/今天/明天与未设日期', () => {
    expect(todoDueMeta('2026-08-21T09:30', now)).toMatchObject({ label: '逾期 8/21 09:30', tone: 'overdue' })
    expect(todoDueMeta('2026-08-22T18:00', now)).toMatchObject({ label: '今天 18:00', tone: 'today' })
    expect(todoDueMeta('2026-08-23', now)).toMatchObject({ label: '明天', tone: 'future' })
    expect(todoDueMeta('', now)).toMatchObject({ label: '未设日期', tone: 'muted' })
  })
})
