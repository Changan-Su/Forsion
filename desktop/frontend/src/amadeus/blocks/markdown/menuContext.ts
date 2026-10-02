// 三件菜单「哪个上下文列哪些项」的**唯一**判定(评审 I-19 / B-18):选区工具栏、slash 菜单、块菜单(⠿)
// 都从这里取,不在各自组件里另写条件 —— 否则同一个上下文在三处列出三套不一样的动作。
// 原则:点了静默无效(或把结构劈坏)的项**不列**;能用但有前提的,执行时失败要给提示(调用方负责)。
import type { ResolvedPos } from '@milkdown/kit/prose/model'
import type { Selection } from '@milkdown/kit/prose/state'

/** 选区 / 光标所处的编辑上下文(只看祖先链)。 */
export interface EditContext {
  /** 代码块里:行内格式、链接、颜色、对齐都无效(代码块不收 mark)。 */
  code: boolean
  /** 表格单元格里:块级转换会劈表(replaceWith 把表切成两张)、前缀转换静默无效、段落对齐会往格子里写 span。 */
  tableCell: boolean
  /** 列表项里(含待办)。 */
  listItem: boolean
  /** 分栏的列里。 */
  column: boolean
  /** 画布卡片里。 */
  card: boolean
  /** 文本块是 doc 的直接子节点(列表 / 引用 / 分栏 / 卡片里都不算)。 */
  topLevel: boolean
}

export function editContextAt($pos: ResolvedPos): EditContext {
  const ctx: EditContext = { code: !!$pos.parent.type.spec.code, tableCell: false, listItem: false, column: false, card: false, topLevel: $pos.depth === 1 }
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d)
    const role = n.type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') ctx.tableCell = true
    else if (n.type.name === 'list_item') ctx.listItem = true
    else if (n.type.name === 'amadeusColumnCell') ctx.column = true
    else if (n.type.name === 'amadeusCanvasCard') ctx.card = true
  }
  return ctx
}

/** 选区两端的上下文取并(跨块选区一端在代码 / 表格里,就按受限的那端算)。 */
export function editContextOf(sel: Selection): EditContext {
  const a = editContextAt(sel.$from)
  if (sel.empty) return a
  const b = editContextAt(sel.$to)
  return {
    code: a.code || b.code,
    tableCell: a.tableCell || b.tableCell,
    listItem: a.listItem || b.listItem,
    column: a.column || b.column,
    card: a.card || b.card,
    topLevel: a.topLevel && b.topLevel,
  }
}

/** 选区工具栏的分区(I-19)。「清除格式」与「问 Tangu / AI」恒在,不在此列。 */
export interface ToolbarShape {
  /** 「转换为…」 */
  turnInto: boolean
  /** B / I / U / S / </> */
  format: boolean
  link: boolean
  color: boolean
  align: boolean
}

export function toolbarShape(ctx: EditContext): ToolbarShape {
  // 代码块:只留「转换为」(把代码块转回正文 / 标题)与「清除」;其余按钮点了全都没反应。
  if (ctx.code) return { turnInto: true, format: false, link: false, color: false, align: false }
  // 单元格:转换会劈表;对齐是整列的事(表格块菜单里有),段落级对齐会往格子里写 `<span data-amadeus-align>`。
  if (ctx.tableCell) return { turnInto: false, format: true, link: true, color: true, align: false }
  return { turnInto: true, format: true, link: true, color: true, align: true }
}

/** slash 菜单在这里开不开(B-18):代码块里 `/` 是路径 / 注释;单元格里没有一项做得成 —— 前缀转换静默无效
 *  (`/h1` 原样留在格子里),整块插入落到表格外面(`/code` 插到表后)—— 于是 `/` 在单元格里恒字面(`1/2` 也常见)。 */
export function slashAvailable(ctx: EditContext): boolean {
  return !ctx.code && !ctx.tableCell
}

/** slash 菜单里这一项在这个上下文列不列(B-18:不适用就不列,而不是列出来点了静默无效)。 */
export function slashItemApplies(key: string, ctx: EditContext): boolean {
  if (key === 'instructions') return ctx.topLevel
  // 分栏只做顶层块(列表 / 引用 / 分栏 / 卡片里点了只能给一句「请先移出」)。
  if (key === 'columns') return ctx.topLevel
  // 卡片:列表项里会把整份父列表搬成一张卡、分栏里 blockToCard 拒绝 —— 与块菜单同规。
  if (key === 'card') return !ctx.listItem && !ctx.column
  return true
}

/** 块菜单「移到新列」列不列(B-18):只对 doc 顶层的单块(列表项 / 分栏里 / 卡片里点了静默无效);
 *  画布卡与分栏行本身也不行(splitToColumn 拒绝)。跨块选区另有置灰那一支(B-05)。 */
export function columnSplitApplies(sel: Selection): boolean {
  const node = (sel as Selection & { node?: { type: { name: string } } }).node
  if (!node) return false
  return sel.$from.depth === 0 && !/^amadeus(CanvasCard|ColumnRow)$/.test(node.type.name)
}

/** 块菜单「取消分栏」列不列(B-08):选中的块 / 光标在分栏的某一列里。返回所在行的前位,不在列里 null。 */
export function columnRowOf(sel: Selection): number | null {
  const $p = sel.$from
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'amadeusColumnRow') return $p.before(d)
  return null
}
