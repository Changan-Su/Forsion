// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mdMathSpans, scanMath, unescapeMathSource } from './mathLivePreview'
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
