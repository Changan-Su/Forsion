import { describe, it, expect } from 'vitest'
import { scanMath, unescapeMathSource } from './mathLivePreview'

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

// 落盘反转义:remark 会把纯文本公式里的标点转义(x_i→x\_i),unescapeMathSource 精确还原。
describe('unescapeMathSource', () => {
  it('还原行内公式里被转义的下标 / 星号', () => {
    expect(unescapeMathSource('值 $x\\_i$ 与 $a\\*b$')).toBe('值 $x_i$ 与 $a*b$')
  })
  it('还原块级公式里的转义(下标)', () => {
    expect(unescapeMathSource('$$a\\_b$$')).toBe('$$a_b$$')
  })
  it('LaTeX 命令的反斜杠被 remark 翻倍 → 反转义正好还原(\\\\sum → \\sum)', () => {
    // remark 把 LaTeX 里的 \sum 序列化成 \\sum;标准反转义 \X→X 把 \\ 收回单个 \,得回 \sum。
    expect(unescapeMathSource('$$\\\\sum_{x}$$')).toBe('$$\\sum_{x}$$')
  })
  it('围栏代码块内不动(块内 $…$ 不是公式)', () => {
    const md = '```\n$a\\_b$ echo "\\n"\n```'
    expect(unescapeMathSource(md)).toBe(md)
  })
  it('无 $ 直接原样返回', () => {
    expect(unescapeMathSource('普通文字 a_b * c')).toBe('普通文字 a_b * c')
  })
})
