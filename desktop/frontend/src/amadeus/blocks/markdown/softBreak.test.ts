import { describe, expect, it } from 'vitest'
import { softBreakJoin, splitParagraph } from './softBreak'

const P = (...children: unknown[]) => ({ type: 'paragraph', children })
const T = (value: string) => ({ type: 'text', value })
const BR = { type: 'break' }
const texts = (ps: ReturnType<typeof splitParagraph>): string[] =>
  ps.map((p) => p.children.map((c: { value?: string }) => c.value ?? '·').join(''))

describe('splitParagraph', () => {
  it('无换行 → 原节点原样返回(不复制)', () => {
    const p = P(T('hello'))
    expect(splitParagraph(p)).toEqual([p])
    expect(splitParagraph(p)[0]).toBe(p)
  })

  it("text 里的 '\\n' 拆成多段", () => {
    expect(texts(splitParagraph(P(T('a\nb\nc'))))).toEqual(['a', 'b', 'c'])
  })

  it('break 节点(行尾 \\ 或两空格)同样拆段', () => {
    expect(texts(splitParagraph(P(T('a'), BR, T('b'))))).toEqual(['a', 'b'])
  })

  it('换行处的行内节点跟着各自的行走', () => {
    const out = splitParagraph(P(T('a'), { type: 'strong', children: [T('X')] }, T('\nb')))
    expect(out).toHaveLength(2)
    expect(out[0].children.map((c: { type: string }) => c.type)).toEqual(['text', 'strong'])
    expect(out[1].children.map((c: { type: string }) => c.type)).toEqual(['text'])
  })

  it('保留 paragraph 上的其它字段(position 等)', () => {
    const out = splitParagraph({ type: 'paragraph', foo: 1, children: [T('a\nb')] })
    expect(out.every((p: { foo?: number }) => p.foo === 1)).toBe(true)
  })

  // 中间的空行 = 用户敲两次回车留的空段落,过滤掉的话每次重开笔记就少一个(实测坐实)。
  it('中间的空行保留成空段', () => {
    expect(texts(splitParagraph(P(T('a\n\nb'))))).toEqual(['a', '', 'b'])
  })

  it('首尾的空行削掉(解析残渣,不是用户敲的)', () => {
    expect(texts(splitParagraph(P(T('\na\n'))))).toEqual(['a'])
  })
})

describe('softBreakJoin', () => {
  it('段落之间 0 条空行 = 单个 \\n', () => {
    expect(softBreakJoin({ type: 'paragraph' }, { type: 'paragraph' })).toBe(0)
  })
  // 不表态才安全:返回 1 会把列表项/引用之间的间距也接管过来,由 list 逻辑决定的松紧就被压平了。
  it('非段落对不表态(交回默认 join)', () => {
    expect(softBreakJoin({ type: 'paragraph' }, { type: 'heading' })).toBeUndefined()
    expect(softBreakJoin({ type: 'listItem' }, { type: 'listItem' })).toBeUndefined()
  })
})
