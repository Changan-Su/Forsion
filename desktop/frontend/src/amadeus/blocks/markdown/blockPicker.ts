import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { editContextAt } from './menuContext'
import type { WikiQuery } from './wikiAutocomplete'

/** The plus picker is UI state anchored to an empty paragraph. Its query never
 * enters the Markdown document; ordinary typed slash commands keep their path. */
export const blockPickerKey = new PluginKey<number | null>('amadeus-block-picker')

export function openBlockPicker(tr: Transaction, at: number): Transaction {
  return tr.setMeta(blockPickerKey, { at })
}

export function closeBlockPicker(view: EditorView, focus = true): void {
  const at = blockPickerKey.getState(view.state)
  let tr = view.state.tr.setMeta(blockPickerKey, { at: null })
  if (at != null) tr = tr.setSelection(TextSelection.create(tr.doc, at))
  view.dispatch(tr)
  if (focus) view.focus()
}

export function blockPickerPlugin(report: (query: WikiQuery | null) => void) {
  return $prose(() => new Plugin<number | null>({
    key: blockPickerKey,
    state: {
      init: () => null,
      apply(tr, prev) {
        const meta = tr.getMeta(blockPickerKey) as { at: number | null } | undefined
        let at = meta ? meta.at : prev
        if (at == null) return null
        if (!meta && tr.docChanged) {
          const mapped = tr.mapping.mapResult(at, 1)
          if (mapped.deleted) return null
          at = mapped.pos
        }
        if (at < 1 || at >= tr.doc.content.size) return null
        const $at = tr.doc.resolve(at)
        if ($at.parent.type.name !== 'paragraph' || $at.parent.content.size !== 0) return null
        if (tr.selectionSet && (!tr.selection.empty || tr.selection.from !== at)) return null
        return at
      },
    },
    view: () => ({
      update(view, prev) {
        const at = blockPickerKey.getState(view.state)
        if (at == null) {
          if (blockPickerKey.getState(prev) != null) report(null)
          return
        }
        if (at === blockPickerKey.getState(prev) && view.state.doc === prev.doc) return
        const r = view.coordsAtPos(at)
        report({ from: at, to: at, query: '', left: r.left, top: r.bottom, anchorTop: r.top, ctx: editContextAt(view.state.doc.resolve(at)) })
      },
      destroy: () => report(null),
    }),
  }))
}
