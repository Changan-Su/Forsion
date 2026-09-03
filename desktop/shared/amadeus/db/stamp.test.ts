// updated(修改时间)盖章纯逻辑。负对照(已实跑红):cellsChanged 去掉「引用相同 → 未变」外的 JSON 比对、改成一律
// 盖章 → 「没动的行不盖」红;stampUpdatedRows 去掉 `!p` 分支(新行也盖)→ 「新增行不盖」红。
import { describe, expect, it } from 'vitest'
import type { DbFile } from './schema'
import { localMinuteStamp, stampUpdatedRows } from './stamp'

const NOW = new Date(2026, 8, 2, 9, 5)
const db = (): DbFile => ({
  version: 1, name: 'T',
  columns: [{ id: 'c1', name: '名称', type: 'text' }, { id: 'u', name: '修改时间', type: 'updated' }],
  rows: [{ id: 'r1', cells: { c1: '甲', u: '2026-01-01T00:00' } }, { id: 'r2', cells: { c1: '乙', u: '2026-01-01T00:00' } }],
})

describe('stampUpdatedRows', () => {
  it('格式 YYYY-MM-DDTHH:mm', () => {
    expect(localMinuteStamp(NOW)).toBe('2026-09-02T09:05')
  })
  it('只对内容真变了的行盖章;没动的行原样(引用不变)', () => {
    const prev = db()
    const next = { ...prev, rows: [{ id: 'r1', cells: { ...prev.rows[0].cells, c1: '甲2' } }, prev.rows[1]] }
    const out = stampUpdatedRows(prev, next, NOW)
    expect(out.rows[0].cells).toEqual({ c1: '甲2', u: '2026-09-02T09:05' })
    expect(out.rows[1]).toBe(prev.rows[1])
  })
  it('cells 换了对象但内容一样 → 不盖;只有 updated 列自己变了 → 不盖', () => {
    const prev = db()
    const same = { ...prev, rows: prev.rows.map((r) => ({ ...r, cells: { ...r.cells } })) }
    expect(stampUpdatedRows(prev, same, NOW)).toBe(same)
    const onlyU = { ...prev, rows: [{ id: 'r1', cells: { c1: '甲', u: '2020-01-01T00:00' } }, prev.rows[1]] }
    expect(stampUpdatedRows(prev, onlyU, NOW).rows[0].cells.u).toBe('2020-01-01T00:00')
  })
  it('新增行 / 恢复的行不盖(建行初值由 initialValue 盖);删行、只改列定义不盖', () => {
    const prev = db()
    const added = { ...prev, rows: [...prev.rows, { id: 'r3', cells: { c1: '丙' } }] }
    expect(stampUpdatedRows(prev, added, NOW).rows[2].cells.u).toBeUndefined()
    const removed = { ...prev, rows: [prev.rows[0]] }
    expect(stampUpdatedRows(prev, removed, NOW)).toBe(removed)
    const renamed = { ...prev, columns: [{ ...prev.columns[0], name: '改名' }, prev.columns[1]] }
    expect(stampUpdatedRows(prev, renamed, NOW)).toBe(renamed)
  })
  it('表里没有 updated 列 → 原样返回 next(零开销)', () => {
    const prev: DbFile = { version: 1, name: 'T', columns: [{ id: 'c1', name: '名称', type: 'text' }], rows: [{ id: 'r1', cells: { c1: '甲' } }] }
    const next = { ...prev, rows: [{ id: 'r1', cells: { c1: '乙' } }] }
    expect(stampUpdatedRows(prev, next, NOW)).toBe(next)
  })
  it('null 与缺键视同(清空一格再删键不算变);多个 updated 列都盖', () => {
    const prev = db()
    const nulled = { ...prev, rows: [{ id: 'r1', cells: { c1: '甲', u: '2026-01-01T00:00', x: null } }, prev.rows[1]] }
    expect(stampUpdatedRows(prev, nulled, NOW)).toBe(nulled)
    const two: DbFile = { ...prev, columns: [...prev.columns, { id: 'u2', name: '修改2', type: 'updated' }] }
    const next = { ...two, rows: [{ id: 'r1', cells: { c1: '改' } }, prev.rows[1]] }
    expect(stampUpdatedRows(two, next, NOW).rows[0].cells).toEqual({ c1: '改', u: '2026-09-02T09:05', u2: '2026-09-02T09:05' })
  })
})
