// v4 统一编辑器的键盘语义层(2026-08-14,逐条对齐 AFFiNE doc 模式)。
//
// 为什么单独一层:整页一实例之后,Enter / Backspace / Delete / 方向键这四族全部落回
// ProseMirror base + commonmark preset 的通用实现 —— 通用实现不认「标题折叠」「callout」
// 「嵌入段落」这些我们自有的呈现单元,于是回车会把新段落插进 display:none 的折叠区、
// 退格在标题上要按三下才降到正文、方向键会钻进嵌入块的隐藏源码。这一层就是把这四族
// 按我们自己的块语义重写一遍。
//
// 落盘影响 = 零:全部是同一份 md 文档内的事务,没有新增任何标记/frontmatter 键。
//
// 插件顺序:本层挂在 blockLayer.plugins 里(自写 $prose keymap 天然先于 preset 链跑),
// 每个键内部按「特例 → 通用」顺序短路,最后一律 `return false` 把没命中的交回原路,
// 绝不吞掉自己不管的键。
//
// 故意不做(AFFiNE 有、我们判定为倒退,勿当缺口再提):
//  · 文档首块退格并入标题 —— Amadeus 的标题就是磁盘文件名,一次误按退格会触发改名
//    (还牵动 cascadeFdAfterRename / remapScopePaths),风险与收益不成比例。
//  · 顶层列表项 Shift-Tab 无反应 —— 现状「脱出列表变段落」是 Obsidian 语义,很多人靠它取消列表。
//  · 跨块选区禁止缩进 —— 那是 AFFiNE 自身架构的妥协,不是优点。
import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin } from '@milkdown/kit/prose/state'
import { liftListItem, splitListItem } from '@milkdown/kit/prose/schema-list'
import { NodeSelection, Selection, TextSelection } from '@milkdown/kit/prose/state'
import type { Command, EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { classifyEmbed } from './embedLayer'
import { foldedSectionAfter, headingFoldKey, isHiddenAt } from './headingFold'
import { isListFolded, listHiddenRanges } from './listFold'
import { applyTypedTrigger, canAutoTriggerFromBlock, triggerAtCursor, unwrapAtStart } from '../blocks/markdown/blockTriggers'
import { paragraphIndentAt } from '../blocks/markdown/paragraphIndent'
import { tableKeyPlugins } from './tableKeys'
import { commandsCtx } from '@milkdown/kit/core'
import { toggleInlineCodeCommand } from '@milkdown/kit/preset/commonmark'
import { toggleTaskTr } from '../blocks/markdown/taskList'

/** 光标所在「顶层块」的深度:doc 或分栏 cell 的直接子节点(与 blockLayer / insertMd 同一判定)。 */
export function topDepth($from: ResolvedPos): number {
  let d = $from.depth
  while (d >= 1 && !['doc', 'amadeusColumnCell'].includes($from.node(d - 1).type.name)) d--
  return d
}

/** 「整块型」节点:方向键/退格/删除撞上它一律转成块选中,不钻进去也不合并掉。
 *  嵌入是**恰好是嵌入的段落**(embedLayer 的装饰口径),所以必须按内容判,不能只看类型名。 */
export function isAtomBlock(node: ProseNode | null | undefined): boolean {
  if (!node) return false
  const n = node.type.name
  if (n === 'code_block' || n === 'hr' || n === 'horizontal_rule' || n === 'table') return true
  return classifyEmbed(node) != null
}

/** 竖直方向键要**整块选中**而不是钻进去的块:分割线与嵌入段(K-09)。代码块、表格不在此列 ——
 *  它们有可编辑的行/格,↑/↓ 交给浏览器原生纵向移动直接进首行/首格并保持列位置(Notion 同)。
 *  退格/Delete 的「撞上只选中、不合并」仍按 isAtomBlock(含代码块/表格),两个谓词故意不同。 */
function isArrowAtomBlock(node: ProseNode | null | undefined): boolean {
  if (!node) return false
  const n = node.type.name
  if (n === 'hr' || n === 'horizontal_rule') return true
  return classifyEmbed(node) != null
}

/** 光标所在最内层 list_item 的深度;不在列表里返回 null。 */
function listItemDepth($from: ResolvedPos): number | null {
  for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type.name === 'list_item') return d
  return null
}

/** 该位置是否被任一种折叠藏起来了。两个 fold 层的 appendTransaction 守卫只管**空选区**,
 *  而 NodeSelection 的 empty 恒 false —— 不在这里挡住,方向键/退格/删除会把选中框放到一个
 *  display:none 的块上:屏幕毫无反馈,接着敲字就是在改看不见的内容。 */
function hiddenAt(state: EditorState, pos: number): boolean {
  if (isHiddenAt(state, pos) != null) return true
  return listHiddenRanges(state).some((rg) => pos > rg.start && pos < rg.after)
}

/** 光标外面套了几层 list_item(顶层项 = 1,不在列表里 = 0)。 */
function nestDepth($from: ResolvedPos): number {
  let n = 0
  for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type.name === 'list_item') n++
  return n
}

/** 光标所在最内层 blockquote(= callout 的载体)的深度;不在引用里返回 null。 */
function blockquoteDepth($from: ResolvedPos): number | null {
  for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type.name === 'blockquote') return d
  return null
}

/** 依次试,第一个返回 true 的胜出(prosemirror-commands 的 chainCommands 同款,自带以免多一层依赖)。 */
function chain(...cmds: Command[]): Command {
  return (state, dispatch, view) => cmds.some((c) => c(state, dispatch, view))
}

// ── Enter ────────────────────────────────────────────────────────────────────

/** 折叠态标题上回车:先展开小节,再按普通标题语义把右半拆成正文。
 *  正文若在标题仍折叠时插到它下面,会立刻成为隐藏区的新成员,光标守卫再把光标弹到下一标题；
 *  所以展开与拆分必须在同一个事务里完成。 */
const enterFoldedHeading: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset === 0) return false
  if ($from.parent.type.name !== 'heading') return false
  const headingPos = $from.before($from.depth)
  if (foldedSectionAfter(state, headingPos) == null) return false
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return false
  const tr = state.tr.split($from.pos, 1, [{ type: paragraph }])
  tr.setMeta(headingFoldKey, { toggle: headingPos })
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 普通标题回车不续标题:左半仍是标题,右半从正文开始。列表另由 splitListItem 续同类项。
 *  行首是一个边界特例:在标题上方插入空正文,保留整条原标题。 */
const enterHeadingToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'heading') return false
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return false
  if ($from.parentOffset === 0) {
    const at = $from.before($from.depth)
    const tr = state.tr.insert(at, paragraph.create())
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)))
    dispatch?.(tr.scrollIntoView())
    return true
  }
  const tr = state.tr.split($from.pos, 1, [{ type: paragraph }])
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 块选中态回车:有文字的块 → 光标进块末开始编辑;无文字的块 → 走原路(base 在其后新建空段)。
 *  嵌入段落排除在「有文字」之外 —— 回车进去等于让用户对着 `![[...]]` 源码打字。 */
const enterOnBlockSelection: Command = (state, dispatch) => {
  const sel = state.selection
  if (!(sel instanceof NodeSelection)) return false
  if (!sel.node.isTextblock || classifyEmbed(sel.node) != null) return false
  const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(sel.to - 1), -1))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 回车也跑一遍块级 markdown 规则(AFFiNE:`# ` 后直接回车 = 变标题,不换行)。
 *  与空格触发共用 blockTriggers 的同一套判定,守卫也一致(空选区、无修饰键)。 */
const enterRunsTrigger: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || !view || !dispatch) return false
  const trig = triggerAtCursor($from)
  if (!trig || !canAutoTriggerFromBlock($from.parent.type.name, trig)) return false
  return applyTypedTrigger(view, trig) // 撤销一下回到字面触发符(K-21)
}

// 故意不接管「引用内回车 = 软换行」:AFFiNE 那样落到 md 是 `> a\\\n> b`(反斜杠续行),
// 而我们现在的 `> a\n>\n> b` 是干净的两段引用。磁盘可读性优先于跟它逐像素对齐 —— 且
// Shift+Enter 早就是块内换行,能力并不缺。「第二次回车跳出引用」由 base liftEmptyBlock 提供,已成立。

/** 空列表项回车:交给 liftListItem —— 它对**列表中间**的空项会把列表就地拆成两半、空段落留在原位
 *  (正是 AFFiNE 说的「原地变成普通段落」),对嵌套项则是 outdent 一层。base 的 liftEmptyBlock 只会
 *  把空段落丢到整个列表**之后**,于是「列表末尾凭空多一个空段」。
 *  ⚠️ 天花板:md 表示不了「段落带子列表」,被提出来的子列表会变成独立顶层列表 —— md 唯一可表示的形态。 */
const enterEmptyListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.content.size !== 0) return false
  if (listItemDepth($from) == null) return false
  const listItem = state.schema.nodes.list_item
  if (!listItem) return false
  return liftListItem(listItem)(state, dispatch)
}

/** 折叠态列表项回车:只拆出**同级兄弟**,子项留在原项里(AFFiNE 同)。
 *  PM 的 splitListItem 会把嵌套子列表一起带给新项 —— 折叠态下用户根本看不见子项,
 *  它们跟着跑等于凭空搬家。这里自写:从光标处剪下行尾,作为新项插在原项**之后**。 */
const enterFoldedListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty) return false
  const li = listItemDepth($from)
  if (li == null || li !== $from.depth - 1) return false
  const item = $from.node(li)
  if (item.childCount < 2) return false
  if (!isListFolded(state, $from.before(li))) return false
  const listItem = state.schema.nodes.list_item
  const paragraph = state.schema.nodes.paragraph
  if (!listItem || !paragraph) return false
  const tail = state.doc.slice($from.pos, $from.end()).content
  const newItem = listItem.createAndFill(null, paragraph.create(null, tail))
  if (!newItem) return false
  let tr = state.tr.delete($from.pos, $from.end())
  const at = tr.mapping.map($from.after(li))
  tr = tr.insert(at, newItem)
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 列表项**有展开的子项**时行中回车:右半段成为该项的**第一个子项**(AFFiNE 语义)。
 *  不能用 splitListItem+sinkListItem 拼 —— 实测那样会把原有的子项塞到右半段**下面**去
 *  (甲 > 乙 > 子项),而 AFFiNE 要的是并列(甲 > [乙, 子项])。故自写单事务:
 *  从光标处剪下行尾 → 作为新 list_item 插进已有子列表的最前面。 */
const enterSplitIntoChild: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset === 0) return false
  const li = listItemDepth($from)
  if (li == null || li !== $from.depth - 1) return false // 只管「项的首段」这一层
  const item = $from.node(li)
  if (item.childCount < 2) return false // 没有子列表:走通常的同级拆项
  // 折叠态:AFFiNE 走「新建同级兄弟项」,子项留在原块内不动 —— 让路给默认的 splitListItem。
  if (isListFolded(state, $from.before(li))) return false
  const nested = item.child(1)
  if (!/_list$/.test(nested.type.name)) return false
  const listItem = state.schema.nodes.list_item
  const paragraph = state.schema.nodes.paragraph
  if (!listItem || !paragraph) return false
  const tailFrom = $from.pos
  const tailTo = $from.end()
  const tail = state.doc.slice(tailFrom, tailTo).content
  const nestedInner = $from.before(li) + 1 + item.child(0).nodeSize + 1 // 子列表内容起点
  const newItem = listItem.createAndFill(null, paragraph.create(null, tail))
  if (!newItem) return false
  let tr = state.tr.delete(tailFrom, tailTo)
  const at = tr.mapping.map(nestedInner)
  tr = tr.insert(at, newItem)
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 段尾回车继承段落缩进档(Tab 缩进,paragraphIndent.ts)。
 *  base 的 splitBlock 只有**光标不在段尾**那条走 `node.copy()`(带 attrs);段尾那条改用
 *  `types=[{type: 默认块}]` —— 不带 attrs,于是新段缩进当场归 0。缩进是块属性、回车是新块,
 *  属性理应跟着走(Word/Notion/AFFiNE 一致),这里把段尾那格补齐。
 *
 *  **空缩进段回车 = 继续留在同一档**(本轮显式拍板,勿当疏漏改掉):空列表项回车之所以脱出一层
 *  (enterEmptyListItem),是因为空 bullet 是视觉垃圾必须清;空缩进段落只是一个空行,没有垃圾要清。
 *  而「缩进写了一段,回车想写第二段却掉回顶格」是更常遇到的挫败。逃生口已有两个:Shift-Tab、
 *  行首退格(bsOutdentParagraph),不缺第三个。 */
const enterKeepIndent: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty) return false
  const indent = paragraphIndentAt($from)
  if (!indent) return false
  if ($from.parentOffset !== $from.parent.content.size) return false // 行中拆分:base 的 copy() 已带 attrs
  const tr = state.tr.split($from.pos, 1, [{ type: $from.parent.type, attrs: { ...$from.parent.attrs, indent } }])
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 已勾选待办上回车:新项一律**未勾选**(K-07,Notion/Obsidian 同)。PM 的 splitListItem 行中拆分走
 *  node.copy()、行尾拆分不传 itemAttrs 时也复制原项 —— 两条都会把 checked:true 带给新项。这里照常用它拆,
 *  再把**空出来的那一项**改回未勾选;嵌套项同理(只看最内层)。空项回车仍由 enterEmptyListItem 脱出。
 *  「空出来的那一项」通常是光标所在的新项;唯一例外是非空项的行首回车 —— 文字整条跟着光标下移,
 *  上面留下的空项才是新的,已完成的那条内容不能因为多了一行就被翻回未完成。这一格直接在上方插一个
 *  未勾选的空项(结果与 splitListItem 相同)。
 *  ⚠️ 插完要把 DOM 选区原样重设一次:Chrome 在「光标所在节点之前插入兄弟节点」后,Selection 对象报告的
 *  位置(仍在原文字行首)与真正插字的位置(上面那个新空项)分叉 —— 实测紧接着打的字落进上面的空项。
 *  PM 自己对这类问题(源码注释 #710/#973)只在光标所在节点被改写时才强制重设,这一格漏了。 */
const enterTaskItem: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  const li = listItemDepth($from)
  if (li == null || $from.node(li).attrs.checked !== true) return false
  const listItem = state.schema.nodes.list_item
  if (!listItem) return false
  if (empty && li === $from.depth - 1 && $from.index(li) === 0 && $from.parentOffset === 0 && $from.parent.content.size > 0) {
    const fresh = listItem.createAndFill({ ...$from.node(li).attrs, checked: false })
    if (!fresh) return false
    if (!dispatch) return true
    dispatch(state.tr.insert($from.before(li), fresh).scrollIntoView())
    const sel = view ? (view.root as Document).getSelection?.() : null
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    return true
  }
  if (!dispatch) return splitListItem(listItem)(state)
  let out: Transaction | null = null
  if (!splitListItem(listItem)(state, (t) => { out = t })) return false
  const tr = out as Transaction | null
  if (!tr) return false
  const $n = tr.selection.$from
  const nli = listItemDepth($n)
  if (nli != null && $n.node(nli).attrs.checked === true) {
    tr.setNodeMarkup($n.before(nli), undefined, { ...$n.node(nli).attrs, checked: false })
  }
  dispatch(tr)
  return true
}

const enterCmd: Command = chain(
  enterFoldedHeading,
  enterHeadingToParagraph,
  enterOnBlockSelection,
  enterRunsTrigger, // `# `+回车仍要能变标题,故缩进继承排在它之后
  enterEmptyListItem,
  enterFoldedListItem,
  enterSplitIntoChild,
  enterTaskItem,
  enterKeepIndent,
)

/** Mod+Enter:待办内 = 翻转勾选;引用内 = 块内换行;列表内 = 等同回车(拆项);其余 = 下方直接新建空段落(不拆分文本)。
 *  待办那条是拍板 #3(K-11,对齐 Notion 的 Cmd+Enter):此前唯一的键盘路径是 ← ← Shift+← x Enter,
 *  几乎无从发现。只认**最内层**列表项是待办(与鼠标点方框同一个 toggleTaskTr);普通列表照旧拆项,
 *  Mod-L 仍是左对齐(不跟 Obsidian 抢那颗键)。待办包在引用/callout 里时,离光标更近的那层赢。 */
const modEnterCmd: Command = (state, dispatch) => {
  const { $from } = state.selection
  const li = listItemDepth($from)
  const bq = blockquoteDepth($from)
  if (li != null && (bq == null || li > bq) && $from.node(li).attrs.checked != null) {
    const tr = toggleTaskTr(state, $from.pos)
    if (!tr) return false
    dispatch?.(tr.scrollIntoView())
    return true
  }
  if (bq != null) {
    const br = state.schema.nodes.hardbreak
    if (!br) return false
    dispatch?.(state.tr.replaceSelectionWith(br.create(), false).scrollIntoView())
    return true
  }
  const listItem = state.schema.nodes.list_item
  if (listItem && listItemDepth($from) != null) return splitListItem(listItem)(state, dispatch)
  const paragraph = state.schema.nodes.paragraph
  const d = topDepth($from)
  if (!paragraph || d < 1) return false
  const at = $from.after(d)
  const tr = state.tr.insert(at, paragraph.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)))
  dispatch?.(tr.scrollIntoView())
  return true
}

// ── Backspace ────────────────────────────────────────────────────────────────

/** 行首退格第一级:非空标题**一步**降到正文(preset 的 DowngradeHeading 是逐级降 h3→h2→h1→p,
 *  三下才到正文;AFFiNE 与 v3 块世界都是一步到位)。 */
const bsHeadingToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  if ($from.parent.type.name !== 'heading' || $from.parent.content.size === 0) return false
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return false
  dispatch?.(state.tr.setBlockType($from.start(), $from.end(), paragraph))
  return true
}

/** 行首退格:callout(`> [!x]`)里的**非首段**只拆自己出去,不像通用 unwrap 那样一路脱到底;
 *  首段行首退格则整只 callout 变块选中(与 Esc 选块同款),再按一下才是删。 */
const bsCallout: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const bq = blockquoteDepth($from)
  if (bq == null) return false
  const isFirstChild = $from.index(bq) === 0
  if (isFirstChild) {
    const at = $from.before(bq)
    const bqNode = state.doc.nodeAt(at)
    if (!bqNode || !NodeSelection.isSelectable(bqNode)) return false
    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, at)))
    return true
  }
  // 非首段:把本段从 blockquote 里切出去,落到 blockquote 之后成为普通段落。
  const start = $from.before(bq + 1)
  const end = $from.after(bq + 1)
  const after = $from.after(bq)
  const node = state.doc.nodeAt(start)
  if (!node) return false
  let tr = state.tr.delete(start, end)
  const at = tr.mapping.map(after)
  tr = tr.insert(at, node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 行首退格:列表项就地脱壳变段落(保留缩进层级),绝不与上一块合并。
 *  v3 早有这套(blockTriggers.unwrapAtStart),但判据卡在「整篇文档的第一个块」,v4 进不来。 */
const bsListToParagraph: Command = (state, _dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0 || !view) return false
  if (listItemDepth($from) == null) return false
  return unwrapAtStart(view)
}

/** 行首退格:上一个顶层块是整块型(代码/分割线/表格/嵌入)→ 只把它变成块选中,不删不合并。
 *  当前块本身是空的,顺带把这个空块删掉(AFFiNE 同)。 */
const bsSelectPrevAtom: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const d = topDepth($from)
  if (d < 1) return false
  // ⚠️ P0:`$from.parent.content.size === 0` 判的是**光标所在文本块**,而 d 是**顶层块**。
  //    两者不同层时(最典型:表格空单元格 —— topDepth 一路爬过 cell/row 落在 table 上),
  //    下面那句 delete 会把整只表格删掉。只在两者同层时才接管。
  if (d !== $from.depth) return false
  const before = $from.before(d)
  const $b = state.doc.resolve(before)
  const prev = $b.nodeBefore
  if (!isAtomBlock(prev) || !prev) return false
  const prevPos = before - prev.nodeSize
  let tr = state.tr
  if ($from.parent.content.size === 0) tr = tr.delete(before, $from.after(d))
  const prevNode = tr.doc.nodeAt(prevPos)
  if (!prevNode || !NodeSelection.isSelectable(prevNode)) return false
  if (hiddenAt(state, prevPos)) return false // 藏起来的块不给选中(见 hiddenAt)
  tr = tr.setSelection(NodeSelection.create(tr.doc, prevPos))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** 行首退格:**先逐级反缩进**,退到 0 档才交回原路(与上一段合并)。
 *  没有这条时行首退格直接落到 base 的 joinBackward:三档缩进的段落一按就整段并进上一段,
 *  缩进一次性全没 —— 用户报的「多 tab 了会全部一起删除」正是这一格。列表/引用里的段落
 *  由 paragraphIndentAt 返回 null 让路给 bsListToParagraph / bsCallout,不会被这条截胡。
 *  ⚠️ 不要改写成直接调 adjustParagraphIndent:那支为 Tab 设计、**恒返回 true**(恒吞键),
 *  用在退格上会让 0 档段落的退格彻底失灵。 */
const bsOutdentParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const indent = paragraphIndentAt($from)
  if (!indent) return false // null=不归缩进档管、0=已顶格:两种都交回 base
  const pos = $from.before($from.depth)
  dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...$from.parent.attrs, indent: indent - 1 }).scrollIntoView())
  return true
}

const backspaceCmd: Command = chain(bsHeadingToParagraph, bsCallout, bsListToParagraph, bsOutdentParagraph, bsSelectPrevAtom)

/** Mod+Backspace:光标在块首时一路反缩进到顶层。逐级经 view.dispatch 发 —— PM history 会把
 *  同一次按键内的相邻事务并进同一组,撤销仍是一下;整文替换那种写法会连带毁掉分栏派生与装饰,勿用。
 *  段落缩进档一步归 0(与列表的「一路 lift 到顶层项」同语义,单笔事务够了)。
 *  两者都不适用就 return false,让路给浏览器/base 的删词。 */
const modBackspaceCmd: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const indent = paragraphIndentAt($from)
  if (indent) {
    const pos = $from.before($from.depth)
    dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...$from.parent.attrs, indent: 0 }).scrollIntoView())
    return true
  }
  const listItem = state.schema.nodes.list_item
  if (!listItem || listItemDepth($from) == null) return false
  if (!dispatch || !view) return true
  for (let i = 0; i < 32; i++) {
    if (nestDepth(view.state.selection.$from) <= 1) break // 已经是顶层项:再 lift 就脱出列表了
    if (!liftListItem(listItem)(view.state, (t) => view.dispatch(t))) break
  }
  return true
}

// ── Delete(前向删除)──────────────────────────────────────────────────────────

/** 折叠标题行尾按 Delete = 先展开这一节,不合并(K-04)。紧跟标题的块藏在折叠区里,直接交给 base 的
 *  joinForward 等于把**看不见的**内容拉进标题(实测 `A标题隐藏一。`)。展开后再按一次才是通常的合并
 *  —— 与 bsSelectPrevAtom / deleteSelectNextAtom「先现形、再动手」同一口径。 */
const deleteUnfoldHeading: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'heading') return false
  if ($from.parentOffset !== $from.parent.content.size) return false
  const headingPos = $from.before($from.depth)
  if (foldedSectionAfter(state, headingPos) == null) return false
  dispatch?.(state.tr.setMeta(headingFoldKey, { toggle: headingPos }))
  return true
}

/** 块尾按 Delete:下一个顶层块是整块型 → 只把它变成块选中(不吞不合并);其余交回 base。 */
const deleteSelectNextAtom: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== $from.parent.content.size) return false
  const d = topDepth($from)
  if (d < 1) return false
  const after = $from.after(d)
  const next = state.doc.resolve(after).nodeAfter
  if (!next || !isAtomBlock(next) || !NodeSelection.isSelectable(next)) return false
  if (hiddenAt(state, after)) return false
  dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, after)).scrollIntoView())
  return true
}

/** 块尾 Delete:把**下一个文本块的文字**接到本块末尾,被掏空的列表项/引用随之消失(K-22,Notion 同)。
 *  base 的 joinForward 遇到「下一块在列表/引用里」只会 lift 或 wrap:段尾 Delete 撞列表只把首项拆壳、
 *  列表末项尾 Delete 把下面的段落包成新列表项 —— 与反方向「退格一次就并对」不对称。
 *  只接管跨容器的那几种;同层相邻兄弟(段↔段、段↔标题)base 本来就并对,原样交回。
 *  下一块是 callout 标题 → 整块选中(与撞上代码块同一口径),不把 `[!note]` 令牌拉成正文;
 *  中间夹着分割线等叶子、代码块、表格、折叠藏起来的块 → 交回原路。 */
const CALLOUT_HEAD = /^\[![A-Za-z]+\]/
const deleteJoinNextText: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock || $from.parentOffset !== $from.parent.content.size) return false
  if ($from.parent.type.name === 'code_block' || $from.depth < 1) return false
  const inTable = ($p: ResolvedPos): boolean => {
    for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'table') return true
    return false
  }
  if (inTable($from)) return false
  const after = $from.after()
  const next = Selection.findFrom(state.doc.resolve(after), 1, true)
  if (!(next instanceof TextSelection)) return false
  const $n = next.$from
  if ($n.parentOffset !== 0 || !$n.parent.isTextblock || $n.parent.type.name === 'code_block' || inTable($n)) return false
  if ($n.depth === $from.depth && $n.before() === after) return false // 同层相邻兄弟:base 的 joinForward 就对
  if (hiddenAt(state, $n.pos)) return false
  let blocked = false
  state.doc.nodesBetween(after, $n.before(), (node, pos) => {
    if (pos >= after && pos + node.nodeSize <= $n.before() && (node.isLeaf || node.isTextblock)) blocked = true
    return !blocked
  })
  if (blocked) return false
  const bq = $n.depth >= 2 && $n.node(-1).type.name === 'blockquote' && $n.index(-1) === 0 ? $n.before(-1) : null
  if (bq != null && CALLOUT_HEAD.test($n.parent.textContent)) {
    const node = state.doc.nodeAt(bq)
    if (!node || !NodeSelection.isSelectable(node)) return false
    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, bq)).scrollIntoView())
    return true
  }
  const joined = $from.parent.textContent + $n.parent.textContent
  const tr = state.tr.delete($from.pos, $n.pos)
  // 不盲信 Fitter:合并后光标所在块的文字必须恰好是「本块 + 下一块」,否则交回原路。
  const $j = tr.doc.resolve(tr.mapping.map($from.pos))
  if (!$j.parent.isTextblock || $j.parent.textContent !== joined || tr.doc.textContent !== state.doc.textContent) return false
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, $j.pos)).scrollIntoView())
  return true
}

// ── 方向键 ───────────────────────────────────────────────────────────────────

/** 竖直方向键撞上分割线/嵌入 → 变成块选中,而不是钻进它的隐藏源码(嵌入段)或停在没有行盒的地方。 */
function arrowToAtom(dir: 'up' | 'down'): Command {
  return (state, dispatch, view) => {
    const sel = state.selection
    if (!sel.empty || !view) return false
    if (!view.endOfTextblock(dir)) return false
    const $from = sel.$from
    const d = topDepth($from)
    if (d < 1) return false
    const at = dir === 'down' ? $from.after(d) : $from.before(d)
    const target = dir === 'down' ? state.doc.resolve(at).nodeAfter : state.doc.resolve(at).nodeBefore
    if (!isArrowAtomBlock(target) || !target) return false
    const pos = dir === 'down' ? at : at - target.nodeSize
    const atomNode = state.doc.nodeAt(pos)
    if (!atomNode || !NodeSelection.isSelectable(atomNode)) return false
    if (hiddenAt(state, pos)) return false
    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView())
    return true
  }
}

/** mac 的 ⌘↑ / ⌘↓ = 到文首 / 文末(评审 K-16)。浏览器原生做法在两种首尾块上原地不动:代码块首子节点是
 *  contenteditable=false 的工具条、嵌入段首子节点是 widget。只接这两种 —— 嵌入是整块型,NodeSelection 选中它
 *  (与 ↑/↓ 撞上嵌入同口径);代码块有可编辑的行,光标进块首 / 块尾。其余首尾块(段落 / 分割线 / 表格)原生都到得了,
 *  照旧放行。只在 mac 挂(见 keyboardPlugins):别的平台 Ctrl+↑ 是按段落跳,不能吞。 */
function docEdge(dir: 'up' | 'down'): Command {
  return (state, dispatch) => {
    const doc = state.doc
    const edge = dir === 'up' ? doc.firstChild : doc.lastChild
    if (!edge) return false
    const pos = dir === 'up' ? 0 : doc.content.size - edge.nodeSize
    if (classifyEmbed(edge) != null) {
      if (!NodeSelection.isSelectable(edge) || hiddenAt(state, pos)) return false
      dispatch?.(state.tr.setSelection(NodeSelection.create(doc, pos)).scrollIntoView())
      return true
    }
    if (edge.type.name === 'code_block') {
      dispatch?.(state.tr.setSelection(TextSelection.create(doc, dir === 'up' ? pos + 1 : pos + edge.nodeSize - 1)).scrollIntoView())
      return true
    }
    return false
  }
}

/** 有选区时按成对符号 = **包裹**选中文字而不是替换掉它(AFFiNE 的 PAIRS 同款)。
 *  反引号 = 行内代码(I-09 / K-18b):与 ⌘E、工具栏 </> 走**同一条** toggleInlineCode 命令。
 *  ⚠️ 别改回按字面插两个反引号 —— 字面 `x` 在编辑器里只是文字,落盘被转义成 \`x\`,永远成不了代码。
 *  其余按字面成对包。包完保持选中,可以继续再包一层。没有选区时一律放行 —— 正常打字不受影响。 */
const PAIRS: Record<string, string> = {
  '(': ')', '[': ']', '{': '}', '<': '>', '"': '"', "'": "'", '`': '`',
  '（': '）', '【': '】', '「': '」', '《': '》', '“': '”', '‘': '’',
}
const wrapSelectionPlugin = $prose(
  (ctx) =>
    new Plugin({
      props: {
        handleTextInput: (view, from, to, text) => {
          const close = PAIRS[text]
          if (!close || from === to) return false
          const sel = view.state.selection
          if (!(sel instanceof TextSelection) || sel.empty) return false
          if (!sel.$from.sameParent(sel.$to)) return false // 跨块选区不包(会拆坏结构)
          if (sel.$from.parent.type.name === 'code_block') return false // 代码块里符号就是符号
          if (text === '`' && view.state.schema.marks.inlineCode) return ctx.get(commandsCtx).call(toggleInlineCodeCommand.key)
          const tr = view.state.tr.insertText(close, to).insertText(text, from)
          tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1))
          view.dispatch(tr.scrollIntoView())
          return true
        },
      },
    }),
)

// ── 整块选中时打字(K-02)────────────────────────────────────────────────────────

/** 块选中(NodeSelection:退格/Delete 撞上代码块/表格、↓/↑ 撞上嵌入/分割线、Esc 选块、文末 `---` 生成的 hr)时,打出来的
 *  字该落在哪。PM 的默认是「用输入替换选区」—— 整块被一个字替换并落盘,输入法组字开头的
 *  deleteSelection 同样删块。块选中是「看着这个块」,不是「要换掉它」(Notion 同):
 *   · 代码块 → 进块尾;表格 → 进首格(末尾);
 *   · 嵌入/分割线等整块型、以及没有可写文字的叶子块 → 在其后新建一段;
 *   · 文字块 / 容器(Esc 选中的段、标题、引用、callout、列表)→ 光标移到块内最后一处文字末尾。
 *  行内原子(图片、行内公式)的 NodeSelection 不在此列,仍是编辑器通常的「选中即替换」。 */
function typingTargetTr(state: EditorState): Transaction | null {
  const sel = state.selection
  if (!(sel instanceof NodeSelection) || !sel.node.isBlock) return null
  const node = sel.node
  const tr = state.tr
  if (node.type.name === 'code_block') return tr.setSelection(TextSelection.create(tr.doc, sel.to - 1))
  if (node.type.name === 'table') {
    const first = Selection.near(tr.doc.resolve(sel.from + 1), 1)
    if (!(first instanceof TextSelection) || first.from >= sel.to) return null
    return tr.setSelection(TextSelection.create(tr.doc, first.$from.end()))
  }
  if (!isAtomBlock(node) && !node.isLeaf) {
    const inside = Selection.near(tr.doc.resolve(sel.to - 1), -1)
    if (inside instanceof TextSelection && inside.from > sel.from && inside.to < sel.to) return tr.setSelection(inside)
  }
  const paragraph = state.schema.nodes.paragraph
  const $to = sel.$to
  if (!paragraph || !$to.parent.canReplaceWith($to.index(), $to.index(), paragraph)) return null
  tr.insert(sel.to, paragraph.create())
  return tr.setSelection(TextSelection.create(tr.doc, sel.to + 1))
}

/** 在浏览器插字之前把块选中换成 typingTargetTr 的落点。三个入口缺一不可:
 *  · keydown(可打印键 / 229 输入法处理中)—— 普通打字、输入法起组合前;
 *  · compositionstart —— 不发 229 的输入法兜底(PM 自己的 compositionstart 见非空选区就 deleteSelection);
 *  · beforeinput insertText —— 不经 keydown 的插字(全角标点直出、表情面板、听写):这里直接自己插,
 *    不赌浏览器会不会在事件中途重读选区。 */
const blockSelectionTypingPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          keydown: (view, event) => {
            if (!view.editable || event.metaKey || event.ctrlKey) return false
            const printable = event.key.length === 1 || event.key === 'Process' || event.keyCode === 229
            if (!printable) return false
            const tr = typingTargetTr(view.state)
            if (tr) view.dispatch(tr.scrollIntoView())
            return false // 不吞键:浏览器随后在新光标处照常插字
          },
          compositionstart: (view) => {
            if (!view.editable) return false
            const tr = typingTargetTr(view.state)
            if (tr) view.dispatch(tr)
            return false
          },
          beforeinput: (view, event) => {
            const e = event as InputEvent
            if (!view.editable || e.inputType !== 'insertText' || !e.data) return false
            const tr = typingTargetTr(view.state)
            if (!tr) return false
            e.preventDefault()
            const { from, to } = tr.selection
            view.dispatch(tr.insertText(e.data, from, to).scrollIntoView())
            return true
          },
        },
      },
    }),
)

/** 与 prosemirror-keymap 判「Mod 是 Cmd 还是 Ctrl」同一口径(它按 navigator.platform)。 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

export const keyboardPlugins: MilkdownPlugin[] = [
  tableKeyPlugins, // 表格回车族(K-10):必须排在下面的 Enter 链之前,见 tableKeys.ts
  blockSelectionTypingPlugin,
  wrapSelectionPlugin,
  $prose(() =>
    keymap({
      Enter: enterCmd,
      'Mod-Enter': modEnterCmd,
      Backspace: backspaceCmd,
      'Mod-Backspace': modBackspaceCmd,
      Delete: chain(deleteUnfoldHeading, deleteSelectNextAtom, deleteJoinNextText),
      // mac 的 emacs 习惯键,与 Delete 同一支。**只在 mac 上挂**(拍板 #8):其它平台 Ctrl 就是 Mod,
      // Ctrl+D 归「复制块」(blockLayer 的 Mod-d,对齐 Notion),不能在这里再被当成向前删除。
      ...(IS_MAC ? { 'Ctrl-d': chain(deleteUnfoldHeading, deleteSelectNextAtom, deleteJoinNextText) } : {}),
      ArrowUp: arrowToAtom('up'),
      ArrowDown: arrowToAtom('down'),
      ...(IS_MAC ? { 'Meta-ArrowUp': docEdge('up'), 'Meta-ArrowDown': docEdge('down') } : {}),
    }),
  ),
].flat()
