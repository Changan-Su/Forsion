import { describe, expect, it } from 'vitest'
import { expand, restoreBlankParagraphs, softBreakJoin, splitParagraph, stripEmptyLineBr } from './softBreak'

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

// v4 统一编辑器(不挂 softBreakRemark)的空行还原:N 个空段落落盘 = 文中 2N+1 / 文首 2N / 文末 2N−1 条空行。
// 行号取自真实落盘串(见 scripts/enter-semantics.check.cjs 打出来的 disk)。
describe('restoreBlankParagraphs — v4 按空行距还原空段落', () => {
  const para = (l1: number, l2: number, ...children: unknown[]) =>
    ({ type: 'paragraph', children, position: { start: { line: l1 }, end: { line: l2 } } })
  const head = (l: number, t: string) =>
    ({ type: 'heading', depth: 2, children: [T(t)], position: { start: { line: l }, end: { line: l } } })
  const root = (endLine: number, ...children: unknown[]) =>
    ({ type: 'root', children, position: { start: { line: 1 }, end: { line: endLine } } })
  const kinds = (tree: { children: unknown[] }): string[] =>
    (tree.children as { type: string; children?: unknown[] }[])
      .map((c) => (c.type === 'paragraph' && !c.children?.length ? '' : c.type))

  it("标准 md 的一条空行不臆造空段落('a\n\nb')", () => {
    const tree = root(4, para(1, 1, T('a')), para(3, 3, T('b')))
    restoreBlankParagraphs(tree)
    expect(kinds(tree)).toEqual(['paragraph', 'paragraph'])
  })

  it("段⏎⏎段:三条空行 → 一个空段落('a\n\n\n\nb')", () => {
    const tree = root(6, para(1, 1, T('a')), para(5, 5, T('b')))
    restoreBlankParagraphs(tree)
    expect(kinds(tree)).toEqual(['paragraph', '', 'paragraph'])
  })

  it('五条空行 → 两个空段落', () => {
    const tree = root(8, para(1, 1, T('a')), para(7, 7, T('b')))
    restoreBlankParagraphs(tree)
    expect(kinds(tree)).toEqual(['paragraph', '', '', 'paragraph'])
  })

  it('邻居不是段落也照样还原(病灶:空行挨着标题/列表就没人管)', () => {
    const tree = root(6, para(1, 1, T('a')), head(5, 'H'))
    restoreBlankParagraphs(tree)
    expect(kinds(tree)).toEqual(['paragraph', '', 'heading'])
    const t2 = root(6, head(1, 'H'), head(5, 'H2'))
    restoreBlankParagraphs(t2)
    expect(kinds(t2)).toEqual(['heading', '', 'heading'])
  })

  it("文首空行:2N 条('\n\n\n\nalpha\n' → 两个空段落)", () => {
    const tree = root(6, para(5, 5, T('alpha')))
    restoreBlankParagraphs(tree)
    expect(kinds(tree)).toEqual(['', '', 'paragraph'])
  })

  it("文末空行:2N−1 条('alpha\n\n\n\n' → 两个空段落;'alpha\n' → 零)", () => {
    const tree = root(5, para(1, 1, T('alpha')))
    restoreBlankParagraphs(tree)
    expect(kinds(tree)).toEqual(['paragraph', '', ''])
    const t2 = root(2, para(1, 1, T('alpha')))
    restoreBlankParagraphs(t2)
    expect(kinds(t2)).toEqual(['paragraph'])
  })

  // Codex 评审 F1 的实证:相邻间距必须用「前一个节点的 **end** 行」——多行节点(围栏/表格/setext)
  // 若误用 start 行,节点自己的行数会被算进空行,重开就凭空长出空段落。
  it('多行节点(代码围栏)相邻:内部行数不算进空行', () => {
    const fence = (l1: number, l2: number) =>
      ({ type: 'code', value: 'x', position: { start: { line: l1 }, end: { line: l2 } } })
    const tight = root(8, fence(1, 5), para(7, 7, T('b'))) // 常态:围栏后一条空行
    restoreBlankParagraphs(tight)
    expect(kinds(tight)).toEqual(['code', 'paragraph'])
    const gap = root(10, fence(1, 5), para(9, 9, T('b'))) // 三条空行 = 一个空段落
    restoreBlankParagraphs(gap)
    expect(kinds(gap)).toEqual(['code', '', 'paragraph'])
  })

  it('外来 md 的偶数条空行向下取整(不臆造)', () => {
    const tree = root(5, para(1, 1, T('a')), para(4, 4, T('b'))) // 'a\n\n\nb'
    restoreBlankParagraphs(tree)
    expect(kinds(tree)).toEqual(['paragraph', 'paragraph'])
  })

  it('空文档 / 缺 position 一律不动(宁可少还原)', () => {
    const empty = { type: 'root', children: [] as unknown[] }
    restoreBlankParagraphs(empty)
    expect(empty.children).toEqual([])
    const noPos = { type: 'root', children: [{ type: 'paragraph', children: [T('a')] }] }
    restoreBlankParagraphs(noPos)
    expect(noPos.children).toHaveLength(1)
  })
})
