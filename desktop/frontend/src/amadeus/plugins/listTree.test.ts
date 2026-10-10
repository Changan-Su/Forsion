import { describe, expect, it } from 'vitest'
import { ancestorsOf, buildListTree, dropCandidates, flattenLeaves, leafCount } from './listTree'
import type { ListItem } from './types'

const row = (key: string, extra: Partial<ListItem> = {}): ListItem => ({ key, title: key, ...extra })
const shape = (nodes: ReturnType<typeof buildListTree>): unknown => nodes.map((n) => (n.children.length ? [n.item.key, shape(n.children)] : n.item.key))

describe('buildListTree', () => {
  it('没有 parent 的列表原样是一层', () => {
    expect(shape(buildListTree([row('a'), row('b')]))).toEqual(['a', 'b'])
  })

  it('子行挂到上一级下面,顺序照输入;上一级可以排在子行后面', () => {
    const items = [row('p2', { parent: 'f' }), row('f', { kind: 'folder' }), row('p1', { parent: 'f' }), row('x')]
    expect(shape(buildListTree(items))).toEqual([['f', ['p2', 'p1']], 'x'])
  })

  it('parent 指不到、指向自己、互相成环的行都落回根,不丢行', () => {
    const items = [row('lost', { parent: 'nope' }), row('self', { parent: 'self' }), row('a', { parent: 'b' }), row('b', { parent: 'a' })]
    expect(shape(buildListTree(items))).toEqual(['lost', 'self', 'a', 'b'])
  })

  it('重复的 key 只认第一条', () => {
    expect(shape(buildListTree([row('a', { title: '先' }), row('a', { title: '后' })]))).toEqual(['a'])
    expect(buildListTree([row('a', { title: '先' }), row('a', { title: '后' })])[0].item.title).toBe('先')
  })
})

describe('数行 / 压平 / 找上级', () => {
  const items = [
    row('f', { kind: 'folder', group: '文档' }), row('p1', { parent: 'f' }),
    row('g', { kind: 'folder', parent: 'f' }), row('p2', { parent: 'g' }),
    row('empty', { kind: 'folder' }), row('top', { group: '站点' }),
  ]
  const tree = buildListTree(items)

  it('文件夹不算数,空文件夹是 0', () => {
    expect(leafCount(tree)).toBe(3)
    expect(leafCount(tree.filter((n) => n.item.key === 'empty'))).toBe(0)
  })

  it('搜索时压平:去掉文件夹,行沿用最上面那一级的分组', () => {
    expect(flattenLeaves(tree).map((i) => `${i.key}@${i.group ?? ''}`)).toEqual(['p1@文档', 'p2@文档', 'top@站点'])
  })

  it('上级由近到远;没有上级是空', () => {
    expect(ancestorsOf(items, 'p2')).toEqual(['g', 'f'])
    expect(ancestorsOf(items, 'top')).toEqual([])
    expect(ancestorsOf(items, '不存在')).toEqual([])
  })
})

describe('dropCandidates', () => {
  it('普通行只分上下两半', () => {
    expect(dropCandidates(0.1, false)).toEqual(['before'])
    expect(dropCandidates(0.9, false)).toEqual(['after'])
  })

  it('文件夹:上下四分之一是排在前 / 后,中间是放进去;被拒时有退路', () => {
    expect(dropCandidates(0.1, true)).toEqual(['before', 'into'])
    expect(dropCandidates(0.9, true)).toEqual(['after', 'into'])
    expect(dropCandidates(0.4, true)).toEqual(['into', 'before'])
    expect(dropCandidates(0.6, true)).toEqual(['into', 'after'])
  })
})
