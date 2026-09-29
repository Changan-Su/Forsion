// K-10(评审 2026-09-27):块菜单的「表格」区 —— 所见即所得下增删行列与列对齐的唯一入口(此前没有任何入口,
// 斜杠菜单建出的表只有 1 行正文,之后长不大)。放进现有块菜单而不另造浮条:右键单元格 = Obsidian 的表格菜单
// 位置,⠿ 菜单同一份;样式复用 .ubm-label / .ubm-sep / 普通按钮行,当前对齐在末列打勾(DESIGN §3 菜单几何)。
//
// 锚格:右键时指针下的那一格(菜单打开那一刻记下,见 tableCellAtPoint);⠿ 打开时没有格子上下文 →
// 只给「在下方插入行 / 在右侧插入列」(= 追加到表尾),不给删除与对齐(对着猜出来的格子删行是陷阱)。
// 原语与 GFM 约束见 blocks/markdown/tableEdit.ts。
import { AlignCenter, AlignLeft, AlignRight, BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Check, Trash2 } from 'lucide-react'
import { NodeSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { ReactElement } from 'react'
import { cellPosAround, tableAlignTr, tableMenuModel, tableOpTr, type ColumnAlign, type TableOp } from '../blocks/markdown/tableEdit'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'unipage.table.label': { zh: '表格', en: 'Table' },
  'unipage.table.rowAbove': { zh: '在上方插入行', en: 'Insert row above' },
  'unipage.table.rowBelow': { zh: '在下方插入行', en: 'Insert row below' },
  'unipage.table.colLeft': { zh: '在左侧插入列', en: 'Insert column left' },
  'unipage.table.colRight': { zh: '在右侧插入列', en: 'Insert column right' },
  'unipage.table.deleteRow': { zh: '删除行', en: 'Delete row' },
  'unipage.table.deleteCol': { zh: '删除列', en: 'Delete column' },
  'unipage.table.alignLeft': { zh: '左对齐', en: 'Align left' },
  'unipage.table.alignCenter': { zh: '居中', en: 'Align center' },
  'unipage.table.alignRight': { zh: '右对齐', en: 'Align right' },
})

/** 块菜单是否对着整张表(右键 / ⠿ 都会先把表设成 NodeSelection)。 */
export function isTableSelected(view: EditorView | null | undefined): boolean {
  const sel = view?.state.selection
  return sel instanceof NodeSelection && sel.node.type.spec.tableRole === 'table'
}

/** 菜单打开那一刻指针下的单元格位置。⚠️ 只能在打开时算:菜单浮层一出来就盖住这个点。
 *  ⠿ 打开时坐标落在把手栏 → null(不拿 posAtCoords 就近吸附,那会凭空猜出一个格子)。 */
export function tableCellAtPoint(view: EditorView | null | undefined, x: number, y: number): number | null {
  if (!view || !isTableSelected(view)) return null
  const td = document.elementFromPoint(x, y)?.closest?.('td,th')
  if (!td || !view.dom.contains(td)) return null
  try {
    return cellPosAround(view.state.doc, view.posAtDOM(td, 0))
  } catch {
    return null
  }
}

const OPS: { op: TableOp; key: string; Icon: typeof Trash2 }[] = [
  { op: 'rowAbove', key: 'unipage.table.rowAbove', Icon: BetweenHorizontalStart },
  { op: 'rowBelow', key: 'unipage.table.rowBelow', Icon: BetweenHorizontalEnd },
  { op: 'colLeft', key: 'unipage.table.colLeft', Icon: BetweenVerticalStart },
  { op: 'colRight', key: 'unipage.table.colRight', Icon: BetweenVerticalEnd },
  { op: 'deleteRow', key: 'unipage.table.deleteRow', Icon: Trash2 },
  { op: 'deleteCol', key: 'unipage.table.deleteCol', Icon: Trash2 },
]
const ALIGNS: { align: ColumnAlign; key: string; Icon: typeof Trash2 }[] = [
  { align: 'left', key: 'unipage.table.alignLeft', Icon: AlignLeft },
  { align: 'center', key: 'unipage.table.alignCenter', Icon: AlignCenter },
  { align: 'right', key: 'unipage.table.alignRight', Icon: AlignRight },
]

/** 块菜单里的表格区(分隔线 + 标签 + 行列操作 + 对齐)。不对着表格时渲染为空。 */
export function TableMenuSection({ view, cell, onDone }: { view: EditorView; cell: number | null; onDone: () => void }): ReactElement | null {
  const { t } = useI18n()
  const sel = view.state.selection
  if (!(sel instanceof NodeSelection) || sel.node.type.spec.tableRole !== 'table') return null
  const model = tableMenuModel(view.state.doc, sel.from, cell)
  if (!model) return null
  /** 与块菜单其余项同一形状(withSelectedNode):先收菜单,再按**当下**的 doc 重算一次(锚格失效就不动)。 */
  const run = (make: () => ReturnType<typeof tableOpTr>): void => {
    onDone()
    const tr = make()
    if (tr) view.dispatch(tr)
    view.focus()
  }
  return (
    <>
      <div className="ubm-sep" />
      <div className="ubm-label">{t('unipage.table.label')}</div>
      {OPS.filter((o) => model.ops.includes(o.op)).map(({ op, key, Icon }) => (
        <button key={op} data-table-op={op} onClick={() => run(() => tableOpTr(view.state, model.cellPos, op))}>
          <Icon size={13} /> {t(key)}
        </button>
      ))}
      {model.align && ALIGNS.map(({ align, key, Icon }) => (
        <button key={align} data-table-align={align} aria-checked={model.align === align} role="menuitemcheckbox"
          onClick={() => run(() => tableAlignTr(view.state, model.cellPos, align))}>
          <Icon size={13} /> {t(key)}
          {model.align === align && <Check size={13} className="ubm-check" />}
        </button>
      ))}
    </>
  )
}
