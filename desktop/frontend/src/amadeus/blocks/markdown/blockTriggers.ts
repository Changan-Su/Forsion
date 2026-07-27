// 块级 markdown 触发层:空格触发的行首前缀(#{1,6} / - * + / 1. / > / [])与 slash 菜单选中的
// 前缀类型,一律在编辑器内部「单事务:删触发符 + 原地转换」完成 —— 不经 store 回写/重挂载。
// 为什么:store 的 content 经 markdownUpdated 有 200ms debounce 滞后,且序列化恒带尾部 '\n',
// 靠「改 store → content 差异 → remount」转换必然竞态(残留 '/'、丢字、丢焦点),已实测坐实。
// 语义对齐 Notion/AFFiNE:标题是「设成 N 级」(Milkdown 内置规则是叠加,h1+## 会变 h3);
// 同级重打幂等;已在列表项内时 -/1./[] 改父列表类型/勾选态,不再嵌套包一层。
import type { ResolvedPos } from '@milkdown/kit/prose/model'
import { canJoin, findWrapping } from '@milkdown/kit/prose/transform'
import type { EditorView } from '@milkdown/kit/prose/view'

export type TriggerKind = 'text' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote'

export interface Trigger {
  kind: TriggerKind
  level?: number
  order?: number
  checked?: boolean
}

/** 光标前的行内文本;leaf 节点占 1 位占位符,保证字符串下标 == 文档偏移(行内有图片/公式也不错位)。 */
export function textBeforeCursor($from: ResolvedPos): string {
  return $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
}

/** 识别「光标前文本恰好是行首触发符」(空格尚未落字时调用;消费长度 = before.length)。 */
export function matchTrigger(before: string): Trigger | null {
  const b = before.replace(/\u00A0/g, ' ') // 行尾空格在 contenteditable 中是 nbsp("[ ]" 的空格即是)
  let m: RegExpExecArray | null
  if ((m = /^(#{1,6})$/.exec(b))) return { kind: 'heading', level: m[1].length }
  if (/^[-*+]$/.test(b)) return { kind: 'bullet' }
  if ((m = /^(\d{1,9})\.$/.exec(b))) return { kind: 'ordered', order: Number(m[1]) }
  if ((m = /^\[( |x)?\]$/i.exec(b))) return { kind: 'task', checked: (m[1] ?? '').toLowerCase() === 'x' }
  if (b === '>') return { kind: 'quote' }
  return null
}

/** 光标前最近的 '/'(slash 菜单触发符)→ 消费区间;找不到返回 null。 */
export function slashRange($from: ResolvedPos): { from: number; to: number } | null {
  const seg = textBeforeCursor($from)
  const idx = seg.lastIndexOf('/')
  if (idx < 0) return null
  return { from: $from.start() + idx, to: $from.pos }
}

/** blockLabel 的入参:光标所在文本块**由内往外**的祖先链,attrs 必须**各自随各自的节点**走。 */
export interface BlockNode {
  name: string
  /** heading 专用 */
  level?: number
  /** list_item 专用:非 null 即待办项(gfm 的 checked attr) */
  checked?: boolean | null
}

/**
 * 行内工具栏「转换为」按钮上显示的**当前**块类型名。链是内→外(如
 * `[paragraph, list_item, bullet_list]`),故 list_item 先于它的列表被扫到:自己带 checked 就是待办,
 * 否则继续外扫拿列表类型。此前这里写死「正文」,光标在标题/列表上也这么显示。
 * ⚠️ checked 必须读**命中的那个 list_item 自己的**——嵌套列表里用一个全局 checked 会串味
 * (待办里嵌普通列表被报成待办,反之亦然)。
 */
export function blockLabel(chain: BlockNode[]): string {
  for (const n of chain) {
    if (n.name === 'heading') return `标题 ${n.level ?? 1}`
    if (n.name === 'code_block') return '代码'
    if (n.name === 'list_item' && n.checked != null) return '待办'
    if (n.name === 'ordered_list') return '有序列表'
    if (n.name === 'bullet_list') return '无序列表'
    if (n.name === 'blockquote') return '引用'
  }
  return '正文'
}

function findDepth($p: ResolvedPos, name: string): number | null {
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === name) return d
  return null
}

/**
 * 单事务应用块级转换:先删 consume 区间(触发符),再把光标所在文本块原地转成目标类型。
 * 成功 dispatch 返回 true;结构不允许(如列表项里设标题)返回 false 且不动文档。
 */
export function applyTrigger(
  view: EditorView,
  trig: Trigger,
  consume: { from: number; to: number } | null
): boolean {
  const { state } = view
  const { schema } = state
  const paragraph = schema.nodes.paragraph
  const heading = schema.nodes.heading
  const blockquote = schema.nodes.blockquote
  const bulletList = schema.nodes.bullet_list
  const orderedList = schema.nodes.ordered_list
  const listItem = schema.nodes.list_item
  if (!paragraph) return false

  const tr = state.tr
  if (consume && consume.to > consume.from) tr.delete(consume.from, consume.to)
  const pos = consume ? consume.from : state.selection.from
  let $blk = tr.doc.resolve(pos)
  if (!$blk.parent.isTextblock) return false

  const liDepth = findDepth($blk, 'list_item')
  if (liDepth !== null && (trig.kind === 'bullet' || trig.kind === 'ordered' || trig.kind === 'task')) {
    // 已在列表项内:改父列表类型 / 勾选态(Notion 语义),不嵌套新列表。
    const li = $blk.node(liDepth)
    if (trig.kind === 'task') {
      tr.setNodeMarkup($blk.before(liDepth), undefined, { ...li.attrs, checked: trig.checked ?? false })
    } else {
      const listDepth = liDepth - 1
      const list = $blk.node(listDepth)
      const targetList = trig.kind === 'bullet' ? bulletList : orderedList
      if (!targetList || listDepth < 1 || !/_list$/.test(list.type.name)) return false
      const listAttrs = trig.kind === 'ordered' ? { order: trig.order ?? 1, spread: false } : { spread: false }
      tr.setNodeMarkup($blk.before(listDepth), targetList, listAttrs)
      tr.setNodeMarkup($blk.before(liDepth), undefined, { ...li.attrs, checked: null })
    }
    view.dispatch(tr.scrollIntoView())
    return true
  }

  if (trig.kind === 'heading' || trig.kind === 'text') {
    const target = trig.kind === 'heading' ? heading : paragraph
    if (!target) return false
    const idx = $blk.index(-1)
    if (!$blk.node(-1).canReplaceWith(idx, idx + 1, target)) return false
    tr.setBlockType($blk.before(), $blk.after(), target, trig.kind === 'heading' ? { level: trig.level ?? 1 } : undefined)
    view.dispatch(tr.scrollIntoView())
    return true
  }

  if (trig.kind === 'quote') {
    if (!blockquote) return false
    if (findDepth($blk, 'blockquote') === null) {
      if ($blk.parent.type === heading) {
        // 引用内文本按段落呈现(Notion/AFFiNE 同款):标题先降级再包。
        tr.setBlockType($blk.before(), $blk.after(), paragraph)
        $blk = tr.doc.resolve(pos)
      }
      const range = $blk.blockRange()
      const wrap = range && findWrapping(range, blockquote)
      if (!wrap) return false
      tr.wrap(range, wrap)
    } // 已在引用内:幂等,只消费触发符。
    view.dispatch(tr.scrollIntoView())
    return true
  }

  // bullet / ordered / task(不在列表内):包一层 list > list_item。
  const listType = trig.kind === 'ordered' ? orderedList : bulletList
  if (!listType || !listItem) return false
  if ($blk.parent.type === heading) {
    tr.setBlockType($blk.before(), $blk.after(), paragraph)
    $blk = tr.doc.resolve(pos)
  }
  const range = $blk.blockRange()
  const wrap = range && findWrapping(range, listType, trig.kind === 'ordered' ? { order: trig.order ?? 1 } : undefined)
  if (!wrap) return false
  tr.wrap(range, wrap)
  if (trig.kind === 'task') {
    // wrap 后 list 起于 range.start,li 定在 range.start+1(gfm 扩展的 checked attr)。
    const li = tr.doc.nodeAt(range.start + 1)
    if (li && li.type.name === 'list_item') {
      tr.setNodeMarkup(range.start + 1, undefined, { ...li.attrs, checked: trig.checked ?? false })
    }
  }
  // 紧邻的前一个同类列表 → 并入(与内置 wrappingInputRule 同款)。
  const nb = tr.doc.resolve(range.start).nodeBefore
  if (nb && nb.type === listType && canJoin(tr.doc, range.start)) tr.join(range.start)
  view.dispatch(tr.scrollIntoView())
  return true
}
