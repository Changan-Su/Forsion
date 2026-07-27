import { describe, expect, it } from 'vitest'
import { arrangeStatusItems } from './StatusBar'
import type { StatusItem } from './types'

const Noop = (): null => null
const item = (id: string, side?: 'left' | 'right'): StatusItem => ({ id, component: Noop, side })

describe('arrangeStatusItems', () => {
  it('无偏好时保持注册序', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(arrangeStatusItems(items).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('hidden 过滤', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(arrangeStatusItems(items, ['b']).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('order 里出现的按序靠前,未列出的保持注册序排后', () => {
    const items = [item('a'), item('b'), item('c'), item('d')]
    expect(arrangeStatusItems(items, undefined, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('order 含未注册 id 不影响结果;hidden 与 order 组合', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(arrangeStatusItems(items, ['a'], ['ghost', 'c']).map((i) => i.id)).toEqual(['c', 'b'])
  })

  it('不改动入参数组', () => {
    const items = [item('b'), item('a')]
    arrangeStatusItems(items, undefined, ['a'])
    expect(items.map((i) => i.id)).toEqual(['b', 'a'])
  })
})
