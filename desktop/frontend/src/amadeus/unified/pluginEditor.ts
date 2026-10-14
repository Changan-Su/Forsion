import { TextSelection } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { PluginEditorEdit } from '../plugins/types'
import { reconcileTr, reconcileBlockTr, sameNodeLoose } from './reconcileDiff'

/** Markers exist only in temporary immutable documents, never the live editor or save pipeline.
 * Round-trip checks make unsupported positions an explicit failure instead of guessing offsets. */
function sourceOffset(view: EditorView, pos: number, serialize: (doc: PMNode) => string, text: string, parse: (md: string) => PMNode): number {
  const marker = `FORSIONCURSOR${crypto.randomUUID().replaceAll('-', '')}END`
  const $pos = view.state.doc.resolve(pos), selection = view.state.selection
  const marks = !selection.empty ? (pos === selection.from ? $pos.nodeAfter?.marks : $pos.nodeBefore?.marks) : $pos.marks()
  const marked = serialize(view.state.tr.insert(pos, view.state.schema.text(marker, marks)).doc)
  const at = marked.indexOf(marker)
  if (at >= 0 && marked.slice(0, at) + marked.slice(at + marker.length) === text) return at
  // GFM serialization expands column padding around the temporary marker. Match its
  // non-space prefix, then prove the candidate by parsing it back to this exact PM
  // position and unchanged document. Never infer a cell from a repeated text label.
  if (at >= 0 && Array.from({length:$pos.depth},(_,i)=>$pos.node(i+1).type.name).some(n=>/table/i.test(n))) {
    // Separator dashes expand with the columns too. Token normalization only narrows
    // candidates; the parse/position proof below is what authorizes the mapping.
    const tokens = (s: string) => [...s.matchAll(/-{3,}|[^ \t]/g)]
    const compact = (s: string): string => tokens(s).map(m => m[0].startsWith('---')?'---':m[0]).join('')
    if (compact(marked.slice(0,at)+marked.slice(at+marker.length)) === compact(text)) {
      const count=tokens(marked.slice(0,at)).length, units=tokens(text)
      const from=count ? units[count-1].index!+units[count-1][0].length : 0
      const to=count<units.length ? units[count].index! : text.length
      for(let i=from;i<=to && i-from<512;i++) {
        try { if(nativePosition(text,i,view.state.doc,parse)===pos)return i } catch { /* syntax/padding is not a text position */ }
      }
    }
  }
    throw new Error('This native selection cannot be mapped to Markdown safely. Place the cursor in plain text.')
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
  const anchor = sourceOffset(view, selection.anchor, serialize, text, parse)
  const head = selection.empty ? anchor : sourceOffset(view, selection.head, serialize, text, parse)
  let used = false
  const isCurrent = (): boolean => !used && valid() && view.editable && view.state.doc === doc && view.state.selection.eq(selection)
  return {
    path: opts.path, text, anchor, head, isCurrent,
    apply(change) {
      const current = isCurrent()
      used = true
      if (!current) return false
      if (typeof change?.text !== 'string' || change.text.length > 8 * 1024 * 1024) throw new Error('Invalid Markdown edit')
      if (change.text === text && !change.selection) return true
      const next = parse(change.text)
      let tr = reconcileTr(view.state, next)
      if (tr && !sameNodeLoose(tr.doc, next)) tr = reconcileBlockTr(view.state, next)
      if (tr && !sameNodeLoose(tr.doc, next)) throw new Error('Plugin edit could not preserve document structure')
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
