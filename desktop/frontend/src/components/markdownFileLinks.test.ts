// @vitest-environment happy-dom
// D25:聊天里指向文件的普通 Markdown 链接渲染成文件引用条(按会话工作目录拼绝对路径),不安全的地址照旧被清空。
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'

const render = (content: string, cwd?: string): string => renderToStaticMarkup(createElement(Markdown, { content, run: cwd ? { cwd } : undefined }))

describe('chat Markdown file links', () => {
  it('`[x](src/a.ts:42)` → 文件引用条,路径按工作目录拼好、带行号', () => {
    const html = render('见 [src/a.ts:42](src/a.ts:42) 和 [这段](./lib/b.py:3-9)', '/repo')
    expect(html).toContain('data-wiki="/repo/src/a.ts"')
    expect(html).toContain('title="/repo/src/a.ts:42"')
    expect(html).toContain('title="/repo/lib/b.py:3-9"')
    const box = document.createElement('div'); box.innerHTML = html
    expect(box.textContent).toBe('见 a.ts:42 和 这段')
  })
  it('没有工作目录(插件说明之类)时相对路径不当文件,绝对路径照样当', () => {
    const html = render('[guide](docs/setup.md) [b](a.ts:3) [c](/abs/c.ts:9)')
    expect(html).toContain('href="docs/setup.md"')
    expect(html).not.toContain('a.ts:3"')
    expect(html).toContain('data-wiki="/abs/c.ts"')
  })
  it('网址照旧是网页链接;javascript: 照旧被清空', () => {
    const html = render('[a](https://example.org/a.ts) [b](javascript:alert(1))', '/repo')
    expect(html).toContain('href="https://example.org/a.ts"')
    expect(html).not.toContain('javascript:')
  })
})
