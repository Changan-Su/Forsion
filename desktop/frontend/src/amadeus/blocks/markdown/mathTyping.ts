import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { buildBlockString, scanMath } from './mathLivePreview'

function context(view: EditorView, from: number, to: number) {
  if (!view.editable || view.composing || from !== to) return null
  const $pos = view.state.doc.resolve(from)
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code ||
      (view.state.storedMarks ?? $pos.marks()).some((m) => m.type.spec.code)) return null
  const text = buildBlockString($pos.parent)
  const offset = $pos.parentOffset
  const left = text.slice(0, offset)
  const right = text.slice(offset)
  return { text, offset, left, right }
}

/** User contract: $ stays literal; the second $ makes $|$, the next makes $$|$$. */
export function mathDollarInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (text !== '$') return false
  const c = context(view, from, to)
  if (!c) return false
  const { left, right } = c
  const spans = scanMath(c.text)
  // Recognize both characters of a populated display closer before considering
  // the visually identical $|$ shape an empty inline formula.
  if (right.startsWith('$') && spans.some((s) =>
    c.offset >= s.to - (s.display ? 2 : 1) && c.offset < s.to)) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)))
    return true
  }
  // An escaped dollar and dollar runs inside inline code are literal.
  const singleLeft = /(?:^|[^$])\$$/.test(left) && !/(?:^|[^\\])(?:\\\\)*\\\$$/.test(left)
  let insert: string | null = null
  let caret = from
  if (singleLeft && right.startsWith('$') && !right.startsWith('$$') &&
      !spans.some((s) => s.from <= c.offset && s.to >= c.offset)) {
    insert = '$$'
    caret++
  } else if (singleLeft && !right.startsWith('$')) {
    if (spans.some((s) => s.to === c.offset)) return false
    // Do not turn the closing delimiter of a populated formula into an empty pair.
    const completedSpans = scanMath(c.text.slice(0, c.offset) + '$' + right)
    if (completedSpans.some((s) => s.from < c.offset - 1 && s.to === c.offset + 1)) return false
    insert = '$'
  }
  if (insert == null) return false
  const tr = view.state.tr.insertText(insert, from, to)
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)))
  return true
}

export function mathPairBackspace(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return false
  const { from, to } = view.state.selection
  const c = context(view, from, to)
  if (!c || !c.left.endsWith('$') || !c.right.startsWith('$')) return false
  const l = c.left.match(/\$+$/)?.[0].length ?? 0
  const r = c.right.match(/^\$+/)?.[0].length ?? 0
  if (l !== r || (l !== 1 && l !== 2) || /\\$/.test(c.left.slice(0, -l))) return false
  if (scanMath(c.text).some((s) => s.from <= c.offset && s.to >= c.offset)) return false
  // $$|$$ -> $|$ -> empty, one undoable transaction per key.
  view.dispatch(view.state.tr.delete(from - 1, from + 1))
  return true
}
