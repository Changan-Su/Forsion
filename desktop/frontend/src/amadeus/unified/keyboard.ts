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
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { Command, EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { classifyEmbed } from './embedLayer'
import { foldedSectionAfter, isHiddenAt } from './headingFold'
import { isListFolded, listHiddenRanges } from './listFold'
import { applyTrigger, matchTrigger, textBeforeCursor, unwrapAtStart } from '../blocks/markdown/blockTriggers'

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

/** 折叠态标题上回车:新块落到**隐藏区之后**,并继承原标题的级别(AFFiNE 同款)。
 *  不接这条的话新段落正好插在隐藏区起点,一按回车就掉进 display:none —— 光标守卫只会把它弹走,
 *  用户看到的是「回车了,但什么都没发生」。 */
const enterFoldedHeading: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty) return false
  const d = topDepth($from)
  if (d !== 1 || $from.parent.type.name !== 'heading') return false
  const after = foldedSectionAfter(state, $from.before(1))
  if (after == null) return false
  const heading = state.schema.nodes.heading
  if (!heading) return false
  const node = heading.createAndFill({ level: $from.parent.attrs.level ?? 1 })
  if (!node) return false
  const tr = state.tr.insert(after, node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
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
  const trig = matchTrigger(textBeforeCursor($from))
  if (!trig) return false
  return applyTrigger(view, trig, { from: $from.start(), to: $from.pos })
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

const enterCmd: Command = chain(
  enterFoldedHeading,
  enterOnBlockSelection,
  enterRunsTrigger,
  enterEmptyListItem,
  enterFoldedListItem,
  enterSplitIntoChild,
)

/** Mod+Enter:引用内 = 块内换行;列表内 = 等同回车(拆项);其余 = 下方直接新建空段落(不拆分文本)。 */
const modEnterCmd: Command = (state, dispatch) => {
  const { $from } = state.selection
  if (blockquoteDepth($from) != null) {
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

const backspaceCmd: Command = chain(bsHeadingToParagraph, bsCallout, bsListToParagraph, bsSelectPrevAtom)

/** Mod+Backspace:光标在块首时一路反缩进到顶层。逐级经 view.dispatch 发 —— PM history 会把
 *  同一次按键内的相邻事务并进同一组,撤销仍是一下;整文替换那种写法会连带毁掉分栏派生与装饰,勿用。
 *  不在列表里就 return false,让路给浏览器/base 的删词。 */
const modBackspaceCmd: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
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

// ── 方向键 ───────────────────────────────────────────────────────────────────

/** 竖直方向键撞上整块型 → 变成块选中,而不是钻进它的隐藏源码(嵌入段)或停在没有行盒的地方。 */
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
    if (!isAtomBlock(target) || !target) return false
    const pos = dir === 'down' ? at : at - target.nodeSize
    const atomNode = state.doc.nodeAt(pos)
    if (!atomNode || !NodeSelection.isSelectable(atomNode)) return false
    if (hiddenAt(state, pos)) return false
    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView())
    return true
  }
}

/** 有选区时按成对符号 = **包裹**选中文字而不是替换掉它(AFFiNE 的 PAIRS 同款)。
 *  反引号直接套行内代码(md 里 `x` 就是行内代码,不必再走 mark);其余按字面成对包。
 *  包完保持选中,可以继续再包一层。没有选区时一律放行 —— 正常打字不受影响。 */
const PAIRS: Record<string, string> = {
  '(': ')', '[': ']', '{': '}', '<': '>', '"': '"', "'": "'", '`': '`',
  '（': '）', '【': '】', '「': '」', '《': '》', '“': '”', '‘': '’',
}
const wrapSelectionPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput: (view, from, to, text) => {
          const close = PAIRS[text]
          if (!close || from === to) return false
          const sel = view.state.selection
          if (!(sel instanceof TextSelection) || sel.empty) return false
          if (!sel.$from.sameParent(sel.$to)) return false // 跨块选区不包(会拆坏结构)
          if (sel.$from.parent.type.name === 'code_block') return false // 代码块里符号就是符号
          const tr = view.state.tr.insertText(close, to).insertText(text, from)
          tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1))
          view.dispatch(tr.scrollIntoView())
          return true
        },
      },
    }),
)

export const keyboardPlugins: MilkdownPlugin[] = [
  wrapSelectionPlugin,
  $prose(() =>
    keymap({
      Enter: enterCmd,
      'Mod-Enter': modEnterCmd,
      Backspace: backspaceCmd,
      'Mod-Backspace': modBackspaceCmd,
      Delete: deleteSelectNextAtom,
      'Ctrl-d': deleteSelectNextAtom, // mac 习惯键,与 Delete 同一支
      ArrowUp: arrowToAtom('up'),
      ArrowDown: arrowToAtom('down'),
    }),
  ),
].flat()
