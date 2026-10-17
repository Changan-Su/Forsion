import { describe, expect, it } from 'vitest'
import { ORDER, bucketOf, dropDay, inView, moveToDay, sortTimeOf } from './todoGroups'

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

describe('moveToDay(拖到分组头改日期)', () => {
  const D = (y: number, m: number, d: number) => new Date(y, m - 1, d)
  it('全天 → 换日子', () => expect(moveToDay('2026-08-27', D(2026, 8, 29))).toBe('2026-08-29'))
  it('带钟点 → 只换日子,钟点不动', () => expect(moveToDay('2026-08-28T17:00', D(2026, 8, 29))).toBe('2026-08-29T17:00'))
  it('跨天 → 两侧平移同样天数(跨月)', () => expect(moveToDay('2026-08-30T09:00/2026-09-01T10:00', D(2026, 9, 2))).toBe('2026-09-02T09:00/2026-09-04T10:00'))
  it('原来没日期 → 落成那一天的全天', () => expect(moveToDay('', D(2026, 8, 28))).toBe('2026-08-28'))
  it('day = null → 清空', () => expect(moveToDay('2026-08-28T17:00', null)).toBe(''))
})

describe('筛选与拖放目标', () => {
  it('今天 = 逾期 + 今天;计划不含未排期;全部都在', () => {
    expect(ORDER.filter((b) => inView('today', b))).toEqual(['overdue', 'today'])
    expect(ORDER.filter((b) => inView('plan', b))).toEqual(['overdue', 'today', 'tomorrow', 'week', 'later'])
    expect(ORDER.filter((b) => inView('all', b))).toEqual(ORDER)
  })
  it('只有今天 / 明天 / 未排期收拖放,本周 / 以后 / 逾期不收', () => {
    expect(dropDay('today', TODAY)?.getDate()).toBe(28)
    expect(dropDay('tomorrow', TODAY)?.getDate()).toBe(29)
    expect(dropDay('undated', TODAY)).toBeNull()
    for (const b of ['week', 'later', 'overdue'] as const) expect(dropDay(b, TODAY)).toBeUndefined()
  })
})
