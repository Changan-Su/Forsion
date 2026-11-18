// K-10(评审 2026-09-27):块菜单的「表格」区 —— 所见即所得下增删行列与列对齐的唯一入口(此前没有任何入口,
// 斜杠菜单建出的表只有 1 行正文,之后长不大)。放进现有块菜单而不另造浮条:右键单元格 = Obsidian 的表格菜单
// 位置,⠿ 菜单同一份;样式复用 .ubm-label / .ubm-sep / 普通按钮行,当前对齐在末列打勾(DESIGN §3 菜单几何)。
//
// 锚格:右键时指针下的那一格(菜单打开那一刻记下,见 tableCellAtPoint);⠿ 打开时没有格子上下文 →
// 只给「在下方插入行 / 在右侧插入列」(= 追加到表尾),不给删除与对齐(对着猜出来的格子删行是陷阱)。
// 原语与 GFM 约束见 blocks/markdown/tableEdit.ts。
//
// 行首 / 列首把手(2026-11-17,Notion 对齐第 3 条,unified/tableHover.ts)打开的是**同一份**表格区,只按轴过滤:
// 行把手 = 插入 / 删除行,列把手 = 插入 / 删除列 + 对齐。它不走块菜单 —— 块菜单里的「删除 / 复制 / 转换」作用于
// 整张表,摆在行把手底下就是陷阱(点行把手、按「删除」,没的是整张表)。所以另起一个只装表格区的小菜单
// (TableAxisMenu,宿主 UnifiedPage 挂一处),由悬停层经 openTableAxisMenu 打开;外壳 / 按钮样式与块菜单同一套。
import { AlignCenter, AlignLeft, AlignRight, BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Check, Trash2 } from 'lucide-react'
import { NodeSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { cellPosAround, dispatchTableOp, tableAlignTr, tableMenuModel, tableOpTr, type ColumnAlign, type TableAxis, type TableOp } from '../blocks/markdown/tableEdit'
import { registerMessages, useI18n } from '../../i18n'
import { OverlayAt } from '../lib/clampMenu'
import { OverlayPortal } from '../lib/overlayPortal'
import { isCoarsePointer } from '../../touch'

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
  'unipage.table.row': { zh: '行', en: 'Row' },
  'unipage.table.column': { zh: '列', en: 'Column' },
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

/** 块菜单里的表格区(分隔线 + 标签 + 行列操作 + 对齐)。不对着表格时渲染为空。
 *  tablePos / axis = 把手菜单:表由调用方指明(不靠整表 NodeSelection),只列那条轴的操作,不画开头的分隔线。 */
export function TableMenuSection({ view, cell, onDone, tablePos, axis }: {
  view: EditorView
  cell: number | null
  onDone: () => void
  tablePos?: number
  axis?: TableAxis
}): ReactElement | null {
  const { t } = useI18n()
  const sel = view.state.selection
  const at = tablePos ?? (sel instanceof NodeSelection && sel.node.type.spec.tableRole === 'table' ? sel.from : null)
  if (at == null) return null
  const model = tableMenuModel(view.state.doc, at, cell, axis)
  if (!model) return null
  /** 与块菜单其余项同一形状(withSelectedNode):先收菜单,再按**当下**的 doc 重算一次(锚格失效就不动)。 */
  const run = (make: () => ReturnType<typeof tableOpTr>): void => {
    onDone()
    const tr = make()
    if (tr) dispatchTableOp(view, tr)
    view.focus()
  }
  return (
    <>
      {!axis && <div className="ubm-sep" role="separator" />}
      <div className="ubm-label" role="presentation">{t(axis === 'row' ? 'unipage.table.row' : axis === 'col' ? 'unipage.table.column' : 'unipage.table.label')}</div>
      {OPS.filter((o) => model.ops.includes(o.op)).map(({ op, key, Icon }) => (
        <button key={op} data-table-op={op} role="menuitem" tabIndex={-1} onClick={() => run(() => tableOpTr(view.state, model.cellPos, op))}>
          <Icon size={13} /> {t(key)}
        </button>
      ))}
      {model.align && ALIGNS.map(({ align, key, Icon }) => (
        <button key={align} data-table-align={align} aria-checked={model.align === align} role="menuitemcheckbox" tabIndex={-1}
          onClick={() => run(() => tableAlignTr(view.state, model.cellPos, align))}>
          <Icon size={13} /> {t(key)}
          {model.align === align && <Check size={13} className="ubm-check" />}
        </button>
      ))}
    </>
  )
}

// ── 把手菜单 ──────────────────────────────────────────────────────────────────────

export interface TableAxisMenuState {
  view: EditorView
  /** 视口 px(交给 OverlayAt 夹取)。 */
  x: number
  y: number
  tablePos: number
  /** 锚格:行把手 = 该行首格,列把手 = 该列表头格。 */
  cellPos: number
  axis: TableAxis
  /** 第几行 / 第几列(悬停层据此在菜单开着时留住把手与高亮)。 */
  index: number
  /** 键盘打开(聚焦把手按 Enter / 空格):焦点进首项。 */
  keyboard?: boolean
}
let axisMenu: TableAxisMenuState | null = null
const axisSubs = new Set<() => void>()
const emitAxis = (): void => { for (const f of axisSubs) f() }
/** 悬停层 → 宿主:打开把手菜单。同一时刻只有一份(多个编辑器各自的宿主按 view 认领)。 */
export function openTableAxisMenu(s: TableAxisMenuState): void { axisMenu = s; emitAxis() }
export function closeTableAxisMenu(): void { if (axisMenu) { axisMenu = null; emitAxis() } }
export const tableAxisMenuState = (): TableAxisMenuState | null => axisMenu
export function subscribeTableAxisMenu(cb: () => void): () => void { axisSubs.add(cb); return () => { axisSubs.delete(cb) } }

/** 把手菜单的宿主:UnifiedPage 挂一处。只渲染属于自己编辑器(getView())的那份;只读不出。
 *  收起:点菜单外 / 右键别处 / Esc(焦点回编辑器)/ 执行一项。↑↓ Home End 在项间移动,Enter / 空格走聚焦项的原生 click。 */
export function TableAxisMenu({ getView, readOnly }: { getView: () => EditorView | null; readOnly?: boolean }): ReactElement | null {
  const s = useSyncExternalStore(subscribeTableAxisMenu, tableAxisMenuState)
  const { t } = useI18n()
  const menuEl = useRef<HTMLDivElement | null>(null)
  const view = getView()
  const mine = !!s && !!view && s.view === view && !readOnly && view.editable
  useEffect(() => {
    if (!mine || !s) return
    const close = (e: Event): void => {
      if (e.target instanceof Node && menuEl.current?.contains(e.target)) return
      closeTableAxisMenu()
    }
    const onKey = (e: KeyboardEvent): void => {
      const menu = menuEl.current
      if (!menu || e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeTableAxisMenu()
        if (!isCoarsePointer()) s.view.focus()
        return
      }
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (bare && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        const items = [...menu.querySelectorAll<HTMLElement>('button')]
        const i = items.indexOf(document.activeElement as HTMLElement)
        const n = items.length
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : i < 0 ? (e.key === 'ArrowUp' ? n - 1 : 0) : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
        items[next]?.focus()
        return
      }
      if (menu.contains(document.activeElement) && (e.key === 'Enter' || e.key === ' ')) return
      if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return
      // 其余键:收菜单。焦点在菜单项上时(↓ 进过菜单)这一下键吞掉、焦点还给编辑器 —— 菜单一卸载焦点就落到 body,
      // 之后打字 / 撤销全都落空(与块菜单同一口径)。焦点本来就在编辑器里则键照常落进去。
      const inside = menu.contains(document.activeElement)
      closeTableAxisMenu()
      if (inside) {
        e.preventDefault()
        if (!isCoarsePointer()) s.view.focus()
      }
    }
    let raf = 0
    if (s.keyboard) {
      let tries = 0
      const focusIn = (): void => {
        const first = menuEl.current?.querySelector<HTMLElement>('button')
        if (first) first.focus()
        else if (++tries < 10) raf = requestAnimationFrame(focusIn)
      }
      raf = requestAnimationFrame(focusIn)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('contextmenu', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('contextmenu', close, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [mine, s])
  if (!mine || !s || !view) return null
  return (
    <OverlayPortal>
      <OverlayAt className="ctx-menu unified-block-menu amx-table-axis-menu" role="menu" aria-label={t('unipage.table.label')} x={s.x} y={s.y}
        data-axis={s.axis} innerRef={(el) => { menuEl.current = el }} onClick={(e) => e.stopPropagation()}>
        <TableMenuSection view={view} cell={s.cellPos} tablePos={s.tablePos} axis={s.axis} onDone={closeTableAxisMenu} />
      </OverlayAt>
    </OverlayPortal>
  )
}
