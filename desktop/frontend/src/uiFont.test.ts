/**
 * 字体覆盖的两条会真出事的性质:
 *  ① 值拼进 CSS 文本 → 必须挡住 `;` / `}` / 注释,否则一个被改写的 localStorage 就能往全局样式表里塞规则。
 *  ② 「跟随主题」必须是**一条声明都不出**,而不是出个空值 —— 出空值会把主题字体清成默认无衬线。
 */
import { describe, expect, it } from 'vitest'
import { sanitizeFont, buildFontCss } from './uiFont'

describe('sanitizeFont', () => {
  it('放行正常字体名(含中文与引号逗号)', () => {
    expect(sanitizeFont("'PingFang SC', 苹方, ui-sans-serif")).toBe("'PingFang SC', 苹方, ui-sans-serif")
  })

  it('剔掉能越出声明的字符', () => {
    expect(sanitizeFont('Inter; } body { display: none')).toBe('Inter  body  display none')
    expect(sanitizeFont('Inter/*x*/')).toBe('Interx')
    expect(sanitizeFont('a<script>')).toBe('ascript')
  })

  it('空/空白/null → 空串', () => {
    expect(sanitizeFont('   ')).toBe('')
    expect(sanitizeFont(null)).toBe('')
  })
})

describe('buildFontCss', () => {
  it('三档全空 → 不出任何 CSS(跟随主题)', () => {
    expect(buildFontCss({})).toBe('')
    expect(buildFontCss({ ui: '', body: '  ', mono: '' })).toBe('')
  })

  it('界面档同时盖 --font-ui 与 Amadeus soft 的 --font,且带 !important', () => {
    const css = buildFontCss({ ui: 'Inter' })
    expect(css).toContain('--font-ui: Inter !important;')
    expect(css).toContain('--font: Inter !important;')
    expect(css).not.toContain('--font-mono')
  })

  it('选择器点到会重定义字体变量的那几个类(否则被 .tangu-lovable[data-skin] 遮住)', () => {
    const css = buildFontCss({ mono: 'Menlo' })
    for (const sel of [':root', '.am-app', '.tangu-lovable', '.tangu-soft']) expect(css).toContain(sel)
    expect(css).toContain('--mono: Menlo !important;')
  })

  it('脏值进来也只产出一条规则(逃不出花括号)', () => {
    const css = buildFontCss({ ui: 'X; } * { color: red' })
    expect(css.match(/[{}]/g)).toEqual(['{', '}'])
  })
})
