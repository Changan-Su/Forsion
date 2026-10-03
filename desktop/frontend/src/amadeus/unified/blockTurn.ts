// 块菜单(⠿)「转换为」的落地(评审 B-05):单块走 applyTrigger(与 slash / 工具栏 / 空格触发符同一套转换),
// 跨块选区逐块转换。放在独立模块里,UnifiedPage 只管接线。
import { TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { canJoin, findWrapping, liftTarget } from '@milkdown/kit/prose/transform'
import { FOLD_TOKEN, applyTrigger, type Trigger } from '../blocks/markdown/blockTriggers'

const LIST_KINDS = new Set<Trigger['kind']>(['bullet', 'ordered', 'task'])

/** 块菜单「转换为 ›」那一行行尾显示的当前类型(与子菜单里打勾的项同一份判定)。认不出 → null,不打勾也不显示。 */
export type BlockKind = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'quote' | 'callout' | 'fold' | 'code' | 'card'
export function blockKindOf(node: PMNode | null | undefined): BlockKind | null {
  if (!node) return null
  switch (node.type.name) {
    case 'paragraph': return 'text'
    case 'heading': return node.attrs.level >= 1 && node.attrs.level <= 3 ? (`h${node.attrs.level}` as BlockKind) : null
    case 'bullet_list': return node.firstChild?.attrs.checked != null ? 'task' : 'bullet'
    case 'ordered_list': return 'ordered'
    case 'code_block': return 'code'
    case 'amadeusCanvasCard': return 'card'
    case 'blockquote': {
      const head = node.firstChild?.isTextblock ? node.firstChild.textContent : ''
      return /^\[!fold\]/i.test(head) ? 'fold' : /^\[![\w-]+\]/.test(head) ? 'callout' : 'quote'
    }
    default: return null
  }
}

/** 把 [from, to)(整块边界,来自 topRangeOf)里的每个文本块都转成 trig。返回是否至少转成了一块。
 *  自下而上逐块做:后面的块先变,前面块的位置不受影响;相邻的改动在撤销史里并成一步。
 *  列表类转换逐块包出来的是一串单项列表 → 最后把区间内相邻的同类列表并成一只(Notion 同:选中几段转列表 = 一只列表)。 */
export function turnBlocksInto(view: EditorView, from: number, to: number, trig: Trigger): boolean {
  // 区间里的 callout 先摘掉 `[!type]` 令牌(B-11),否则标题行连令牌一起转成正文 / 标题 / 列表项。
  if (trig.kind !== 'quote' && trig.kind !== 'fold') {
    const tr = view.state.tr
    const size0 = tr.doc.content.size
    view.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'blockquote') { stripCalloutToken(tr, tr.mapping.map(pos)); return false }
      return !node.isTextblock
    })
    if (tr.docChanged) {
      view.dispatch(tr)
      to += tr.doc.content.size - size0
    }
  }
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

/** callout 首行令牌:`[!type]`,可带折叠符,连同其后那一个空格。 */
const CALLOUT_TOKEN = /^\[![\w-]+\]([+-])?[ \u00a0]?/

/** at 处的 blockquote 若是 callout:摘掉首行令牌(标题留作普通段落;标题为空则整行不留)。返回是否摘了。 */
function stripCalloutToken(tr: Transaction, at: number): boolean {
  const bq = tr.doc.nodeAt(at)
  const head = bq?.firstChild
  const m = bq?.type.name === 'blockquote' && head?.isTextblock ? CALLOUT_TOKEN.exec(head.textContent) : null
  if (!bq || !head || !m) return false
  if (head.content.size === m[0].length && bq.childCount > 1) tr.delete(at + 1, at + 1 + head.nodeSize)
  else tr.delete(at + 2, at + 2 + m[0].length)
  return true
}

/** callout 的「转换为」(B-11):[from, to) 恰是一只 callout 时接管,否则返回 null 交回通常路径。
 *  此前按普通引用处理 —— 光标落进首段再转,`[!note]` 令牌以字面漏进正文(落盘 `\[!note] 标题`),只有标题行被提出来,
 *  其余留在引用里;转「引用」什么都不发生。现在先摘令牌,再按目标整只处理(Notion 转成文本 = 去掉容器、保留全部内容):
 *   · 引用 → 只摘令牌,仍是一只引用;折叠 → 令牌换成 `[!fold]-`(已是折叠则不动);
 *   · 正文 / 标题 / 列表 / 代码块 → 摘令牌后把全部内容提出引用,标题 = 首行转标题,列表 = 逐行成项并成一只,
 *     代码块 = 按原文合成一个。 */
export function turnCalloutInto(view: EditorView, from: number, to: number, target: Trigger | 'code'): boolean | null {
  const bq = view.state.doc.nodeAt(from)
  const head = bq?.firstChild
  const m = bq?.type.name === 'blockquote' && from + bq.nodeSize === to && head?.isTextblock ? CALLOUT_TOKEN.exec(head.textContent) : null
  if (!bq || !head || !m) return null
  const tr = view.state.tr
  if (target !== 'code' && target.kind === 'fold') {
    if (/^\[!fold\]/i.test(head.textContent)) return true
    const tokenLen = m[0].length - (/[ \u00a0]$/.test(m[0]) ? 1 : 0)
    tr.replaceWith(from + 2, from + 2 + tokenLen, view.state.schema.text(FOLD_TOKEN))
    view.dispatch(tr.scrollIntoView())
    return true
  }
  stripCalloutToken(tr, from)
  if (target !== 'code' && target.kind === 'quote') {
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)))
    view.dispatch(tr.scrollIntoView())
    return true
  }
  const quote = tr.doc.nodeAt(from)!
  const size = quote.content.size
  const range = tr.doc.resolve(from + 1).blockRange(tr.doc.resolve(from + quote.nodeSize - 1))
  const lift = range ? liftTarget(range) : null
  if (!range || lift == null) return false
  tr.lift(range, lift)
  tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)))
  view.dispatch(tr.scrollIntoView())
  if (target === 'code') return turnRangeIntoCode(view, from, from + size)
  if (target.kind === 'text') return true
  if (target.kind === 'heading') return applyTrigger(view, target, null) // 光标已在首行(原标题)
  return turnBlocksInto(view, from, from + size, target)
}
