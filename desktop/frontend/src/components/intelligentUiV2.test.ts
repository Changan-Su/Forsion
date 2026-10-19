// @vitest-environment happy-dom
// Intelligent UI v2 渲染层:真组件 renderToStaticMarkup。钉三件:画廊文档按初值算出来、算出来的字插进 markdown
// 只当纯文字(网址不变链接、竖线不拆表格格子)、比本版更新的文档显示标题 + 首段 + 「要新版」。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IntelligentUi } from './IntelligentUi'
import type { ToolEvent } from '../types'
const gallery = JSON.parse(readFileSync(join(__dirname, '../../../scripts/fixtures/intelligent-ui-gallery.json'), 'utf8'))
const html = (doc: unknown): string => renderToStaticMarkup(React.createElement(IntelligentUi, {
  event: { id: 'call-1', name: 'intelligent_ui', arguments: JSON.stringify({ document: JSON.stringify(doc) }), done: true, result: 'Intelligent UI rendered: x', isError: false } as unknown as ToolEvent,
  live: false,
}))

describe('Intelligent UI v2 renderer', () => {
  it('computes the gallery mortgage at its initial values: text, figures and table', () => {
    const out = html(gallery.loan)
    expect(out).toContain('每月还 5,190 元')
    expect(out).toContain('<dd aria-live="polite">66.8 万</dd>')
    expect(out.match(/<tr>/g)).toHaveLength(7) // 表头 + 6 行(5 年一档到 30 年)
    expect(out).toContain('<td data-num="true">107.1 万</td>')
  })
  it('inserts computed text as plain text: no links, no extra table cells', () => {
    const doc = { version: 2, id: 'esc', title: 'Escape', inputs: [], state: [{ id: 's', initial: 'https://evil.example www.x.com a|b [x](https://y.example) **bold**' }], derived: [], resources: [], blocks: [
      { id: 't', kind: 'text', markdown: 'Value: {{s}}\n\n| k | v |\n|---|---|\n| one | {{s}} |' },
    ] }
    const out = html(doc)
    expect(out).not.toContain('<a')
    expect(out).not.toContain('<strong>')
    expect(out.match(/<td>/g)).toHaveLength(2)
    expect(out).toContain('https://evil.example')
  })
  it('shows the title, opening text and a notice for a document from a later version', () => {
    const out = html({ version: 3, id: 'n', title: 'From the future', inputs: [], blocks: [{ id: 'a', kind: 'text', markdown: 'Opening line.' }, { id: 'b', kind: 'hologram' }] })
    expect(out).toContain('From the future')
    expect(out).toContain('Opening line.')
    expect(out).toContain('这张卡要新版 Forsion 才能显示。')
  })
  it('renders set buttons off when their condition holds, and the flashcard figures', () => {
    const out = html(gallery.vocab)
    expect(out).toMatch(/<button type="button" disabled="">从头再来<\/button>/)
    expect(out).toMatch(/<button type="button">认识<\/button>/)
    expect(out).toContain('<dt>还剩</dt><dd aria-live="polite">10</dd>')
  })
})
