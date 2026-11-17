import { useEffect, useState } from 'react'
import { ChevronRight, Palette } from 'lucide-react'
import { NodeSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { closeHistory } from '@milkdown/kit/prose/history'
import { useI18n } from '../../i18n'
import { ColorPalettePopover } from '../blocks/markdown/ColorPalette'
import { blockColorTr, colorTargetsOf, sharedColor, type ColorChannel } from './blockColorCommands'

type Range = { from: number; to: number } | null

/** 块菜单里的颜色项。
 *  - 画布卡片:「分块颜色…」(卡片底色进 amadeus_canvas,参与撤销 / 复制 / 存盘)。
 *  - 段落 / 标题 / 列表项 / 待办 / 引用(Notion 对齐 A1):「颜色 ›」,在「转换为」下面,行尾是当前颜色的小方块;
 *    悬停或点开现有调色板(文字 / 背景两页),底部「应用于整个分块」。跨块选区一次全上(rangeOf = blockLayer.topRangeOf)。 */
export function BlockColorMenu({ view, restore, onDone, rangeOf }: { view: EditorView; restore: () => boolean; onDone: () => void; rangeOf?: (view: EditorView) => Range }) {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const sel = view.state.selection
  let pos: number | null = sel instanceof NodeSelection && sel.node.type.name === 'amadeusCanvasCard' ? sel.from : null
  if (pos == null) for (let d = sel.$from.depth; d > 0; d--) if (sel.$from.node(d).type.name === 'amadeusCanvasCard') { pos = sel.$from.before(d); break }
  const targets = pos == null ? colorTargetsOf(view.state, rangeOf?.(view) ?? null) : []
  // 指针移到菜单里别的行 → 收起调色板(与「转换为 ›」子菜单同一种手感)
  useEffect(() => {
    if (!anchor || pos != null) return
    const menu = anchor.closest('.unified-block-menu')
    const over = (e: Event): void => { if (!anchor.contains(e.target as Node)) setAnchor(null) }
    menu?.addEventListener('mouseover', over)
    return () => menu?.removeEventListener('mouseover', over)
  }, [anchor, pos])
  if (pos != null) {
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
  if (!targets.length) return null
  const bg = sharedColor(targets, 'bg')
  const fg = sharedColor(targets, 'fg')
  const apply = (ch: ColorChannel, value: string): void => {
    if (!view.editable || !restore()) { onDone(); return }
    // restore 之后重新取目标:菜单开着期间文档没变(restore 已核),位置与菜单打开时一致
    const tr = blockColorTr(view.state, colorTargetsOf(view.state, rangeOf?.(view) ?? null), { [ch]: value })
    if (tr) view.dispatch(tr)
    onDone(); view.focus()
  }
  const swatch = bg || fg
  return <>
    <button role="menuitem" tabIndex={-1} data-act="blockColor" aria-haspopup="dialog" aria-expanded={!!anchor} className={anchor ? 'is-open' : undefined}
      onMouseEnter={(e) => setAnchor(e.currentTarget)} onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget) }}>
      <Palette size={13} />{t('palette.blockRow')}
      <span className="ubm-sub-tail">
        {swatch && <i className="ubm-color-chip" data-chip-bg={bg || undefined} data-chip-fg={!bg && fg ? fg : undefined}
          style={/^#/.test(swatch) ? { background: swatch } : undefined} />}
        <ChevronRight size={13} />
      </span>
    </button>
    {anchor && <ColorPalettePopover anchor={anchor} side="right" set="block" scope="block" initial={!bg && fg ? 'text' : 'fill'} fill={bg} text={fg}
      onText={(v) => apply('fg', v)} onFill={(v) => apply('bg', v)} onClose={() => { setAnchor(null); onDone(); view.focus() }} />}
  </>
}
