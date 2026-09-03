import { describe, expect, it } from 'vitest'
import { MAIN_KEY, cardKey, relatedTreeEdgeChildren, relatedTreeFocus } from './canvasElements'

describe('选中卡片的层级线强调范围', () => {
  const edges: Array<[string, string]> = [
    ['child', 'root'],
    ['grandchild', 'child'],
    ['sibling', 'root'],
    ['main-child', MAIN_KEY],
  ]

  it('中间节点只收齐自己的祖先链与子树，不误亮兄弟分支', () => {
    expect([...relatedTreeEdgeChildren(edges, new Set([cardKey('child')]))].sort())
      .toEqual(['child', 'grandchild'])
    expect([...relatedTreeFocus(edges, new Set([cardKey('child')])).nodes].sort())
      .toEqual(['child', 'grandchild', 'root'])
  })

  it('根节点收齐全部后代，主卡也能作为同等层级节点', () => {
    expect([...relatedTreeEdgeChildren(edges, new Set([cardKey('root')]))].sort())
      .toEqual(['child', 'grandchild', 'sibling'])
    expect([...relatedTreeEdgeChildren(edges, new Set([MAIN_KEY]))])
      .toEqual(['main-child'])
  })

  it('形状/关系线选择不触发，坏数据里的环也能收敛', () => {
    expect(relatedTreeEdgeChildren(edges, new Set(['e:shape', 't:child']))).toEqual(new Set())
    expect([...relatedTreeEdgeChildren([['a', 'b'], ['b', 'a']], new Set([cardKey('a')]))].sort())
      .toEqual(['a', 'b'])
  })

  it('孤立卡片也进入轻聚焦，多选时合并各自关系范围', () => {
    expect(relatedTreeFocus([], new Set([cardKey('solo')])).nodes).toEqual(new Set(['solo']))
    expect([...relatedTreeFocus(edges, new Set([cardKey('grandchild'), cardKey('sibling')])).nodes].sort())
      .toEqual(['child', 'grandchild', 'root', 'sibling'])
  })
})
