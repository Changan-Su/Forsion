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
