import { describe, expect, it } from 'vitest'
import { ancestorsOf, buildListTree, dropCandidates, fitsPhoneList, flattenLeaves, groupFold, hiddenByFilter, isGroupHead, leafCount, type GroupFold } from './listTree'
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

describe('组头(folderStyle: group)', () => {
  const head = (key: string, extra: Partial<ListItem> = {}): ListItem => ({ key, title: key, kind: 'folder', folderStyle: 'group', ...extra })
  const row = (key: string, parent?: string): ListItem => ({ key, title: key, ...(parent ? { parent } : {}) })

  it('只有最上面一级的才算组头', () => {
    expect(isGroupHead(head('g'))).toBe(true)
    expect(isGroupHead(head('g', { parent: 'x' }))).toBe(false)
    expect(isGroupHead({ key: 'f', title: 'f', kind: 'folder' })).toBe(false)
    expect(isGroupHead({ key: 'r', title: 'r', folderStyle: 'group' })).toBe(false)
  })

  it('手机整屏列表画得下:平铺的行、一层组头;普通文件夹、行挂行、组头下面再套文件夹都画不下', () => {
    expect(fitsPhoneList([row('a'), row('b')])).toBe(true)
    expect(fitsPhoneList([head('g'), row('a', 'g'), row('b'), head('empty')])).toBe(true)
    expect(fitsPhoneList([{ key: 'f', title: 'f', kind: 'folder' }, row('a', 'f')])).toBe(false)
    expect(fitsPhoneList([row('a'), row('b', 'a')])).toBe(false)
    expect(fitsPhoneList([head('g'), head('h', { parent: 'g' }), row('a', 'h')])).toBe(false)
  })

  it('开合:defaultOpen 由假变真时打开(哪怕用户收起过);一直为真时用户收起就收着;变回假不自己合上', () => {
    const memo = new Map<string, GroupFold>()
    const at = (defaultOpen: boolean): GroupFold => groupFold(memo, 'k', head('g', defaultOpen ? { defaultOpen } : {}))
    expect(at(false).open).toBe(false)          // 没有未读:收着
    expect(at(true).open).toBe(true)            // 来了未读:打开
    at(true).open = false                       // 用户收起
    expect(at(true).open).toBe(false)           // 未读还在:让它收着
    expect(at(false).open).toBe(false)
    expect(at(true).open).toBe(true)            // 又来了新的:重新打开
    expect(at(false).open).toBe(true)           // 读完了:不在光标底下合上
    at(false).open = true
    expect(at(false).open).toBe(true)           // 用户自己打开的没有未读的组:开着
  })
})

describe('hiddenByFilter', () => {
  it('数清掉筛选会多出来的行:文件夹不算,重复的 key 只算一行(和 buildListTree 画出来的一样)', () => {
    expect(hiddenByFilter([row('g', { kind: 'folder' }), row('a', { parent: 'g' }), row('a'), row('b')], [row('b')])).toBe(1)
    expect(hiddenByFilter([row('a')], [row('x')])).toBe(1) // 筛出来的不是子集:不会减成 0 或负数
  })
})
