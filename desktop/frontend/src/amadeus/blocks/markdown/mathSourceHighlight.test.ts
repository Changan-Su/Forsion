// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { mathSourceHighlights } from './mathSourceHighlight'
import { bootEditor } from './parseFidelity.testkit'
import { mathLivePreviewPlugin } from './mathLivePreview'
import { editorFocusKey, editorFocusPlugin } from './editorFocus'

const KINDS = ['dollar', 'command', 'script', 'letter', 'number', 'bracket'] as const
const kindOf = (className: string) => KINDS.find((k) => className.split(' ').includes(`math-source-${k}`)) ?? '?'
const tokens = (source: string) => mathSourceHighlights(source).map((r) => [source.slice(r.from, r.to), kindOf(r.className)])

describe('lightweight math source tokens', () => {
  it('splits dollars, commands, scripts, letters, numbers and brackets; operators and spaces stay plain', () => {
    expect(tokens('$U = N \\sum_{i} P_i + 2^n$')).toEqual([
      ['$', 'dollar'], ['U', 'letter'], ['N', 'letter'], ['\\sum', 'command'], ['_', 'script'], ['{', 'bracket'],
      ['i', 'letter'], ['}', 'bracket'], ['P', 'letter'], ['_', 'script'], ['i', 'letter'], ['2', 'number'],
      ['^', 'script'], ['n', 'letter'], ['$', 'dollar'],
    ])
  })

  it("matches the user's formula token by token", () => {
    expect(tokens('$$ t(\\{n_{j}\\})$$')).toEqual([
      ['$$', 'dollar'], ['t', 'letter'], ['(', 'bracket'], ['\\{', 'command'], ['n', 'letter'], ['_', 'script'],
      ['{', 'bracket'], ['j', 'letter'], ['}', 'bracket'], ['\\}', 'command'], [')', 'bracket'], ['$$', 'dollar'],
    ])
  })

  it('groups decimals, alignment marks and bracket runs the way the source reads', () => {
    expect(tokens('$$x^{2} & 3.14 + .5 )[$$')).toEqual([
      ['$$', 'dollar'], ['x', 'letter'], ['^', 'script'], ['{', 'bracket'], ['2', 'number'], ['}', 'bracket'],
      ['&', 'script'], ['3.14', 'number'], ['.5', 'number'], [')[', 'bracket'], ['$$', 'dollar'],
    ])
  })

  it('retains original UTF-16 positions, including display padding and line breaks', () => {
    const source = '$$\n𝛹 + \\Psi [a]\\\\\n\\frac{a}{b}\n$$'
    const ranges = mathSourceHighlights(source, 19)
    const command = ranges.find((r) => r.className.includes('command'))!
    expect(command.from).toBe(19 + source.indexOf('\\Psi'))
    expect(source.slice(command.from - 19, command.to - 19)).toBe('\\Psi')
    expect(tokens(source).filter(([, kind]) => kind === 'command').map(([text]) => text)).toEqual(['\\Psi', '\\\\', '\\frac'])
    // Non-ASCII letters keep the document color.
    expect(tokens(source).some(([text]) => text.includes('𝛹'))).toBe(false)
  })

  it('keeps escaped symbols together as commands and does not reinterpret them', () => {
    expect(tokens('$\\{x\\} + \\_ + \\% + (y)$')).toEqual([
      ['$', 'dollar'], ['\\{', 'command'], ['x', 'letter'], ['\\}', 'command'], ['\\_', 'command'],
      ['\\%', 'command'], ['(', 'bracket'], ['y', 'letter'], [')', 'bracket'], ['$', 'dollar'],
    ])
  })

  it('does not color anything inside a TeX comment', () => {
    expect(tokens('$$x % \\alpha {ignored}\n\\beta$$')).toEqual([
      ['$$', 'dollar'], ['x', 'letter'], ['\\beta', 'command'], ['$$', 'dollar'],
    ])
    expect(tokens('$x % \\alpha {ignored}$')).toEqual([['$', 'dollar'], ['x', 'letter'], ['$', 'dollar']])
  })

  it('removes syntax color only over selected characters, without moving offsets', () => {
    const source = '$\\alpha$'
    const ranges = mathSourceHighlights(source, 10, { from: 13, to: 15 })
    expect(ranges.filter((r) => r.className.includes('command')).map(({ from, to }) => [from, to])).toEqual([[11, 13], [15, 17]])
    expect(ranges.every((r) => r.to <= 13 || r.from >= 15)).toBe(true)
    expect(mathSourceHighlights(source, 10, { from: 10, to: 18 })).toEqual([])
  })

  it('tolerates invalid commands and unmatched brackets without changing the source', () => {
    const source = '$\\doesnotexist{x$'
    expect(tokens(source)).toEqual([
      ['$', 'dollar'], ['\\doesnotexist', 'command'], ['{', 'bracket'], ['x', 'letter'], ['$', 'dollar'],
    ])
  })

  it('keeps the older umbrella class on punctuation tokens only', () => {
    const umbrella = mathSourceHighlights('$a_{1}\\b$').filter((r) => r.className.split(' ').includes('math-source-delimiter'))
    expect(umbrella.map((r) => '$a_{1}\\b$'.slice(r.from, r.to))).toEqual(['$', '_', '{', '}', '$'])
  })
})

describe('math source decorations in the editor', () => {
  const extra = () => [editorFocusPlugin(), mathLivePreviewPlugin()]
  it('colors only the active formula and removes source tokens when leaving it', async () => {
    const b = await bootEditor('First $\\alpha_1$ and $\\beta_2$\n\nTail\n', { extra: extra() })
    try {
      const v = b.view
      const before = b.md()
      expect(v.dom.querySelectorAll('.math-source-token')).toHaveLength(0)
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 9)).setMeta(editorFocusKey, true))
      expect([...v.dom.querySelectorAll('.math-source-command')].map((n) => n.textContent)).toEqual(['\\alpha'])
      expect(v.dom.querySelectorAll('.math-rendered')).toHaveLength(1)
      expect(v.dom.querySelector('.math-preview .math-source-token')).toBeNull()
      expect(b.md()).toBe(before)
      v.dispatch(v.state.tr.setMeta(editorFocusKey, false))
      expect(v.dom.querySelectorAll('.math-source-token')).toHaveLength(0)
      expect(v.dom.querySelectorAll('.math-rendered')).toHaveLength(2)
      expect(b.md()).toBe(before)
    } finally { await b.destroy() }
  })

  it('highlights a display source at the exact untrimmed offsets and preserves selection and serialization', async () => {
    const source = '$$\n  \\frac{a}{b} + \\unknown{x\n$$\n'
    const b = await bootEditor(source, { extra: extra() })
    try {
      const v = b.view, before = b.md()
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7)).setMeta(editorFocusKey, true))
      expect([...v.dom.querySelectorAll('.math-source-command')].map((n) => n.textContent)).toEqual(['\\frac', '\\unknown'])
      expect(v.state.selection.from).toBe(7)
      expect(v.dom.querySelector('.math-preview--block')).not.toBeNull()
      expect(b.md()).toBe(before)
      const from = 1, to = v.state.doc.firstChild!.content.size + 1
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)))
      expect(v.dom.querySelectorAll('.math-source-token')).toHaveLength(0)
      expect(b.md()).toBe(before)
    } finally { await b.destroy() }
  })

  it('wraps the whole active source, dollars and spaces included, in one hook class that survives a selection', async () => {
    const b = await bootEditor('Lead $x + \\beta$ and $y$\n\n$$ t(\\{n_{j}\\}) $$\n', { extra: extra() })
    try {
      const v = b.view, before = b.md()
      const hooked = () => [...v.dom.querySelectorAll('.math-source')].map((n) => n.textContent).join('')
      expect(hooked()).toBe('')
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 9)).setMeta(editorFocusKey, true))
      expect(hooked()).toBe('$x + \\beta$')
      expect([...v.dom.querySelectorAll('.math-source-token')].every((n) => n.classList.contains('math-source'))).toBe(true)
      expect(v.dom.querySelector('.math-preview .math-source, .math-rendered .math-source')).toBeNull()
      const second = v.state.doc.child(1)
      const start = v.state.doc.child(0).nodeSize + 1
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, start + 3, start + second.content.size - 3)))
      expect(hooked()).toBe('$$ t(\\{n_{j}\\}) $$')
      expect(v.dom.querySelectorAll('.math-source-letter')).toHaveLength(0)
      expect(b.md()).toBe(before)
    } finally { await b.destroy() }
  })

  it.each(['`$\\alpha$`\n', '```tex\n$\\alpha$\n```\n'])('does not highlight code content: %s', async (source) => {
    const b = await bootEditor(source, { extra: extra() })
    try {
      const v = b.view, before = b.md()
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)).setMeta(editorFocusKey, true))
      expect(v.dom.querySelectorAll('.math-source-token')).toHaveLength(0)
      expect(b.md()).toBe(before)
    } finally { await b.destroy() }
  })
})
