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
const md = pipeline(attentionHandlers) // = 生产(MarkdownBlock 的 .use(attentionSerializer) 之后)
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

const CODE = { WS: ' '.charCodeAt(0), PUNCT: '（'.charCodeAt(0), LETTER: '尾'.charCodeAt(0), HI: 0xd83d, LO: 0xde00 }

describe('inlineHtmlMarksPlugin 解析侧', () => {
  it('<u>…</u> 折成单个 mark 节点(不是两个裸 html 兄弟)', () => {
    const tree = parseWithMarks.runSync(parseWithMarks.parse('前<u>下划线</u>后')) as any
    expect(tree.children[0].children.map(shape).join('+')).toBe('text+amadeusU(text)+text')
  })
})

describe('encodeSides(encode-info 四×四表的 ~ 列)', () => {
  it('内侧空白 → 必编内侧;外侧只有字母/汉字才一起编(外侧空白不编,否则软换行成 &#xA;)', () => {
    expect(encodeSides(CODE.LETTER, CODE.WS)).toEqual({ inside: true, outside: true })
    expect(encodeSides(CODE.WS, CODE.WS)).toEqual({ inside: true, outside: false })
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
  it('外侧未知(NaN:空文本兄弟 / 容器边界)→ 不编外侧(否则落 `&#xNAN;`)', () => {
    expect(encodeSides(NaN, CODE.WS)).toEqual({ inside: true, outside: false })
    expect(encodeSides(NaN, CODE.PUNCT)).toEqual({ inside: false, outside: false })
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
  // 09-18 二轮评审:借 `_` 会把上游带进 encode-info 的 `_` 分支(按 UTF-16 码元编内侧 → emoji 变 U+FFFD)。
  // 故一律写 `*`:`_斜体_`/`__加粗__` 规范成 `*`,渲染不变、不再有 `_` 分支的任何编码。
  it('node.marker 是 `_` 也一律写 `*`(不走上游 `_` 分支)', () => {
    const U = (type: string, value: string) => ({ ...N(type, T(value)), marker: '_' })
    expect(out(U('emphasis', '斜体'), T(' 尾'))).toBe('*斜体* 尾')
    expect(out(U('strong', '加粗'), T(' 尾'))).toBe('**加粗** 尾')
    const r = roundTrip(U('emphasis', `尾巴。${NBSP}`), T(' 尾'))
    expect([r.md, r.shape, r.stable, r.textStable]).toEqual([`*尾巴。&#xA0;* 尾`, 'emphasis(text)+text', true, true])
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

// 09-18 独立评审(真 Milkdown 实测)挖出的四条,这里按它给出的 mdast 形状钉死。
describe('09-18 评审:空壳 / NaN / BOM marker / 软换行', () => {
  const E = T('') // milkdown moveSpaces 挪走空格后留下的空文本
  it('N1 空文本兄弟后面的 mark 不落 `&#xNAN;`(加粗 + 删除线 / 斜体 + 加粗)', () => {
    for (const inline of [
      N('strong', E, N('delete', T('（备注）'))),
      N('emphasis', E, N('strong', T('“引用”'))),
    ]) {
      const md = out(T('内容'), inline)
      expect(md).not.toMatch(/NaN/i) // 落盘是大写 `&#xNAN;`,大小写敏感的 /NaN/ 曾假绿
      expect(parse.parse(md)).toBeTruthy()
    }
  })
  it('E1 空删除线/加粗/斜体整个丢掉,不落 `~~~~` / `****` / `**`', () => {
    const md = out(N('strong', N('delete', T('甲'))), N('delete', E), T(' '), N('strong', N('delete', T('乙'))))
    expect(md).toBe('**~~甲~~** **~~乙~~**')
    expect(out(T('a'), N('strong', E), T('b'))).toBe('ab')
    expect(out(T('a'), N('emphasis', E), T('b'))).toBe('ab')
    expect(out(T('a'), N('delete'), T('b'))).toBe('ab') // 连 children 都没有
  })
  it('B1 marker 不是 `*`/`_`(BOM 让 remark-marker 读偏)→ 不抛,退回缺省 `*`', () => {
    for (const marker of ['\uFEFF', ' ', '前', '\n']) {
      expect(out({ ...N('strong', T('加粗')), marker }, T(' 后'))).toBe('**加粗** 后')
      expect(out({ ...N('emphasis', T('斜体')), marker }, T(' 后'))).toBe('*斜体* 后')
    }
  })
  it('L1 mark 尾随 NBSP 后接软换行:换行留作换行,不编成 `&#xA;`(两行不并成一行)', () => {
    for (const [type, d] of [['delete', '~~'], ['strong', '**'], ['emphasis', '*']] as const) {
      const md = out(N(type, T(`完成了。${NBSP}`)), T('\n'), N(type, T('第二条')))
      expect(md).toBe(`${d}完成了。&#xA0;${d}\n${d}第二条${d}`)
    }
  })
})

// 09-18 二轮评审(真 Milkdown 实测)的三条 + 一条半修。都以「源文件是 `_` 定界」起手 —— 那正是出事的入口。
describe('09-18 二轮评审:`_` 分支 / 嵌套空壳', () => {
  const U = (type: string, ...kids: unknown[]) => ({ ...N(type, ...kids), marker: '_' })
  it('P0 `_开心😀_` 贴着汉字:emoji 逐字完好、无 U+FFFD、mark 不丢', () => {
    for (const inline of [
      [U('emphasis', T(`开心${EMOJI}`)), T('然后')],
      [T('前'), U('strong', T(`${EMOJI}加粗`))],
    ]) {
      const r = roundTrip(...inline)
      expect(r.md).not.toMatch(/&#xD[89A-F]/i)
      expect([r.text.includes('\uFFFD'), r.text.includes(EMOJI), r.textStable]).toEqual([false, true, true])
      expect(r.shape).toMatch(/emphasis|strong/)
    }
  })
  it('P1 `_` 加粗里只剩一个空删除线:不落 `&#xNAN;`,整个丢掉', () => {
    const md = out(T('甲'), U('strong', N('delete', T(''))), T(' 乙'))
    expect(md).not.toMatch(/NaN/i)
    expect(md).toBe('甲 乙')
  })
  it('P1 相邻 `__甲__` + `_乙_`(中间空格被删):两个 mark 都还在', () => {
    const r = roundTrip(U('strong', T('甲')), U('emphasis', T('乙')))
    expect([r.shape, r.text, r.textStable]).toEqual(['strong(text)+emphasis(text)', '甲乙', true])
  })
  it('P2 空壳递归:空格上同时挂加粗+删除线 / 加粗+斜体 → 不落 `****` / `***`', () => {
    expect(out(N('delete', T('甲')), N('strong', N('delete', T(''))), T(' '), N('delete', T('乙')))).toBe('~~甲~~ ~~乙~~')
    expect(out(T('甲'), N('strong', N('emphasis', T(''))), T(' 乙'))).toBe('甲 乙')
    // 叶子不算空:只装着行内代码的删除线照常写
    expect(out(N('delete', { type: 'inlineCode', value: 'c' }))).toBe('~~`c`~~')
  })
})

// 09-18 fuzz(2 万段真 Milkdown,对比修复前生产)里仅剩的 9 条回归,全是这一个形状 + 顺手去掉的白编。
describe('09-18 fuzz:外侧前面是反斜杠 / `*` run 贴着定界符', () => {
  it('前一段文字以 `\\X` 结尾:不编 X(否则反斜杠转义掉 `&`,字母变字面 `&#x61;`)', () => {
    for (const inline of [
      [T('\\a'), N('strong', N('delete', T('!')))],
      [T('（甲\\a'), N('emphasis', N('delete', T('（')))],
      [T('\\a'), N('delete', T('（x）'))],
    ]) {
      const r = roundTrip(...inline)
      expect(r.md).not.toMatch(/\\&#x/)
      expect(r.text).not.toMatch(/&#x/)
    }
  })
  it('`*` run 内侧贴着别的定界符:外侧汉字不白编(`***重点***后面`、`**~~删除~~**后面`)', () => {
    const r1 = roundTrip(N('strong', N('emphasis', T('重点'))), T('后面'))
    expect([r1.md, r1.stable]).toEqual(['***重点***后面', true])
    expect(r1.shape).toMatch(/^(strong\(emphasis|emphasis\(strong)\(text\)\)\+text$/) // `***x***` 回读嵌套顺序对调,语义相同
    const r2 = roundTrip(N('strong', N('delete', T('删除'))), T('后面'))
    expect([r2.md, r2.shape, r2.stable]).toEqual(['**~~删除~~**后面', 'strong(delete(text))+text', true])
  })
})

// 一律写 `*` 之后,marker 不同的相邻同类 mark(milkdown 不并,因为 marker 在 props 里)会拼成 `**甲****乙**`。
describe('相邻同类 attention 节点在 root 先合并', () => {
  const U = (type: string, ...kids: unknown[]) => ({ ...N(type, ...kids), marker: '_' })
  it('`__甲__` 旁边 ⌘B 出来的 `*` 加粗 → 并成一个 `**甲，乙**`', () => {
    const r = roundTrip(U('strong', T('甲')), N('strong', T('，乙')))
    expect([r.md, r.shape, r.stable]).toEqual(['**甲，乙**', 'strong(text)', true])
  })
  it('嵌套的也递归并:strong[em[x]] + strong[em[y]] → 一层', () => {
    expect(out(N('strong', U('emphasis', T('甲'))), N('strong', N('emphasis', T('乙'))))).toBe('***甲乙***')
  })
  it('不同类不并(加粗挨着斜体照旧两个)', () => {
    expect(roundTrip(N('strong', T('甲')), N('emphasis', T('乙'))).shape).toBe('strong(text)+emphasis(text)')
  })
})

// 相邻 `*` run 拼成一个:斜体紧贴加粗(或反过来),两段之间没有字。micromark 核心 attention 规则下,
// 合并后的 run 要「既能合前一个、又能开后一个」,两侧必须同类(都是字母,或都是标点)。
// 一侧字母一侧标点 → 只能合或只能开 → 后一个 mark 退成字面 `**`,下次保存转义,不可逆(修复前后都坏)。
describe('相邻 `*` run:斜体紧贴加粗', () => {
  const cases: [string, unknown[], string][] = [
    ['斜体 + 以标点开头的加粗', [N('emphasis', T('斜体')), N('strong', T('「注意」'))], 'emphasis(text)+strong(text)'],
    ['以标点结尾的加粗 + 斜体', [N('strong', T('注意：')), N('emphasis', T('斜体'))], 'strong(text)+emphasis(text)'],
    ['加粗 + 以标点开头的斜体', [N('strong', T('加粗')), N('emphasis', T('（备注）'))], 'strong(text)+emphasis(text)'],
    ['以标点结尾的斜体 + 加粗', [N('emphasis', T('（备注）')), N('strong', T('注意'))], 'emphasis(text)+strong(text)'],
    ['字母侧是 emoji(整码点编,绝不拆代理对)', [N('emphasis', T(`开心${EMOJI}`)), N('strong', T('「注意」'))], 'emphasis(text)+strong(text)'],
  ]
  for (const [name, inline, shape] of cases) {
    it(name, () => {
      const want = inline.map(flat).join('') // 先算:root 预处理会就地改树(生产每次都是新树)
      const r = roundTrip(...inline)
      expect(r.md).not.toMatch(/&#xD[89A-F]/i)
      expect([r.shape, r.textStable, r.text]).toEqual([shape, true, want])
    })
  }
  it('两侧同类的不动(字母+字母、标点+标点本来就成立,一个字符都不编)', () => {
    expect(out(N('emphasis', T('斜体')), N('strong', T('注意')))).toBe('*斜体***注意**')
    expect(out(N('emphasis', T('（x）')), N('strong', T('「y」')))).toBe('*（x）***「y」**')
  })
})

// 加粗套斜体:外层 `**` 和内层 `*` 同字符并成一个 `***` run,决定开合的是最里层的边缘字。
describe('嵌套 `*` run:看最里层的边缘字', () => {
  const nest = (v: string) => N('strong', N('emphasis', T(v)))
  it('最里层是标点、外面贴字母 → 外面那个字要编(否则 `***` 开/合不起来)', () => {
    for (const inline of [
      [T('前甲'), nest('（注）')],
      [nest('（注）'), T('1后')],
    ]) {
      const want = inline.map(flat).join('')
      const r = roundTrip(...inline)
      expect([r.textStable, r.text]).toEqual([true, want])
      expect(r.shape).toMatch(/strong\(emphasis|emphasis\(strong/)
    }
  })
  it('最里层是字母 → 外面不白编', () => {
    expect(out(T('前'), nest('重点'), T('后面'))).toBe('前***重点***后面')
  })
})

// 09-18 三轮评审(真 Milkdown 实测)对相邻/嵌套 `*` run 修法挖出的五条。
describe('相邻 run 编码的边角(三轮评审)', () => {
  const keep = (inline: unknown[], shape: RegExp) => {
    const want = inline.map(flat).join('')
    const r = roundTrip(...inline)
    expect([r.textStable, r.text]).toEqual([true, want])
    expect(r.shape).toMatch(shape)
    return r
  }
  it('R1 被编的边缘字前面是换行:换行不许被吞成空格(html 节点会触发 containerPhrasing 的换行改写)', () => {
    const r = keep([N('emphasis', T('x\n甲')), N('strong', T('「b」'))], /^emphasis\(text\)\+strong\(text\)$/)
    expect(r.md).toContain('\n')
  })
  it('R2 尾边是转义的 `*`/`_`/`~`:前一个字就是定界符,run 总能合,不编(否则把好的弄坏)', () => {
    keep([N('strong', T('b'), N('emphasis', T('a*')), T('1')), T(EMOJI)], /^strong\(/)
    keep([N('strong', T('a*')), N('emphasis', T('1')), T(EMOJI)], /^strong\(text\)\+emphasis\(text\)/)
    expect(out(N('strong', T('b'), N('emphasis', T('a*')), T('1')), T('甲'))).not.toMatch(/&#x/)
  })
  it('R3 控制字符/非字符不编(micromark 会把它们的字符引用解成 U+FFFD)', () => {
    for (const inline of [
      [N('emphasis', T('a\u0085')), N('strong', T('「注意」'))],
      [N('strong', T('注：')), N('emphasis', T('\u0092b'))],
      [T('a\u0085'), N('strong', T('（注）'))],
      [N('strong', T('注：')), T('\u0092s')],
    ]) {
      // 编不了就不编:mark 可能退成字面(= 修复前行为),但那个字绝不能变 U+FFFD。
      const ctl = inline.map(flat).join('').match(/[\u0085\u0092]/)![0]
      const r = roundTrip(...inline)
      expect([r.text.includes(ctl), r.text.includes('\uFFFD'), r.md.includes('&#x85;') || r.md.includes('&#x92;')]).toEqual([true, false, false])
    }
  })
  it('R4 中间只有一个字的 mark 被下一对编掉之后,上一对要跟着重判(不动点)', () => {
    keep([N('emphasis', T('斜')), N('strong', T('甲')), N('emphasis', T('「注」'))], /^emphasis\(text\)\+strong\(text\)\+emphasis\(text\)$/)
  })
  it('R6 字母侧边缘字前面是反斜杠:照编,反斜杠被转义成 `\\\\`,文字与两个 mark 都在', () => {
    for (const v of ['!\\a', 'x\\\\a', '\\\\\\a']) keep([N('emphasis', T(v)), N('strong', T('「注」'))], /^emphasis\(text\)\+strong\(text\)$/)
  })
  it('R5 边缘字在裸 URL 里:不编(GFM 自动链接会把 `&#x63;` 吞进链接地址)', () => {
    const want = 'see https://example.com/abc「注意」'
    const r = roundTrip(N('emphasis', T('see https://example.com/abc')), N('strong', T('「注意」')))
    expect(r.md).not.toMatch(/abc?&#x|ab&#x/)
    expect(r.text.replace(/<|>/g, '')).toContain('https://example.com/abc')
    void want
  })
})
