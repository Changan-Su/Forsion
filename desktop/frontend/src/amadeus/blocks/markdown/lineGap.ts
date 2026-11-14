// 探针(enterMode ≠ off 才挂,见 ./enterMode):块与块之间的空行条数逐条往返,配合「回车一次 = 一个换行」。
//
// 为什么要换掉 blankLineRemark 的编码:现状 N 个空段落 = 2N+1 条空行,偶数条空行表示不了(两条空行被编辑一次
// 就塌成一条);标题后紧跟正文(中间没有空行)也表示不了,编辑一次就被补上空行。Obsidian 回车一次只多一个换行,
// 这两种形态在它那里是常态。
//
// 新编码(只管根一层;两侧对称):
//  · 两个「实块」之间的空行 k 条:k ≥ base → 中间还原成 k − base 个空段落;k = 0 而 base = 1 → 上一块记 amxTight
//    (只有段落、标题能记;Enter 在标题末尾、行首触发符拆段也会记)。
//    base = 路线二(line)的段落↔段落为 0,其余一律 1。
//  · 写:空段落自身占一行;空段落之后的连接恒 0;实块之后的连接 = 它记了 amxTight 且安全 ? 0 : base
//    (后面先跟空段落时,按空段落之后的第一个实块算)。
//  · 文首 k 条空行 = k 个空段落;文末同理。
//  · 路线二另把段落按软换行拆成一行一段:根一层的每行带上自己那一行的原文位置(逐字回填按位置取切片,
//    整段位置复制给每一行会让没改的行领到整段旧原文 —— 旧版 softBreak.ts 的做法在 v4 上就是这个坑);
//    数不对行就不给偏移(只给行号),该段不逐字、照常序列化。容器(引用 / 列表项)里也拆,段落间的空行 = 空段落。
//
// 实块的类型在写侧拿不到 PM 节点,所以由 verbatim.ts 的根 runner 在每个顶层块的 mdast 节点上记 data.amxKind
// (逐字占位记 amxFirst / amxLast)。
import { $remark } from '@milkdown/kit/utils'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { enterMode } from './enterMode'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

export interface GapKind {
  k: 'p' | 'h' | 'list' | 'olist' | 'quote' | 'code' | 'hr' | 'table' | 'html' | 'other'
  empty: boolean
  tight: boolean
  /** 本块紧接上一块(上一块记不了 amxTight 时由本块记:代码块 / 分割线之后紧跟的段落、标题)。 */
  tightBefore?: boolean
  /** 有序列表起始号;列表首项是否有字(空项不能紧接段落:`a⏎-` 是 setext 标题)。 */
  start?: number | null
  firstItemText?: boolean
}

export function pmKind(n: PMNode): GapKind {
  const t = n.type.name
  const k: GapKind['k'] = t === 'paragraph' ? 'p' : t === 'heading' ? 'h' : t === 'bullet_list' ? 'list'
    : t === 'ordered_list' ? 'olist' : t === 'blockquote' ? 'quote' : t === 'code_block' ? 'code'
    : t === 'hr' || t === 'horizontal_rule' ? 'hr' : t === 'table' ? 'table' : t === 'html' ? 'html' : 'other'
  const list = k === 'list' || k === 'olist'
  return {
    k,
    empty: t === 'paragraph' && n.content.size === 0,
    tight: n.attrs?.amxTight === true,
    tightBefore: n.attrs?.amxTightBefore === true,
    start: k === 'olist' ? Number(n.attrs?.order ?? 1) : null,
    firstItemText: list ? (n.firstChild?.textContent ?? '').trim().length > 0 : undefined,
  }
}

const isEmptyMdPara = (n: MdNode): boolean =>
  n?.type === 'paragraph' && (!n.children?.length || n.children.every((c: MdNode) => c.type === 'html' && /^<br\s*\/?>$/i.test(String(c.value ?? '').trim())))

export function mdKind(n: MdNode): GapKind {
  const t = n?.type
  const k: GapKind['k'] = t === 'paragraph' ? 'p' : t === 'heading' ? 'h' : t === 'list' ? (n.ordered ? 'olist' : 'list')
    : t === 'blockquote' ? 'quote' : t === 'code' ? 'code' : t === 'thematicBreak' ? 'hr' : t === 'table' ? 'table'
    : t === 'html' ? 'html' : 'other'
  return { k, empty: isEmptyMdPara(n), tight: n?.data?.amxTight === true, tightBefore: n?.data?.amxTightBefore === true, start: k === 'olist' ? (n.start ?? 1) : null, firstItemText: true }
}

/** 两块之间至少要几条空行。路线一:一律 1(标准 markdown)。路线二:能紧挨着就 0(文件里每条空行都是一个看得见的空行),
 *  紧挨着会被并进上一块(段落接在列表 / 引用 / 表格后面的懒续行、段落后的 `---` 成 setext 标题…)才要 1。 */
export function baseGap(l: GapKind, r: GapKind): number {
  if (enterMode() !== 'line') return 1
  return adjacentOk(l, r) ? 0 : 1
}

function adjacentOk(l: GapKind, r: GapKind): boolean {
  if (r.k === 'other' || l.k === 'other' || l.k === 'html' || r.k === 'html') return false
  const listOk = r.firstItemText !== false && (r.k !== 'olist' || (r.start ?? 1) === 1)
  switch (l.k) {
    case 'p': return r.k === 'p' || r.k === 'h' || r.k === 'quote' || r.k === 'code' || ((r.k === 'list' || r.k === 'olist') && listOk)
    case 'h': return true
    case 'code': case 'hr': return true
    case 'list': case 'olist': return r.k === 'h' || r.k === 'code'
    case 'quote': case 'table': return r.k === 'h' || r.k === 'code'
    default: return false
  }
}

/** 0 条空行接在 l 后面,重开还是两块、各自的类型不变吗。 */
export function safeTight(l: GapKind, r: GapKind): boolean {
  if (l.k === 'h') return r.k !== 'other'
  if (l.k !== 'p') return false
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

const isSoft = (n: MdNode): boolean => n?.type === 'break' && n.data?.isInline === true && !n.data?.amadeusBr

let copyWholePosition = false
/** 仅供单测:复现旧做法(每行都拿整段的位置),用来证明逐字回填会错配。 */
export function setCopyWholePositionForTest(on: boolean): void { copyWholePosition = on }

/** 路线二:按软换行把段落拆成一行一段。withOffsets = 根一层,按原文给每行自己的位置。 */
export function splitLines(p: MdNode, text: string | null, withOffsets: boolean): MdNode[] {
  const kids: MdNode[] = Array.isArray(p?.children) ? p.children : []
  if (!kids.some(isSoft)) return [p]
  const lines: MdNode[][] = [[]]
  for (const k of kids) {
    if (isSoft(k)) lines.push([])
    else lines[lines.length - 1].push(k)
  }
  const pos = p.position
  const s = pos?.start?.offset
  const e = pos?.end?.offset
  const l0 = pos?.start?.line
  const l1 = pos?.end?.line
  const raw = withOffsets && typeof s === 'number' && typeof e === 'number' && text != null ? text.slice(s, e) : null
  const rawLines = raw != null ? raw.split('\n') : null
  // 每一行(拆出来的段)在原文里占几行:1 + 它内部没拆的换行(硬换行、mark 里的软换行、行内代码 / HTML 里的换行)。
  const nl = (n: MdNode): number => (n?.type === 'break' ? 1 : 0)
    + (typeof n?.value === 'string' && n.type !== 'break' ? (n.value.match(/\n/g) ?? []).length : 0)
    + (Array.isArray(n?.children) ? n.children.reduce((a: number, c: MdNode) => a + nl(c), 0) : 0)
  const spans = lines.map((ch) => 1 + ch.reduce((a, c) => a + nl(c), 0))
  const total = spans.reduce((a, b) => a + b, 0)
  const exact = rawLines != null && rawLines.length === total && typeof l0 === 'number'
  let off = typeof s === 'number' ? s : 0
  let row = 0
  return lines.map((children, i) => {
    const piece: MdNode = { ...p, children, data: p.data ? { ...p.data } : undefined }
    if (copyWholePosition) return piece // 对照用:旧 softBreak.ts 的做法(整段位置复制给每一行)
    if (exact) {
      const seg = rawLines!.slice(row, row + spans[i]).join('\n')
      piece.position = {
        start: { line: l0 + row, column: i === 0 ? pos.start.column : 1, offset: off },
        end: { line: l0 + row + spans[i] - 1, column: 1 + (rawLines![row + spans[i] - 1]?.length ?? 0), offset: off + seg.length },
      }
      off += seg.length + 1
      row += spans[i]
    } else if (typeof l0 === 'number' && typeof l1 === 'number' && l1 - l0 + 1 === total) {
      // 行数对得上但没有可信的偏移(容器里):只给行号,够算空行;逐字层见不到偏移就不碰它。
      piece.position = { start: { line: l0 + row }, end: { line: l0 + row + spans[i] - 1 } }
      row += spans[i]
    } else {
      // 数不对行:首块记起点、末块记终点(空行还原够用),中间不给;一律不逐字。
      piece.position = i === 0 && typeof l0 === 'number' ? { start: { line: l0 } }
        : i === lines.length - 1 && typeof l1 === 'number' ? { end: { line: l1 } } : undefined
    }
    return piece
  })
}

const blank = (): MdNode => ({ type: 'paragraph', children: [] })

/** 路线二的容器(引用 / 列表项 / 脚注):拆行 + 段落间每条空行一个空段落(容器里没有逐字回填)。 */
function expandContainer(node: MdNode): void {
  if (!Array.isArray(node?.children)) return
  const out: MdNode[] = []
  let prev: MdNode | null = null
  for (const child of node.children) {
    if (child?.type === 'paragraph') {
      const pieces = splitLines(child, null, false)
      const first = pieces[0]
      if (prev?.type === 'paragraph') {
        const a = lineOf(prev, 'end')
        const b = lineOf(first, 'start')
        if (a != null && b != null) for (let i = 0; i < b - a - 1; i++) out.push(blank())
      }
      out.push(...pieces)
      prev = pieces[pieces.length - 1]
      continue
    }
    expandContainer(child)
    out.push(child)
    prev = child
  }
  node.children = out
}

/** 根一层:拆行(路线二)+ 按空行还原空段落 / 记 amxTight。导出供单测。 */
export function decodeRoot(tree: MdNode, text: string | null): void {
  let kids: MdNode[] = Array.isArray(tree?.children) ? tree.children : []
  if (!kids.length) return
  if (enterMode() === 'line') {
    const split: MdNode[] = []
    for (const k of kids) {
      if (k?.type === 'paragraph') split.push(...splitLines(k, text, true))
      else {
        expandContainer(k)
        split.push(k)
      }
    }
    kids = split
  }
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
      const base = baseGap(mdKind(prev), mdKind(child))
      if (k < base) {
        if (prev.type === 'paragraph' || prev.type === 'heading') prev.data = { ...prev.data, amxTight: true }
        else if ((child.type === 'paragraph' || child.type === 'heading') && (prev.type === 'code' || prev.type === 'thematicBreak')) child.data = { ...child.data, amxTightBefore: true }
      } else push(k - base)
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
  if (parent?.type !== 'root') {
    return enterMode() === 'line' && left?.type === 'paragraph' && right?.type === 'paragraph' ? 0 : undefined
  }
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
  return baseGap(L, N)
}

export const lineGapRemark = $remark('amadeusLineGap', () =>
  function lineGap(this: any) {
    const data = this.data()
    const toMd = (data.toMarkdownExtensions ||= [])
    toMd.push({ join: [lineGapJoin] })
    return (tree: MdNode, file: MdNode): void => decodeRoot(tree, typeof file?.value === 'string' ? file.value : file?.value != null ? String(file.value) : null)
  },
)
