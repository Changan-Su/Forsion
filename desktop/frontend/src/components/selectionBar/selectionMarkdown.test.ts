// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import katex from 'katex'
import { selectionMarkdown } from './selectionMarkdown'

let root: HTMLDivElement
beforeEach(() => { document.body.innerHTML = ''; root = document.createElement('div'); document.body.append(root) })
const math = (source: string, displayMode = false): string => katex.renderToString(source, { displayMode })
function select(node: Node): Selection {
  const range = document.createRange(); range.selectNodeContents(node)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  return selection
}

describe('rendered selection to Markdown', () => {
  it('replaces both KaTeX layers with one source formula, including fractions, ket and display math', () => {
    root.innerHTML = `<p>Spin ${math('s')} takes ${math(String.raw`s=0,\frac12,1,\frac32`)}.</p>${math(String.raw`S^2|s,m\rangle=\hbar^2s(s+1)|s,m\rangle`, true)}`
    const result = selectionMarkdown(select(root), root)!
    expect(result.markdown).toContain(String.raw`$s=0,\frac12,1,\frac32$`)
    expect(result.markdown).toContain(String.raw`$$
S^2|s,m\rangle=\hbar^2s(s+1)|s,m\rangle
$$`)
    expect(result.markdown.match(/\$s\$/g)).toHaveLength(1)
    expect(result.markdown).not.toContain('𝑠')
  })
  it('a selection inside a numerator captures the whole formula without mutating the real range', () => {
    root.innerHTML = `Before ${math(String.raw`\frac{123}{456}`)} after`
    const numerator = Array.from(root.querySelectorAll('.katex-html span')).find((el) => el.textContent === '123')!
    const selection = select(numerator)
    const original = selection.getRangeAt(0)
    const start = original.startContainer; const end = original.endContainer
    expect(selectionMarkdown(selection, root)?.markdown).toBe(String.raw`$\frac{123}{456}$`)
    expect(selection.getRangeAt(0).startContainer).toBe(start)
    expect(selection.getRangeAt(0).endContainer).toBe(end)
  })
  it('preserves selected prose, formatting, destinations, fenced code and paragraph boundaries', () => {
    root.innerHTML = '<p>Read <strong>this</strong> <a href="https://example.org">manual</a>.</p><pre><code class="language-ts">const x = `$y$`;\n</code></pre><p>Next.</p>'
    const result = selectionMarkdown(select(root), root)!
    expect(result.markdown).toContain('**this** [manual](<https://example.org>)')
    expect(result.markdown).toContain('```ts\nconst x = `$y$`;\n```')
    expect(result.text).toContain('Read this manual.')
    expect(result.markdown).toContain('Next.')
    const outside = document.createElement('div'); document.body.append(outside); outside.textContent = 'outside'
    expect(selectionMarkdown(select(outside), root)).toBeNull()
  })
  it('keeps a selection entirely inside code marked as code, even without the parent in cloneContents', () => {
    root.innerHTML = '<p>Use <code>$literal$</code> here.</p>'
    const selection = select(root.querySelector('code')!)
    expect(selectionMarkdown(selection, root)?.markdown).toBe('` $literal$ `')
  })
  it('keeps the destination when selecting inside a link label', () => {
    root.innerHTML = '<p>Read <a href="https://example.org"><strong>manual</strong></a>.</p>'
    expect(selectionMarkdown(select(root.querySelector('strong')!), root)?.markdown).toBe('[**manual**](<https://example.org>)')
  })
  it('keeps nested list indentation, ordered start values and literal table pipes', () => {
    root.innerHTML = '<ol start="3"><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ol><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a | b</td><td>42</td></tr></tbody></table>'
    const result = selectionMarkdown(select(root), root)!.markdown
    expect(result).toContain('3. Parent\n   \n   - Child\n4. Next')
    expect(result).toContain('| a \\| b | 42 |')
  })
  it('keeps pipes inside table code/math from creating extra columns', () => {
    root.innerHTML = `<table><thead><tr><th>State</th><th>Value</th></tr></thead><tbody><tr><td>${math(String.raw`|s,m\rangle+\text{a|b}`)}</td><td><code>a | b</code></td></tr></tbody></table>`
    const result = selectionMarkdown(select(root), root)!.markdown
    expect(result).toContain(String.raw`$\vert s,m\rangle+\text{a\textbar b}$`)
    expect(result).toContain('` a \\| b `')
    expect(() => katex.renderToString(String.raw`\vert s,m\rangle+\text{a\textbar b}`)).not.toThrow()
  })
})
