// 甘特视图纯逻辑:起止列解析 / 区间(跨月、空日期、end<start)/ 轴范围 / 刻度 / 条几何 / 整体布局。
// 天数算术走 Date.UTC:本文件在 TZ=Australia/Lord_Howe 等五个时区下也必须绿(test:ics-tz 同款跑法)。
import { describe, expect, it } from 'vitest'
import type { DbColumn, DbRow } from '@amadeus-shared/db/schema'
import {
  PX_PER_DAY, addDays, daysBetween, ganttBar, ganttDateCols, ganttLayout, ganttRange, ganttScaleOf, ganttSpanOf, ganttTicks,
  resolveGanttCols, todayYmd, weekdayOf,
} from './ganttLogic'

const title: DbColumn = { id: 't', name: '任务', type: 'text' }
const start: DbColumn = { id: 's', name: '开始', type: 'calendarDate' }
const end: DbColumn = { id: 'e', name: '结束', type: 'calendarDate' }
const due: DbColumn = { id: 'd', name: '截止', type: 'date' } // primitive date:刻意不算甘特候选
const row = (id: string, cells: DbRow['cells']): DbRow => ({ id, cells })

describe('ganttLogic · 起止列解析', () => {
  it('只认 calendarDate 列;startCol 缺 → 第一个 calendarDate;endCol 缺 → = start', () => {
    expect(ganttDateCols([title, start, due, end]).map((c) => c.id)).toEqual(['s', 'e'])
    const r = resolveGanttCols([title, start, end], {})
    expect(r?.start.id).toBe('s')
    expect(r?.end.id).toBe('s')
    const r2 = resolveGanttCols([title, start, end], { gantt: { startCol: 'e', endCol: 's' } })
    expect([r2?.start.id, r2?.end.id]).toEqual(['e', 's'])
  })
  it('指向已删 / 非 calendarDate 的列 → 回落;没有 calendarDate 列 → null', () => {
    // startCol 指 primitive date 列:不算候选,回落第一个 calendarDate
    const r = resolveGanttCols([title, due, start, end], { gantt: { startCol: 'd', endCol: 'gone' } })
    expect([r?.start.id, r?.end.id]).toEqual(['s', 's'])
    expect(resolveGanttCols([title, due], { gantt: { startCol: 'd' } })).toBeNull()
  })
  it('scale 未知回退 day', () => {
    expect(ganttScaleOf('week')).toBe('week')
    expect(ganttScaleOf('month')).toBe('day')
    expect(ganttScaleOf(undefined)).toBe('day')
  })
})

describe('ganttLogic · 行的区间', () => {
  it('单日 → 一天;同格区间 a/b → a..b(跨月照算);时刻分量不影响天数', () => {
    expect(ganttSpanOf(row('r', { s: '2026-03-16' }), start, start)).toEqual({ s: '2026-03-16', e: '2026-03-16' })
    expect(ganttSpanOf(row('r', { s: '2026-03-30/2026-04-02' }), start, start)).toEqual({ s: '2026-03-30', e: '2026-04-02' })
    expect(ganttSpanOf(row('r', { s: '2026-03-16T10:00/2026-03-16T11:30' }), start, start)).toEqual({ s: '2026-03-16', e: '2026-03-16' })
  })
  it('独立结束列:有值取其末侧(自身是区间取 end);空 → 退回开始列自身的区间末侧,再退回开始', () => {
    expect(ganttSpanOf(row('r', { s: '2026-03-16', e: '2026-03-20' }), start, end)).toEqual({ s: '2026-03-16', e: '2026-03-20' })
    expect(ganttSpanOf(row('r', { s: '2026-03-16', e: '2026-03-20/2026-03-22' }), start, end)).toEqual({ s: '2026-03-16', e: '2026-03-22' })
    expect(ganttSpanOf(row('r', { s: '2026-03-16/2026-03-18' }), start, end)).toEqual({ s: '2026-03-16', e: '2026-03-18' })
    expect(ganttSpanOf(row('r', { s: '2026-03-16' }), start, end)).toEqual({ s: '2026-03-16', e: '2026-03-16' })
  })
  it('end < start → 夹成一天(不交换);只有结束没有开始 → 该日单日', () => {
    expect(ganttSpanOf(row('r', { s: '2026-03-20', e: '2026-03-16' }), start, end)).toEqual({ s: '2026-03-20', e: '2026-03-20' })
    expect(ganttSpanOf(row('r', { s: '2026-03-20/2026-03-16' }), start, start)).toEqual({ s: '2026-03-20', e: '2026-03-20' })
    expect(ganttSpanOf(row('r', { e: '2026-03-16' }), start, end)).toEqual({ s: '2026-03-16', e: '2026-03-16' })
  })
  it('空 / 缺 / 非法串 / 非字符串 → null(= 无日期行)', () => {
    expect(ganttSpanOf(row('r', {}), start, end)).toBeNull()
    expect(ganttSpanOf(row('r', { s: '' }), start, start)).toBeNull()
    expect(ganttSpanOf(row('r', { s: '昨天' }), start, start)).toBeNull()
    expect(ganttSpanOf(row('r', { s: 42, e: true }), start, end)).toBeNull()
    expect(ganttSpanOf(row('r', { s: null }), start, start)).toBeNull()
  })
})

describe('ganttLogic · 天数算术(时区无关)', () => {
  it('daysBetween / addDays 跨月跨年 / 闰日', () => {
    expect(daysBetween('2026-03-30', '2026-04-02')).toBe(3)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    expect(daysBetween('2026-03-16', '2026-03-16')).toBe(0)
    expect(addDays('2026-03-30', 3)).toBe('2026-04-02')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })
  it('weekdayOf:2026-09-02 是周三;todayYmd 取本地 y/m/d', () => {
    expect(weekdayOf('2026-09-02')).toBe(3)
    expect(weekdayOf('2026-09-06')).toBe(0)
    expect(todayYmd(new Date(2026, 8, 2, 23, 59))).toBe('2026-09-02')
    expect(todayYmd(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})

describe('ganttLogic · 轴范围与刻度', () => {
  it('日档:覆盖全部条 + 今天,两端各留 3 天', () => {
    const r = ganttRange([{ s: '2026-03-16', e: '2026-03-18' }, { s: '2026-03-30', e: '2026-04-02' }], '2026-03-20', 'day')
    expect(r).toEqual({ from: '2026-03-13', to: '2026-04-05' })
    // 今天在条之外也必须进轴
    expect(ganttRange([{ s: '2026-03-16', e: '2026-03-18' }], '2026-04-10', 'day')).toEqual({ from: '2026-03-13', to: '2026-04-13' })
  })
  it('周档:留 1 周再对齐到周日起 / 周六止;无条 → 今天前后各 14 天', () => {
    const r = ganttRange([{ s: '2026-03-16', e: '2026-03-18' }], '2026-03-20', 'week')
    expect(weekdayOf(r.from)).toBe(0)
    expect(weekdayOf(r.to)).toBe(6)
    expect(r.from <= '2026-03-09' && r.to >= '2026-03-27').toBe(true)
    expect(ganttRange([], '2026-09-02', 'day')).toEqual({ from: '2026-08-16', to: '2026-09-19' })
  })
  it('日档刻度:每天一格,首格与每月 1 号 major 标「M/D」(28px 格里「M月D日」放不下),周末标 weekend', () => {
    const t = ganttTicks('2026-03-28', '2026-04-03', 'day')
    expect(t).toHaveLength(7)
    expect(t.every((x) => x.days === 1)).toBe(true)
    expect(t[0]).toMatchObject({ date: '2026-03-28', label: '3/28', major: true, weekend: true }) // 周六
    expect(t[1]).toMatchObject({ label: '29', major: false, weekend: true })
    expect(t[4]).toMatchObject({ date: '2026-04-01', label: '4/1', major: true, weekend: false })
    expect(t[6]).toMatchObject({ label: '3', major: false, weekend: false })
  })
  it('周档刻度:每 7 天一格(末格可短),标「M/D」,含 1-7 号那周 major', () => {
    const t = ganttTicks('2026-03-29', '2026-04-14', 'week') // 17 天 → 7+7+3
    expect(t.map((x) => x.days)).toEqual([7, 7, 3])
    expect(t.map((x) => x.label)).toEqual(['3/29', '4/5', '4/12'])
    expect(t.map((x) => x.major)).toEqual([true, true, false])
  })
})

describe('ganttLogic · 条几何与整体布局', () => {
  it('条:left 按距轴首日天数,width 按闭区间天数;跨月与单日', () => {
    expect(ganttBar({ s: '2026-03-16', e: '2026-03-16' }, '2026-03-13', 'day')).toEqual({ left: 3 * 28, width: 28 })
    expect(ganttBar({ s: '2026-03-30', e: '2026-04-02' }, '2026-03-13', 'day')).toEqual({ left: 17 * 28, width: 4 * 28 })
    expect(ganttBar({ s: '2026-03-30', e: '2026-04-02' }, '2026-03-13', 'week')).toEqual({ left: 17 * 8, width: 4 * 8 })
  })
  const rows = [
    row('a', { t: '装机', s: '2026-03-16/2026-03-18' }),
    row('b', { t: '无日期', s: '' }),
    row('c', { t: '送货', s: '2026-03-20' }),
    row('d', { t: '采购', s: '2026-03-30', e: '2026-04-02' }),
    row('e', { t: '也无日期' }),
  ]
  it('布局:有日期行保持传入顺序,无日期行排底且保序;left 随开始日期单调;今日线 = 当天开始的条的 left', () => {
    const lay = ganttLayout(rows, start, end, 'day', '2026-03-20')
    expect(lay.dated.map((d) => d.row.id)).toEqual(['a', 'c', 'd'])
    expect(lay.undated.map((r) => r.id)).toEqual(['b', 'e'])
    expect(lay.from).toBe('2026-03-13')
    expect(lay.to).toBe('2026-04-05')
    expect(lay.days).toBe(24)
    expect(lay.width).toBe(24 * PX_PER_DAY.day)
    expect(lay.ticks).toHaveLength(24)
    const lefts = [...lay.dated].sort((x, y) => (x.span.s < y.span.s ? -1 : 1)).map((d) => d.left)
    expect(lefts).toEqual([...lefts].sort((x, y) => x - y))
    expect(lay.todayLeft).toBe(lay.dated.find((d) => d.row.id === 'c')?.left)
    expect(lay.dated.find((d) => d.row.id === 'd')).toMatchObject({ left: 17 * 28, width: 4 * 28 })
  })
  it('周档:同一份行,宽度按 8px/天;今天不在轴上 → todayLeft null(自定义范围的保底分支)', () => {
    const lay = ganttLayout(rows, start, end, 'week', '2026-03-20')
    expect(lay.dated.find((d) => d.row.id === 'd')?.width).toBe(4 * 8)
    expect(weekdayOf(lay.from)).toBe(0)
    expect(lay.width).toBe(lay.days * 8)
    expect(lay.todayLeft).not.toBeNull()
  })
  it('空表:仍有轴(今天前后各 14 天)、零条、今日线在', () => {
    const lay = ganttLayout([], start, start, 'day', '2026-09-02')
    expect(lay.dated).toEqual([])
    expect(lay.days).toBe(35)
    expect(lay.todayLeft).toBe(17 * 28)
  })
})
