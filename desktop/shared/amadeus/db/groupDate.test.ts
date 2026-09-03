// 日期分组纯逻辑:日/月两档取前 10 / 前 7 位、区间按起始侧、脏值归「未设置」且恒排最后。
import { describe, expect, it } from 'vitest'
import { dateGroupKey, dateGroupUnitOf, groupRowsByDate } from './groupDate'

type Row = { id: string; cells: Record<string, string | null> }
const rows: Row[] = [
  { id: 'a', cells: { d: '2026-09-02' } }, // date 列
  { id: 'b', cells: { d: '2026-09-02T10:00/2026-09-02T11:30' } }, // calendarDate 带时刻
  { id: 'c', cells: { d: '2026-08-30/2026-09-05' } }, // 跨月区间 → 按起始侧 08-30
  { id: 'd', cells: { d: '2026-10-01T09:31' } }, // created
  { id: 'e', cells: {} }, // 缺键
  { id: 'f', cells: { d: '' } }, // 空串
]
const shape = (unit: 'day' | 'month'): Array<[string, string[]]> =>
  groupRowsByDate(rows, 'd', unit).map((g) => [g.key, g.rows.map((r) => r.id)])

describe('dateGroupKey(分组键)', () => {
  it('day = 前 10 位、month = 前 7 位;区间取起始侧;带时刻照样只看日期段', () => {
    expect(dateGroupKey('2026-09-02', 'day')).toBe('2026-09-02')
    expect(dateGroupKey('2026-09-02', 'month')).toBe('2026-09')
    expect(dateGroupKey('2026-08-30/2026-09-05', 'day')).toBe('2026-08-30')
    expect(dateGroupKey('2026-08-30/2026-09-05', 'month')).toBe('2026-08')
    expect(dateGroupKey('2026-10-01T09:31', 'day')).toBe('2026-10-01')
  })

  it('非串 / 形状不对 / 空 → `\'\'`(未设置);不做时区换算(串进串出,零 Date)', () => {
    for (const v of [undefined, null, 7, true, '', '不是日期', '2026-9-2', '20260902'] as never[]) {
      expect(dateGroupKey(v, 'day')).toBe('')
    }
    // 00:00 与 23:59 同日:经 Date 折算的实现会在 UTC±N 时区把其中一侧推到隔天,这里恒同组
    expect(dateGroupKey('2026-09-02T00:00', 'day')).toBe(dateGroupKey('2026-09-02T23:59', 'day'))
  })

  it('dateGroupUnitOf 只认 day/month,其余回落 day', () => {
    expect([dateGroupUnitOf(undefined), dateGroupUnitOf('day'), dateGroupUnitOf('month'), dateGroupUnitOf('year')])
      .toEqual(['day', 'day', 'month', 'day'])
  })
})

describe('groupRowsByDate(按日期列分组)', () => {
  it('日档:键升序,同日行合并,未设置恒最后;组内保持输入序', () => {
    expect(shape('day')).toEqual([
      ['2026-08-30', ['c']],
      ['2026-09-02', ['a', 'b']],
      ['2026-10-01', ['d']],
      ['', ['e', 'f']],
    ])
  })

  it('月档:同月合并成一组(跨月区间归起始月)', () => {
    expect(shape('month')).toEqual([['2026-08', ['c']], ['2026-09', ['a', 'b']], ['2026-10', ['d']], ['', ['e', 'f']]])
  })

  it('没有空值行就不造空组;全是空值时「未设置」是唯一一组;总行数恒等于输入', () => {
    const dated = rows.filter((r) => r.cells.d)
    expect(groupRowsByDate(dated, 'd', 'day').some((g) => g.key === '')).toBe(false)
    expect(groupRowsByDate(rows.filter((r) => !r.cells.d), 'd', 'day').map((g) => g.key)).toEqual([''])
    for (const unit of ['day', 'month'] as const) {
      expect(groupRowsByDate(rows, 'd', unit).reduce((s, g) => s + g.rows.length, 0)).toBe(rows.length)
    }
    expect(groupRowsByDate([], 'd', 'day')).toEqual([])
  })
})
