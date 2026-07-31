import { describe, expect, it } from 'vitest'
import { expand, softBreakJoin, splitParagraph, stripEmptyLineBr } from './softBreak'

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

// `<br…>` 变体(用户实报「云端笔记有时候莫名会出现 <br />」):Milkdown 的 preserve-empty-line 只认
// 四种精确写法,其余一律当原始 HTML 渲染成 contenteditable=false 的原子块 = 字面量出现在正文里。
// 取证是真浏览器(scripts/.probe-br 一次性 + e2e T33),这里锁住纯函数那一半。
const H = (value: string) => ({ type: 'html', value })
describe('splitParagraph — <br> 变体当换行', () => {
  it.each([['<BR>'], ['<br  />'], ['<br class="x">'], ['<br/>'], ['<BR />']])('%s → 一次换行', (tag) => {
    expect(texts(splitParagraph(P(T('a'), H(tag), T('b'))))).toEqual(['a', 'b'])
  })

  it('连着两个 br = 两次换行(中间留空段)', () => {
    expect(texts(splitParagraph(P(T('a'), H('<BR><BR>'), T('b'))))).toEqual(['a', '', 'b'])
  })

  it('br 后面紧跟的纯文本接回正文', () => {
    expect(texts(splitParagraph(P(T('a'), H('<BR>\nx'))))).toEqual(['a', 'x'])
  })

  it('不是 br 打头的 html 一律不动(用户写的真 HTML 别乱解释)', () => {
    const p = P(T('a'), H('<div>x</div>'), T('b'))
    expect(splitParagraph(p)).toEqual([p])
  })

  it('br 后面跟的还是标签 → 标签部分保持 html 原样', () => {
    const out = splitParagraph(P(T('a'), H('<br /><div>x</div>')))
    expect(out).toHaveLength(2)
    expect(out[1].children[0]).toEqual({ type: 'html', value: '<div>x</div>' })
  })
})

// 空行不再靠落盘 `<br />` 当记号(用户实报「文件里到处是莫名的 <br />」):
// 写端 stripEmptyLineBr 抹平成真空行,读端 expand 按 position 行距把空段落还原回来。
describe('stripEmptyLineBr', () => {
  it('整行的 <br /> → 空行(四种写法都认)', () => {
    expect(stripEmptyLineBr('a\n<br />\nb')).toBe('a\n\nb')
    expect(stripEmptyLineBr('a\n<br>\nb')).toBe('a\n\nb')
    expect(stripEmptyLineBr('a\n<br/>\nb')).toBe('a\n\nb')
    expect(stripEmptyLineBr('a\n  <br >  \nb')).toBe('a\n\nb')
  })

  it('行内的 <br /> 不动(那是行内换行,由 brLead 处理)', () => {
    expect(stripEmptyLineBr('a<br />b')).toBe('a<br />b')
  })

  it('代码围栏里的 <br /> 是代码,不动', () => {
    expect(stripEmptyLineBr('```html\n<br />\n```')).toBe('```html\n<br />\n```')
    expect(stripEmptyLineBr('~~~\n<br />\n~~~\n<br />')).toBe('~~~\n<br />\n~~~\n')
  })

  it('没有 br 时原样返回(零开销)', () => {
    const md = 'a\n\nb'
    expect(stripEmptyLineBr(md)).toBe(md)
  })
})

describe('expand — 空行按行距还原成空段落', () => {
  const at = (l1: number, l2: number, ...children: unknown[]) =>
    ({ type: 'paragraph', children, position: { start: { line: l1 }, end: { line: l2 } } })

  it('两段之间空一行 → 中间插一个空段落', () => {
    const tree = { type: 'root', children: [at(1, 1, T('a')), at(3, 3, T('b'))] }
    expand(tree)
    expect(texts(tree.children as never)).toEqual(['a', '', 'b'])
  })

  it('空两行 → 两个空段落', () => {
    const tree = { type: 'root', children: [at(1, 1, T('a')), at(4, 4, T('b'))] }
    expand(tree)
    expect(texts(tree.children as never)).toEqual(['a', '', '', 'b'])
  })

  it('紧挨着的两段不插空段(块内换行的常态)', () => {
    const tree = { type: 'root', children: [at(1, 1, T('a')), at(2, 2, T('b'))] }
    expand(tree)
    expect(texts(tree.children as never)).toEqual(['a', 'b'])
  })

  it('非段落邻居不参与(标题与正文之间的空行是 markdown 常态,不是空段落)', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'heading', depth: 2, children: [T('H')], position: { start: { line: 1 }, end: { line: 1 } } }, at(3, 3, T('b'))],
    }
    expand(tree)
    expect(tree.children).toHaveLength(2)
  })

  it('没有 position(合成节点)不乱插', () => {
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [T('a')] }, { type: 'paragraph', children: [T('b')] }] }
    expand(tree)
    expect(texts(tree.children as never)).toEqual(['a', 'b'])
  })
})
