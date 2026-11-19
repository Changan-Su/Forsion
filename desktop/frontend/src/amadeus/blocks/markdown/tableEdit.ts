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
//
// 悬停层(2026-11-17,Notion 对齐第 3 条;unified/tableHover.ts)另用三个原语:appendTableTr(加号条 / 右下角拖,
// 一笔事务追加 N 行 M 列)、moveTableRowTr / moveTableColTr(把手拖动换序)。都带 closeHistory = 恰好一个撤销步,
// 都只产出标准 GFM:表头恒为首行(行换序只在正文行之间)、列换序整列连表头一起走(对齐存在格子上,跟着走)。
// 仪器:npm run check:tablehover;纯原语另有 tableEdit.test.ts(对着 gfm 同构 schema)。
import { TableMap, addColumn, cellAround, isInTable, removeColumn, removeRow, selectionCell } from '@milkdown/kit/prose/tables'
import { TextSelection, type Command, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import { Fragment, type Node as PMNode, type ResolvedPos } from '@milkdown/kit/prose/model'

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
/** 菜单从哪条轴打开:行首把手只给行的操作,列首把手只给列的操作与对齐;不给 = 整份(右键 / ⠿)。 */
export type TableAxis = 'row' | 'col'
const ROW_OPS: readonly TableOp[] = ['rowAbove', 'rowBelow', 'deleteRow']
const COL_OPS: readonly TableOp[] = ['colLeft', 'colRight', 'deleteCol']

export interface TableMenuModel {
  tablePos: number
  cellPos: number
  /** 锚格来自用户(右键的那一格)。false = ⠿ 打开、没有格子上下文:锚取右下角,只给「加行 / 加列」。 */
  explicit: boolean
  ops: TableOp[]
  /** 锚格所在列的对齐;无对齐(`---`)按左对齐显示。explicit=false 时为 null(不给对齐项)。 */
  align: ColumnAlign | null
}

/** 块菜单对着整张表(tablePos)时的可用操作。cellPos = 打开菜单那一刻指针下的格子(可空 / 可失效)。
 *  axis = 从行首 / 列首把手打开:只留那条轴上的操作(行把手不给对齐 —— 对齐是整列的事)。 */
export function tableMenuModel(doc: PMNode, tablePos: number, cellPos: number | null, axis?: TableAxis): TableMenuModel | null {
  const table = doc.nodeAt(tablePos)
  if (!table || table.type.spec.tableRole !== 'table') return null
  const anchor = cellPos != null ? cellContextAtPos(doc, cellPos) : null
  if (anchor && anchor.tablePos === tablePos) {
    const { row, map } = anchor
    let ops: TableOp[] = []
    if (row > 0) ops.push('rowAbove')
    ops.push('rowBelow', 'colLeft', 'colRight')
    if (row > 0 && map.height > 2) ops.push('deleteRow')
    if (map.width > 1) ops.push('deleteCol')
    if (axis) ops = ops.filter((op) => (axis === 'row' ? ROW_OPS : COL_OPS).includes(op))
    const a = table.nodeAt(map.map[anchor.col])?.attrs.alignment
    const align: ColumnAlign | null = axis === 'row' ? null : a === 'center' || a === 'right' ? a : 'left'
    return { tablePos, cellPos: anchor.cellPos, explicit: true, ops, align }
  }
  if (axis) return null // 把手总带着锚格;锚格失效 = 不出一份猜出来的菜单
  const map = TableMap.get(table)
  const last = cellPosAt(doc, tablePos, map.height - 1, map.width - 1)
  if (last == null) return null
  return { tablePos, cellPos: last, explicit: false, ops: ['rowBelow', 'colRight'], align: null }
}

/** 新列的格子是 createAndFill() 的缺省对齐 'left',会落成 `:--`;新列与未设过对齐的列一样写 `---`。
 *  tr.doc 里那张表的第 col 列逐格清成无对齐;表已不在返回 false。 */
function clearColumnAlign(tr: Transaction, tablePos: number, col: number): boolean {
  const table = tr.doc.nodeAt(tablePos)
  if (!table) return false
  const map = TableMap.get(table)
  for (let r = 0; r < map.height; r++) {
    const pos = tablePos + 1 + map.map[r * map.width + col]
    const cell = tr.doc.nodeAt(pos)
    if (cell && cell.attrs.alignment != null) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: null })
  }
  return true
}

/** 执行一个行列操作。返回带新光标的事务;锚格已失效 / 操作不合法返回 null。 */
export function tableOpTr(state: EditorState, cellPos: number, op: TableOp): Transaction | null {
  const c = cellContextAtPos(state.doc, cellPos)
  if (!c) return null
  const tr = closeHistory(state.tr) // 菜单 / 把手的一次操作 = 一个撤销步,不并进刚才的打字
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
      if (!clearColumnAlign(tr, c.tablePos, col)) return null
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
  const tr = closeHistory(state.tr)
  for (let r = 0; r < c.map.height; r++) {
    const pos = c.tablePos + 1 + c.map.map[r * c.map.width + c.col]
    const cell = tr.doc.nodeAt(pos)
    if (cell && cell.attrs.alignment !== value) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: value })
  }
  const caret = caretInCell(tr.doc, c.cellPos)
  if (caret) tr.setSelection(caret)
  return tr.scrollIntoView()
}

// ── 悬停层(加号条 / 右下角 / 行列把手)────────────────────────────────────────────

/** 派发一笔表格结构操作,使它**单独**成一个撤销步:事务自带的 closeHistory 隔开之前的打字;
 *  派发完再补一笔不改文档的空事务封口,隔开紧跟着的打字 —— 否则加完行 500ms 内在新格里打字会并进同一组,
 *  一次撤销把字和新行一起撤掉(prosemirror-history 按「相邻 + 时间」合组,closeHistory 只管它之前)。 */
export function dispatchTableOp(view: { state: EditorState; dispatch: (tr: Transaction) => void }, tr: Transaction): void {
  view.dispatch(tr)
  view.dispatch(closeHistory(view.state.tr))
}

const tableAt = (doc: PMNode, tablePos: number): PMNode | null => {
  const t = tablePos >= 0 && tablePos < doc.content.size ? doc.nodeAt(tablePos) : null
  return t && t.type.spec.tableRole === 'table' ? t : null
}

/** 表格的行列数(悬停层画把手 / 算拖动步长用);不是表返回 null。 */
export function tableSize(doc: PMNode, tablePos: number): { rows: number; cols: number } | null {
  const table = tableAt(doc, tablePos)
  if (!table) return null
  const map = TableMap.get(table)
  return { rows: map.height, cols: map.width }
}

/** 第 row 行第 col 列那一格的位置(把手打开菜单时的锚格)。 */
export function tableCellPos(doc: PMNode, tablePos: number, row: number, col: number): number | null {
  return tableAt(doc, tablePos) ? cellPosAt(doc, tablePos, row, col) : null
}

/** 表尾追加 rows 行、cols 列(加号条点一下 = 1;右下角拖 = 一次多个)。一笔事务、一个撤销步。
 *  caret:'row' = 光标进新的末行首格,'col' = 进新的末列表头格(点加号条后接着打字);不给 = 选区原样映射(拖完不跳光标)。
 *  新列与未设过对齐的列一样写 `---`;新行每格继承表头那一列的对齐(insertTableRow)。表已不在 / 数目不合法返回 null。 */
export function appendTableTr(state: EditorState, tablePos: number, rows: number, cols: number, caret?: 'row' | 'col'): Transaction | null {
  const table = tableAt(state.doc, tablePos)
  if (!table || rows < 0 || cols < 0 || rows + cols === 0 || !Number.isInteger(rows) || !Number.isInteger(cols)) return null
  const tr = closeHistory(state.tr)
  if (cols > 0) {
    // 自下而上逐行在行尾补格:后面行的插入不挪前面行的位置,不必过 mapping
    // (prosemirror-tables 的 addColumn 每次都按 tr.mapping 重映射,同一笔里连调会把位置映两遍)。
    const starts: number[] = []
    table.forEach((_row, offset) => { starts.push(tablePos + 1 + offset) })
    for (let r = table.childCount - 1; r >= 0; r--) {
      const row = table.child(r)
      const type = row.firstChild?.type
      if (!type) return null
      const cells: PMNode[] = []
      for (let i = 0; i < cols; i++) {
        const cell = type.createAndFill({ alignment: null })
        if (!cell) return null
        cells.push(cell)
      }
      tr.insert(starts[r] + row.nodeSize - 1, cells)
    }
  }
  let lastRowAt: number | null = null
  for (let i = 0; i < rows; i++) {
    const t = tr.doc.nodeAt(tablePos)
    if (!t) return null
    lastRowAt = insertTableRow(tr, tablePos, t.childCount)
    if (lastRowAt == null) return null
  }
  if (caret) {
    const size = tableSize(tr.doc, tablePos)
    const target = !size ? null
      : caret === 'row' ? (lastRowAt == null ? null : cellPosAt(tr.doc, tablePos, size.rows - 1, 0))
      : cols > 0 ? cellPosAt(tr.doc, tablePos, 0, size.cols - 1) : null
    const sel = target == null ? null : caretInCell(tr.doc, target)
    if (sel) tr.setSelection(sel).scrollIntoView()
  }
  return tr
}

/** 换序后光标的去处:换序前选区在这张表里 → 落进被搬的那一行 / 列的格子(内容会整段重排,原位置映射过来不可信);
 *  不在表里 → 原样映射(表的总长度不变,表外的位置不动)。 */
function caretAfterMove(state: EditorState, tr: Transaction, tablePos: number, size: number, row: number, col: number): void {
  const { from, to } = state.selection
  if (to <= tablePos || from >= tablePos + size) return
  const target = cellPosAt(tr.doc, tablePos, row, col)
  const sel = target == null ? null : caretInCell(tr.doc, target)
  if (sel) tr.setSelection(sel)
}

/** 正文行换序:第 from 行搬到第 to 行(都是 TableMap 行号,换序后的落点)。表头恒为首行 → from / to 都须 ≥ 1。
 *  一笔事务、一个撤销步;不合法 / 没动返回 null。 */
export function moveTableRowTr(state: EditorState, tablePos: number, from: number, to: number): Transaction | null {
  const table = tableAt(state.doc, tablePos)
  if (!table) return null
  const n = table.childCount
  if (from === to || from < 1 || to < 1 || from >= n || to >= n) return null
  const rows: PMNode[] = []
  table.forEach((r) => { rows.push(r) })
  const [moved] = rows.splice(from, 1)
  rows.splice(to, 0, moved)
  const tr = closeHistory(state.tr).replaceWith(tablePos + 1, tablePos + table.nodeSize - 1, Fragment.from(rows))
  caretAfterMove(state, tr, tablePos, table.nodeSize, to, 0)
  return tr
}

/** 列换序:第 from 列搬到第 to 列,表头格连同对齐(存在每一格的 alignment 上)整列一起走。
 *  GFM 没有合并格;某行格数对不上整列(畸形表)就不动。一笔事务、一个撤销步;不合法 / 没动返回 null。 */
export function moveTableColTr(state: EditorState, tablePos: number, from: number, to: number): Transaction | null {
  const table = tableAt(state.doc, tablePos)
  if (!table) return null
  const width = TableMap.get(table).width
  if (from === to || from < 0 || to < 0 || from >= width || to >= width) return null
  const rows: PMNode[] = []
  let ok = true
  table.forEach((row) => {
    if (row.childCount !== width) { ok = false; return }
    const cells: PMNode[] = []
    row.forEach((c) => { cells.push(c) })
    const [moved] = cells.splice(from, 1)
    cells.splice(to, 0, moved)
    rows.push(row.copy(Fragment.from(cells)))
  })
  if (!ok) return null
  const tr = closeHistory(state.tr).replaceWith(tablePos + 1, tablePos + table.nodeSize - 1, Fragment.from(rows))
  caretAfterMove(state, tr, tablePos, table.nodeSize, 0, to)
  return tr
}
