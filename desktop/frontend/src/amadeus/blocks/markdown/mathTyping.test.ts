// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor } from './parseFidelity.testkit'
import { mathLivePreviewPlugin } from './mathLivePreview'

describe('math dollar typing', () => {
  it('centers the second dollar, upgrades the third, and deletes empty pairs', async () => {
    const b = await bootEditor('', { extra: [mathLivePreviewPlugin()] })
    try {
      const v = b.view
      const type = (ch: string) => {
        const { from, to } = v.state.selection
        if (!v.someProp('handleTextInput', f => f(v, from, to, ch, () => v.state.tr.insertText(ch, from, to)))) v.dispatch(v.state.tr.insertText(ch, from, to))
      }
      const snapshot = () => [v.state.doc.textContent, v.state.selection.$from.parentOffset]
      type('$'); expect(snapshot()).toEqual(['$', 1])
      type('$'); expect(snapshot()).toEqual(['$$', 1])
      type('$'); expect(snapshot()).toEqual(['$$$$', 2])
      v.someProp('handleKeyDown', f => f(v, new KeyboardEvent('keydown', { key: 'Backspace' })))
      expect(snapshot()).toEqual(['$$', 1])
      v.someProp('handleKeyDown', f => f(v, new KeyboardEvent('keydown', { key: 'Backspace' })))
      expect(snapshot()).toEqual(['', 0])
      type('$'); type('$'); type('x'); type('$')
      expect(snapshot()).toEqual(['$x$', 3])
      expect(b.md()).toBe('$x$\n')
    } finally { await b.destroy() }
  })
  it.each(['`$`', '\\$', '```txt\n$\n```'])('does not pair literal dollars: %s', async seed => {
    const b = await bootEditor(seed, { extra: [mathLivePreviewPlugin()] })
    try {
      const v = b.view
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2)))
      expect(v.someProp('handleTextInput', f => f(v, 2, 2, '$', () => v.state.tr.insertText('$', 2)))).toBeFalsy()
    } finally { await b.destroy() }
  })
  it('overtypes both display closing dollars without adding another pair', async () => {
    const b = await bootEditor('$$x$$', { extra: [mathLivePreviewPlugin()] })
    try {
      const v = b.view
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)))
      for (let i = 0; i < 2; i++) {
        const { from, to } = v.state.selection
        expect(v.someProp('handleTextInput', f => f(v, from, to, '$', () => v.state.tr.insertText('$', from, to)))).toBe(true)
      }
      expect(v.state.doc.textContent).toBe('$$x$$')
      expect(v.state.selection.$head.parentOffset).toBe(5)
    } finally { await b.destroy() }
  })
  it.each([['$$x$$', 4], ['$x$$y$', 3]] as const)('does not pair-delete populated delimiters: %s', async (seed, offset) => {
    const b = await bootEditor(seed, { extra: [mathLivePreviewPlugin()] })
    try {
      const v = b.view
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, offset + 1)))
      expect(v.someProp('handleKeyDown', f => f(v, new KeyboardEvent('keydown', { key: 'Backspace' })))).toBeFalsy()
      expect(v.state.doc.textContent).toBe(seed)
    } finally { await b.destroy() }
  })
})

describe('bracket typing in math', () => {
  it.each([['(', ')'], ['[', ']'], ['{', '}']])('pairs %s, overtypes its closer, and deletes an empty pair', async (open, close) => {
    const b = await bootEditor('$$$$', { extra: [mathLivePreviewPlugin()] })
    try {
      const v = b.view
      const type = (ch: string) => { const { from, to } = v.state.selection; return v.someProp('handleTextInput', f => f(v, from, to, ch, () => v.state.tr.insertText(ch, from, to))) }
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)))
      expect(type(open)).toBe(true)
      expect(v.state.doc.textContent).toBe(`$$${open}${close}$$`)
      expect(v.state.selection.$head.parentOffset).toBe(3)
      expect(type(close)).toBe(true)
      expect(v.state.doc.textContent).toBe(`$$${open}${close}$$`)
      expect(v.state.selection.$head.parentOffset).toBe(4)
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)))
      expect(v.someProp('handleKeyDown', f => f(v, new KeyboardEvent('keydown', { key: 'Backspace' })))).toBe(true)
      expect(v.state.doc.textContent).toBe('$$$$')
    } finally { await b.destroy() }
  })
  it.each([['prose', 5], ['$x$', 1], ['$\\\\x$', 2], ['`$x$`', 1]])('does not pair outside math, before a word, or after an escape: %s', async (seed, offset) => {
    const b = await bootEditor(seed as string, { extra: [mathLivePreviewPlugin()] })
    try {
      const v = b.view
      const pos = (offset as number) + 1
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)))
      expect(v.someProp('handleTextInput', f => f(v, pos, pos, '(', () => v.state.tr.insertText('(', pos)))).toBeFalsy()
    } finally { await b.destroy() }
  })
})
