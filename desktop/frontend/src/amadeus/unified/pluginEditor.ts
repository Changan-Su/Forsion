import { TextSelection } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { PluginEditorEdit } from '../plugins/types'
import { reconcileTr, sameNodeLoose } from './reconcileDiff'

/** Markers exist only in temporary immutable documents, never the live editor or save pipeline.
 * Round-trip checks make unsupported positions an explicit failure instead of guessing offsets. */
function sourceOffset(view: EditorView, pos: number, serialize: (doc: PMNode) => string, text: string): number {
  const marker = `FORSIONCURSOR${crypto.randomUUID().replaceAll('-', '')}END`
  const $pos = view.state.doc.resolve(pos), selection = view.state.selection
  const marks = !selection.empty ? (pos === selection.from ? $pos.nodeAfter?.marks : $pos.nodeBefore?.marks) : $pos.marks()
  const marked = serialize(view.state.tr.insert(pos, view.state.schema.text(marker, marks)).doc)
  const at = marked.indexOf(marker)
  if (at < 0 || marked.slice(0, at) + marked.slice(at + marker.length) !== text)
    throw new Error('This native selection cannot be mapped to Markdown safely. Place the cursor in plain text.')
  return at
}
function nativePosition(text: string, offset: number, next: PMNode, parse: (md: string) => PMNode): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error('Invalid Markdown selection')
  const marker = `FORSIONCURSOR${crypto.randomUUID().replaceAll('-', '')}END`
  const marked = parse(text.slice(0, offset) + marker + text.slice(offset))
  let found = -1
  marked.descendants((node, pos) => { if (node.isText && node.text?.includes(marker)) found = pos + node.text.indexOf(marker) })
  if (found < 0) throw new Error('Plugin selection is inside unsupported Markdown syntax')
  // Remove through a temporary EditorState transaction so marks and structure are checked as well.
  const clean = marked.replace(found, found + marker.length, next.slice(0, 0))
  if (!sameNodeLoose(clean, next)) throw new Error('Plugin selection changes Markdown structure')
  return found
}

export function captureMarkdownEdit(opts: {
  path: string; view: EditorView; valid: () => boolean
  serialize: (doc: PMNode) => string; parse: (md: string) => PMNode
}): PluginEditorEdit | null {
  const { view, valid, parse, serialize } = opts
  if (!valid() || !view.editable || !(view.state.selection instanceof TextSelection)) return null
  const { doc, selection } = view.state
  const text = serialize(doc)
  const anchor = sourceOffset(view, selection.anchor, serialize, text)
  const head = selection.empty ? anchor : sourceOffset(view, selection.head, serialize, text)
  let used = false
  return {
    path: opts.path, text, anchor, head,
    apply(change) {
      if (used) return false
      used = true
      if (!valid() || !view.editable || view.state.doc !== doc || !view.state.selection.eq(selection)) return false
      if (typeof change?.text !== 'string' || change.text.length > 8 * 1024 * 1024) throw new Error('Invalid Markdown edit')
      if (change.text === text && !change.selection) return true
      const next = parse(change.text)
      let tr = reconcileTr(view.state, next)
      if (change.selection) {
        const a = nativePosition(change.text, change.selection.anchor, next, parse)
        const h = nativePosition(change.text, change.selection.head, next, parse)
        tr ??= view.state.tr
        tr.setSelection(TextSelection.between(tr.doc.resolve(a), tr.doc.resolve(h)))
      }
      if (!tr) return true
      // One command = one undo item; the following typing must not join it either.
      view.dispatch(closeHistory(tr.setMeta('addToHistory', true)))
      view.dispatch(closeHistory(view.state.tr))
      return true
    },
  }
}
