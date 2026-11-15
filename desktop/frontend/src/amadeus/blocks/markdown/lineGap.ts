// 空行逐条往返(只在回车口径开关打开时挂,见 ./enterMode;关着时 v4 照旧用 ./softBreak 的 blankLineRemark)。
//
// 为什么要换掉 blankLineRemark 的编码:现状 N 个空段落 = 2N+1 条空行,偶数条空行表示不了(两条空行被编辑一次
// 就塌成一条);标题后紧跟正文(中间没有空行)也表示不了,编辑一次就被补上空行。回车一次只多一个换行之后,
// 这两种形态是常态。
//
// 编码(只管根一层;读写对称):
//  · 两个「实块」之间的空行 k 条:k ≥ 1 → 中间还原成 k − 1 个空段落;k = 0 → 上一块记 amxTight(只有段落、标题能记;
//    上一块是围栏代码 / 分割线而下一块是段落、标题时,由下一块记 amxTightBefore)。回车在标题末尾、行首触发符拆段
//    也会记 amxTight(unified/keyboard.ts、./blockTriggers)。
//  · 写:空段落自身占一行;空段落之后的连接恒 0;实块之后的连接 = 它记了 amxTight 且安全 ? 0 : 1
//    (后面先跟空段落时,按空段落之后的第一个实块算)。
//  · 文首 k 条空行 = k 个空段落;文末同理。
//
// 实块的类型在写侧拿不到 PM 节点,所以由 verbatim.ts 的根 runner 在每个顶层 mdast 节点上记 data.amxKind
// (逐字占位记 amxFirst / amxLast)。
//
// 紧贴记号说的是「我和**此刻的**下一块之间没有空行」。邻居被删、被挪走、中间插进新块,或者自己被挪到别处之后,
// 记号就过期了:以后旁边换来一个能紧贴的块(标题、列表…)会被悄悄贴上、吞掉一条空行。tightGuard 在每个改了
// 顶层结构的事务之后按位置映射核对一遍,过期的清掉(见下方注释)。
import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Mapping, ReplaceAroundStep, ReplaceStep, type Step } from '@milkdown/kit/prose/transform'
import { isHistoryTransaction } from '@milkdown/kit/prose/history'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

export interface GapKind {
  k: 'p' | 'h' | 'list' | 'olist' | 'quote' | 'code' | 'hr' | 'table' | 'html' | 'other'
  empty: boolean
  tight: boolean
  /** 本块紧接上一块(上一块记不了 amxTight 时由本块记:代码块 / 分割线之后紧跟的段落、标题)。 */
  tightBefore?: boolean
  /** 有序列表起始号;列表首项是否有内容(空项不能紧接段落:`a⏎-` 是 setext 标题)。 */
  start?: number | null
  firstItemText?: boolean
  /** 标题里有换行 = 写出去是 setext 标题(`甲⏎乙⏎===`),紧接在段落后面会把段落一起吞成标题。 */
  multiline?: boolean
  /** 逐字抄回的块:原文的第一行。紧接在段落后面能不能另起一块,按原文怎么写的判(缩进代码、setext 标题都不能)。 */
  lead?: string | null
}

/** 列表首项有没有内容(图片、公式这类没有文字的行内节点也算)。 */
const firstItemHasContent = (list: PMNode): boolean => {
  const para = list.firstChild?.firstChild
  if (!para || !para.isTextblock) return false
  let has = false
  para.forEach((c) => { if (!c.isText || /\S/.test(c.text ?? '')) has = true })
  return has
}

export function pmKind(n: PMNode): GapKind {
  const t = n.type.name
  const k: GapKind['k'] = t === 'paragraph' ? 'p' : t === 'heading' ? 'h' : t === 'bullet_list' ? 'list'
    : t === 'ordered_list' ? 'olist' : t === 'blockquote' ? 'quote' : t === 'code_block' ? 'code'
    : t === 'hr' || t === 'horizontal_rule' ? 'hr' : t === 'table' ? 'table' : t === 'html' ? 'html' : 'other'
  const list = k === 'list' || k === 'olist'
  let multiline = false
  if (k === 'h') n.forEach((c) => { if (c.type.name === 'hardbreak') multiline = true })
  return {
    k,
    empty: t === 'paragraph' && n.content.size === 0,
    tight: n.attrs?.amxTight === true,
    tightBefore: n.attrs?.amxTightBefore === true,
    start: k === 'olist' ? Number(n.attrs?.order ?? 1) : null,
    firstItemText: list ? firstItemHasContent(n) : undefined,
    multiline,
  }
}

/** 紧接在段落的下一行,能自己另起一块(打断段落)吗。逐字抄回的块看原文第一行;新写出去的块看它会被写成什么样。 */
function interruptsParagraph(r: GapKind): boolean {
  if (typeof r.lead === 'string') return /^ {0,3}(#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|>|[-*+][ \t]+\S|1[.)][ \t]+\S)/.test(r.lead)
  if (r.k === 'h') return !r.multiline
  return r.k === 'quote' || r.k === 'code' || r.k === 'list' || r.k === 'olist'
}

/** 0 条空行接在 l 后面,重开还是两块、各自的类型不变吗。 */
export function safeTight(l: GapKind, r: GapKind): boolean {
  if (l.k === 'h') return r.k !== 'other'
  if (l.k !== 'p' || !interruptsParagraph(r)) return false
  if (r.k === 'h' || r.k === 'quote' || r.k === 'code') return true
  if (r.k === 'list') return r.firstItemText !== false
  if (r.k === 'olist') return r.firstItemText !== false && (r.start ?? 1) === 1
  return false
}

/** 0 条空行接在 l 后面、由 r 记账时安全吗(l 是围栏代码 / 分割线,r 是段落 / 标题)。 */
export function safeBefore(l: GapKind, r: GapKind): boolean {
  return (l.k === 'code' || l.k === 'hr') && (r.k === 'p' || r.k === 'h')
}

// ── 读侧 ──────────────────────────────────────────────────────────────────────

function lineOf(node: MdNode, side: 'start' | 'end'): number | null {
  const marked = side === 'start' ? node?.data?.amadeusIndentLine : undefined
  const n = typeof marked === 'number' ? marked : node?.position?.[side]?.line
  return typeof n === 'number' ? n : null
}

const blank = (): MdNode => ({ type: 'paragraph', children: [] })

/** 根一层:按空行还原空段落 / 记 amxTight。导出供单测。 */
export function decodeRoot(tree: MdNode): void {
  const kids: MdNode[] = Array.isArray(tree?.children) ? tree.children : []
  if (!kids.length) return
  const out: MdNode[] = []
  const push = (n: number): void => { for (let i = 0; i < n; i++) out.push(blank()) }
  const rootStart = lineOf(tree, 'start')
  const first = lineOf(kids[0], 'start')
  if (rootStart != null && first != null) push(first - rootStart)
  let prev: MdNode | null = null
  for (const child of kids) {
    const start = lineOf(child, 'start')
    const prevEnd = prev ? lineOf(prev, 'end') : null
    if (prev && prevEnd != null && start != null) {
      const k = start - prevEnd - 1
      if (k < 1) {
        if (prev.type === 'paragraph' || prev.type === 'heading') prev.data = { ...prev.data, amxTight: true }
        else if ((child.type === 'paragraph' || child.type === 'heading') && (prev.type === 'code' || prev.type === 'thematicBreak')) child.data = { ...child.data, amxTightBefore: true }
      } else push(k - 1)
    }
    out.push(child)
    prev = child
  }
  const rootEnd = lineOf(tree, 'end')
  const lastEnd = prev ? lineOf(prev, 'end') : null
  if (rootEnd != null && lastEnd != null) push(Math.max(0, rootEnd - lastEnd - 1))
  tree.children = out
}

// ── 写侧 ──────────────────────────────────────────────────────────────────────

const leftKind = (n: MdNode): GapKind | null => n?.data?.amxLast ?? n?.data?.amxKind ?? null
const rightKind = (n: MdNode): GapKind | null => n?.data?.amxFirst ?? n?.data?.amxKind ?? null

export function lineGapJoin(left: MdNode, right: MdNode, parent: MdNode): number | undefined {
  if (parent?.type !== 'root') return undefined
  const L = leftKind(left)
  const R = rightKind(right)
  if (!L || !R) return undefined
  if (L.empty) return 0
  let N: GapKind | null = R
  if (R.empty) {
    N = null
    const kids: MdNode[] = parent.children ?? []
    for (let j = kids.indexOf(right) + 1; j < kids.length; j++) {
      const kk = rightKind(kids[j])
      if (kk && !kk.empty) { N = kk; break }
    }
    if (!N) return 1
  }
  // 同类列表紧挨(中间没有空段落):交给 to-markdown 自己的换符逻辑。
  if (!R.empty && (L.k === 'list' || L.k === 'olist') && L.k === R.k) return undefined
  if ((L.tight && safeTight(L, N)) || (N.tightBefore && safeBefore(L, N))) return 0
  return 1
}

export const lineGapRemark = $remark('amadeusLineGap', () =>
  function lineGap(this: any) {
    const data = this.data()
    const toMd = (data.toMarkdownExtensions ||= [])
    toMd.push({ join: [lineGapJoin] })
    return (tree: MdNode): void => decodeRoot(tree)
  },
)

// ── 过期紧贴记号的清理 ─────────────────────────────────────────────────────────
//
// 紧贴记号挂在块上,但它说的是这块和「下一块」之间的那条边界。每个改了顶层结构的事务之后,对每个顶层块 X
// (段落 / 标题)按位置映射把 X 的右边界(amxTight)/ 左边界(amxTightBefore)倒推回事务之前:
//  · 边界是原样留下的老边界:X 就是原来那块(只改了里面的字或 attr)→ 记号保持现值(事务里有意改的也算);
//    X 是别的块挪到了这条边界上(并段、拆段的后半段)→ 继承原来在这条边界左边那块的记号。
//  · 边界整个落在这个事务新插入的内容里(粘贴、外部回灌整篇替换、拆段新起的块之间),且边界两边的块都是新插入的
//    → 记号随新内容来,保持;一边是老块(例如老块被从中间拆开)→ 清掉。
//  · 其余(边界贴着插入 / 删除的边缘:邻居被删、被挪走、中间插进新块、自己被挪到别处)→ 清掉。
// 只改 attr 的 ReplaceAroundStep(setNodeMarkup / setBlockType)不挪动位置,但映射会把块边界报成「被替换」,
// 这里跳过它们的映射。主动维护记号的命令(回车在标题末尾、行首触发符拆段、行首退格并段)打 TIGHT_MANAGED
// 自己负责;撤销 / 重做恢复的是之前一致的状态,也不碰。
export const TIGHT_MANAGED = 'amxTightManaged'

let managedDepth = 0
/** fn 里同步派发的事务都算「自己维护紧贴记号」(行首触发符拆段之后的转换:applyTrigger 内部派发,没法逐个打 meta)。 */
export function withTightManaged<T>(fn: () => T): T {
  managedDepth++
  try { return fn() } finally { managedDepth-- }
}

const tightGuardKey = new PluginKey('amadeusTightGuard')

/** 只改节点 attr / 类型、不挪位置的 ReplaceAroundStep(setNodeMarkup 的形状)。 */
function attrOnly(step: Step): boolean {
  if (!(step instanceof ReplaceAroundStep)) return false
  const s = step as unknown as { from: number; to: number; gapFrom: number; gapTo: number; insert: number; structure: boolean; slice: { size: number; openStart: number; openEnd: number } }
  return s.gapFrom === s.from + 1 && s.gapTo === s.to - 1 && s.insert === 1 && s.slice.size === 2 && s.slice.openStart === 0 && s.slice.openEnd === 0
}

/** 这一步只动了某个文本块里的行内内容(打字、删字、加减 mark)= 顶层结构没变。 */
function inlineOnly(step: Step, doc: PMNode): boolean {
  if (step instanceof ReplaceStep) {
    const s = step as unknown as { from: number; to: number; slice: { openStart: number; openEnd: number; content: { forEach(f: (n: PMNode) => void): void } } }
    if (s.slice.openStart !== 0 || s.slice.openEnd !== 0) return false
    let inline = true
    s.slice.content.forEach((n) => { if (!n.isInline) inline = false })
    if (!inline) return false
    const $a = doc.resolve(s.from)
    const $b = doc.resolve(s.to)
    return $a.parent.isTextblock && $a.sameParent($b)
  }
  return !(step instanceof ReplaceAroundStep) || attrOnly(step)
}

export function staleTightFix(trs: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  if (managedDepth > 0 || !trs.some((tr) => tr.docChanged)) return null
  if (trs.some((tr) => tr.getMeta(TIGHT_MANAGED) || isHistoryTransaction(tr))) return null
  let structural = false
  const m = new Mapping()
  for (const tr of trs) {
    tr.steps.forEach((step, i) => {
      if (!inlineOnly(step, tr.docs[i])) structural = true
      if (!attrOnly(step)) m.appendMap(tr.mapping.maps[i])
    })
  }
  if (!structural) return null
  const inv = m.invert()
  const old = oldState.doc
  const oldByStart = new Map<number, PMNode>()
  const oldByEnd = new Map<number, PMNode>()
  old.forEach((n, off) => { oldByStart.set(off, n); oldByEnd.set(off + n.nodeSize, n) })
  const doc = newState.doc
  const starts: number[] = []
  doc.forEach((_n, off) => starts.push(off))
  /** 新文档里 [from, to) 这块是不是整块都是本事务新插入的。 */
  const wholeNew = (from: number): boolean => inv.mapResult(from, 1).deleted
  /** 边界 pos 倒推:老边界(原样留下)→ 老位置;落在新插入内容中间 → 'inside';贴着改动边缘 → null。 */
  const back = (pos: number): number | 'inside' | null => {
    const a = inv.mapResult(pos, -1)
    const b = inv.mapResult(pos, 1)
    if (!a.deleted && !b.deleted && a.pos === b.pos) return a.pos
    if (a.deleted && b.deleted) return 'inside'
    return null
  }
  let tr: Transaction | null = null
  doc.forEach((x, xs, i) => {
    if (!('amxTight' in x.attrs)) return
    const xe = xs + x.nodeSize
    const r0 = inv.mapResult(xs, 1)
    const origin = r0.deleted ? undefined : oldByStart.get(r0.pos)
    const sameAsOld = (o: PMNode | undefined): boolean => !!origin && origin === o
    let tight = x.attrs.amxTight === true
    let before = x.attrs.amxTightBefore === true
    if (i < doc.childCount - 1 || tight) {
      const b = back(xe)
      if (typeof b === 'number') {
        const left = oldByEnd.get(b)
        if (!sameAsOld(left)) tight = left?.attrs.amxTight === true
      } else if (b === 'inside') {
        if (!(origin == null && wholeNew(xs))) tight = false
      } else tight = false
    }
    if (before) {
      const b = back(xs)
      if (typeof b === 'number') {
        const right = oldByStart.get(b)
        if (!sameAsOld(right)) before = right?.attrs.amxTightBefore === true
      } else if (b === 'inside') {
        const prevStart = i > 0 ? starts[i - 1] : -1
        if (!(origin == null && prevStart >= 0 && wholeNew(prevStart))) before = false
      } else before = false
    }
    if (tight === (x.attrs.amxTight === true) && before === (x.attrs.amxTightBefore === true)) return
    tr ??= newState.tr
    tr.setNodeMarkup(xs, undefined, { ...x.attrs, amxTight: tight, amxTightBefore: before })
  })
  if (!tr) return null
  return (tr as Transaction).setMeta(TIGHT_MANAGED, true)
}

export const tightGuardPlugin = $prose(() => new Plugin({
  key: tightGuardKey,
  appendTransaction: (trs, oldState, newState) => staleTightFix(trs, oldState, newState),
}))

/** 开关打开时 v4 挂这一组(代替 blankLineRemark)。 */
export const lineGapPlugins = [lineGapRemark, tightGuardPlugin].flat()
