import { describe, it, expect } from 'vitest'
import { clickAct, nextSelection } from './itemSelect'

const mods = (o: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }>) =>
  ({ shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...o })

describe('clickAct', () => {
  it('裸击 = 就地打开 + 只选它', () => {
    expect(clickAct(mods({}))).toEqual({ open: 'same', select: 'replace' })
  })
  it('⌘ / Ctrl = 新标签页(Windows 用 Ctrl)', () => {
    expect(clickAct(mods({ metaKey: true }))).toEqual({ open: 'new', select: 'replace' })
    expect(clickAct(mods({ ctrlKey: true }))).toEqual({ open: 'new', select: 'replace' })
  })
  it('shift = 范围选,不打开', () => {
    expect(clickAct(mods({ shiftKey: true }))).toEqual({ open: 'none', select: 'range' })
  })
  it('option/alt = 逐个加减,不打开', () => {
    expect(clickAct(mods({ altKey: true }))).toEqual({ open: 'none', select: 'toggle' })
  })
  it('组合键取更保守的那个:shift+⌘ 仍然不打开', () => {
    expect(clickAct(mods({ shiftKey: true, metaKey: true })).open).toBe('none')
    expect(clickAct(mods({ altKey: true, metaKey: true })).open).toBe('none')
  })
})

describe('nextSelection', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']

  it('replace = 只剩它,锚点归它', () => {
    expect(nextSelection(['a', 'b'], 'a', 'd', 'replace', ids)).toEqual({ sel: ['d'], anchor: 'd' })
  })

  it('toggle 加入 / 再点取消', () => {
    const add = nextSelection(['a'], 'a', 'c', 'toggle', ids)
    expect(add).toEqual({ sel: ['a', 'c'], anchor: 'c' })
    expect(nextSelection(add.sel, add.anchor, 'c', 'toggle', ids)).toEqual({ sel: ['a'], anchor: 'c' })
  })

  it('range 取锚点到目标的连续区间(方向无所谓)', () => {
    expect(nextSelection(['b'], 'b', 'd', 'range', ids).sel).toEqual(['b', 'c', 'd'])
    expect(nextSelection(['d'], 'd', 'b', 'range', ids).sel).toEqual(['b', 'c', 'd'])
  })

  it('连着 shift 点 = 反复改同一个范围(锚点不动)', () => {
    const first = nextSelection(['b'], 'b', 'e', 'range', ids)
    expect(first).toEqual({ sel: ['b', 'c', 'd', 'e'], anchor: 'b' })
    // 再 shift 点回 c:范围应收窄成 b..c,而不是从 e 起算
    expect(nextSelection(first.sel, first.anchor, 'c', 'range', ids).sel).toEqual(['b', 'c'])
  })

  it('没有锚点 / 锚点已不可见(树收起了)→ 退化成单选', () => {
    expect(nextSelection([], null, 'c', 'range', ids)).toEqual({ sel: ['c'], anchor: 'c' })
    expect(nextSelection(['x'], 'x', 'c', 'range', ids)).toEqual({ sel: ['c'], anchor: 'c' })
  })
})
