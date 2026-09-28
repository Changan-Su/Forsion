// 块菜单(⠿)「转换为」的落地(评审 B-05):单块走 applyTrigger(与 slash / 工具栏 / 空格触发符同一套转换),
// 跨块选区逐块转换。放在独立模块里,UnifiedPage 只管接线。
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { canJoin, findWrapping } from '@milkdown/kit/prose/transform'
import { applyTrigger, type Trigger } from '../blocks/markdown/blockTriggers'

const LIST_KINDS = new Set<Trigger['kind']>(['bullet', 'ordered', 'task'])

/** 把 [from, to)(整块边界,来自 topRangeOf)里的每个文本块都转成 trig。返回是否至少转成了一块。
 *  自下而上逐块做:后面的块先变,前面块的位置不受影响;相邻的改动在撤销史里并成一步。
 *  列表类转换逐块包出来的是一串单项列表 → 最后把区间内相邻的同类列表并成一只(Notion 同:选中几段转列表 = 一只列表)。 */
export function turnBlocksInto(view: EditorView, from: number, to: number, trig: Trigger): boolean {
  const targets: number[] = []
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      targets.push(pos + 1)
      return false
    }
    return true
  })
  const size0 = view.state.doc.content.size
  let any = false
  for (const pos of targets.reverse()) {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))))
    if (applyTrigger(view, trig, null)) any = true
  }
  if (any && LIST_KINDS.has(trig.kind)) joinListsBetween(view, from, to + (view.state.doc.content.size - size0))
  return any
}

/** [from, to) 所在容器里,区间内相邻的同类列表并起来(只并本次转换产出的那一段,区间外的列表不动)。 */
function joinListsBetween(view: EditorView, from: number, to: number): void {
  const { doc } = view.state
  const $f = doc.resolve(from)
  const parent = $f.parent
  const cuts: number[] = []
  let pos = $f.start()
  for (let i = 0; i < $f.index(); i++) pos += parent.child(i).nodeSize
  for (let i = $f.index(); i < parent.childCount - 1; i++) {
    const a = parent.child(i)
    pos += a.nodeSize
    if (pos >= to) break
    const b = parent.child(i + 1)
    if (a.type === b.type && /_list$/.test(a.type.name)) cuts.push(pos)
  }
  if (!cuts.length) return
  const tr = view.state.tr
  for (const c of cuts.reverse()) if (canJoin(tr.doc, c)) tr.join(c)
  if (tr.docChanged) view.dispatch(tr)
}

/** 「转换为 → 代码块」(B-14):按**原文**造一个代码块替换 [from, to)(块之间换行)。跨块选区合成一个代码块
 *  (AFFiNE 同;逐块转会得到 N 个代码块)。⚠️ 不能复用 applyTrigger 的 code 分支 —— 它是给「```」触发符用的,
 *  会把原文挪到一个空代码块下面。容器不收代码块(列表项的首子只能是段落)→ false,调用方提示。 */
export function turnRangeIntoCode(view: EditorView, from: number, to: number): boolean {
  const { state } = view
  const code = state.schema.nodes.code_block
  if (!code) return false
  const $f = state.doc.resolve(from)
  const $t = state.doc.resolve(to)
  if ($f.parent !== $t.parent || !$f.parent.canReplaceWith($f.index(), $t.index(), code)) return false
  const text = state.doc.textBetween(from, to, '\n', '\n').replace(/^\n+|\n+$/g, '')
  const tr = state.tr.replaceWith(from, to, code.create(null, text ? state.schema.text(text) : undefined))
  tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)))
  view.dispatch(tr.scrollIntoView())
  return true
}

/** callout 首行令牌(Obsidian `> [!type]`)。 */
const CALLOUT_HEAD = /^\[![\w-]+\]/
/** 「转换为 → 标注」(B-14):单块先按「引用」包起来(applyTrigger 同一套:出列表、标题降为段落),跨块选区整段
 *  包进**一只**引用;再在首行行首补 `[!note] `(与「折叠」补 `[!fold]-` 同形:原首行成为标注标题)。
 *  已经是 callout 的不重复补。[from, to) = 整块边界(NodeSelection 或 topRangeOf)。 */
export function turnIntoCallout(view: EditorView, from: number, to: number, multi: boolean): boolean {
  const bq = view.state.schema.nodes.blockquote
  if (!bq) return false
  let quoteAt: number
  const node = view.state.doc.nodeAt(from)
  if (node?.type === bq && from + node.nodeSize === to) {
    quoteAt = from // 本来就是引用 / callout:只补令牌
  } else if (multi) {
    const range = view.state.doc.resolve(from).blockRange(view.state.doc.resolve(to))
    const wrap = range && findWrapping(range, bq)
    if (!range || !wrap) return false
    view.dispatch(view.state.tr.wrap(range, wrap))
    quoteAt = from
  } else {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(from + 1))))
    if (!applyTrigger(view, { kind: 'quote' }, null)) return false
    const $at = view.state.selection.$from
    let d = $at.depth
    while (d > 0 && $at.node(d).type !== bq) d--
    if (d < 1) return false
    quoteAt = $at.before(d)
  }
  const quote = view.state.doc.nodeAt(quoteAt)
  const first = quote?.firstChild
  if (!quote || quote.type !== bq || !first?.isTextblock || CALLOUT_HEAD.test(first.textContent)) return !!quote
  view.dispatch(view.state.tr.insertText(first.content.size ? '[!note] ' : '[!note]', quoteAt + 2))
  return true
}
