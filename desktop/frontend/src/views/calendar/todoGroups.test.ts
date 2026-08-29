import { describe, expect, it } from 'vitest'
import { ORDER, bucketOf, sortTimeOf } from './todoGroups'

const TODAY = new Date(2026, 7, 28) // 2026-08-28
const b = (raw: string) => bucketOf(raw, TODAY)

describe('bucketOf', () => {
  it('空 / 解析不出 → 未排期(笔记正文任务天然全部落这里)', () => {
    expect(b('')).toBe('undated')
    expect(b('不是日期')).toBe('undated')
  })

  it('六个桶的边界', () => {
    expect(b('2026-08-27')).toBe('overdue')
    expect(b('2026-08-28')).toBe('today')
    expect(b('2026-08-28T23:59')).toBe('today')
    expect(b('2026-08-29')).toBe('tomorrow')
    expect(b('2026-08-30')).toBe('week')
    expect(b('2026-09-04')).toBe('week') // +7 天仍算本周
    expect(b('2026-09-05')).toBe('later') // +8 天出界
  })

  it('带时间的逾期日仍是逾期(按天判,不按时刻)', () => {
    expect(b('2026-08-27T23:59/2026-08-27T23:59')).toBe('overdue')
  })

  // 负对照:把 'overdue' 挪到 ORDER 末尾,这条必须变红。
  it('桶序是硬编码的,逾期在最前、未排期在最后', () => {
    expect(ORDER).toEqual(['overdue', 'today', 'tomorrow', 'week', 'later', 'undated'])
    expect(ORDER.indexOf('overdue')).toBeLessThan(ORDER.indexOf('today'))
    expect(ORDER.indexOf('undated')).toBe(ORDER.length - 1)
  })

  it('ORDER 覆盖 bucketOf 能产出的全部桶(加了新桶忘了插进 ORDER 就红)', () => {
    const produced = ['', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-09-30'].map(b)
    for (const x of produced) expect(ORDER).toContain(x)
    expect(new Set(produced).size).toBe(6)
  })
})

describe('sortTimeOf', () => {
  it('无日期恒沉底', () => {
    expect(sortTimeOf('')).toBe(Number.POSITIVE_INFINITY)
    expect(sortTimeOf('2026-08-28') < sortTimeOf('')).toBe(true)
  })
})
