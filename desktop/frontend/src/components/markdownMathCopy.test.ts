// @vitest-environment happy-dom
//
// Chat 等处 Markdown 的块公式复制键:只给 `$$…$$` 块公式(段落里的 `$$x$$` 是行内,不挂),
// 复制的是 KaTeX annotation 里的纯 LaTeX,不带 `$$`。
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const md = (content: string) => React.createElement(Markdown, { content })

describe('Markdown × 块公式复制键', () => {
  it('块公式包一层 md-math、带复制键;行内公式不包', () => {
    const h = renderToStaticMarkup(md('a\n\n$$\nT = \\frac{a}{b}\n$$\n\n行内 $x$ 和 $$y$$ 结束'))
    expect(h.match(/class="md-math"/g)?.length).toBe(1)
    expect(h).toMatch(/class="md-math"[\s\S]*class="katex-display"[\s\S]*aria-label="复制 LaTeX"/)
    expect(h).not.toContain('data-tex') // 源码只给组件读,不漏进 DOM
  })
  it('点复制键写入纯 LaTeX', async () => {
    let wrote = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { wrote = s } } })
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(md('$$\nE = mc^2\n$$')) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.md-math > button')!.click() })
    expect(wrote).toBe('E = mc^2')
    act(() => root.unmount())
  })
  // 11-17:\( \[ 由解析器直接认(remarkLlmMath),不再先用正则改写源文
  it('\\[ 块公式同样带复制键,\\( 渲染成行内公式', () => {
    const h = renderToStaticMarkup(md('a\n\n\\[\nT = \\frac{a}{b}\n\\]\n\n行内 \\(x^2\\) 结束'))
    expect(h.match(/class="md-math"/g)?.length).toBe(1)
    expect(h.match(/class="katex"/g)?.length).toBe(2)
    expect(h).not.toContain('\\(')
  })
  it('代码里和 \\\\( 转义的不当公式', () => {
    const h = renderToStaticMarkup(md('a \\\\(x\\\\) b\n\n~~~\n\\(y\\)\n~~~'))
    expect(h).not.toContain('katex')
    expect(h).toContain('\\(x\\)')
    expect(h).toContain('\\(y\\)')
  })
  it('单独成段的 \\[ 升成块公式;段中的、带后文的、没闭合的不升', () => {
    const block = renderToStaticMarkup(md('\\[\nE[X] = \\mu\n\\]'))
    expect(block.match(/class="md-math"/g)?.length).toBe(1)
    expect(block).toContain('katex-display')
    const inline = renderToStaticMarkup(md('\\[x\\] tail and \\[y\\]'))
    expect(inline).not.toContain('md-math')
    expect(inline.match(/class="katex"/g)?.length).toBe(2)
    expect(inline).toContain('tail')
    const partial = renderToStaticMarkup(md('\\[\n\\frac{1'))
    expect(partial).not.toContain('katex')
  })
  it('块公式里以 - + 1. # > 开头的行、空行都还是公式,不被拆成列表 / 引用(Codex 11-17 复核)', () => {
    for (const src of ['\\[\na\n+ b\n\\]', '\\[\nx =\n- y\n\\]', '\\[\n1. x\n\\]', '\\[\n> x\n\\]', '\\[\na\n\nb\n\\]', 'para\n\\[\nx\n\\]\nmore', '- item\n\n  \\[\n  - y\n  \\]']) {
      const h = renderToStaticMarkup(md(src))
      expect(h.match(/class="md-math"/g)?.length, src).toBe(1)
      expect(h, src).not.toMatch(/<li>[^<]*y|<blockquote/)
    }
  })
  it('块公式没收尾(流式写到一半)按普通文字显示', () => {
    for (const src of ['\\[\nx =\n- y', '\\[']) expect(renderToStaticMarkup(md(src)), src).not.toContain('katex')
  })
})
