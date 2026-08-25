import { describe, expect, it } from 'vitest'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { inlineHtmlMarksPlugin } from './marks'
import { attentionHandlers, encodeSides } from './attentionFlanking'

const NBSP = ' ' // 用户实报那条真正的尾随空白(输入法打的,不是 ASCII 空格)
const EMOJI = '\u{1F600}' // 非 BMP:外侧编码会按单个 UTF-16 码元拆坏它

// 照 milkdown `init` 的**真实搭法**装管线:remarkStringify 先吃 milkdown 自带的
// `remarkStringifyOptionsCtx` 默认 options(里面那份 text/strong/emphasis 会压过任何扩展),
// 再叠 gfm + marks.ts 真身插件。`MILKDOWN_OPTS` 就是生产里那份,不是测试自己编的。
const MILKDOWN_OPTS = (remarkStringifyOptionsCtx as any)._defaultValue as { handlers: Record<string, unknown> }
const pipeline = (handlers: Record<string, unknown>) =>
  unified()
    .use(remarkStringify, { ...MILKDOWN_OPTS, handlers: { ...MILKDOWN_OPTS.handlers, ...handlers } })
    .use(remarkGfm)
    .use(inlineHtmlMarksPlugin)
const md = pipeline(attentionHandlers) // = 生产(UnifiedSpike 的 .use(attentionSerializer) 之后)
const bare = pipeline({}) // = 不覆盖时的 milkdown 原样,用来证明这层覆盖确实是那道防线
const parse = unified().use(remarkParse).use(remarkGfm)
// 同一个插件的**解析侧**(foldTags:把 <u>…</u> 拆开的两个 html 兄弟折回一个 mark 节点)。
// 它此前没有任何测试,而本次把插件真身从 $remark 闭包里提了出来,顺手把这条也钉住。
const parseWithMarks = unified().use(remarkParse).use(remarkGfm).use(inlineHtmlMarksPlugin)

const T = (value: string) => ({ type: 'text', value })
const N = (type: string, ...children: unknown[]) => ({ type, children })
const doc = (...inline: unknown[]) => ({ type: 'root', children: [{ type: 'paragraph', children: inline }] }) as any
const shape = (n: any): string => (n.children ? `${n.type}(${n.children.map(shape).join(',')})` : n.type)
const flat = (n: any): string => (n.children ? n.children.map(flat).join('') : (n.value ?? ''))
const out = (...inline: unknown[]): string => md.stringify(doc(...inline)).trim()
const kids = (source: string): any[] => (parse.parse(source).children[0] as any).children

/** 落盘 → 回读三轮:节点结构 + **完整文本**(逐轮) + markdown 串是否第一轮即不动点。 */
const roundTrip = (...inline: unknown[]) => {
  const rounds = [out(...inline)]
  for (let i = 0; i < 2; i++) rounds.push(md.stringify(parse.parse(rounds[rounds.length - 1])).trim())
  const texts = rounds.map((r) => kids(r).map(flat).join(''))
  return {
    md: rounds[0],
    shape: kids(rounds[0]).map(shape).join('+'),
    text: texts[0],
    textStable: texts[1] === texts[0] && texts[2] === texts[0], // 内容一个字都不许变
    stable: rounds[1] === rounds[0] && rounds[2] === rounds[1],
  }
}

// 先钉住「不覆盖会怎样」:三个 mark 全部自毁。覆盖没挂上 → 下面整片跟着红。
describe('milkdown 自带 handler(不覆盖)本身就是坏的', () => {
  const dies = (...inline: unknown[]) => {
    const raw = bare.stringify(doc(...inline)).trim()
    return kids(raw).map(shape).join('+')
  }
  it('加粗/斜体尾随空格、删除线尾随空格 —— 重新解析全退化成纯文本', () => {
    expect(dies(N('strong', T('abc ')), T('尾巴'))).toBe('text')
    expect(dies(N('emphasis', T('abc ')), T('尾巴'))).toBe('text')
    expect(dies(N('delete', T('abc ')), T('尾巴'))).toBe('text')
  })
  it('加粗嵌行内代码后接汉字 —— 同样自毁', () =>
    expect(dies(N('strong', { type: 'inlineCode', value: 'c' }), T('尾巴'))).toBe('text+inlineCode+text'))
})

const CODE = { WS: ' '.charCodeAt(0), PUNCT: '*'.charCodeAt(0), LETTER: '尾'.charCodeAt(0), HI: 0xd83d, LO: 0xde00 }

describe('inlineHtmlMarksPlugin 解析侧', () => {
  it('<u>…</u> 折成单个 mark 节点(不是两个裸 html 兄弟)', () => {
    const tree = parseWithMarks.runSync(parseWithMarks.parse('前<u>下划线</u>后')) as any
    expect(tree.children[0].children.map(shape).join('+')).toBe('text+amadeusU(text)+text')
  })
})

describe('encodeSides(encode-info 四×四表的 ~ 列)', () => {
  it('内侧空白 → 必编内侧;外侧非标点时一起编', () => {
    expect(encodeSides(CODE.LETTER, CODE.WS)).toEqual({ inside: true, outside: true })
    expect(encodeSides(CODE.WS, CODE.WS)).toEqual({ inside: true, outside: true })
    expect(encodeSides(CODE.PUNCT, CODE.WS)).toEqual({ inside: true, outside: false })
  })
  it('内侧标点 → 只有外侧是字母/汉字才编外侧,内侧永不编', () => {
    expect(encodeSides(CODE.LETTER, CODE.PUNCT)).toEqual({ inside: false, outside: true })
    expect(encodeSides(CODE.WS, CODE.PUNCT)).toEqual({ inside: false, outside: false })
    expect(encodeSides(CODE.PUNCT, CODE.PUNCT)).toEqual({ inside: false, outside: false })
  })
  it('内侧字母/汉字 → 本来就成立,两侧都不编', () => {
    expect(encodeSides(CODE.LETTER, CODE.LETTER)).toEqual({ inside: false, outside: false })
    expect(encodeSides(CODE.WS, CODE.LETTER)).toEqual({ inside: false, outside: false })
  })
  it('外侧是代理对的一半 → 绝不请求外侧编码(否则 emoji 被拆坏)', () => {
    for (const half of [CODE.HI, CODE.LO]) {
      expect(encodeSides(half, CODE.WS)).toEqual({ inside: true, outside: false })
      expect(encodeSides(half, CODE.PUNCT)).toEqual({ inside: false, outside: false })
    }
  })
})

// 每条都断言:结构还原 + 文本逐字不变 + 第一轮即不动点。修复前这些全部退化成 text。
describe('删除线往返', () => {
  it('尾随 NBSP(用户实报那条)', () => {
    const r = roundTrip(N('delete', T(`完成了这件事。${NBSP}`)))
    expect(r.md).toBe('~~完成了这件事。&#xA0;~~')
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['delete(text)', `完成了这件事。${NBSP}`, true, true])
  })
  it('尾随 ASCII 空格', () => {
    const r = roundTrip(N('delete', T('abc ')), T('尾巴'))
    expect(r.md).toBe('~~abc&#x20;~~&#x5C3E;巴')
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['delete(text)+text', 'abc 尾巴', true, true])
  })
  it('删除线嵌加粗后接汉字(内侧标点 + 外侧汉字)', () => {
    const r = roundTrip(N('delete', N('strong', T('加粗'))), T('尾巴'))
    expect(r.md).toBe('~~**加粗**~~&#x5C3E;巴')
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['delete(strong(text))+text', '加粗尾巴', true, true])
  })
  it('汉字后接删除线嵌加粗(开侧同理)', () => {
    const r = roundTrip(T('前面'), N('delete', N('strong', T('加粗'))))
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['text+delete(strong(text))', '前面加粗', true, true])
  })
  it('删除线嵌行内代码后接汉字', () => {
    const r = roundTrip(N('delete', { type: 'inlineCode', value: '代码' }), T('字'))
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['delete(inlineCode)+text', '代码字', true, true])
  })
  it('加粗套删除线(父子反过来)', () => {
    const r = roundTrip(N('strong', N('delete', T('x  '))), T('尾巴'))
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['strong(delete(text))+text', 'x  尾巴', true, true])
  })
  it('无需编码的普通删除线一个字符都不改', () => {
    const r = roundTrip(N('delete', T('普通')), T('尾巴'))
    expect(r.md).toBe('~~普通~~尾巴')
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['delete(text)+text', '普通尾巴', true, true])
  })
})

// 包一层不得改变上游 strong/emphasis 在正常情况下的落盘形态(等于没包)。
describe('guardSurrogate 不改变上游正常行为', () => {
  it('加粗尾随空格仍编成 &#x20;,外侧汉字仍编成 &#x5C3E;', () => {
    const r = roundTrip(N('strong', T('x ')), T('尾巴'))
    expect(r.md).toBe('**x&#x20;**&#x5C3E;巴')
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['strong(text)+text', 'x 尾巴', true, true])
  })
  it('斜体同款', () => {
    const r = roundTrip(N('emphasis', T('x ')), T('尾巴'))
    expect(r.md).toBe('*x&#x20;*&#x5C3E;巴')
    expect([r.shape, r.text, r.stable, r.textStable]).toEqual(['emphasis(text)+text', 'x 尾巴', true, true])
  })
  it('用不着编码时一个字符都不改', () => {
    expect(out(N('strong', T('加粗')), T('尾巴'))).toBe('**加粗**尾巴')
    expect(out(N('emphasis', T('斜体')), T('尾巴'))).toBe('*斜体*尾巴')
  })
})

// Codex 评审揪出的数据毁坏边界:外侧编码按单个 UTF-16 码元走,会把 emoji 拆成
// `&#xD83D;` + 孤立低位(上游 strong/emphasis 同病,`**x **😀` 实测一样毁)。守卫后删除线
// 退化成字面 `~~`(= 修复前的行为,markdown 串第 2 轮才稳),但 emoji 逐字完好、文本逐轮不变。
describe('紧邻 emoji:宁可不成 mark,也绝不改坏字符', () => {
  for (const [name, ...inline] of [
    ['删除线 后接', N('delete', N('strong', T('x'))), T(`${EMOJI}tail`)],
    ['删除线 前接', T(`tail${EMOJI}`), N('delete', N('strong', T('x')))],
    ['删除线 内侧空白 + 后接', N('delete', T('x ')), T(`${EMOJI}tail`)],
    ['加粗 内侧空白 + 后接', N('strong', T('x ')), T(`${EMOJI}tail`)],
    ['加粗 内侧空白 + 前接', T(`tail${EMOJI}`), N('strong', T(' x'))],
    ['加粗 内侧标点(行内代码) + 后接', N('strong', { type: 'inlineCode', value: 'c' }), T(`${EMOJI}tail`)],
    ['斜体 内侧空白 + 后接', N('emphasis', T('x ')), T(`${EMOJI}tail`)],
    ['斜体 内侧标点 + 后接', N('emphasis', N('strong', T('x'))), T(`${EMOJI}tail`)],
  ] as [string, ...unknown[]][]) {
    it(`${name} emoji:文本逐轮不变、无 U+FFFD、无孤立代理项`, () => {
      const r = roundTrip(...inline)
      const lone = r.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
      expect([r.text.includes('\uFFFD'), /[\uD800-\uDFFF]/.test(lone), r.text.includes(EMOJI), r.textStable])
        .toEqual([false, false, true, true])
    })
  }
})
