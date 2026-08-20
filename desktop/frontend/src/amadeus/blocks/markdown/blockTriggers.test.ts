import { describe, expect, it } from 'vitest'
import { blockLabel, matchTrigger, triggerFromStructuralPrefix } from './blockTriggers'

describe('matchTrigger(光标前文本 → 块触发)', () => {
  it('标题 1-6 级;7 个 # 不触发', () => {
    expect(matchTrigger('#')).toEqual({ kind: 'heading', level: 1 })
    expect(matchTrigger('##')).toEqual({ kind: 'heading', level: 2 })
    expect(matchTrigger('######')).toEqual({ kind: 'heading', level: 6 })
    expect(matchTrigger('#######')).toBeNull()
  })
  it('列表/有序/待办/引用', () => {
    expect(matchTrigger('-')).toEqual({ kind: 'bullet' })
    expect(matchTrigger('*')).toEqual({ kind: 'bullet' })
    expect(matchTrigger('+')).toEqual({ kind: 'bullet' })
    expect(matchTrigger('3.')).toEqual({ kind: 'ordered', order: 3 })
    expect(matchTrigger('[]')).toEqual({ kind: 'task', checked: false })
    expect(matchTrigger('[ ]')).toEqual({ kind: 'task', checked: false })
    expect(matchTrigger('[x]')).toEqual({ kind: 'task', checked: true })
    expect(matchTrigger('[X]')).toEqual({ kind: 'task', checked: true })
    expect(matchTrigger('- [ ]')).toEqual({ kind: 'task', checked: false })
    expect(matchTrigger('- [x]')).toEqual({ kind: 'task', checked: true })
    // 2026-07-29 换键位:`|` = 引用,`>` = 折叠(Notion 手感)。落盘两者仍都是 `>` 开头的合法 md。
    expect(matchTrigger('|')).toEqual({ kind: 'quote' })
    expect(matchTrigger('>')).toEqual({ kind: 'fold' })
  })
  it('nbsp 空格("[ ]" 在 contenteditable 里的真实形态)也识别', () => {
    expect(matchTrigger('[ ]')).toEqual({ kind: 'task', checked: false })
  })
  it('非行首触发符/夹杂内容一律不触发', () => {
    expect(matchTrigger('a#')).toBeNull()
    expect(matchTrigger('# x')).toBeNull()
    expect(matchTrigger('')).toBeNull()
    expect(matchTrigger('1')).toBeNull()
    expect(matchTrigger('[y]')).toBeNull()
  })
})

describe('triggerFromStructuralPrefix(实况源码 → 块类型)', () => {
  it('只有带渲染边界空格的完整标题语法才命中', () => {
    expect(triggerFromStructuralPrefix('### ')).toEqual({ kind: 'heading', level: 3 })
    expect(triggerFromStructuralPrefix('###')).toBeNull()
    expect(triggerFromStructuralPrefix('####### ')).toBeNull()
  })
  it('列表/待办/引用逐字符删坏后不再命中', () => {
    expect(triggerFromStructuralPrefix('- ')).toEqual({ kind: 'bullet' })
    expect(triggerFromStructuralPrefix('4. ')).toEqual({ kind: 'ordered', order: 4 })
    expect(triggerFromStructuralPrefix('- [ ] ')).toEqual({ kind: 'task', checked: false })
    expect(triggerFromStructuralPrefix('- [x] ')).toEqual({ kind: 'task', checked: true })
    expect(triggerFromStructuralPrefix('> ')).toEqual({ kind: 'quote' })
    expect(triggerFromStructuralPrefix('- [] ')).toBeNull()
    expect(triggerFromStructuralPrefix('>')).toBeNull()
  })
})

const N = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra })

describe('blockLabel', () => {
  it('普通段落 = 正文', () => expect(blockLabel([N('paragraph')])).toBe('正文'))
  it('标题带级别', () => expect(blockLabel([N('heading', { level: 3 })])).toBe('标题 3'))
  it('列表项先于列表被扫到,但自己没 checked 时继续外扫到列表类型', () =>
    expect(blockLabel([N('paragraph'), N('list_item'), N('bullet_list')])).toBe('无序列表'))
  it('有序列表', () => expect(blockLabel([N('paragraph'), N('list_item'), N('ordered_list')])).toBe('有序列表'))
  it('checked 非 null = 待办(不报成无序列表)', () =>
    expect(blockLabel([N('paragraph'), N('list_item', { checked: false }), N('bullet_list')])).toBe('待办'))
  it('引用', () => expect(blockLabel([N('paragraph'), N('blockquote')])).toBe('引用'))
  it('代码块', () => expect(blockLabel([N('code_block')])).toBe('代码'))
  it('列表里的引用:由内往外先命中引用', () =>
    expect(blockLabel([N('paragraph'), N('blockquote'), N('list_item'), N('bullet_list')])).toBe('引用'))
  // codex#5:嵌套列表的 checked 必须各随各的节点,不能被外层 list_item 串味
  it('待办里嵌普通列表 → 内层是普通列表,不报待办', () =>
    expect(blockLabel([N('paragraph'), N('list_item'), N('bullet_list'), N('list_item', { checked: true }), N('bullet_list')])).toBe('无序列表'))
  it('普通列表里嵌待办 → 内层是待办,不报无序列表', () =>
    expect(blockLabel([N('paragraph'), N('list_item', { checked: false }), N('bullet_list'), N('list_item'), N('bullet_list')])).toBe('待办'))
})
