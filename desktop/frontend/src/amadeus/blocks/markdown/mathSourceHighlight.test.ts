// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { mathSourceHighlights } from './mathSourceHighlight'
import { bootEditor } from './parseFidelity.testkit'
import { mathLivePreviewPlugin } from './mathLivePreview'
import { editorFocusKey, editorFocusPlugin } from './editorFocus'

const tokens = (source: string) => mathSourceHighlights(source).map((r) => [
  source.slice(r.from, r.to), r.className.includes('command') ? 'command' : 'delimiter',
])

describe('lightweight math source tokens', () => {
  it('colors commands and syntax while leaving variables, numbers and operators unchanged', () => {
    expect(tokens('$U = N \\sum_{i} P_i + 2^n$')).toEqual([
      ['$', 'delimiter'], ['\\sum', 'command'], ['_{', 'delimiter'], ['}', 'delimiter'],
      ['_', 'delimiter'], ['^', 'delimiter'], ['$', 'delimiter'],
    ])
  })

  it('retains original UTF-16 positions, including display padding and line breaks', () => {
    const source = '$$\n𝛹 + \\Psi [a]\\\\\n\\frac{a}{b}\n$$'
    const ranges = mathSourceHighlights(source, 19)
    const command = ranges.find((r) => r.className.includes('command'))!
    expect(command.from).toBe(19 + source.indexOf('\\Psi'))
    expect(source.slice(command.from - 19, command.to - 19)).toBe('\\Psi')
    expect(tokens(source).filter(([, kind]) => kind === 'command').map(([text]) => text)).toEqual(['\\Psi', '\\\\', '\\frac'])
  })

  it('keeps escaped brackets together and does not reinterpret escaped control symbols', () => {
    expect(tokens('$\\{x\\} + \\_ + \\% + (y)$')).toEqual([
      ['$', 'delimiter'], ['\\{', 'delimiter'], ['\\}', 'delimiter'], ['\\_', 'command'],
      ['\\%', 'command'], ['(', 'delimiter'], [')$', 'delimiter'],
    ])
  })

  it('does not color command-like text inside a TeX comment', () => {
    expect(tokens('$$x % \\alpha {ignored}\n\\beta$$')).toEqual([
      ['$$', 'delimiter'], ['\\beta', 'command'], ['$$', 'delimiter'],
    ])
    expect(tokens('$x % \\alpha {ignored}$')).toEqual([['$', 'delimiter'], ['$', 'delimiter']])
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
      ['$', 'delimiter'], ['\\doesnotexist', 'command'], ['{', 'delimiter'], ['$', 'delimiter'],
    ])
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
