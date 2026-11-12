import { useState } from 'react'
import { Palette } from 'lucide-react'
import { NodeSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { closeHistory } from '@milkdown/kit/prose/history'
import { useI18n } from '../../i18n'
import { ColorPalettePopover } from '../blocks/markdown/ColorPalette'

/** Card colors already participate in undo, copying and frontmatter persistence. */
export function BlockColorMenu({ view, restore, onDone }: { view: EditorView; restore: () => boolean; onDone: () => void }) {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const sel = view.state.selection
  let pos: number | null = sel instanceof NodeSelection && sel.node.type.name === 'amadeusCanvasCard' ? sel.from : null
  if (pos == null) for (let d = sel.$from.depth; d > 0; d--) if (sel.$from.node(d).type.name === 'amadeusCanvasCard') { pos = sel.$from.before(d); break }
  if (pos == null) return null
  const at = pos
  const card = view.state.doc.nodeAt(at)!
  const apply = (value: string, text: boolean): void => {
    if (!view.editable || !restore() || view.state.doc.nodeAt(at) !== card) { onDone(); return }
    let tr = closeHistory(view.state.tr)
    if (text) {
      const mark = view.state.schema.marks.amadeusColor
      if (!mark) return
      tr = tr.removeMark(at + 1, at + card.nodeSize - 1, mark)
      if (value) tr = tr.addMark(at + 1, at + card.nodeSize - 1, mark.create({ color: value }))
    } else tr = tr.setNodeMarkup(at, undefined, { ...card.attrs, color: value })
    view.dispatch(tr)
    onDone(); view.focus()
  }
  return <>
    <button role="menuitem" tabIndex={-1} data-act="blockColor" aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget) }}><Palette size={13} />{t('palette.blockMenu')}</button>
    {anchor && <ColorPalettePopover anchor={anchor} initial="fill" scope="block" fill={card.attrs.color}
      onText={(v) => apply(v, true)} onFill={(v) => apply(v, false)} onClose={() => { setAnchor(null); onDone(); view.focus() }} />}
  </>
}
