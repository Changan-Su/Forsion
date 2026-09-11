import { describe, expect, it } from 'vitest'
import { groupRows, groupValueKey, visibleGroups } from './groupRows'
import { parseDb, type CellValue, type DbColumn, type DbRow, type DbView } from './schema'

const view: DbView = { id: 'v', name: 'Table', type: 'table', groupBy: 'g' }
const col: DbColumn = { id: 'g', name: 'Group', type: 'text' }
const rows = (...values: CellValue[]): DbRow[] => values.map((v, i) => ({ id: String(i), cells: { g: v } }))

describe('property groups', () => {
  it('keeps blank distinct from literal sentinel-like values; preserves group row order', () => {
    const result = groupRows(rows('__none', null, 'empty:', '__none'), col, 'text', view)
    expect(result.map((g) => g.value)).toEqual(['__none', 'empty:', null])
    expect(result[0].rows.map((r) => r.id)).toEqual(['0', '3'])
    expect(new Set(result.map((g) => g.key)).size).toBe(3)
  })
  it('groups each multi-select value once and retains unknown values and blank arrays', () => {
    const result = groupRows(rows(['A', 'A', 'B'], ['unknown'], [], ['']), { ...col, options: ['B', 'A', 'unused'] }, 'multiselect', view)
    expect(result.map((g) => [g.value, g.rows.length])).toEqual([['B', 1], ['A', 1], ['unused', 0], ['unknown', 1], [null, 2]])
  })
  it('sorts numbers numerically, keeps zero distinct from blank, and groups checkbox false', () => {
    expect(groupRows(rows(10, 2, 0, null), col, 'number', view).map((g) => g.value)).toEqual([0, 2, 10, null])
    expect(groupRows(rows(false, null, true), col, 'checkbox', view).map((g) => g.rows.length)).toEqual([2, 1])
  })
  it('manual order, hidden groups and hide-empty compose after filtering without changing source data', () => {
    const source = rows('A', 'B', 'C', null), before = JSON.stringify(source)
    const v = { ...view, groupSort: 'manual' as const, groupOrder: [groupValueKey('C'), groupValueKey('A')], groupHidden: [groupValueKey('A')], groupHideEmpty: true }
    const groups = groupRows(source.slice(0, 3), col, 'text', v, source)
    expect(groups.map((g) => g.value)).toEqual(['C', 'A', 'B', null])
    expect(visibleGroups(groups, v).map((g) => g.value)).toEqual(['C', 'B'])
    expect(JSON.stringify(source)).toBe(before)
  })
  it('uses display labels for alphabetical sort and stable IDs for manual order', () => {
    const column = { ...col, options: ['id-z', 'id-a'], optionLabels: { 'id-z': 'Alpha', 'id-a': 'Beta' } }
    expect(groupRows(rows('id-a', 'id-z'), column, 'select', { ...view, groupSort: 'asc' }).map((g) => g.value)).toEqual(['id-z', 'id-a', null])
  })
  it('date grouping preserves local calendar days and month boundaries', () => {
    const source = rows('2026-09-01T00:10/2026-09-03', '2026-08-31T23:59', null)
    expect(groupRows(source, col, 'date', { ...view, groupUnit: 'month' }).map((g) => g.value)).toEqual(['2026-08', '2026-09', null])
  })
  it('all view options and labels survive the file parser', () => {
    const configured = { ...view, groupSort: 'desc', groupHidden: ['empty:'], groupOrder: ['value:"a"'], groupHideEmpty: true }
    const file = { version: 1, name: 'DB', columns: [{ ...col, optionLabels: { a: 'Alpha' } }], rows: rows('a'), views: [configured] }
    const parsed = parseDb(JSON.stringify(file))
    expect(parsed).toMatchObject({ ok: true, data: file })
  })
})
