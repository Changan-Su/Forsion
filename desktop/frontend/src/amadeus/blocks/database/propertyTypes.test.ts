/** 属性注册表的建行接缝:newRowCells 只对声明了 initialValue 的已注册类型盖章;isStamped 只认两个内置名。
 *  纯逻辑,自己注册一个假类型即可(不依赖 builtins,免得加载期拉进 pageStore/图标)。 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import { isStamped, newRowCells, registerPropertyType, unregisterPropertyType } from './propertyTypes'

const db = (rows: DbFile['rows']): DbFile => ({
  version: 1,
  name: 'T',
  columns: [
    { id: 'c1', name: '名称', type: 'text' },
    { id: 'seq', name: '序号', type: 'fakeSeq' },
    { id: 'plain', name: '普通自定义', type: 'fakePlain' },
    { id: 'nil', name: '不盖章', type: 'fakeNil' },
  ],
  rows,
})

afterEach(() => {
  unregisterPropertyType('fakeSeq')
  unregisterPropertyType('fakePlain')
  unregisterPropertyType('fakeNil')
})

describe('newRowCells', () => {
  it('未注册 / 已注册但没有 initialValue 的类型 → 不盖章;有的 → 按当时的 rows 算', () => {
    registerPropertyType({ type: 'fakeSeq', label: '序', icon: '#', baseType: 'number', Cell: () => null, initialValue: ({ rows, column }) => rows.length + 1 + (column.id === 'seq' ? 100 : 0) })
    registerPropertyType({ type: 'fakePlain', label: '普', icon: '·', baseType: 'text', Cell: () => null })
    expect(newRowCells(db([]))).toEqual({ seq: 101 })
    expect(newRowCells(db([{ id: 'r1', cells: {} }, { id: 'r2', cells: {} }]))).toEqual({ seq: 103 })
  })

  it('initialValue 返回 null → 该列不出现在结果里(不写 null 进 cells)', () => {
    registerPropertyType({ type: 'fakeNil', label: '空', icon: '·', baseType: 'text', Cell: () => null, initialValue: () => null })
    expect(newRowCells(db([]))).toEqual({})
    expect('nil' in newRowCells(db([]))).toBe(false)
  })
})

describe('isStamped', () => {
  it('只认 autonumber / created(与引擎 db_row_add 的同名契约),其余类型都不是', () => {
    expect(isStamped('autonumber')).toBe(true)
    expect(isStamped('created')).toBe(true)
    for (const t of ['formula', 'lookup', 'rowlink', 'text', 'calendarDate', 'todo', 'fakeSeq']) expect(isStamped(t)).toBe(false)
  })
})
