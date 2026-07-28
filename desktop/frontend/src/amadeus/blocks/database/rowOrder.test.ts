import { describe, expect, it } from 'vitest'
import { dropAfter, moveRow } from './rowOrder'

const R = (...ids: string[]) => ids.map((id) => ({ id }))
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id)

describe('moveRow', () => {
  it('往下拖:插到目标之后', () => expect(ids(moveRow(R('a', 'b', 'c'), 'a', 'c', true))).toEqual(['b', 'c', 'a']))
  it('往下拖:插到目标之前', () => expect(ids(moveRow(R('a', 'b', 'c'), 'a', 'c', false))).toEqual(['b', 'a', 'c']))
  it('往上拖:插到目标之前', () => expect(ids(moveRow(R('a', 'b', 'c'), 'c', 'a', false))).toEqual(['c', 'a', 'b']))
  it('往上拖:插到目标之后', () => expect(ids(moveRow(R('a', 'b', 'c'), 'c', 'a', true))).toEqual(['a', 'c', 'b']))

  // 摘掉源行后目标下标会左移,拿旧下标算就会差一位(往下拖时表现为「少走一格」)
  it('相邻往下拖不差一位', () => expect(ids(moveRow(R('a', 'b', 'c'), 'a', 'b', true))).toEqual(['b', 'a', 'c']))

  it('拖到自己身上 → 同一个引用(调用方据此跳过写盘)', () => {
    const rows = R('a', 'b')
    expect(moveRow(rows, 'a', 'a', true)).toBe(rows)
  })
  it('id 不存在 → 同一个引用', () => {
    const rows = R('a', 'b')
    expect(moveRow(rows, 'x', 'a', true)).toBe(rows)
    expect(moveRow(rows, 'a', 'x', true)).toBe(rows)
  })
  it('不改原数组', () => {
    const rows = R('a', 'b', 'c')
    moveRow(rows, 'a', 'c', true)
    expect(ids(rows)).toEqual(['a', 'b', 'c'])
  })
})

describe('dropAfter', () => {
  const rect = { top: 100, height: 40 }
  it('上半 → 之前', () => expect(dropAfter(110, rect)).toBe(false))
  it('下半 → 之后', () => expect(dropAfter(130, rect)).toBe(true))
  it('正中间算之前(边界稳定,不来回跳)', () => expect(dropAfter(120, rect)).toBe(false))
})
