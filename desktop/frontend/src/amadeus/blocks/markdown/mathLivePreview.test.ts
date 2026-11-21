// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { formulaAtSelection, maskNonMath, mathLivePreviewPlugin, mdMathSpans, scanMath, unescapeMathSource } from './mathLivePreview'
import { bgSchema, inlineHtmlMarksRemark } from './marks'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor, roundTrip } from './parseFidelity.testkit'
import { normalizeFragmentMd } from './MarkdownBlock'

// 公式扫描器是这套实况预览的解析核心 —— 误配会把货币/普通文本渲成公式,或漏掉真公式。重点覆盖。
describe('scanMath', () => {
  it('行内 $…$', () => {
    expect(scanMath('值 $x^2$ 重要')).toEqual([{ from: 2, to: 7, latex: 'x^2', display: false }])
  })
  it('块级 $$…$$(可跨行)', () => {
    const s = '$$\nE=mc^2\n$$'
    expect(scanMath(s)).toEqual([{ from: 0, to: s.length, latex: 'E=mc^2', display: true }])
  })
  it('一行多个行内公式', () => {
    const r = scanMath('$a$ 和 $b$')
    expect(r.map((x) => x.latex)).toEqual(['a', 'b'])
    expect(r.every((x) => !x.display)).toBe(true)
  })
  it('货币不误伤:开/闭 $ 贴空白或无闭合都不算公式', () => {
    expect(scanMath('花了 $5 和 $10 块')).toEqual([]) // 闭 $ 前是空白 → 不闭合
    expect(scanMath('单个 $ 符号')).toEqual([])       // 无闭合
    expect(scanMath('$ x$')).toEqual([])              // 开 $ 后接空白
  })
  it('紧贴的价位区间 / 环境变量不误伤(闭 $ 后接字母数字则不算行内公式)', () => {
    expect(scanMath('$5-$10')).toEqual([])       // 价位区间
    expect(scanMath('$5+$3')).toEqual([])
    expect(scanMath('$100-$200')).toEqual([])
    expect(scanMath('$HOME/$USER')).toEqual([])  // 环境变量路径
  })
  it('$$$ 三连(价位/货币)不当块公式起手', () => {
    expect(scanMath('$$$')).toEqual([])
    expect(scanMath('评价 $$$')).toEqual([])
  })
  it('CJK 紧跟闭 $ 仍算公式(不是字母数字)', () => {
    expect(scanMath('$x^2$后面')).toEqual([{ from: 0, to: 5, latex: 'x^2', display: false }])
  })
  it('行内不跨行', () => {
    expect(scanMath('$a\nb$')).toEqual([]) // 中间有换行 → 不成行内公式
  })
  it('未闭合的 $$ 不退化成行内', () => {
    expect(scanMath('$$ 只有开头')).toEqual([])
  })
  it('块级与行内混排,块级优先', () => {
    const r = scanMath('前 $$x$$ 中 $y$ 后')
    expect(r.map((x) => [x.latex, x.display])).toEqual([['x', true], ['y', false]])
  })
})

// 落盘反转义(序列化那一半):remark 会把纯文本公式里的标点转义(x_i→x\_i),unescapeMathSource 精确还原。
// ⚠️ 只测这一半曾让 R-01 漏网(解析侧把 `\\` `\{` 当 markdown 转义吃掉)—— 端到端见下面「公式源码逐字往返」。
describe('unescapeMathSource', () => {
  it('还原行内公式里被转义的下标 / 星号', () => {
    expect(unescapeMathSource('值 $x\\_i$ 与 $a\\*b$')).toBe('值 $x_i$ 与 $a*b$')
  })
  it('还原块级公式里的转义(下标)', () => {
    expect(unescapeMathSource('$$a\\_b$$')).toBe('$$a_b$$')
  })
  it('LaTeX 命令(反斜杠后接字母)原样保留,不被吞成 sum / begin', () => {
    // 真实 serializer:\sum 后接字母 → remark 不加转义、原样单反斜杠;反转义必须保留(旧的 \X→X 会误删成 sum)。
    expect(unescapeMathSource('$$\\sum_{x}$$')).toBe('$$\\sum_{x}$$')
    expect(unescapeMathSource('$$\\frac{a}{b}$$')).toBe('$$\\frac{a}{b}$$')
  })
  it('矩阵/数组:\\\\ 换行与 \\hline / \\begin 保留,只反转义 remark 加的 \\| 等标点', () => {
    // serializer 产物:\begin 原样、c\|cccc(| 被转义)、行分隔 \\ 的首个反斜杠被翻倍成 \\\。旧盲删会把命令与换行全吞 → 数组炸。
    const serialized = '$$\\begin{array}{c\\|cccc} a & b \\\\\\ \\hline c \\end{array}$$'
    const want = '$$\\begin{array}{c|cccc} a & b \\\\ \\hline c \\end{array}$$'
    expect(unescapeMathSource(serialized)).toBe(want)
  })
  it('围栏代码块内不动(块内 $…$ 不是公式)', () => {
    const md = '```\n$a\\_b$ echo "\\n"\n```'
    expect(unescapeMathSource(md)).toBe(md)
  })
  it('无 $ 直接原样返回', () => {
    expect(unescapeMathSource('普通文字 a_b * c')).toBe('普通文字 a_b * c')
  })
})

// R-01(评审 2026-09-27):端到端 —— 磁盘 md → 真 Milkdown 解析(生产装配)→ 落盘(normalizeSerializedMd)。
// 旧病:解析时 micromark 把公式里的「反斜杠 + 标点」当 markdown 转义吃掉,矩阵 `\\` 塌成一个、`\{a,b\}` 变 `{a,b}`;
// 首次保存看着对(序列化侧有 unescapeMathSource),**重开再编辑一次**才坏。所以每条都跑两轮。
describe('公式源码逐字往返(端到端)', () => {
  const cases: Array<[string, string]> = [
    ['矩阵 \\\\ 换行(块级)', '$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$\n'],
    ['aligned 多行', '$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$\n'],
    ['单行块级', '前\n\n$$\\begin{pmatrix} a \\\\ b \\end{pmatrix}$$\n\n后\n'],
    ['行内集合花括号', 'set $\\{x\\}$ here\n'],
    ['各种标点转义', '$a\\,b \\| c \\% d \\# e \\_ f \\{g\\}$ 尾\n'],
    ['块级里的 \\$', '$$a\\$b$$\n'],
    ['列表 / 引用 / 标题里的公式', '* 项 $\\{a\\}$\n\n> 引 $\\{b\\}$\n\n## 题 $\\{c\\}$\n'],
    ['对照:命令与下标本来就没事', '$x_i + \\sum_{k} a*b$ ok\n'],
    ['对照:公式外的转义不补', 'literal \\*not em\\* and \\_x\\_ and $\\{y\\}$\n'],
  ]
  it.each(cases)('%s', async (_label, md) => {
    const once = await roundTrip(md)
    expect(once).toBe(md)
    expect(await roundTrip(once)).toBe(md) // 重开再存
  })

  it('被转义的定界符 `\\$x\\$` 不当公式:不许补出 `\\\\$`(旧的 D-11 剥转义另归 0b)', async () => {
    const out = await roundTrip('not math: \\$x\\$ ok\n')
    expect(out).not.toContain('\\\\$')
  })

  it('Amadeus 里新写的公式:首存 → 重开 → 再编辑别处 → 落盘不变', async () => {
    const formula = '$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$ 与 $\\{a,b\\}$'
    // 第一轮:在空段落里「敲」出公式(纯文本插入,同用户输入)
    const b1 = await bootEditor('seed\n')
    let saved: string
    try {
      const { state } = b1.view
      b1.view.dispatch(state.tr.insertText(formula, state.doc.content.size - 1))
      saved = b1.md()
    } finally { await b1.destroy() }
    expect(saved).toBe(`seed${formula}\n`)
    // 第二轮:重开这份落盘,在段首再敲一个字
    const b2 = await bootEditor(saved)
    try {
      b2.view.dispatch(b2.view.state.tr.insertText('Z', 1))
      expect(b2.md()).toBe(`Zseed${formula}\n`)
    } finally { await b2.destroy() }
  })
})

// R-01 返修(评审 2026-09-27 阻断意见 R-01-growth):读侧曾按 PM 视图认公式(行内代码抹空、链接地址 / mark 定界符不计),
// 写侧 unescapeMathSource 按原文认 —— 两侧配出的对不同,读侧补的反斜杠写侧不还原,**每重开再存一次翻一倍**。
// 只测「打开→存盘 === 原文」抓不到它(那几份种子首存就已经坏了,第二存才开始长),所以这里全部测 save_{n+1} === save_n。
const backslashes = (s: string): number => (s.match(/\\/g) ?? []).length
async function saves(md: string, rounds = 3, opts: { v3?: boolean } = {}): Promise<string[]> {
  const seq = [md]
  for (let i = 0; i < rounds; i++) seq.push(await roundTrip(seq[seq.length - 1], opts))
  return seq
}
/** 首存允许既定规范化(附录 A:`~`→`\~`、表格补宽之类);此后每一存必须逐字不变、反斜杠不增。 */
const expectStable = (seq: string[]): void => {
  for (let i = 2; i < seq.length; i++) {
    expect(seq[i]).toBe(seq[i - 1])
    expect(backslashes(seq[i])).toBeLessThanOrEqual(backslashes(seq[i - 1]))
  }
}

describe('mdMathSpans(读写两侧共用的公式跨度)', () => {
  it('偏移相对整段原文,跨过围栏代码块也对得上', () => {
    const md = 'a $x$\n```\n$not$\n```\nb $$y$$'
    expect(mdMathSpans(md).map((sp) => md.slice(sp.from, sp.to))).toEqual(['$x$', '$$y$$'])
  })
  it('行内代码里的 `$` 不参与配对(与 Markdown 解析一致;读写两侧共用,口径照样一致)', () => {
    const md = '用`$`包裹公式,例如$\\{a\\}$'
    expect(mdMathSpans(md).map((sp) => md.slice(sp.from, sp.to))).toEqual(['$\\{a\\}$'])
  })
  const spansOf = (md: string): string[] => mdMathSpans(md).map((sp) => md.slice(sp.from, sp.to))
  it('任意长度反引号的行内代码:闭合按同长度配对,转义的反引号不开代码', () => {
    expect(spansOf('a ``x $b` c$ y`` $z$')).toEqual(['$z$'])
    expect(spansOf('a \\`$x$` b')).toEqual(['$x$']) // `\`` 是字面反引号,后面的 `$x$` 是公式
    expect(spansOf('a `$x$`` b')).toEqual(['$x$'])  // 长度对不上 → 没有代码,`$x$` 是公式
  })
  it('围栏:任意长度、` 或 ~,闭栏不短于开栏;未闭合的围栏到文末', () => {
    expect(spansOf('````md\n```\n$a$\n```\n$b$\n````\n$c$')).toEqual(['$c$'])
    expect(spansOf('~~~\n$a$\n~~~\n$b$')).toEqual(['$b$'])
    expect(spansOf('  ```\n$a$\n  ```\n$b$')).toEqual(['$b$'])
    expect(spansOf('```\n$a$\n')).toEqual([])
  })
  it('缩进代码块里的 `$` 不是公式;列表续行的缩进不当代码', () => {
    expect(spansOf('para\n\n    $a$ x\n\n$b$')).toEqual(['$b$'])
    expect(spansOf('- item\n\n    $a$\n')).toEqual(['$a$'])
  })
  it('链接 / 图片地址里的 `$` 不参与配对;链接文字里的公式照认', () => {
    expect(spansOf('[文档](http://x/?$top=1)里$\\{a\\}$')).toEqual(['$\\{a\\}$'])
    expect(spansOf('![i]($p.png "t$") $x$')).toEqual(['$x$'])
    expect(spansOf('[$x$](http://y)')).toEqual(['$x$'])
  })
  it('行内代码不跨进下一块;引用里的围栏随引用结束', () => {
    expect(spansOf('P `\n# $\\{x}$\n`')).toEqual(['$\\{x}$'])
    expect(spansOf('> ```\n> x\n\n$\\{x}$')).toEqual(['$\\{x}$'])
    expect(spansOf('> a `x\n> $y$` b')).toEqual([])
  })
})

// F03/F04(Obsidian 手感对齐):代码 / 链接地址里的 `\_` `\{` 曾被写侧当公式反转义删掉,且第二轮保持损坏。
describe('代码与链接地址里的反斜杠逐字(不被公式反转义误删)', () => {
  it('写侧:代码 / 地址里的反斜杠不动', () => {
    for (const md of [
      'before `$a\\_b$ and $\\{x\\}$` after\n',
      '````md\n```\n$a\\_b$ \\{x\\}\n```\n````\n',
      '~~~\n$a\\_b$ \\{x\\}$\n~~~\n',
      'para\n\n    $a\\_b$ \\{x\\}$\n',
      '[l](http://x/$a\\_b$) 与 $x$\n',
    ]) expect(unescapeMathSource(md)).toBe(md)
  })
  it('写侧:同一段里代码之外的真公式照旧反转义', () => {
    expect(unescapeMathSource('`$a\\_b$` 与 $c\\_d$\n')).toBe('`$a\\_b$` 与 $c_d$\n')
  })
  it.each([
    ['行内代码里的公式样文字(实测 F12)', 'before `$a\\_b$ and $\\{x\\}$` after\n'],
    ['双反引号行内代码', 'x ``a $b\\_c$ ` d$`` 与 $\\{y\\}$\n'],
    ['四反引号围栏里包三反引号', '````md\n```\n$a\\_b$ \\{x\\}\n```\n````\n'],
    ['行内代码里的单个 `$` 挨着公式', '用`$`包裹公式,例如$\\{a,b\\}$\n'],
    ['行内代码里的 $HOME 挨着公式', '先设置`$HOME`,再看集合$\\{a,b\\}$\n'],
    ['链接地址里的 `$` 挨着公式', '[文档](http://x/?$top=1)里$\\{a\\}$\n'],
    ['转义的反斜杠后面紧跟行内代码', 'P\n\n\\{$\\\\`x$`\n'],
    ['公式里的尖括号自动链接(序列化器翻倍反斜杠,不许越存越多)', '$<ab:x\\{y\\}>$\n'],
  ])('端到端逐字:%s', async (_label, md) => {
    const once = await roundTrip(md)
    expect(once).toBe(md)
    expect(await roundTrip(once)).toBe(md)
  })
  // 块结构本身会规范化(补空行 / 补闭栏,既定行为),这里只钉公式里的 `\\` 不丢、此后逐字。
  it.each([
    ['反引号不跨进下一块的标题', 'P `\n# $\\\\{x}$\n`\n'],
    ['引用里未闭合的围栏随引用结束', '> ```\n> x\n\n$\\\\{x}$\n'],
  ])('块边界:%s', async (_label, md) => {
    const seq = await saves(md)
    for (const x of seq.slice(1)) expect(x).toContain('$\\\\{x}$')
    expectStable(seq)
  })
  it('段首敲一个字:行内代码里的反斜杠不丢(实测 F12)', async () => {
    const b = await bootEditor('before `$a\\_b$ and $\\{x\\}$` after\n')
    try {
      b.view.dispatch(b.view.state.tr.insertText('Z', 3))
      expect(b.md()).toBe('beZfore `$a\\_b$ and $\\{x\\}$` after\n')
    } finally { await b.destroy() }
  })
})

// 排除域返修:抹多了 = 真公式读侧不补反斜杠(编辑器里 `$\{a\}$` 变 `${a}$`);抹少了 = 代码 / 地址里的 `\_` 存盘被删。
describe('排除域返修:别把真公式当代码 / 地址,也别漏掉真地址', () => {
  const spansOf = (md: string): string[] => mdMathSpans(md).map((sp) => md.slice(sp.from, sp.to))
  const editorText = async (md: string): Promise<string> => {
    const b = await bootEditor(md)
    try { return b.view.state.doc.textBetween(0, b.view.state.doc.content.size, '\n') } finally { await b.destroy() }
  }
  // A / D 钉「别把原来对的弄坏」(main 上是绿的,返修前的排除域把它们弄红);B / C 钉「代码 / 地址里的反斜杠不丢」(main 上红)。
  // 掩码断言与编辑器 / 存盘断言分开写:负对照时端到端那一半要单独看得到红绿。
  const caseA: Array<[string, string]> = [
    ['脚注定义', 'text[^1]\n\n[^1]: 其中 $\\{a\\}$ 与 $a \\\\ b$\n'],
    ['脚注续行段落(缩进 4 格不是代码)', 'text[^1]\n\n[^1]: first\n\n    second $\\{a\\}$ 与 $a \\\\ b$ para\n'],
    ['不是合法定义的 `[注]: 文字`', '[注]: 设 $\\{a\\}$ 与 $a \\\\ b$ 为集合\n'],
  ]
  // A:脚注定义 / 脚注续行 / `[标签]: 文字` 里的公式是正文公式,编辑器里的文字要带着反斜杠
  it.each(caseA)('A %s:编辑器里的文字公式带反斜杠', async (_label, md) => {
    expect(await editorText(md)).toContain('$\\{a\\}$ 与 $a \\\\ b$')
  })
  it.each(caseA)('A %s:mdMathSpans 认得出', (_label, md) => {
    expect(spansOf(md)).toEqual(['$\\{a\\}$', '$a \\\\ b$'])
  })
  it('引用定义口径:整行剩余恰好是「地址 + 可选标题」、且不打断段落时才抹', () => {
    expect(spansOf('[l]: /u$ "t$x$"\n\n$y$')).toEqual(['$y$'])                 // 合法定义:地址 / 标题不参与配对
    expect(spansOf('[l]: /u "t" x$y$\n')).toEqual(['$y$'])                      // 标题后还有字 = 普通段落
    expect(spansOf('P\n[l]: <$\\{a\\}$>\n')).toEqual(['$\\{a\\}$'])               // 定义打断不了段落 = 普通文字
  })
  // D:缩进 ≥4 的 ``` 属于上面的段落,不是开栏
  const caseD = 'P\n    ```\n$\\{x\\}$\n'
  it('D 段落里缩进 4 格的 ```:编辑器里的文字公式带反斜杠', async () => {
    expect(await editorText(caseD)).toContain('$\\{x\\}$')
  })
  it('D 段落里缩进 4 格的 ```:不开围栏,mdMathSpans 认得出后面的公式', () => {
    expect(spansOf(caseD)).toEqual(['$\\{x\\}$'])
  })
  it('围栏缩进口径:列表项里相对内容列 ≤3 才是围栏;顶层 ≤3', () => {
    expect(spansOf('- a\n\n     ```\n  $x$\n     ```\n$y$')).toEqual(['$y$'])  // 内容列 2 + 3 = 5:是围栏
    expect(spansOf('- a\n\n      ```\n  $x$\n')).toEqual(['$x$'])             // 内容列 2 + 4:缩进代码里的 ```,不开栏
    expect(spansOf('   ```\n$x$\n   ```\n$y$')).toEqual(['$y$'])
  })
  // B:地址里的撇号不是标题(标题前必须有空白)。
  // 地址里的 `\\_` 是字面反斜杠(`\_` 在地址里本来就只是 `_`):序列化照原样写回 `\\_`,地址没抹到就被当公式反转义成 `\_`,
  // 重开后链接地址少一个反斜杠。
  const caseB = "see [l](http://x/it's/$a\\\\_b$) end\n"
  it('B 链接地址里带撇号:编辑同一块后存盘,地址里的反斜杠还在', async () => {
    const b = await bootEditor(caseB)
    try {
      b.view.dispatch(b.view.state.tr.insertText('Z', 1))
      expect(b.md()).toBe("Zsee [l](http://x/it's/$a\\\\_b$) end\n")
    } finally { await b.destroy() }
  })
  it('B 链接地址里带撇号:整段地址都抹掉', () => {
    expect(maskNonMath(caseB)).toBe('see [l](' + ' '.repeat("http://x/it's/$a\\\\_b$".length) + ') end\n')
  })
  it('B 标题里转义的引号不算闭合;没闭合的标题 = 不是链接(同 CommonMark)', () => {
    expect(maskNonMath('[l](/u "a\\"$b$")')).toBe('[l](' + ' '.repeat('/u "a\\"$b$"'.length) + ')')
    expect(spansOf('[l](/u "$x$)')).toEqual(['$x$'])
  })
  // C:引用定义的标题在下一行
  const caseC = '> [l]: /url\n>   "$a\\_b$"\n>\n> edit\n'
  it('C 引用定义的标题在下一行:改引用里别的段落后存盘,标题里的反斜杠还在', async () => {
    const b = await bootEditor(caseC)
    try {
      let at = -1
      b.view.state.doc.descendants((n, pos) => { if (n.isText && n.text === 'edit') at = pos })
      expect(at).toBeGreaterThan(0)
      b.view.dispatch(b.view.state.tr.insertText('Z', at))
      expect(b.md()).toBe('> [l]: /url\n>   "$a\\_b$"\n>\n> Zedit\n')
    } finally { await b.destroy() }
  })
  it('C 引用定义的标题在下一行:标题一并抹,不参与配对', () => {
    expect(spansOf(caseC)).toEqual([])
  })
  // E:线性 —— 原先每个 `](` 往回扫整段、没闭合的反引号串反复扫到段尾(平方级)
  it('E 病态输入线性:成串的 `](`、成串不闭合的反引号、成串的 `[` + `][]`', () => {
    const time = (md: string): number => { const t = performance.now(); mdMathSpans(md); return performance.now() - t }
    const brackets = (n: number): string => ']('.repeat(n) + '$\\{x\\}$\n'
    const ticks = (n: number): string => Array.from({ length: n }, (_, i) => '`'.repeat(i + 1) + 'x').join(' ') + ' $\\{x\\}$\n'
    const collapsed = (n: number): string => '[l]: /u\n\n' + '['.repeat(n) + 'x' + '][]'.repeat(n) + ' $\\{x\\}$\n'
    expect(spansOf(brackets(16000))).toEqual(['$\\{x\\}$'])
    expect(spansOf(ticks(600))).toEqual(['$\\{x\\}$'])
    expect(spansOf(collapsed(16000))).toEqual(['$\\{x\\}$'])
    // 宽松的绝对上限(修前 16000 个 `](` 单跑掩码要 2 秒以上;高负载机器也留足余量)
    expect(time(brackets(32000))).toBeLessThan(1000)
    expect(time(ticks(1200))).toBeLessThan(1000)
    expect(time(collapsed(32000))).toBeLessThan(1000)
  })
})

describe('公式反斜杠:重开再存不增长(R-01 返修)', () => {
  // 评审给的复现种子:行内代码 / 链接地址里带 `$`、mark 定界符挨着公式。修前:反斜杠 1→2→4→8。
  it.each([
    ['行内代码里的单个 `$`', '用`$`包裹公式,例如$\\{a,b\\}$\n'],
    ['行内代码里的 $HOME', '先设置`$HOME`,再看集合$\\{a,b\\}$\n'],
    ['行内代码里的 $PATH', 'shell 里 `echo $PATH`之后$x\\_1$\n'],
    ['粗体里的货币', '价格**$5**,集合$\\{a\\}$\n'],
    ['链接地址里的 `$`', '[文档](http://x/?$top=1)里$\\{a\\}$\n'],
    ['评审 fuzz 抓到的短例', 'P$\\[$**s**~中文$\n'],
    ['公式旁的转义美元符 `\\$`', '$a \\$,x$\\{b\\}$\n'],
    ['行内代码跨行', '$o `x\ny`z$\\{w\\}$\n'],
    ['BOM 开头', '\uFEFFset $\\{x\\}$ here\n'],
    ['表格单元格里的 `\\|`(首存补宽是既定规范化)', '| h |\n| - |\n| $\\|x\\|$ |\n'],
  ])('%s', async (_label, md) => {
    expectStable(await saves(md))
  })

  it('v3 宿主(softBreakRemark 按行拆段)里跨行的块公式:两侧都按原文认,不因拆段翻倍', async () => {
    const md = '$$\na \\{x\\} \\\\\nb \\{y\\}\n$$\n'
    const seq = await saves(md, 3, { v3: true })
    expect(seq[1]).toBe(md)
    expectStable(seq)
  })

  it('能认出的公式照旧逐字(不是靠「一律不补」换来的稳定)', async () => {
    for (const md of ['集合$\\{a,b\\}$与`code`\n', '$$\\begin{pmatrix} a \\\\ b \\end{pmatrix}$$ 与 `x`\n', '* 项 $\\{a\\}$ 与 [l](http://x.y)\n']) {
      const seq = await saves(md)
      expect(seq[1]).toBe(md)
      expectStable(seq)
    }
  })

  // 小号种子 fuzz(评审 zzReviewFuzz 的片段表):返修前 1500 例里 60 例不稳、34 例反斜杠递增。
  it('种子 fuzz:三轮存盘稳定、反斜杠不增', async () => {
    let seed = 777
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const FRAG = ['$', '$', '$', '$$', '\\{', '\\}', '\\\\', '\\$', '`x$`', '`c`', '[x](http://a/$b)', '*e*', '**s**', '<br>', '中文', 'a', ' ', ' ', ' ', '\\_', '\\,', '\\%', '\\#', '_u_', 'x', 'y', '5', '\\|', '~', '\n', '\n\n', '\\*', '\\[', '\\]']
    const bad: string[][] = []
    for (let t = 0; t < 400; t++) {
      let src = 'P'
      const k = 3 + rnd(12)
      for (let i = 0; i < k; i++) src += FRAG[rnd(FRAG.length)]
      const seq = await saves(src + '\n')
      const rising = seq.slice(2).some((x, i) => backslashes(x) > backslashes(seq[i + 1]))
      if (rising || seq[2] !== seq[1] || seq[3] !== seq[2]) bad.push(seq)
    }
    expect(bad).toEqual([])
  }, 120_000)

  // F03/F04:代码 / 围栏 / 链接地址的排除域进了 mdMathSpans 之后,两侧照样同一口径(片段表偏向反引号与地址)。
  it('种子 fuzz(代码与地址):三轮存盘稳定、反斜杠不增', async () => {
    let seed = 4242
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const FRAG = ['$', '$', '$', '`', '``', '`$a\\_b$`', '``x`$``', '\\`', '\n```\n', '\n~~~~\n', '\n\n    ', '[t](http://a/$b)', '<http://q/$>', '](', '\\{', '\\_', '\\\\', '\\$', 'x', 'y', ' ', ' ', '\n', '\n\n', '中文']
    const bad: string[][] = []
    for (let t = 0; t < 300; t++) {
      let src = 'P'
      const k = 3 + rnd(12)
      for (let i = 0; i < k; i++) src += FRAG[rnd(FRAG.length)]
      const seq = await saves(src + '\n')
      const rising = seq.slice(2).some((x, i) => backslashes(x) > backslashes(seq[i + 1]))
      if (rising || seq[2] !== seq[1] || seq[3] !== seq[2]) bad.push(seq)
    }
    expect(bad).toEqual([])
  }, 180_000)
})

// ── 对拍:手写的 maskNonMath vs 编辑器实际用的 remark 解析器 ─────────────────────────────────────────────
// maskNonMath 是按 Markdown 口径手写的「哪些地方不算公式」。抹多了 = 真公式不补反斜杠(编辑器里公式渲染错,新回归);
// 抹少了 = 代码 / 地址里的 `\_` 存盘时被删(老毛病)。这里拿同一套 remark(编辑器 remarkCtx,只解析、不跑 transformer ——
// transformer 里 refDefinitions 会把 definition 改成字面段落)解析出 mdast,按节点位置算「真的非公式区域」:
// code / inlineCode 整个节点;link / image 的地址 + 标题;definition 的地址 + 标题。
// image 的 alt 不是子节点:从 `![` 起按未转义方括号配平找到 alt 的 `]`,其后才是地址部分。
// 自动链接(`<…>` 与裸网址)的「地址部分」按此算法为空 —— 刻意不抹(序列化器会翻倍其中的反斜杠,见 mathLivePreview.ts「哪些地方不算公式」顶注)。
type Region = { kind: string; from: number; to: number }
let remarkProcessor: { parse(md: string): unknown } | null = null
async function remarkParser(): Promise<{ parse(md: string): unknown }> {
  if (remarkProcessor) return remarkProcessor
  const { remarkCtx } = await import('@milkdown/kit/core')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null
  const b = await bootEditor('x\n', { extra: [((ctx: unknown) => () => { captured = ctx }) as never] })
  remarkProcessor = captured.get(remarkCtx)
  await b.destroy()
  return remarkProcessor!
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function trueRegions(tree: any, md: string): Region[] {
  const out: Region[] = []
  const walk = (n: any): void => {
    const s = n.position?.start?.offset, e = n.position?.end?.offset
    if (typeof s === 'number' && typeof e === 'number') {
      if (n.type === 'code' || n.type === 'inlineCode') out.push({ kind: n.type, from: s, to: e })
      else if (n.type === 'link') {
        const last = n.children?.[n.children.length - 1]?.position?.end?.offset
        out.push({ kind: 'link', from: typeof last === 'number' ? last : s + 1, to: e })
      } else if (n.type === 'image') {
        let depth = 0, k = s + 2
        for (; k < e; k++) {
          if (md[k] === '\\') { k++; continue }
          if (md[k] === '[') depth++
          else if (md[k] === ']') { if (!depth) break; depth-- }
        }
        out.push({ kind: 'image', from: k, to: e })
        // alt 是 image 节点的属性、不是编辑器里的文字:里面嵌的链接地址被解析器整个丢掉(alt 只留文字),
        // 抹不抹都碰不到真公式 —— 记成 imageAlt,只用来免检「抹多了」,不计入抹少了。
        out.push({ kind: 'imageAlt', from: s, to: k })
      } else if (n.type === 'definition') {
        let k = s
        while (k < e && !(md[k] === ']' && md[k - 1] !== '\\')) k++
        out.push({ kind: 'definition', from: k + 1, to: e })
      }
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(tree)
  return out
}
/* eslint-enable @typescript-eslint/no-explicit-any */
/** 被抹的行首容器记号(`>`、列表符):代码行整行抹空时连带抹掉,mdast 的 code 节点从记号之后起算。
 *  它们永远不是 `$` / `\`,也不贴着公式(同一行其余部分都在 code 节点里),不影响公式配对。 */
const CONTAINER_PREFIX = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(?:\[\^[^\]\s]+\]:[ \t]*)?/
interface MaskDiff { over: Array<{ at: number; ch: string }>; under: Region[]; withDollar: Region[] }
function diffMask(md: string, masked: string, regions: Region[]): MaskDiff {
  const inTrue = new Uint8Array(md.length + 1)
  for (const r of regions) for (let x = r.from; x < r.to; x++) inTrue[x] = 1
  const prefixEnd = new Uint8Array(md.length + 1)
  for (let ls = 0; ls <= md.length;) {
    const le = md.indexOf('\n', ls) === -1 ? md.length : md.indexOf('\n', ls)
    const p = CONTAINER_PREFIX.exec(md.slice(ls, le))![0].length
    for (let x = ls; x < ls + p; x++) prefixEnd[x] = 1
    ls = le + 1
  }
  const over: MaskDiff['over'] = []
  for (let x = 0; x < md.length; x++) {
    if (masked[x] === md[x] || /\s/.test(md[x]) || inTrue[x]) continue
    if (prefixEnd[x] && masked.slice(md.lastIndexOf('\n', x) + 1, md.indexOf('\n', x) === -1 ? md.length : md.indexOf('\n', x)).trim() === '') continue
    over.push({ at: x, ch: md[x] })
  }
  const withDollar = regions.filter((r) => r.kind !== 'imageAlt' && md.slice(r.from, r.to).includes('$'))
  const under = withDollar.filter((r) => { for (let x = r.from; x < r.to; x++) if (md[x] === '$' && masked[x] === '$') return true; return false })
  return { over, under, withDollar }
}
// 片段表:各种长度的反引号、围栏(缩进 0–5、列表 / 引用 / 脚注里)、缩进行、列表、引用、脚注定义及续行、`[标签]: 文字`、
// 合法引用定义(含标题在下一行)、链接 / 图片(地址里带 `$`、撇号、括号、`<…>`、标题)、公式、转义、中文。
const MASK_FRAG = [
  '`', '``', '```', '`$a\\_b$`', '``x`$``', '\\`', '$', '$', '$', '$\\{a\\}$', '$a \\\\ b$', '\\{', '\\_', '\\\\', '\\$', '\\[', '\\]',
  '[', ']', '](', '(', ')', '"', "'", '!', '<', '>',
  "[l](http://x/it's/$a\\_b$)", "[l](http://x/it's/$a\\\\_b$)", '[l](</a b/$c$>)', '[l](/u "t $x$")', "[l](/u 't$')", '[l](/u (t$))', '[l](a(b)$c)', '[l]( /u$ )',
  '![i]($p.png "t$")', '[$x$](http://y)', '[a [b](/c$) d](/e$)', '[t][l]', '[l]', '<http://q/$>', '<br>', '<span a="`$">',
  '中文', 'x', 'y', ' ', ' ', ' ', '*e*', 'text[^1]',
  '\n', '\n', '\n\n', '\n\n', '\n- ', '\n  - ', '\n1. ', '\n> ', '\n> > ', '\n>', '\n    ', '\n  ', '\n      ', '\n\t', '\n# ',
  '\n---\n', '\n[^1]: ', '\n\n[^1]: a\n\n    b $\\{x\\}$', '\n[注]: 设 $\\{a\\}$', '\n[l]: /u$', '\n[l]: /u$ "t$x$"', '\n[l]: </a b$>',
  '\n[l]: /u\n  "$a\\_b$"', '\n> [l]: /u\n>   "$a\\_b$"', '\n[l]: /u "t" x$', '\n[l]:\n/u$',
  'FENCE', 'FENCE', 'FENCE', '\n- ```\n', '\n> ```\n', '\n~~~\n', '\n````\n',
  '\n- > ', '\n> - ', '\n   ', '\n1) ', '\n2. ', '\n   - ', '\n***\n', '\n===\n', '\n<div>\n', '\n<!-- ', ' -->',
  '\n| a | b |\n| - | - |\n', '|', '`x|$y$`',
]
function genMaskDoc(rnd: (n: number) => number): string[] {
  const parts: string[] = ['P']
  const k = 4 + rnd(18)
  for (let i = 0; i < k; i++) {
    const f = MASK_FRAG[rnd(MASK_FRAG.length)]
    parts.push(f === 'FENCE' ? `\n${' '.repeat(rnd(6))}${rnd(4) ? '```' : '~~~'}\n` : f)
  }
  return parts
}
async function maskFuzz(seed0: number, cases: number): Promise<{ over: string[]; under: Map<string, string[]>; regionsWithDollar: number; underCount: number; underByKind: Record<string, [number, number]> }> {
  const { maskNonMath } = await import('./mathLivePreview')
  const proc = await remarkParser()
  let seed = seed0
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const check = (md: string): MaskDiff => diffMask(md, maskNonMath(md), trueRegions(proc.parse(md), md))
  const over: string[] = []
  const under = new Map<string, string[]>()
  const underByKind: Record<string, [number, number]> = {}
  let regionsWithDollar = 0, underCount = 0
  for (let t = 0; t < cases; t++) {
    const parts = genMaskDoc(rnd)
    const md = parts.join('') + '\n'
    const d = check(md)
    regionsWithDollar += d.withDollar.length
    underCount += d.under.length
    for (const r of d.withDollar) (underByKind[r.kind] ||= [0, 0])[1]++
    for (const r of d.under) {
      underByKind[r.kind][0]++
      const list = under.get(r.kind) ?? []
      if (list.length < 3) list.push(md.slice(r.from, r.to) + (process.env.MASK_FUZZ_DEBUG ? `  ⟸ ${JSON.stringify(md)}` : ''))
      under.set(r.kind, list)
    }
    if (d.over.length) {
      // 缩小:逐个删片段,仍抹多就保留删除
      let cur = parts.slice()
      for (let i = cur.length - 1; i >= 0; i--) {
        const tryParts = cur.slice(0, i).concat(cur.slice(i + 1))
        if (check(tryParts.join('') + '\n').over.length) cur = tryParts
      }
      const small = cur.join('') + '\n'
      over.push(JSON.stringify(small) + (process.env.MASK_FUZZ_DEBUG ? `  masked=${JSON.stringify(maskNonMath(small))} over=${JSON.stringify(check(small).over)}` : ''))
    }
  }
  return { over, under, regionsWithDollar, underCount, underByKind }
}

describe('maskNonMath 对拍 remark 解析器(抹多了必须为 0)', () => {
  it('解析器口径自检:gfm 脚注 / 删除线在、节点带偏移', async () => {
    const proc = await remarkParser()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree: any = proc.parse('a[^1] ~~d~~\n\n[^1]: x\n')
    const types: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (n: any): void => { types.push(n.type); expect(typeof n.position?.start?.offset).toBe('number'); for (const c of n.children ?? []) walk(c) }
    walk(tree)
    expect(types).toContain('footnoteDefinition')
    expect(types).toContain('delete')
  })
  it('种子 fuzz:抹多了 = 0;抹少了报比例', async () => {
    const N = Number(process.env.MASK_FUZZ_N ?? 500)
    const seed = Number(process.env.MASK_FUZZ_SEED ?? 20261114)
    const r = await maskFuzz(seed, N)
    console.log(`[mask-fuzz] seed=${seed} cases=${N} over=${r.over.length} under=${r.underCount}/${r.regionsWithDollar} byKind=${JSON.stringify(r.underByKind)}`)
    for (const [kind, shapes] of r.under) console.log(`[mask-fuzz] under ${kind}: ${shapes.map((x) => JSON.stringify(x)).join(' | ')}`)
    for (const o of r.over.slice(0, 40)) console.log(`[mask-fuzz] over: ${o}`)
    expect(r.over).toEqual([])
  }, 180_000)
})

describe('切块 / 剪贴板结构化复制(normalizeFragmentMd)', () => {
  it('公式里读时补回的反斜杠不在片段 md 里翻倍', async () => {
    const md = '* 看 $\\{a\\}$ 与 $$x \\\\ y$$\n'
    const b = await bootEditor(md)
    try {
      const { state } = b.view
      // 同 clipboardTextSerializer:切片内容 → topNodeType.createAndFill → 宿主序列化器 → 片段规范化
      const doc = state.schema.topNodeType.createAndFill(undefined, state.doc.slice(0, state.doc.content.size).content)!
      expect(normalizeFragmentMd(b.serialize(doc))).toBe(md.trimEnd() + '\n')
    } finally { await b.destroy() }
  })
})

// 块公式的复制键(排在 `</>` 左边;只读视图也挂、靠到最右);复制纯 LaTeX,不带 `$$`。
describe('块公式复制键', () => {
  it('块公式挂复制键、排在 </> 之前,点了写纯 LaTeX;行内公式不挂', async () => {
    const { mathLivePreviewPlugin } = await import('./mathLivePreview')
    const b = await bootEditor('$$\nT = \\frac{a}{b}\n$$\n\n行内 $x$ 一个\n', { extra: [mathLivePreviewPlugin()] })
    try {
      const block = b.view.dom.querySelector('.math-rendered--block')!
      const btns = [...block.querySelectorAll(':scope > .amx-src-btn')]
      expect(btns.map((x) => x.classList.contains('amx-src-btn--copy'))).toEqual([true, false])
      expect(b.view.dom.querySelector('.math-rendered:not(.math-rendered--block) .amx-src-btn--copy')).toBeNull()
      let wrote = ''
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { wrote = s } } })
      ;(btns[0] as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 0))
      expect(wrote).toBe('T = \\frac{a}{b}')
      expect(btns[0].classList.contains('is-copied')).toBe(true)
    } finally { await b.destroy() }
  })
  it('键盘按在复制键 / </> 上不改文档(按键不冒到编辑器的键位表)', async () => {
    const { mathLivePreviewPlugin } = await import('./mathLivePreview')
    const { TextSelection } = await import('@milkdown/kit/prose/state')
    const b = await bootEditor('前面一段文字\n\n$$\nE=mc^2\n$$\n', { extra: [mathLivePreviewPlugin()] })
    try {
      const before = b.md()
      b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, 2, 5)))
      for (const btn of b.view.dom.querySelectorAll('.math-rendered--block > .amx-src-btn')) {
        for (const key of ['Enter', ' ', 'Backspace']) btn.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }
      expect(b.md()).toBe(before)
    } finally { await b.destroy() }
  })
  it('只读视图:没有 </>,复制键照样在、带 --solo', async () => {
    const { mathLivePreviewPlugin } = await import('./mathLivePreview')
    const b = await bootEditor('seed\n', { extra: [mathLivePreviewPlugin()] })
    try {
      b.view.setProps({ editable: () => false })
      b.view.dispatch(b.view.state.tr.insertText('$$E=mc^2$$', 1))
      const block = b.view.dom.querySelector('.math-rendered--block')!
      const btns = [...block.querySelectorAll(':scope > .amx-src-btn')]
      expect(btns.length).toBe(1)
      expect(btns[0].classList.contains('amx-src-btn--solo')).toBe(true)
    } finally { await b.destroy() }
  })
})

// 格式浮条 / 预览共用的「选区在不在公式里」:光标按源码范围(含开头的 `$`),非空选区要落在两头的 `$` 之间。
describe('formulaAtSelection', () => {
  it('caret and selections inside the body hit the formula; whole-formula and crossing selections do not', async () => {
    const b = await bootEditor('Lead $x + \\beta$ and $y$\n\n$$ t(\\{n_{j}\\}) $$\n\n```tex\n$\\alpha$\n```\n')
    try {
      const v = b.view
      const at = (from: number, to = from) => {
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)))
        return formulaAtSelection(v.state)
      }
      // `Lead $x + \beta$`: `$` at 6, body 7..16, closing `$` ends at 17
      expect(at(9)).toMatchObject({ from: 6, to: 17, latex: 'x + \\beta', display: false })
      expect(at(7, 16)?.latex).toBe('x + \\beta')
      expect(at(6, 17)).toBeNull() // the whole formula, `$` included
      expect(at(3, 9)).toBeNull() // half in the text
      const start = v.state.doc.child(0).nodeSize + 1
      const size = v.state.doc.child(1).content.size
      expect(at(start + 3, start + size - 3)).toMatchObject({ display: true })
      expect(at(start + 1, start + size)).toBeNull() // starts on the opening `$$`
      const code = v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize + 1
      expect(at(code + 2, code + 4)).toBeNull()
    } finally { await b.destroy() }
  })
})

// 背景色划线连公式一起:渲染件是挂在源码前的 widget,要套上源码整段带着的标记,不然公式那块没有底色。
describe('formula widget carries the source marks', () => {
  it('a highlighted inline formula renders inside the same <mark>; partial / unmarked ones stay bare', async () => {
    const b = await bootEditor('<mark style="background:#fef3a1">$t(\\{n_j\\})$: number</mark>, $a$ and <mark>$b</mark>$ <mark>lead </mark>$c$\n', {
      extra: [inlineHtmlMarksRemark, bgSchema, mathLivePreviewPlugin()].flat(),
    })
    try {
      const v = b.view
      v.dom.blur()
      v.dispatch(v.state.tr) // 失焦 → 全部渲染
      const rendered = [...v.dom.querySelectorAll('.math-rendered')] as HTMLElement[]
      expect(rendered.length).toBe(4)
      const [hl, plain, partial, after] = rendered
      const mark = hl.closest('mark')
      expect(mark?.getAttribute('data-hl')).toBe('yellow')
      expect(mark?.textContent).toContain(': number') // 和后面那段划线同一个 <mark>,底色连成一条
      expect(plain.closest('mark')).toBeNull()
      expect(partial.closest('mark')).toBeNull() // 只划了半个公式:不套
      expect(after.closest('mark')).toBeNull() // 紧跟在一段划线后面、自己没划:不沿用前文的 <mark>
    } finally {
      await b.destroy()
    }
  })
})
