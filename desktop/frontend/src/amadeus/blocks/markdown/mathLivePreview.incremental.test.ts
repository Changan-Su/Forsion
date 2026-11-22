// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { AllSelection, EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { closeHistory, history, redo, undo } from '@milkdown/kit/prose/history'
import type { DecorationSet } from '@milkdown/kit/prose/view'
import { editorFocusKey, editorFocusPlugin } from './editorFocus'
import { mathLivePreviewPlugin } from './mathLivePreview'
import { bootEditor } from './parseFidelity.testkit'

const source = [
  'prefix $x$ and $y+z$',
  '> $$ u^2 + v_1 $$',
  '> - nest $n$\n> - again $n$',
  '`$ignored$`',
  '| col |\n| --- |\n| $a+b$ |',
  '```tex\n$x$\n```',
  'end $z$',
].join('\n\n')

function decorationsFor(plugin: ReturnType<typeof mathLivePreviewPlugin>, state: EditorState): DecorationSet {
  const pmPlugin = plugin.plugin()
  return pmPlugin.props.decorations!.call(pmPlugin, state) as DecorationSet
}

function describeSet(set: DecorationSet) {
  return set.find().map((deco) => ({
    from: deco.from,
    to: deco.to,
    key: deco.spec.key,
    side: deco.spec.side,
    marks: deco.spec.marks?.map((mark: { toJSON(): unknown }) => mark.toJSON()),
    // ProseMirror exposes HTML attributes on the inline decoration's type at runtime.
    attrs: (deco as unknown as { type: { attrs?: Record<string, string> } }).type.attrs,
  }))
}

it('keeps math source, token classes, trailing carets, marked widgets and display previews identical to a fresh document render', async () => {
  const math = mathLivePreviewPlugin()
  const focus = editorFocusPlugin()
  const b = await bootEditor(source, { extra: [math, focus] })
  const oracle = mathLivePreviewPlugin()
  const other = await bootEditor('different document', { extra: [oracle] })
  try {
    const doc = b.view.state.doc
    let state = EditorState.create({ doc, plugins: [math.plugin(), focus.plugin(), history()] })
    const check = () => {
      // Reset only the reference plugin on a different document before evaluating the same state.
      decorationsFor(oracle, other.view.state)
      expect(describeSet(decorationsFor(math, state))).toEqual(describeSet(decorationsFor(oracle, state)))
    }
    const apply = (tr: typeof state.tr) => { state = state.apply(tr); check() }
    const select = (from: number, to = from) => apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
    const points: number[] = []
    doc.descendants((node, pos) => {
      if (node.isTextblock) { points.push(pos + 1); return false }
      return true
    })
    const [first, display, nested, nestedAgain, inlineCode, , cell, code, last] = points
    expect(doc.resolve(cell).parent.textContent).toBe('$a+b$')
    expect(doc.resolve(code).parent.type.spec.code).toBe(true)
    check()
    apply(state.tr.setMeta(editorFocusKey, true))
    select(first + 8)
    select(display + 4)
    select(display + 4, display + 7)
    select(display + 5, display + 6)
    select(nested + 6, last + 6)
    select(cell + 1, last + 7)
    select(last + 6, cell + 3)
    select(first + 10, display + 5)
    select(nestedAgain, nestedAgain + 8)
    select(inlineCode)
    select(code + 1)
    apply(state.tr.setSelection(NodeSelection.create(doc, 0)))
    apply(state.tr.setSelection(new AllSelection(doc)))
    apply(state.tr.setMeta(editorFocusKey, false))
    select(last + 5)
    apply(state.tr.setMeta(editorFocusKey, true))
    const same = decorationsFor(math, state)
    apply(state.tr.setMeta('composition', 3))
    apply(state.tr.addStoredMark(state.schema.marks.strong.create()))
    expect(decorationsFor(math, state)).toBe(same)
    apply(state.tr.addMark(first + 7, first + 10, state.schema.marks.strong.create()))
    const beforeInput = state.doc
    apply(closeHistory(state.tr).insertText('界', first + 8))
    expect(undo(state, apply)).toBe(true)
    expect(state.doc.eq(beforeInput)).toBe(true)
    expect(redo(state, apply)).toBe(true)
    expect(state.doc.textContent).toContain('界')
    apply(state.tr.delete(display - 1, display + 1))
    apply(state.tr.replaceWith(0, state.doc.content.size, doc.content))
    state = state.reconfigure({ plugins: [math.plugin()] }) // same document, focus plugin removed
    check()
  } finally {
    await other.destroy()
    await b.destroy()
  }
})

it('distant caret jumps and small changes to a large selection leave the intervening paragraphs alone', async () => {
  const math = mathLivePreviewPlugin()
  const focus = editorFocusPlugin()
  const b = await bootEditor(Array.from({ length: 50 }, (_, i) => `line ${i} $a+b$`).join('\n\n'), { extra: [focus, math] })
  try {
    const doc = b.view.state.doc
    let state = b.view.state.apply(b.view.state.tr.setMeta(editorFocusKey, true))
    const change = (a: number, h: number) => {
      state = state.apply(state.tr.setSelection(TextSelection.create(doc, a, h)))
      return decorationsFor(math, state)
    }
    const start = 1
    const end = doc.content.size - 1
    change(start + 8, start + 8)
    const middle = vi.spyOn(doc.child(25), 'forEach')
    try {
      change(end - 2, end - 2)
      expect(middle).not.toHaveBeenCalled()
      change(start + 8, end - 2)
      expect(middle).toHaveBeenCalled() // this paragraph's formulas really changed to source
      middle.mockClear()
      change(start + 9, end - 3)
      expect(middle).not.toHaveBeenCalled()
    } finally { middle.mockRestore() }
  } finally { await b.destroy() }
})
