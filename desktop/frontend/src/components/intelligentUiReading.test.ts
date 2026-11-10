// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IntelligentUi } from './IntelligentUi'
import { RunContext } from './Markdown'
import type { ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'
const render = (markdown: string, kind = 'text', values = '') => {
  const doc = { version: 2, id: 'reading', title: 'Lecture notes', inputs: [], resources: [], state: [{ id: 'value', initial: values }], derived: [], blocks: [{ id: 'body', kind, title: kind === 'disclosure' ? 'Details' : undefined, markdown }] }
  const event = { id: 'reading', name: 'intelligent_ui', done: true, result: 'Intelligent UI rendered.', arguments: JSON.stringify({ document: JSON.stringify(doc) }) } as ToolEvent
  return renderToStaticMarkup(createElement(RunContext.Provider, { value: { cwd: '/course', allowRun: true } }, createElement(IntelligentUi, { event, live: false })))
}
describe('Intelligent UI reading compatibility', () => {
  it.each(['text', 'disclosure'])('renders math and note/PDF references in %s', kind => {
    const html = render('Inline $n_i!$.\n\n$$\n\\Omega=\\frac{N!}{\\prod_i n_i!}\n$$\n\n[[/course/book.pdf#page=20|Textbook]] [[Lecture 1]] [Source](./notes.md:4)', kind)
    expect(html.match(/class="katex"/g)).toHaveLength(2)
    expect(html).toContain('class="md-math"')
    expect(html).not.toContain('katex-error')
    expect(html).toContain('data-wiki="/course/book.pdf"')
    expect(html).toContain('wikilink-unresolved">Lecture 1</span>')
    expect(html).toContain('title="/course/notes.md:4"')
  })
  it('keeps computed strings inert without mutating the cached parse tree', () => {
    const html = render('Value: {{value}} and $x$', 'text', '[[secret.md]] **bold** $y$ <img src=x>')
    expect(html).not.toContain('data-wiki="secret.md"')
    expect(html).not.toContain('<strong>bold')
    expect(html).not.toContain('<img')
    expect(html.match(/class="katex"/g)).toHaveLength(1)
    expect(render('Value: {{value}} and $x$', 'text', 'second')).toContain('Value: second')
  })
  it('resolves computed math and wiki labels without allowing TeX or destination injection', () => {
    const html = render('$x={{value}}$\n\n$$\ny={{value}}\n$$\n\n[[/course/book.pdf#page=2|Page {{value}}]]', 'text', '42')
    expect(html).not.toContain('\uE000')
    expect(html).toContain('42')
    expect(html).not.toContain('katex-error')
    const host = document.createElement('div'); host.innerHTML = html
    expect(host.querySelector('.wikilink')?.textContent).toBe('Page 42')
    const unsafe = render('$x={{value}}$ [[{{value}}|Link]]', 'text', '\\href{https://evil.example}{click}')
    expect(unsafe).not.toContain('href="https://evil.example"')
    expect(unsafe).not.toContain('data-wiki=')
    expect(unsafe).not.toContain('katex-error')
  })
  it('renders malformed encoded wiki targets as text', () => {
    expect(render('[Broken](#wiki=%FF)')).toContain('Broken')
  })
  it('keeps code copy and blocks execution, images, HTML and unsafe links', () => {
    const html = render('```bash\necho hello\n```\n\n![remote](https://example.org/x.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [private](http://127.0.0.1/x) [good](https://example.org)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="http://127.')
    expect(html).toContain('href="https://example.org"')
    expect(html).not.toContain('运行')
    expect(html).toContain('复制')
  })
})
