/** Tab 缩进语义 —— v3 块世界与 v4 unified **共用同一份**:
 *  两个世界各自的 keymap 只做「挂在哪、要不要让位」的判断,分支阶梯全在这里,免得两边漂移。
 *
 *  阶梯(先命中先赢):
 *  · code_block 内 Tab = 插两空格(多行选区=逐行行首),Shift-Tab = 逐行去至多两空格
 *  · 表格内 → 自己调 goToNextCell(±1)(与 gfm tableKeymap 同一条命令):边界格跳不动时**吞键**,
 *    裸 return false 会落进浏览器默认行为把焦点抛出编辑器(评审 P2)
 *  · 列表项 Tab/Shift-Tab = sink/lift(显式调命令,不依赖 fall-through;首项无处可缩也吞掉);
 *    Shift-Tab 对「li 内非首子段落」只抬那一段(历史 merge 内容的对称逃生口)
 *  · 段落(不在列表/表格/代码里)→ 整段缩进档 ±1(2026-08-14 用户拍板:纯缩进,Notion/AFFiNE
 *    视觉;此前的「段落转列表/并入前列表」两条已废除)。语义在 paragraphIndent.ts。
 *  · 其余一律吞掉:编辑器内按 Tab 绝不把焦点放走(AFFiNE/Notion 同款,焦点跳走比无操作更糟)
 */
import { sinkListItem, liftListItem } from '@milkdown/kit/prose/schema-list'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { goToNextCell } from '@milkdown/kit/prose/tables'
import { liftTarget } from '@milkdown/kit/prose/transform'
import { adjustParagraphIndent } from './paragraphIndent'

export interface TabFoldHooks {
  /** sink 的落点是**前一兄弟 li** 的子列表:该兄弟处于列表折叠态(子项 display:none)时返回 true,
   *  否则缩进的项会消失在折叠区里(v4 listFold;评审 P1)。 */
  listFoldedAt?(state: EditorState, itemPos: number): boolean
  unfoldList?(view: EditorView, itemPos: number): void
}

type Dispatch = ((tr: Transaction) => void) | undefined

const inListItem = (state: EditorState): boolean => {
  const li = state.schema.nodes.list_item
  if (!li) return false
  const { $from } = state.selection
  for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type === li) return true
  return false
}

const inTable = (state: EditorState): boolean => {
  const { $from } = state.selection
  for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type.name === 'table') return true
  return false
}

/** 表格内 Tab/Shift-Tab:与 gfm tableKeymap 同一条 goToNextCell;边界格跳不动也吞键防焦点逃逸。 */
function tableTab(state: EditorState, dispatch: Dispatch, dir: 1 | -1): boolean {
  goToNextCell(dir)(state, dispatch)
  return true
}

/** code_block 内选区覆盖的每行行首(选区在同一父内;含光标所在行)。 */
function codeLineStarts(state: EditorState): number[] {
  const { $from, $to } = state.selection
  const text = $from.parent.textContent
  const starts = [text.lastIndexOf('\n', $from.parentOffset - 1) + 1]
  for (let i = $from.parentOffset; i < $to.parentOffset; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts.map((p) => $from.start() + p)
}

export function tabIndent(state: EditorState, dispatch: Dispatch, view: EditorView | undefined, hooks?: TabFoldHooks): boolean {
  const { $from, $to } = state.selection
  if ($from.parent.type.name === 'code_block') {
    // 选区跨出代码块(如 code→下个段落)时不许整段替换成两空格(Codex 终审 P1):吞键不动。
    if (!$from.sameParent($to)) return true
    // 多行选区 = 逐行缩进(从后往前插,位置不漂移);整段替换成两空格会把选中代码吃掉(评审 P2)。
    if (!state.selection.empty && $from.parent.textContent.slice($from.parentOffset, $to.parentOffset).includes('\n')) {
      const tr = state.tr
      for (const at of codeLineStarts(state).reverse()) tr.insertText('  ', at, at)
      dispatch?.(tr.scrollIntoView())
      return true
    }
    dispatch?.(state.tr.insertText('  ', $from.pos, $to.pos))
    return true
  }
  if (inTable(state)) return tableTab(state, dispatch, 1)
  if (inListItem(state)) {
    // sink 把当前项送进前一兄弟 li 的子列表:兄弟折叠着就先展开,别把项缩进 display:none 里
    // (与 merge 分支同款两拍语义:这一下只展开,再按一次才真缩进)。
    const li = state.schema.nodes.list_item
    let d = $from.depth
    while (d >= 1 && $from.node(d).type !== li) d--
    if (d >= 1) {
      const itemPos = $from.before(d)
      const prev = state.doc.resolve(itemPos).nodeBefore
      if (prev && prev.type === li) {
        const prevPos = itemPos - prev.nodeSize
        if (hooks?.listFoldedAt?.(state, prevPos)) {
          if (view) hooks?.unfoldList?.(view, prevPos)
          return true
        }
      }
    }
    sinkListItem(state.schema.nodes.list_item)(state, dispatch)
    return true
  }
  if ($from.parent.type.name === 'paragraph') return adjustParagraphIndent(state, dispatch, 1)
  return true
}

export function tabOutdent(state: EditorState, dispatch: Dispatch): boolean {
  const { $from, $to } = state.selection
  if ($from.parent.type.name === 'code_block') {
    if (!$from.sameParent($to)) return true
    // 逐行去至多两个行首空格(单行=光标所在行;多行选区=覆盖的每一行,从后往前删防位置漂移)。
    const doc = state.doc
    const tr = state.tr
    for (const at of codeLineStarts(state).reverse()) {
      let n = 0
      while (n < 2 && doc.textBetween(at + n, at + n + 1) === ' ') n++
      if (n > 0) tr.delete(at, at + n)
    }
    if (tr.steps.length) dispatch?.(tr.scrollIntoView())
    return true
  }
  if (inTable(state)) return tableTab(state, dispatch, -1)
  if (inListItem(state)) {
    const li = state.schema.nodes.list_item
    // 段落是 li 的**非首子块**(Tab 并进来的那种)→ 只把这一段抬出去(merge 的真逆操作)。
    // 整项 liftListItem 在这形态下会把邻项的 bullet 一并拆掉(评审 P2:Tab↔Shift-Tab 不对称)。
    if ($from.parent.type.name === 'paragraph' && $from.depth >= 2 && $from.node($from.depth - 1).type === li && $from.index($from.depth - 1) > 0) {
      const range = $from.blockRange($to)
      const target = range ? liftTarget(range) : null
      if (range && target != null) {
        dispatch?.(state.tr.lift(range, target).scrollIntoView())
        return true
      }
    }
    liftListItem(li)(state, dispatch)
    return true
  }
  if ($from.parent.type.name === 'paragraph') return adjustParagraphIndent(state, dispatch, -1)
  return true
}
