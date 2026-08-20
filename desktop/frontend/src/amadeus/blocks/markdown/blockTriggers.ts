// 块级 markdown 触发层:空格触发的行首前缀(#{1,6} / - * + / 1. / > / [])与 slash 菜单选中的
// 前缀类型,一律在编辑器内部「单事务:删触发符 + 原地转换」完成 —— 不经 store 回写/重挂载。
// 为什么:store 的 content 经 markdownUpdated 有 200ms debounce 滞后,且序列化恒带尾部 '\n',
// 靠「改 store → content 差异 → remount」转换必然竞态(残留 '/'、丢字、丢焦点),已实测坐实。
// 语义对齐 Notion/AFFiNE:标题是「设成 N 级」(Milkdown 内置规则是叠加,h1+## 会变 h3);
// 同级重打幂等;已在列表项内时 -/1./[] 改父列表类型/勾选态,不再嵌套包一层。
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { Selection, type Transaction } from '@milkdown/kit/prose/state'
import { canJoin, findWrapping, liftTarget } from '@milkdown/kit/prose/transform'
import type { EditorView } from '@milkdown/kit/prose/view'

export type TriggerKind = 'text' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'fold' | 'code' | 'math'

/**
 * 折叠块的落盘形态 = Obsidian 折叠 callout(`> [!fold]- 标题` + 内容行同样带 `> ` 前缀)。
 * 选它而不是 `<details>` / 私有块属性:Obsidian 里原生就能折叠、GitHub 上退化成引用块也能读,
 * 且**老笔记里的裸 `>` 语义不变**(仍是普通引用)—— 变的只是「键盘上敲 `>` 得到什么」。
 * 渲染/折叠开关复用已有的 callout.ts 装饰层(状态就写在 md 里的 +/- 字符,跨端一致)。
 */
// 令牌**不带尾随空格**:contenteditable 会把行尾空格吃掉(实测),留着只会得到一个「有时有有时没有」
// 的落盘形态。标题紧跟在 `-` 后面 Obsidian 照样认,渲染层靠 CSS 给出间距。
export const FOLD_TOKEN = '[!fold]-'
const CALLOUT_HEAD_RE = /^\[!\w+\]/

export interface Trigger {
  kind: TriggerKind
  level?: number
  order?: number
  checked?: boolean
  /** code 专用:围栏后的语言(```py → 'py');空串 = 纯文本。 */
  lang?: string
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
  // `- [ ]` 是任务项从渲染态退回字面源码后的自然形态；用户补回最后一个空格时必须能
  // 再次渲染。保留既有 `[ ]` / `[]` 简写，两条入口落到同一 task 事务。
  if ((m = /^- \[( |x)\]$/i.exec(b))) return { kind: 'task', checked: m[1].toLowerCase() === 'x' }
  if ((m = /^\[( |x)?\]$/i.exec(b))) return { kind: 'task', checked: (m[1] ?? '').toLowerCase() === 'x' }
  // `|` = 引用,`>` = 折叠(Notion 手感;用户 2026-07-29 定的键位)。落盘两者都还是 `>` 开头的合法 md。
  if (b === '|') return { kind: 'quote' }
  if (b === '>') return { kind: 'fold' }
  // ```lang → 代码块(语言即 fence info,落盘就是原生 md);$$ → 行内公式骨架。
  if ((m = /^```([A-Za-z0-9+#._-]*)$/.exec(b))) return { kind: 'code', lang: m[1] }
  if (b === '$$') return { kind: 'math' }
  return null
}

/**
 * 实况预览里露出的完整行首源码 → 块类型。
 * 与 matchTrigger 的区别是这里包含「触发转换所需的尾随空格」，因此删掉任意关键字符后就不再
 * 命中，调用方会把残余源码还原成普通文本。这个空格是 Obsidian 式“渲染/源码”边界。
 */
export function triggerFromStructuralPrefix(source: string): Trigger | null {
  const s = source.replace(/\u00A0/g, ' ')
  let m: RegExpExecArray | null
  if ((m = /^(#{1,6}) $/.exec(s))) return { kind: 'heading', level: m[1].length }
  if (/^[-*+] $/.test(s)) return { kind: 'bullet' }
  if ((m = /^(\d{1,9})\. $/.exec(s))) return { kind: 'ordered', order: Number(m[1]) }
  if ((m = /^- \[( |x)\] $/i.exec(s))) return { kind: 'task', checked: m[1].toLowerCase() === 'x' }
  if (s === '> ') return { kind: 'quote' }
  return null
}

/** 光标前最近的 '/'(slash 菜单触发符)→ 消费区间;找不到返回 null。 */
export function slashRange($from: ResolvedPos): { from: number; to: number } | null {
  const seg = textBeforeCursor($from)
  const idx = seg.lastIndexOf('/')
  if (idx < 0) return null
  return { from: $from.start() + idx, to: $from.pos }
}

/**
 * 在块内按「光标前的文本」找回落点:返回锚点末尾对应的文档位置,找不到 → null(调用方保持原位)。
 * 用 lastIndexOf:同一段文字在块里重复出现时,取靠后那个更接近用户离开时的位置。
 */
export function posAtTextAnchor(view: EditorView, anchor: string): number | null {
  // 逐个文本块拼出纯文本,同时记下「文本下标 → 文档位置」的分段映射(leaf 节点占 1 位,不错位)。
  const segs: Array<{ at: number; pos: number }> = []
  let text = ''
  view.state.doc.descendants((node, pos) => {
    if (node.isText) {
      segs.push({ at: text.length, pos })
      text += node.text ?? ''
    } else if (node.isLeaf) {
      segs.push({ at: text.length, pos })
      text += '￼'
    } else if (node.isTextblock && text) {
      text += '\n' // 块间用换行隔开,免得上一块尾接下一块首拼出假匹配
    }
    return true
  })
  const hit = text.lastIndexOf(anchor)
  if (hit < 0) return null
  const target = hit + anchor.length
  // 找到 target 落在哪个文本段里,换算成文档位置。
  let out: number | null = null
  for (const s of segs) if (s.at <= target) out = s.pos + (target - s.at)
  return out
}

/**
 * 行首退格:把光标所在文本块从列表项/引用里脱出来(一路脱到不再有外壳),脱掉了返回 true。
 * 不在任何外壳里 → false,调用方继续走「与上一块合并 / 删空块」。
 */
export function unwrapAtStart(view: EditorView): boolean {
  const { state } = view
  const pos = state.selection.from
  if (!inAny(state.selection.$from, ['list_item', 'blockquote'])) return false
  const tr = state.tr
  const after = liftOutOfWrappers(tr, pos, ['list_item', 'blockquote'])
  if (!tr.steps.length) return false
  // 提完把光标放回原处(lift 会移动位置,不显式设选区的话会掉到块首外面)。
  tr.setSelection(Selection.near(tr.doc.resolve(after)))
  view.dispatch(tr.scrollIntoView())
  return true
}

/**
 * Shift+Enter 的「切块」:把光标**之后**的内容从本块切走,返回它的 markdown 交调用方开新块。
 * 光标已在块尾 → 返回 null,调用方照旧新建一个空块(唯一该建空块的场合)。
 *
 * 切走的是 doc.slice(光标, 末尾),**连结构一起**:待办项切出来还是待办项、标题切出来还是标题
 * (Notion/Obsidian 同款)。装不回一个合法 doc(createAndFill 给 null)就放弃切分退回空块,
 * 宁可少做一步也不吐一个畸形文档。
 *
 * ⚠️ 先算 md 再 dispatch:算不出来就一步都别走,免得内容已经被删、新块却没接住。
 */
export function splitTail(view: EditorView, toMd: (node: ProseNode) => string): string | null {
  const { state } = view
  const from = state.selection.to
  if (from >= Selection.atEnd(state.doc).$head.pos) return null // 块尾
  const tail = state.doc.slice(from, state.doc.content.size)
  if (tail.content.size === 0) return null
  const tailDoc = state.schema.topNodeType.createAndFill(undefined, tail.content)
  if (!tailDoc) return null
  // 「切下来的部分有没有东西」必须问**文本内容**,不能问序列化结果:行尾一个空格 remark 会写成
  // `&#x20;`(非空!),于是「光标停在尾随空格前按 Shift+Enter」会切出一个 `# &#x20;` 的垃圾块
  // —— e2e T8 实测踩到。leafText 占位符保证纯图片/公式的尾部照样算「有东西」。
  if (!tailDoc.textBetween(0, tailDoc.content.size, '\n', '￼').trim()) return null
  const md = toMd(tailDoc).trim()
  if (!md) return null
  view.dispatch(state.tr.delete(from, state.doc.content.size).scrollIntoView())
  return md
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

const inAny = ($p: ResolvedPos, names: string[]): boolean => names.some((n) => findDepth($p, n) !== null)

/**
 * 把光标所在文本块从列表项/引用里**提出来**,返回提完后的光标位置。
 *
 * 为什么必须有:`list_item` 的 content 是 `paragraph block*` —— 首个子节点只能是段落,于是
 * `canReplaceWith(0, 1, heading)` 恒 false,「待办 → 标题」在结构上根本不允许;而「待办 → 正文」
 * 走 setBlockType(paragraph→paragraph) 是空操作,点了跟没点一样。两者合起来就是用户报的
 * 「待办情况下无法切换成别的」。正解不是绕过 canReplaceWith,是先脱离列表再转换(Notion 语义)。
 *
 * 嵌套列表要提多次,故循环;liftTarget 给不出目标(结构不允许)就停在当前层,绝不硬改。
 */
function liftOutOfWrappers(tr: Transaction, pos: number, names: string[]): number {
  let p = pos
  // 上限只是失控保险(每轮都靠「没产生 step 就 break」保证推进);6 层对深嵌套列表不够,给到 32。
  for (let i = 0; i < 32; i++) {
    const $p = tr.doc.resolve(p)
    if (!inAny($p, names)) break
    const range = $p.blockRange()
    const target = range ? liftTarget(range) : null
    if (!range || target == null) break
    const n = tr.steps.length
    tr.lift(range, target)
    if (tr.steps.length === n) break // 没产生 step:再循环就是死循环
    p = tr.mapping.slice(n).map(p)
  }
  return p
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
  let pos = consume ? consume.from : state.selection.from
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
    // 待办/列表项/引用里 → 先脱离容器再转换(否则 list_item 的 `paragraph block*` 直接把标题挡在门外,
    // 而「转正文」在段落里是空操作 —— 两者就是「切不动行样式」的全部病因)。
    if (inAny($blk, ['list_item', 'blockquote'])) {
      pos = liftOutOfWrappers(tr, pos, ['list_item', 'blockquote'])
      $blk = tr.doc.resolve(pos)
      if (!$blk.parent.isTextblock) return false
    }
    const idx = $blk.index(-1)
    if (!$blk.node(-1).canReplaceWith(idx, idx + 1, target)) return false
    tr.setBlockType($blk.before(), $blk.after(), target, trig.kind === 'heading' ? { level: trig.level ?? 1 } : undefined)
    view.dispatch(tr.scrollIntoView())
    return true
  }

  if (trig.kind === 'code' || trig.kind === 'math') {
    // ⚠️ 每一步都要在**当前 tr.doc** 上重解析:consume 已经删过触发符,拿删之前的 $blk 算
    // before()/after() 会越界(实测 "Position 9 out of range",且余文被塞进代码块里)。
    const codeType = schema.nodes.code_block
    if (trig.kind === 'code' && !codeType) return false
    // ⚠️ list_item 的 content 是 `paragraph block*` —— code_block 当不了首子。直接 replaceWith
    //    会被 PM Fitter 自动补一个空 paragraph 再放代码块,于是「余文段落插到了代码块之前」+
    //    光标落进那个凭空多出来的空段(评审实测)。与 heading/text 分支同一套解法:先脱出容器。
    let $b = tr.doc.resolve(pos)
    if (trig.kind === 'code' && inAny($b, ['list_item', 'blockquote'])) {
      pos = liftOutOfWrappers(tr, pos, ['list_item', 'blockquote'])
      $b = tr.doc.resolve(pos)
    }
    if (!$b.parent.isTextblock) return false
    // 行尾余文:光标之后剩下的字要切成**这个块之后**的一个新段落(AFFiNE 同),不能被吞掉。
    const rest = tr.doc.textBetween($b.pos, $b.end(), '\n', '\n')
    if (rest) tr.delete($b.pos, $b.end())
    $b = tr.doc.resolve(tr.mapping.map(pos))
    const blkFrom = $b.before()
    const blkTo = $b.after()
    let afterBlock: number
    if (trig.kind === 'math') {
      // 公式骨架 `$$  $$` 落在同一段里(两个 delimiter 同处一个 textblock,实况预览才扫得到成对)。
      tr.insertText('$$  $$', blkFrom + 1)
      tr.setSelection(Selection.near(tr.doc.resolve(blkFrom + 4)))
      afterBlock = tr.mapping.map(blkTo)
    } else {
      const code = codeType!.create({ language: trig.lang || null })
      tr.replaceWith(blkFrom, blkTo, code)
      tr.setSelection(Selection.near(tr.doc.resolve(blkFrom + 1)))
      afterBlock = blkFrom + code.nodeSize
    }
    if (rest) tr.insert(afterBlock, paragraph.create(null, schema.text(rest)))
    view.dispatch(tr.scrollIntoView())
    return true
  }

  if (trig.kind === 'quote' || trig.kind === 'fold') {
    if (!blockquote) return false
    if (findDepth($blk, 'blockquote') === null) {
      // 列表项里转引用:先出列表(Notion 语义,引用不留在待办的框里),再包。只提 list_item,
      // 不提 blockquote —— 这条分支的前提就是「还没在引用里」。
      if (findDepth($blk, 'list_item') !== null) {
        pos = liftOutOfWrappers(tr, pos, ['list_item'])
        $blk = tr.doc.resolve(pos)
        if (!$blk.parent.isTextblock) return false
      }
      if ($blk.parent.type === heading) {
        // 引用内文本按段落呈现(Notion/AFFiNE 同款):标题先降级再包。
        tr.setBlockType($blk.before(), $blk.after(), paragraph)
        $blk = tr.doc.resolve(pos)
      }
      const range = $blk.blockRange()
      const wrap = range && findWrapping(range, blockquote)
      if (!wrap) return false
      const n = tr.steps.length
      tr.wrap(range, wrap)
      pos = tr.mapping.slice(n).map(pos) // wrap 插了容器开标签,位置整体后移
      $blk = tr.doc.resolve(pos)
    } // 已在引用内:幂等,只消费触发符。
    // 折叠:在首行行首补 `[!fold]- ` 令牌(已经是 callout 就不重复补,重打幂等)。
    if (trig.kind === 'fold' && !CALLOUT_HEAD_RE.test($blk.parent.textContent)) {
      const at = $blk.start()
      tr.insertText(FOLD_TOKEN, at)
      tr.setSelection(Selection.near(tr.doc.resolve(at + FOLD_TOKEN.length)))
    }
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
