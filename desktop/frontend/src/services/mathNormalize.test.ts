import { describe, it, expect } from 'vitest'
import { normalizeMath } from './mathNormalize'

describe('normalizeMath', () => {
  it('行内 \\(..\\) → $..$', () => {
    expect(normalizeMath('能量 \\(E=mc^2\\) 守恒')).toBe('能量 $E=mc^2$ 守恒')
  })
  it('块级 \\[..\\] → $$..$$', () => {
    expect(normalizeMath('\\[\\int_0^1 x\\,dx\\]')).toBe('$$\\int_0^1 x\\,dx$$')
  })
  it('围栏代码块内不改写', () => {
    const s = '```\n\\(x\\)\n```'
    expect(normalizeMath(s)).toBe(s)
  })
  it('行内代码不改写', () => {
    const s = 'use `\\(x\\)` literally'
    expect(normalizeMath(s)).toBe(s)
  })
  it('已是 $ 的保持不动', () => {
    expect(normalizeMath('$a^2$ and $$b$$')).toBe('$a^2$ and $$b$$')
  })
})

// 11-17:改由解析器认公式后,以前正则会改坏的几种(借鉴 DeepSeek chat-demo ⑦)
describe('normalizeMath 跟解析器同口径', () => {
  it('\\\\( 是转义的字面括号,不当公式', () => {
    const s = 'a \\\\(x\\\\) b'
    expect(normalizeMath(s)).toBe(s)
  })
  it('没闭合的围栏(流式写到一半)、~~~ 围栏、缩进代码里都不改写', () => {
    for (const s of ['```py\nprint("\\(")\nx = 1 \\) y', '~~~\n\\(x\\)\n~~~', 'para\n\n    \\(x\\)']) expect(normalizeMath(s)).toBe(s)
  })
  it('段落里跨行的 \\[ 也认得;列表里的块公式只换定界符', () => {
    expect(normalizeMath('text \\[\nb\n\\]')).toBe('text $$\nb\n$$')
    expect(normalizeMath('- a\n- \\[y\\]')).toBe('- a\n- $$y$$')
  })
  it('没闭合的公式原样留着', () => {
    expect(normalizeMath('a \\(x^2 + ')).toBe('a \\(x^2 + ')
  })
})
