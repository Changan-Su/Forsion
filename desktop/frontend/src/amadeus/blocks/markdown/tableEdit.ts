// K-10(评审 2026-09-27):表格编辑的纯 PM 原语 —— 键盘(Enter 下移 / 末行加行、Shift+Enter 格内换行、
// Mod-Enter 跳出、末格 Tab 加行)与块菜单(增删行列、列对齐)共用一份。不依赖 Milkdown ctx:
// v3 块世界共用的 tabIndent 也在调,块菜单那侧也拿不到 ctx。
//
// 与 preset-gfm 命令的对应(那组命令全仓此前没有调用方):
//  · 加行 = preset addRowAfter/addRowBefore 的本体 addRowWithAlignment 逐字对位(它要 ctx 取类型,这里改从
//    schema 取):新行每格继承表头那一列的对齐。**不用** prosemirror-tables 的 addRow —— 以表头行为参照时它会
//    推断出 table_header 格塞进 table_row,违反 schema,replace 拼不出合法结果就静默不动。
//  · 加列 / 删行 / 删列 = prosemirror-tables 的 addColumn / removeRow / removeColumn(preset addColBefore/After
//    与 deleteSelectedCells 的本体)。它们的命令版只认「选区在表内」,块菜单打开时选区是整表 NodeSelection,
//    所以这里直接喂 rect 调底层函数,一笔事务一次撤销。
//  · 对齐 = preset setAlign 的语义,但作用于**整列**:md 只从表头行读 align(tableSchema.toMarkdown),
//    keepTableAlignPlugin 又会把正文格拉回表头的值 —— setCellAttr 只改一格会被当场改回去。
//
// GFM 约束(菜单据此隐藏不可用项,不做「点了静默无效」):表头恒为首行 → 不提供「表头上方插行」「删表头行」;
// 表体至少一行(schema `table_header_row table_row+`)→ 只剩一行正文时不提供删行;只剩一列时不提供删列。
// 仪器:npm run check:table(scripts/unified-table.check.cjs)。
import { TableMap, addColumn, cellAround, isInTable, removeColumn, removeRow, selectionCell } from '@milkdown/kit/prose/tables'
import { TextSelection, type Command, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { Node as PMNode, ResolvedPos } from '@milkdown/kit/prose/model'

/** 单元格上下文。row/col 是 TableMap 坐标;bottom = 该格下沿(GFM 无合并格,恒为 row+1)。 */
export interface CellCtx {
  table: PMNode
  /** table 节点自身的位置。 */
  tablePos: number
  map: TableMap
  cellPos: number
  row: number
  col: number
  bottom: number
}

const isCellRole = (n: PMNode | null | undefined): boolean => {
  const role = n?.type.spec.tableRole
  return role === 'cell' || role === 'header_cell'
}

/** $cell = 单元格**之前**的位置(父节点是行)。 */
function ctxFromCell($cell: ResolvedPos): CellCtx | null {
  if (!isCellRole($cell.nodeAfter) || $cell.depth < 1) return null
  const table = $cell.node(-1)
  if (table.type.spec.tableRole !== 'table') return null
  const tableStart = $cell.start(-1)
  const map = TableMap.get(table)
  const rect = map.findCell($cell.pos - tableStart)
  return { table, tablePos: tableStart - 1, map, cellPos: $cell.pos, row: rect.top, col: rect.left, bottom: rect.bottom }
}

/** 选区所在单元格(光标 / 格选区);不在表格里返回 null。整表 NodeSelection 不算在表内。 */
export function cellContext(state: EditorState): CellCtx | null {
  if (!isInTable(state)) return null
  try {
    return ctxFromCell(selectionCell(state))
  } catch {
    return null
  }
}

/** 按单元格位置取上下文(块菜单记下的锚格);位置已失效 / 不是单元格返回 null。 */
export function cellContextAtPos(doc: PMNode, cellPos: number): CellCtx | null {
  if (cellPos < 0 || cellPos >= doc.content.size) return null
  return ctxFromCell(doc.resolve(cellPos))
}

/** 包含 posInside 的单元格位置(块菜单用 posAtDOM(td) 反查指针下的格子);不在格内返回 null。 */
export function cellPosAround(doc: PMNode, posInside: number): number | null {
  const $p = doc.resolve(posInside)
  const $cell = cellAround($p)
  return $cell && isCellRole($cell.nodeAfter) ? $cell.pos : null
}

/** 单元格里的光标:内容末尾(atEnd)或开头。单元格内容恒为一个段落(gfm cellContent),near 兜住例外。 */
export function caretInCell(doc: PMNode, cellPos: number, atEnd = true): TextSelection | null {
  const cell = doc.nodeAt(cellPos)
  if (!cell) return null
  const sel = TextSelection.near(doc.resolve(atEnd ? cellPos + cell.nodeSize - 1 : cellPos + 1), atEnd ? -1 : 1)
  return sel instanceof TextSelection ? sel : null
}

const cellPosAt = (doc: PMNode, tablePos: number, row: number, col: number): number | null => {
  const table = doc.nodeAt(tablePos)
  if (!table) return null
  const map = TableMap.get(table)
  if (row < 0 || row >= map.height || col < 0 || col >= map.width) return null
  return tablePos + 1 + map.map[row * map.width + col]
}

/** 在第 index 行之前插入一行空正文行(index = 行数即追加)。index ≥ 1:表头恒为首行。
 *  返回新行的位置;不合法时返回 null 且不动 tr。 */
export function insertTableRow(tr: Transaction, tablePos: number, index: number): number | null {
  const table = tr.doc.nodeAt(tablePos)
  const { table_row: rowType, table_cell: cellType } = tr.doc.type.schema.nodes
  if (!table || !rowType || !cellType || index < 1 || index > table.childCount) return null
  const map = TableMap.get(table)
  const cells: PMNode[] = []
  for (let c = 0; c < map.width; c++) {
    const cell = cellType.createAndFill({ alignment: table.nodeAt(map.map[c])?.attrs.alignment ?? null })
    if (!cell) return null
    cells.push(cell)
  }
  let at = tablePos + 1
  for (let i = 0; i < index; i++) at += table.child(i).nodeSize
  tr.insert(at, rowType.create(null, cells))
  return at
}

// ── 键盘 ──────────────────────────────────────────────────────────────────────

/** Enter:下一行同列(Excel / Obsidian);末行先加一行再过去。光标落在目标格内容末尾。 */
export const tableEnter: Command = (state, dispatch) => {
  const c = cellContext(state)
  if (!c) return false
  const tr = state.tr
  if (c.bottom >= c.map.height && insertTableRow(tr, c.tablePos, c.map.height) == null) return false
  const target = cellPosAt(tr.doc, c.tablePos, c.bottom, c.col)
  const caret = target == null ? null : caretInCell(tr.doc, target)
  if (!caret) return false
  dispatch?.(tr.setSelection(caret).scrollIntoView())
  return true
}

/** Shift+Enter:格内换行。必须带原文 `<br>` —— 单元格里落 `\`+换行会把 GFM 行劈断;`<br>` 是 D-06 已打通的
 *  单元格换行编码(inlineBr.ts 读回成同一个 hardbreak)。
 *  ⚠️ 不设 meta 'hardbreak':hardbreakClearMarkKeepAttrs 见到它会把 attrs 重置成缺省,原文随之丢失。 */
export const tableHardBreak: Command = (state, dispatch) => {
  if (!cellContext(state)) return false
  const br = state.schema.nodes.hardbreak
  if (!br) return false
  if (!(state.selection instanceof TextSelection)) return true // 格选区:吞键不动(不替换掉一片格子)
  dispatch?.(state.tr.replaceSelectionWith(br.create({ html: '<br>' }), false).scrollIntoView())
  return true
}

/** Mod+Enter:跳出表格 —— 表后新建空段,光标进去(preset exitTable 同款,表在引用 / 列表 / 分栏里也成立)。 */
export const tableExit: Command = (state, dispatch) => {
  const c = cellContext(state)
  const paragraph = state.schema.nodes.paragraph
  if (!c || !paragraph) return false
  const at = c.tablePos + c.table.nodeSize
  const tr = state.tr.insert(at, paragraph.create())
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView())
  return true
}

/** 末格 Tab:加一行,光标进新行首格(goToNextCell 在末格跳不动时由 tabIndent 调)。 */
export const tableAppendRow: Command = (state, dispatch) => {
  const c = cellContext(state)
  if (!c) return false
  const tr = state.tr
  const at = insertTableRow(tr, c.tablePos, c.map.height)
  const caret = at == null ? null : caretInCell(tr.doc, at + 1, false)
  if (!caret) return false
  dispatch?.(tr.setSelection(caret).scrollIntoView())
  return true
}

// ── 块菜单 ────────────────────────────────────────────────────────────────────

export type TableOp = 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'deleteRow' | 'deleteCol'
export type ColumnAlign = 'left' | 'center' | 'right'

export interface TableMenuModel {
  tablePos: number
  cellPos: number
  /** 锚格来自用户(右键的那一格)。false = ⠿ 打开、没有格子上下文:锚取右下角,只给「加行 / 加列」。 */
  explicit: boolean
  ops: TableOp[]
  /** 锚格所在列的对齐;无对齐(`---`)按左对齐显示。explicit=false 时为 null(不给对齐项)。 */
  align: ColumnAlign | null
}

/** 块菜单对着整张表(tablePos)时的可用操作。cellPos = 打开菜单那一刻指针下的格子(可空 / 可失效)。 */
export function tableMenuModel(doc: PMNode, tablePos: number, cellPos: number | null): TableMenuModel | null {
  const table = doc.nodeAt(tablePos)
  if (!table || table.type.spec.tableRole !== 'table') return null
  const anchor = cellPos != null ? cellContextAtPos(doc, cellPos) : null
  if (anchor && anchor.tablePos === tablePos) {
    const { row, map } = anchor
    const ops: TableOp[] = []
    if (row > 0) ops.push('rowAbove')
    ops.push('rowBelow', 'colLeft', 'colRight')
    if (row > 0 && map.height > 2) ops.push('deleteRow')
    if (map.width > 1) ops.push('deleteCol')
    const a = table.nodeAt(map.map[anchor.col])?.attrs.alignment
    return { tablePos, cellPos: anchor.cellPos, explicit: true, ops, align: a === 'center' || a === 'right' ? a : 'left' }
  }
  const map = TableMap.get(table)
  const last = cellPosAt(doc, tablePos, map.height - 1, map.width - 1)
  if (last == null) return null
  return { tablePos, cellPos: last, explicit: false, ops: ['rowBelow', 'colRight'], align: null }
}

/** 执行一个行列操作。返回带新光标的事务;锚格已失效 / 操作不合法返回 null。 */
export function tableOpTr(state: EditorState, cellPos: number, op: TableOp): Transaction | null {
  const c = cellContextAtPos(state.doc, cellPos)
  if (!c) return null
  const tr = state.tr
  const tableStart = c.tablePos + 1
  const rect = { left: c.col, right: c.col + 1, top: c.row, bottom: c.bottom, tableStart, map: c.map, table: c.table }
  let row = c.row
  let col = c.col
  switch (op) {
    case 'rowAbove':
    case 'rowBelow': {
      row = op === 'rowAbove' ? c.row : c.bottom
      if (insertTableRow(tr, c.tablePos, row) == null) return null
      break
    }
    case 'colLeft':
    case 'colRight': {
      col = op === 'colLeft' ? c.col : c.col + 1
      addColumn(tr, rect, col)
      // 新列的格子是 createAndFill() 的缺省对齐 'left',会落成 `:--`;新列与未设过对齐的列一样写 `---`。
      const table = tr.doc.nodeAt(c.tablePos)
      if (!table) return null
      const map = TableMap.get(table)
      for (let r = 0; r < map.height; r++) {
        const pos = tableStart + map.map[r * map.width + col]
        const cell = tr.doc.nodeAt(pos)
        if (cell && cell.attrs.alignment != null) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: null })
      }
      break
    }
    case 'deleteRow': {
      if (c.row === 0 || c.map.height <= 2) return null
      removeRow(tr, rect, c.row)
      row = Math.min(c.row, c.map.height - 2)
      break
    }
    case 'deleteCol': {
      if (c.map.width <= 1) return null
      removeColumn(tr, rect, c.col)
      col = Math.min(c.col, c.map.width - 2)
      break
    }
  }
  const target = cellPosAt(tr.doc, c.tablePos, row, col)
  const caret = target == null ? null : caretInCell(tr.doc, target)
  if (caret) tr.setSelection(caret)
  return tr.scrollIntoView()
}

/** 整列对齐。左对齐写成「无对齐」(`---`,GFM 渲染即左对齐):没人动过的表不因点一下「左对齐」就被改写成 `:--`,
 *  存量 `:--` 列点「左对齐」则收成 `---`(渲染不变)。居中 / 右对齐写 `:-:` / `--:`。 */
export function tableAlignTr(state: EditorState, cellPos: number, align: ColumnAlign): Transaction | null {
  const c = cellContextAtPos(state.doc, cellPos)
  if (!c) return null
  const value = align === 'left' ? null : align
  const tr = state.tr
  for (let r = 0; r < c.map.height; r++) {
    const pos = c.tablePos + 1 + c.map.map[r * c.map.width + c.col]
    const cell = tr.doc.nodeAt(pos)
    if (cell && cell.attrs.alignment !== value) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: value })
  }
  const caret = caretInCell(tr.doc, c.cellPos)
  if (caret) tr.setSelection(caret)
  return tr.scrollIntoView()
}
