import { describe, expect, it } from 'vitest'
import { baseKind, cellDisplay, resolveDbTable } from './readonlyView'
import type { DbFile } from './schema'

const db = (over: Partial<DbFile>): DbFile => ({
  version: 1, name: 'T',
  columns: [
    { id: 'c1', name: '名称', type: 'text' },
    { id: 'c2', name: '数量', type: 'number' },
    { id: 'c3', name: '完成', type: 'checkbox' },
  ],
  rows: [
    { id: 'r1', cells: { c1: 'b', c2: 2, c3: true } },
    { id: 'r2', cells: { c1: 'a', c2: 5, c3: false } },
  ],
  ...over,
})

describe('resolveDbTable', () => {
  it('classic table renders all columns and rows by default', () => {
    const t = resolveDbTable(db({}))
    expect(t.noteView).toBe(false)
    expect(t.columns.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(t.rows.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
  it('hides columns listed in the first view.hidden', () => {
    const t = resolveDbTable(db({ views: [{ id: 'v', name: 'V', type: 'table', hidden: ['c2'] }] }))
    expect(t.columns.map((c) => c.id)).toEqual(['c1', 'c3'])
  })
  it('applies the view filter', () => {
    const t = resolveDbTable(db({ views: [{ id: 'v', name: 'V', type: 'table', filters: [{ colId: 'c3', op: 'checked' }] }] }))
    expect(t.rows.map((r) => r.id)).toEqual(['r1']) // only the checked row
  })
  it('applies the view sort (number asc / desc)', () => {
    const asc = resolveDbTable(db({ views: [{ id: 'v', name: 'V', type: 'table', sort: { colId: 'c2', dir: 'asc' } }] }))
    expect(asc.rows.map((r) => r.id)).toEqual(['r1', 'r2']) // 2, 5
    const desc = resolveDbTable(db({ views: [{ id: 'v', name: 'V', type: 'table', sort: { colId: 'c2', dir: 'desc' } }] }))
    expect(desc.rows.map((r) => r.id)).toEqual(['r2', 'r1']) // 5, 2
  })
  it('note-view db (source) yields columns but no rows', () => {
    const t = resolveDbTable(db({ source: { folder: 'People' }, rows: [] }))
    expect(t.noteView).toBe(true)
    expect(t.rows).toEqual([])
    expect(t.columns.length).toBe(3)
  })
})

describe('cellDisplay', () => {
  it('checkbox → checked flag', () => {
    expect(cellDisplay(true, 'checkbox')).toEqual({ checked: true })
    expect(cellDisplay(undefined, 'checkbox')).toEqual({ checked: false })
  })
  it('multiselect / select → chips', () => {
    expect(cellDisplay(['x', 'y'], 'multiselect')).toEqual({ chips: ['x', 'y'] })
    expect(cellDisplay('one', 'select')).toEqual({ chips: ['one'] })
  })
  it('text / number → text', () => {
    expect(cellDisplay('hi', 'text')).toEqual({ text: 'hi' })
    expect(cellDisplay(42, 'number')).toEqual({ text: '42' })
  })
  it('unknown/custom column type falls back to text', () => {
    expect(baseKind('todo')).toBe('text')
    expect(cellDisplay('v', 'todo')).toEqual({ text: 'v' })
  })
})
