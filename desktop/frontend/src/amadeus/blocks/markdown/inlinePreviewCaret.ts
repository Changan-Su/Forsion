import { TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, type EditorView } from '@milkdown/kit/prose/view'

/** A rendered inline preview replaces display:none source text. Give its right
 * edge a zero-width DOM boundary so native clicks and the smooth
 * caret do not end up in hidden source or inside the non-editable preview. The
 * element is empty and uses generated CSS content, so native drag selection and
 * typing work without inserting a marker character into the document. */
export function inlinePreviewCaret(from: number, to: number, key: string): Decoration {
  return Decoration.widget(to, () => {
    const el = document.createElement('span')
    el.className = 'amx-inline-caret'
    el.contentEditable = 'false'
    el.setAttribute('aria-hidden', 'true')
    el.dataset.sourceSize = String(to - from)
    return el
  }, { side: -1, relaxedSide: true, key: `caret:${key}` })
}

/** Chromium may resolve a click in trailing whitespace into KaTeX's nested
 * non-editable DOM instead of the textblock endpoint. Only claim whitespace
 * after the final preview on its own line; clicking the preview stays native. */
export function inlinePreviewEdgeClick(view: EditorView, event: MouseEvent): boolean {
  if (!view.editable || event.button !== 0 || event.detail > 1 || event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest('[contenteditable="false"], button, input, textarea')) return false
  for (const edge of target.querySelectorAll<HTMLElement>('.amx-inline-caret')) {
    if (edge.parentElement !== target && !target.contains(edge)) continue
    const r = edge.getBoundingClientRect()
    if (r.height <= 0 || event.clientX < r.right || event.clientY < r.top || event.clientY > r.bottom) continue
    const pos = view.posAtDOM(edge, 0)
    const anchor = event.shiftKey ? view.state.selection.anchor : pos
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, pos)))
    view.focus()
    event.preventDefault()
    return true
  }
  return false
}

/** Keep the boundary decoration transparent to backward editing. Native browser
 * deletion otherwise removes only the ignored widget and appears to do nothing. */
export function inlinePreviewEdgeKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (!view.editable || view.composing || event.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
      (event.key !== 'Backspace' && event.key !== 'ArrowLeft') || (event.key === 'Backspace' && event.shiftKey)) return false
  const sel = view.state.selection
  if (!sel.empty) return false
  for (const edge of view.dom.querySelectorAll<HTMLElement>('.amx-inline-caret')) {
    if (view.posAtDOM(edge, 0) !== sel.from) continue
    if (event.key === 'ArrowLeft') {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, event.shiftKey ? sel.anchor : sel.from - 1, sel.from - 1)))
    } else {
      const size = Number(edge.dataset.sourceSize)
      if (!size || size > sel.$from.parentOffset) return false
      view.dispatch(view.state.tr.delete(sel.from - size, sel.from))
    }
    return true
  }
  return false
}
