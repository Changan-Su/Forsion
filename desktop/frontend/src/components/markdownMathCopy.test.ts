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
})
