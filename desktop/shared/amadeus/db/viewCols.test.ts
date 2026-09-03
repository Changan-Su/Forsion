// 每视图列序纯逻辑:首列铁律 / 缺席列补后 / 死 id 忽略 / 无变化返原引用。
import { describe, expect, it } from 'vitest'
import { orderColumns } from './viewCols'

const cols = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id)

describe('orderColumns(每视图列序)', () => {
  it('按 order 重排;没提到的列按全局序补在后;order 里已不存在的 id 忽略', () => {
    expect(ids(orderColumns(cols, ['d', 'zz', 'b']))).toEqual(['a', 'd', 'b', 'c', 'e'])
  })

  it('首列固定在 0 位:order 把它写到别处 / 根本没写,输出 [0] 都是 columns[0]', () => {
    expect(ids(orderColumns(cols, ['c', 'a', 'b']))).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(ids(orderColumns(cols, ['e', 'd', 'c', 'b', 'a']))).toEqual(['a', 'e', 'd', 'c', 'b'])
    expect(orderColumns(cols, ['e', 'd', 'c', 'b', 'a'])[0]).toBe(cols[0])
  })

  it('order 缺 / 空 / 与全局序一致 → 返回**原数组引用**;有变化才是新数组', () => {
    expect(orderColumns(cols, undefined)).toBe(cols)
    expect(orderColumns(cols, [])).toBe(cols)
    expect(orderColumns(cols, ['a', 'b', 'c', 'd', 'e'])).toBe(cols)
    expect(orderColumns(cols, ['zz'])).toBe(cols) // 全是死 id = 没排
    expect(orderColumns(cols, ['c'])).not.toBe(cols)
  })

  it('重复 id 取首次出现;单列 / 空表原样返回', () => {
    expect(ids(orderColumns(cols, ['e', 'c', 'e']))).toEqual(['a', 'e', 'c', 'b', 'd'])
    const one = [{ id: 'a' }]
    expect(orderColumns(one, ['b', 'a'])).toBe(one)
    expect(orderColumns([], ['a'])).toEqual([])
  })
})
