import { describe, expect, it } from 'vitest'
import { foldBucket, foldKey, foldMinutesOf, foldRowId, foldRows, foldSummary, foldTimeMs, resolveFold } from './foldRows'
import type { CellValue, DbColumn, DbRow } from './schema'

const cols: DbColumn[] = [
  { id: 'at', name: 'Time', type: 'date' },
  { id: 'user', name: 'User', type: 'text' },
  { id: 'model', name: 'Model', type: 'text' },
  { id: 'tokens', name: 'Tokens', type: 'number' },
  { id: 'ok', name: 'OK', type: 'checkbox' },
  { id: 'tags', name: 'Tags', type: 'multiselect' },
]
const kindOf = (c: DbColumn): string => c.type
const row = (id: string, cells: Record<string, CellValue>): DbRow => ({ id, cells })
const usage = { by: ['user'], timeCol: 'at', minutes: 30 }

describe('规则行折叠', () => {
  it('同用户同 30 分钟窗折成一个单元;跨窗 / 换用户另起;单元序 = 首次出现序,同键不要求相邻', () => {
    const rows = [
      row('1', { at: '2026-09-21T14:29', user: 'alice' }),
      row('2', { at: '2026-09-21T14:05', user: 'bob' }),
      row('3', { at: '2026-09-21T14:00', user: 'alice' }), // 与 1 同窗(14:00–14:30),中间隔着 bob
      row('4', { at: '2026-09-21T14:30', user: 'alice' }), // 14:30 属于下一个窗
    ]
    expect(foldRows(rows, usage).map((u) => u.rows.map((r) => r.id))).toEqual([['1', '3'], ['2'], ['4']])
  })

  it('窗口按本地时钟对齐:本地纯日期串不经 UTC;1440 分钟 = 本地自然日', () => {
    const midnight = new Date(2026, 8, 21, 0, 0).getTime()
    expect(foldTimeMs('2026-09-21')).toBe(midnight) // 丢给 Date.parse 会得到 UTC 午夜,东八区之外整片错一天
    expect(foldTimeMs('2026-09-21T10:00/2026-09-21T11:00')).toBe(new Date(2026, 8, 21, 10, 0).getTime()) // 区间取起始侧
    expect(foldTimeMs(new Date(2026, 8, 21, 14, 3).toISOString())).toBe(new Date(2026, 8, 21, 14, 3).getTime()) // 带时区的 ISO(插件表)
    expect(foldBucket(midnight, 1440)).toBe(foldBucket(new Date(2026, 8, 21, 23, 59).getTime(), 1440))
    expect(foldBucket(midnight, 1440)).not.toBe(foldBucket(midnight - 60000, 1440))
    expect(foldTimeMs('')).toBeNull()
    expect(foldTimeMs('not a date')).toBeNull()
  })

  it('配了时间列但没有时刻的行不可折:各自成单元,绝不互相凑组', () => {
    const rows = [row('1', { user: 'alice' }), row('2', { user: 'alice', at: '' }), row('3', { user: 'alice', at: '2026-09-21T14:00' })]
    expect(foldKey(rows[0], usage)).toBeNull()
    expect(foldRows(rows, usage).map((u) => u.rows.length)).toEqual([1, 1, 1])
    expect(new Set(foldRows(rows, usage).map((u) => u.key)).size).toBe(3)
  })

  it('只给 by 不给时间列 = 纯按值折;空串 / null / 缺 同键;1 与 "1" 同键', () => {
    const rows = [row('1', { user: '' }), row('2', { user: null }), row('3', {}), row('4', { user: 1 }), row('5', { user: '1' })]
    expect(foldRows(rows, { by: ['user'] }).map((u) => u.rows.map((r) => r.id))).toEqual([['1', '2', '3'], ['4', '5']])
  })

  it('规则按现有列解析:已删的列丢掉,by 与 timeCol 都落空 = 不折叠;minutes 坏值回落 30', () => {
    expect(resolveFold({ by: ['gone'], timeCol: 'gone2' }, cols)).toBeNull()
    expect(resolveFold(undefined, cols)).toBeNull()
    expect(resolveFold({ by: ['user', 'gone', 'user'], timeCol: 'at' }, cols)).toEqual({ by: ['user'], timeCol: 'at', minutes: 30 })
    expect(foldMinutesOf({ minutes: -5 })).toBe(30)
    expect(foldMinutesOf({ minutes: Number.NaN })).toBe(30)
    expect(foldMinutesOf({ minutes: 10 })).toBe(10)
  })

  it('汇总:数字求和;单一值保留原值;混合值列出内容与次数;日期取最晚且按时间升序列出;checkbox 缺值 = 未勾', () => {
    const unit = foldRows([
      row('1', { at: '2026-09-21T14:20', user: 'alice', model: 'gpt', tokens: 100, ok: true, tags: ['a'] }),
      row('2', { at: '2026-09-21T14:03', user: 'alice', model: 'claude', tokens: 50, tags: ['b', 'a'] }),
      row('3', { at: '2026-09-21T14:10', user: 'alice', model: 'gpt', tokens: null, ok: false }),
    ], usage)[0]
    const s = foldSummary(unit, cols, kindOf)
    expect(s.row.id).toBe(foldRowId(unit.key))
    expect(s.row.cells.tokens).toBe(150)
    expect(s.row.cells.user).toBe('alice')
    expect(s.mixed.user).toBeUndefined()
    expect(s.row.cells.model).toBe('gpt, claude')
    expect(s.mixed.model.map((m) => [m.value, m.count, m.rowId])).toEqual([['gpt', 2, '1'], ['claude', 1, '2']])
    expect(s.row.cells.at).toBe('2026-09-21T14:20') // 最晚:按它排序 = 按最近活动排
    expect(s.mixed.at.map((m) => m.value)).toEqual(['2026-09-21T14:03', '2026-09-21T14:10', '2026-09-21T14:20'])
    expect(s.row.cells.ok).toBe(false)
    expect(s.mixed.ok.map((m) => [m.value, m.count])).toEqual([[true, 1], [false, 2]]) // 缺值与 false 是同一种
    expect(s.row.cells.tags).toEqual(['a', 'b'])
    expect(s.mixed.tags).toBeUndefined()
  })

  it('不改动源行', () => {
    const rows = [row('1', { at: '2026-09-21T14:00', user: 'a', tokens: 1 }), row('2', { at: '2026-09-21T14:01', user: 'a', tokens: 2 })]
    const before = JSON.stringify(rows)
    foldSummary(foldRows(rows, usage)[0], cols, kindOf)
    expect(JSON.stringify(rows)).toBe(before)
  })
})
