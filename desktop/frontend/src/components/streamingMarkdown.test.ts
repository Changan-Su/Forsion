// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { markdownSnapshot, type MarkdownSnapshot } from './streamingMarkdown'

// Keep this test about parsing/DOM identity; the real Electron probe exercises lazy highlighting.
vi.mock('../lib/nearViewport', () => ({ whenNear: () => () => {} }))
const render = (content: string) => renderToStaticMarkup(React.createElement(Markdown, { content }))
const clean = (html: string) => html.replace(/>\s+</g, '><')
const fixtures = [
  '# Heading\n\nA **bold** paragraph.\n\nAnother $x^2$ paragraph.\n\n## Next\n\nend',
  'a\n\nSetext\n======\n\nA | B\n---|---\nx | y\n\nend',
  '## H\n\n```typescript\nconst a = `x`;\n\n// a blank line inside a fence\n```\n\nend',
  '   ~~~~js\n   const a = 1\n\n   ~~~~\n\nend',
  '> quote\n>\n> - list\n>   continued\n\n> second quote\n\nend',
  '1. one\n2. two\n\n   second paragraph\n\n   - nested\n\n3. three\n\nend',
  '- a\n\n- b\n\n# heading\n\nend',
  'start\n\n    indented code\n\n    still code\n\nend',
  '$$\n\\sum_{i=0}^n x_i\n\n+ y\n$$\n\nend',
  'start\n\n<div>\n\nraw html\n\n</div>\n\nend',
  'a [late][ref] and ![image][ref]\n\nsecond\n\nthird\n\n[ref]: https://example.org "title"\n',
  'a[^note]\n\nsecond\n\n[^note]: footnote\n\n    continued\n\nend',
  'a [late][ref]\n\nsecond\n\n> [ref]: https://example.org\n\nend',
  'A **中文：**正文 ~~中文~~\n\n[[笔记]]\n\n![[image.png]]\n\nend',
  '# A\r\r## B\r\rTail',
  '# A\r\n\r\n## B\r\n\r\nTail',
  '# h\n    /x\n-\n##',
  'prose\n- -\n',
  'hi\n\n\uFEFF# Heading',
]

describe('incremental Markdown', () => {
  it.each(fixtures)('matches whole-document Markdown at every streamed prefix: %s', (source) => {
    let previous: MarkdownSnapshot | undefined
    // Different chunk boundaries include half a delimiter, CRLF and a final definition.
    for (let i = 1; i <= source.length; i++) {
      const text = source.slice(0, i)
      const next = markdownSnapshot(text, previous)
      expect(clean(next.chunks.map((c) => render(c.content)).join('\n')), `prefix ${i}: ${JSON.stringify(text)}`).toBe(clean(render(text)))
      previous = next
    }
  })
  it('reuses stable chunks, resets on replacements, and reparses document-scoped references', () => {
    const first = markdownSnapshot('# A\n\nOne\n\nTwo\n\nThree')
    const next = markdownSnapshot(first.source + ' more', first)
    expect(next.chunks[0]).toBe(first.chunks[0])
    expect(next.chunks[1]).toBe(first.chunks[1])
    expect(markdownSnapshot('Replacement', next).chunks.map((c) => c.content).join('')).toBe('Replacement')
    expect(markdownSnapshot(next.source + '\n\n[id]: /link', next).whole).toBe(true)
  })
  it.each(['\n', '\r', '\r\n'])('preserves headings/DOM with %j across updates and completion, with identical final rendering', async (newline) => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const el = document.createElement('div')
    const root = createRoot(el)
    const update = (content: string, streaming: boolean) => act(async () => root.render(React.createElement(Markdown, { content, streaming, anchorPrefix: 'toc-test' })))
    const start = '# A\n\nOne\n\n## B\n\nTwo\n\n### C\n\nTail'.replaceAll('\n', newline)
    try {
      await update(start, true)
      const heading = el.querySelector('h1')
      const first = el.querySelector('p')
      await update(start + ' keeps growing', true)
      expect(el.querySelector('h1')).toBe(heading)
      expect(el.querySelector('p')).toBe(first)
      await update(start + ' keeps growing', false)
      expect(el.querySelector('h1')).toBe(heading)
      expect(el.querySelector('p')).toBe(first)
      expect([...el.querySelectorAll('h1,h2,h3')].map((h) => h.id)).toEqual(['toc-test-0', 'toc-test-1', 'toc-test-2'])
      const expected = renderToStaticMarkup(React.createElement(Markdown, { content: start + ' keeps growing', anchorPrefix: 'toc-test' }))
      expect(clean(el.innerHTML)).toBe(clean(expected))
    } finally { await act(async () => root.unmount()) }
  })
})
