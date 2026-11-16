// Bold delimiters `**` / `__` as real text characters (behind the hidden switch in ./literalBoldFlag).
// Same model as `==highlight==` (./obsidianInline): the characters live in the document, decorations do the display.
// 加粗的 `**` / `__` 是正文里的真字符(隐藏开关,见 ./literalBoldFlag)。与 `==高亮==` 同一套:字在文档里,显示靠装饰。
//
//  · Read:  ./literalBoldRead turns every mdast `strong` back into `text(open) …children text(close)`.
//           读:见 ./literalBoldRead(strong 还原成定界符文字)。
//  · Save:  ./textSafe writes `*` / `_` in text as-is (only a line-start list bullet / thematic break is escaped).
//           存:见 ./textSafe(正文 `*` `_` 原样写,只有行首会变列表 / 分隔线的照旧转义)。
//  · Show:  scanLiteralBold() runs the CommonMark delimiter algorithm (with the same CJK-friendly flanking rules as the
//           parser) over one text block; selection away -> delimiters hidden, inner text bold; selection touching
//           (both outer edges count) -> delimiters shown. The decoration set is mapped through each transaction and
//           only the touched text blocks are rescanned; during IME composition nothing is recomputed.
//           显示:按解析器同一套定界符规则扫单个文本块;装饰随事务映射,只重扫改到的块;输入法组字中不重算。
//  · Input: Mod-b / the toolbar's B wrap or unwrap the selection with `**` (empty selection: `****`, caret in the middle);
//           the `**x**` -> strong input rule is off (./anchoredMarkRules).
//           输入:⌘B / 工具条 B 在选区两边加或去 `**`;「`**x**` 变加粗属性」的输入规则关掉。
//  · Clipboard: copy puts <strong> in text/html (text/plain keeps the stars); pasted <b> / <strong> become `**` text.
//           剪贴板:复制时网页格式带 <strong>、纯文本留星号;粘贴进来的 <b>/<strong> 变成 `**` 文字。
// The plugin is only installed when the switch is on (MarkdownBlock), so with it off nothing here runs.
// 插件只在开关开着时装上;关着时这里的代码一行都不跑(读 / 存两半各自先查开关)。
// Instruments: literalBold.test.ts (every exit's round trip), literalBoldScan.test.ts (scanner vs parser, random),
// npm run check:litbold (real browser).
import { $prose } from '@milkdown/kit/utils'
import { schemaCtx } from '@milkdown/kit/core'
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Selection, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { DOMSerializer, Fragment, Slice, type Mark, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model'
import {
  classifyCharacter, classifyPrecedingCharacter, isCjk, isCjkOrIvs, isNonCjkPunctuation, isSpaceOrPunctuation,
  isUnicodeWhitespace,
} from 'micromark-extension-cjk-friendly-util'
import { buildBlockString, scanMath } from './mathLivePreview'
import { editorFocusKey, editorFocused } from './editorFocus'

// ── scan ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface BoldSpan { from: number; to: number; delim: '**' | '__' }

/** One text block, 1:1 with its content positions. 一个文本块的扫描输入,下标 = 块内偏移。 */
export interface ScanInput {
  /** text; inline atoms are U+FFFC, line breaks `\n`. 文字;行内原子 U+FFFC、换行 `\n`。 */
  text: string
  /** 1 = this `*` / `_` may be part of a delimiter run (not code / escaped / math / bare URL).
   *  1 = 这个 `*` `_` 能当定界符(不在代码、转义、公式、裸链接里)。 */
  lit: Uint8Array
  /** 0 = the block; k > 0 = the k-th link text (CommonMark resolves emphasis inside a link label on its own).
   *  0 = 本块;k > 0 = 第 k 段链接文字(链接文字里的强调单独配对)。 */
  scope: Int32Array
  /** Source characters a mark edge leaves at boundary i (between i-1 and i): `[` `](…)` for links, `` ` `` for code,
   *  `<…>` for HTML marks, `\` before an escape, `*` / `~~` for italic / strikethrough. 边界 i 处 mark 在原文里留下的字。 */
  edge: string[]
}

const STAR = 42
const UNDER = 95
const TILDE = 126
/** micromark's attentionMarkers with GFM strikethrough. micromark 的 attentionMarkers(加上删除线的 `~`)。 */
const MARKERS = new Set([STAR, UNDER, TILDE])

function isAutolink(text: string, href: unknown): boolean {
  if (typeof href !== 'string') return false
  return href === text || href === `http://${text}` || href === `mailto:${text}`
}

/** [opening, closing] source delimiters of a mark. mark 在原文里两端的定界符。 */
function markDelims(m: Mark, text: string): [string, string] {
  const name = m.type.name
  if (name === 'emphasis') return ['*', '*'] // the serializer always writes `*` (./attentionFlanking)
  if (name === 'strong') return ['**', '**']
  if (name === 'strike_through') return ['~~', '~~']
  if (m.type.spec.code || name === 'inlineCode') return ['`', '`']
  if (name === 'link') return isAutolink(text, m.attrs.href) ? ['', ''] : ['[', '](x)']
  if (name === 'amadeusEscaped') return ['\\', '']
  if (name.startsWith('amadeus')) return ['<x>', '</x>'] // underline / colour / kbd / sub / sup are HTML tags
  return ['', '']
}

/** Build the scan input of one text block. 一个文本块 → 扫描输入。 */
export function scanInput(block: PMNode): ScanInput {
  let text = ''
  const kids: { from: number; to: number; marks: readonly Mark[]; text: string }[] = []
  block.forEach((child, offset) => {
    if (child.isText) text += child.text ?? ''
    else text += child.type.name === 'hardbreak' || child.type.name === 'hard_break' || child.type.name === 'break' ? '\n' : '￼'.repeat(child.nodeSize)
    kids.push({ from: offset, to: offset + child.nodeSize, marks: child.marks, text: child.isText ? child.text ?? '' : '' })
  })
  const n = text.length
  const lit = new Uint8Array(n)
  const scope = new Int32Array(n)
  const edge: string[] = new Array(n + 1).fill('')
  const math = text.includes('$') ? scanMath(buildBlockString(block)) : []
  let scopeId = 0
  let prevLink: Mark | null = null
  let prevMarks: readonly Mark[] = []
  let prevText = ''
  for (const k of kids) {
    const link = k.marks.find((m) => m.type.name === 'link') ?? null
    const auto = link ? isAutolink(k.text, link.attrs.href) : false
    if (link && !auto && !(prevLink && prevLink.eq(link))) scopeId++
    const sc = link && !auto ? scopeId : 0
    prevLink = link && !auto ? link : null
    const opaque = k.marks.some((m) => m.type.spec.code || m.type.name === 'inlineCode' || m.type.name === 'amadeusEscaped') || auto
    for (let i = k.from; i < k.to; i++) {
      scope[i] = sc
      const c = text.charCodeAt(i)
      if (!opaque && (c === STAR || c === UNDER)) lit[i] = 1
    }
    // boundary at k.from: marks closing (left only), then marks opening (right only)
    const closing = prevMarks.filter((m) => !m.isInSet(k.marks)).reverse()
    const opening = k.marks.filter((m) => !m.isInSet(prevMarks))
    edge[k.from] = closing.map((m) => markDelims(m, prevText)[1]).join('') + opening.map((m) => markDelims(m, k.text)[0]).join('')
    prevMarks = k.marks
    prevText = k.text
  }
  edge[n] = [...prevMarks].reverse().map((m) => markDelims(m, prevText)[1]).join('')
  for (const m of math) for (let i = m.from; i < m.to && i < n; i++) lit[i] = 0
  return { text, lit, scope, edge }
}

interface Run { start: number; end: number; ch: number; open: boolean; close: boolean; dead: boolean }

/** Code point just before i (surrogate pairs joined); null at the start. i 前一个码点。 */
function codeBefore(s: string, i: number): number | null {
  if (i <= 0) return null
  const lo = s.charCodeAt(i - 1)
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2)
    if (hi >= 0xd800 && hi <= 0xdbff) return s.codePointAt(i - 2) ?? lo
  }
  return lo
}
const codeAt = (s: string, i: number): number | null => (i < s.length ? s.codePointAt(i) ?? null : null)

/** Open / close flags of a run, the same rules as micromark-extension-cjk-friendly's attention tokenizer.
 *  一串定界符能开 / 能合,与解析器(CJK 友好版 attention)同一套判据。 */
function flank(inp: ScanInput, start: number, end: number, ch: number): { open: boolean; close: boolean } {
  const { text, edge } = inp
  const eb = edge[start]
  const previous = eb ? eb.charCodeAt(eb.length - 1) : codeBefore(text, start)
  const ea = edge[end]
  const next = ea ? ea.charCodeAt(0) : codeAt(text, end)
  const before = classifyCharacter(previous)
  const twoBefore = (): number | null => {
    if (eb || previous == null) return null
    return codeBefore(text, start - (previous > 0xffff ? 2 : 1))
  }
  const beforePrimary = classifyPrecedingCharacter(before, twoBefore, previous)
  const after = classifyCharacter(next)
  const beforeNonCjkPunctuation = isNonCjkPunctuation(beforePrimary)
  const beforeSpaceOrNonCjkPunctuation = beforeNonCjkPunctuation || isUnicodeWhitespace(beforePrimary)
  const afterNonCjkPunctuation = isNonCjkPunctuation(after)
  const afterSpaceOrNonCjkPunctuation = afterNonCjkPunctuation || isUnicodeWhitespace(after)
  const beforeCjkOrIvs = isCjkOrIvs(beforePrimary)
  const open = !afterSpaceOrNonCjkPunctuation || (afterNonCjkPunctuation && (beforeSpaceOrNonCjkPunctuation || beforeCjkOrIvs)) ||
    (next != null && MARKERS.has(next))
  const close = !beforeSpaceOrNonCjkPunctuation || (beforeNonCjkPunctuation && (afterSpaceOrNonCjkPunctuation || isCjk(after))) ||
    (previous != null && MARKERS.has(previous))
  return {
    open: ch === STAR ? open : open && (isSpaceOrPunctuation(beforePrimary) || !close),
    close: ch === STAR ? close : close && (isSpaceOrPunctuation(after) || !open),
  }
}

/** Strong spans of one text block (offsets include the delimiters; nested ones are listed too).
 *  一个文本块里的加粗区间(含定界符;嵌套的也列出)。 */
export function scanLiteralBold(inp: ScanInput): BoldSpan[] {
  const { text, lit, scope, edge } = inp
  if (text.indexOf('**') === -1 && text.indexOf('__') === -1) return []
  const byScope = new Map<number, Run[]>()
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i)
    if (!lit[i]) { i++; continue }
    let j = i + 1
    while (j < text.length && lit[j] && text.charCodeAt(j) === c && scope[j] === scope[i] && !edge[j]) j++
    const f = flank(inp, i, j, c)
    const list = byScope.get(scope[i]) ?? []
    list.push({ start: i, end: j, ch: c, open: f.open, close: f.close, dead: false })
    byScope.set(scope[i], list)
    i = j
  }
  const out: BoldSpan[] = []
  for (const runs of byScope.values()) resolve(runs, text, out)
  return out.sort((a, b) => a.from - b.from || b.to - a.to)
}

/** micromark's resolveAllAttention on runs (rule of three included). 照 micromark 的配对算法(含「三的倍数」规则)。 */
function resolve(runs: Run[], text: string, out: BoldSpan[]): void {
  for (let c = 0; c < runs.length; c++) {
    const closer = runs[c]
    if (!closer.close) continue
    while (closer.end > closer.start) {
      let hit = -1
      for (let o = c - 1; o >= 0; o--) {
        const opener = runs[o]
        if (opener.dead || !opener.open || opener.end === opener.start || opener.ch !== closer.ch) continue
        const cl = closer.end - closer.start
        const ol = opener.end - opener.start
        if ((opener.close || closer.open) && cl % 3 && !((ol + cl) % 3)) continue
        hit = o
        break
      }
      if (hit === -1) break
      const opener = runs[hit]
      const use = opener.end - opener.start > 1 && closer.end - closer.start > 1 ? 2 : 1
      if (use === 2) out.push({ from: opener.end - 2, to: closer.start + 2, delim: text.slice(opener.end - 2, opener.end) as '**' | '__' })
      opener.end -= use
      closer.start += use
      for (let k = hit + 1; k < c; k++) runs[k].dead = true
    }
  }
}

/** Spans of a PM text block. PM 文本块的加粗区间。 */
export const boldSpans = (block: PMNode): BoldSpan[] =>
  block.textContent.indexOf('**') === -1 && block.textContent.indexOf('__') === -1 ? [] : scanLiteralBold(scanInput(block))

// ── show ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface LBState { deco: DecorationSet; pending: Array<[number, number]> }
export const literalBoldKey = new PluginKey<LBState>('amadeus-literal-bold')

let scanCount = 0
/** Tests: text blocks the display has scanned so far (the incremental check). 测试用:显示层累计扫过的文本块数。 */
export const literalScanCount = (): number => scanCount

function blockDecos(node: PMNode, pos: number, sel: Selection, focus: boolean): Decoration[] {
  scanCount++
  const spans = boldSpans(node)
  if (!spans.length) return []
  const cs = pos + 1
  const { from: selFrom, to: selTo } = sel
  const out: Decoration[] = []
  for (const sp of spans) {
    const from = cs + sp.from
    const to = cs + sp.to
    const cls = focus && selFrom <= to && selTo >= from ? 'amx-obs-delim' : 'amx-obs-hidden'
    out.push(
      Decoration.inline(from, from + 2, { class: cls }),
      // inclusive: text typed at either inner edge during composition stays bold until the rescan
      Decoration.inline(from + 2, to - 2, { class: 'amx-lit-bold' }, { inclusiveStart: true, inclusiveEnd: true }),
      Decoration.inline(to - 2, to, { class: cls }),
    )
  }
  return out
}

/** All decorations of a document (initial state, tests). 整篇装饰(初始状态 / 测试)。 */
export function buildLiteralBoldDecorations(state: EditorState, focus = editorFocused(state)): DecorationSet {
  const decos: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (!node.type.spec.code) decos.push(...blockDecos(node, pos, state.selection, focus))
    return false
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

/** Ranges (new-doc positions) a transaction changed. 事务改动的区间(新文档坐标)。 */
function changedRanges(tr: Transaction): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const maps = tr.mapping.maps
  maps.forEach((map, i) => {
    map.forEach((_oa, _ob, nf, nt) => {
      let a = nf
      let b = nt
      for (let k = i + 1; k < maps.length; k++) {
        a = maps[k].map(a, -1)
        b = maps[k].map(b, 1)
      }
      out.push([a, b])
    })
  })
  return out
}

/** Rescan the text blocks touching `ranges`; everything else keeps its (mapped) decorations.
 *  只重扫碰到这些区间的文本块。 */
function rescan(deco: DecorationSet, state: EditorState, focus: boolean, ranges: Array<[number, number]>): DecorationSet {
  const doc = state.doc
  const size = doc.content.size
  const blocks = new Map<number, PMNode>()
  for (const [a0, b0] of ranges) {
    const a = Math.max(0, Math.min(a0, b0) - 1)
    const b = Math.min(size, Math.max(a0, b0) + 1)
    doc.nodesBetween(a, b, (node, pos) => {
      if (node.isTextblock) {
        blocks.set(pos, node)
        return false
      }
      return true
    })
  }
  if (!blocks.size) return deco
  let next = deco
  const add: Decoration[] = []
  for (const [pos, node] of blocks) {
    const old = next.find(pos + 1, pos + 1 + node.content.size)
    if (old.length) next = next.remove(old)
    if (!node.type.spec.code) add.push(...blockDecos(node, pos, state.selection, focus))
  }
  return add.length ? next.add(doc, add) : next
}

// ── input ────────────────────────────────────────────────────────────────────────────────────────────────────
/** The bold span holding [from, to] in one text block, with the block's content start. 选区所在的加粗区间。 */
export function literalBoldAt(state: EditorState, from: number, to: number): { cs: number; sp: BoldSpan } | null {
  const $from = state.doc.resolve(from)
  if (!$from.parent.isTextblock || $from.parent.type.spec.code || !$from.sameParent(state.doc.resolve(to))) return null
  const cs = $from.start()
  let best: BoldSpan | null = null
  for (const sp of boldSpans($from.parent)) {
    if (cs + sp.from <= from && to <= cs + sp.to && (!best || sp.to - sp.from < best.to - best.from)) best = sp
  }
  return best ? { cs, sp: best } : null
}

/** Marks a delimiter inserted at `pos` should carry: the ones on both neighbours (inside italic stays italic,
 *  at a link edge it stays outside the link). 插在 pos 的定界符带哪些 mark:两边都有的那些。 */
function sharedMarks(doc: PMNode, pos: number): readonly Mark[] {
  const $p = doc.resolve(pos)
  const before = $p.nodeBefore?.marks ?? []
  const after = $p.nodeAfter?.marks ?? []
  return before.filter((m) => m.isInSet(after) && m.type.name !== 'amadeusEscaped')
}

/** Wrap [from, to] of `tr.doc` with literal delimiters; the selection stays on the text. 用字面定界符包住 [from, to]。 */
export function wrapLiteral(tr: Transaction, from: number, to: number, delim: string): Transaction {
  const schema = tr.doc.type.schema
  const atTo = sharedMarks(tr.doc, to)
  const atFrom = sharedMarks(tr.doc, from)
  tr.insert(to, schema.text(delim, atTo))
  tr.insert(from, schema.text(delim, atFrom))
  return tr.setSelection(TextSelection.create(tr.doc, from + delim.length, to + delim.length))
}

/** Mod-b / toolbar B with the switch on: wrap or unwrap the selection with `**`; empty selection -> `****`.
 *  ⌘B / 工具条 B(开关开着):选区两边加 / 去 `**`;没选区插 `****`、光标居中。 */
export const toggleLiteralBold: Command = (state, dispatch) => {
  const { $from, $to, from, to, empty } = state.selection
  // Across blocks or in code: do nothing, and do not fall through to the strong-mark command either.
  // 跨块 / 代码里:不动,也不交给加粗属性命令。
  if (!$from.sameParent($to) || !$from.parent.isTextblock || $from.parent.type.spec.code) return true
  const code = state.schema.marks.inlineCode ?? state.schema.marks.code
  const inCode = empty ? $from.marks().some((m) => m.type.spec.code) : !!code && state.doc.rangeHasMark(from, to, code)
  if (inCode) return true
  const hit = literalBoldAt(state, from, to)
  if (hit) {
    const a = hit.cs + hit.sp.from
    const b = hit.cs + hit.sp.to
    const tr = state.tr.delete(b - 2, b).delete(a, a + 2)
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(from), tr.mapping.map(to)))
    dispatch?.(tr.scrollIntoView())
    return true
  }
  if (empty) {
    const tr = state.tr.insert(from, state.schema.text('****', sharedMarks(state.doc, from)))
    tr.setSelection(TextSelection.create(tr.doc, from + 2))
    dispatch?.(tr.scrollIntoView())
    return true
  }
  // Whitespace at the edges stays outside: `** x**` is not bold. 首尾空白让到外面。
  const text = state.doc.textBetween(from, to, '\n', '￼')
  const a = from + (text.length - text.trimStart().length)
  const b = to - (text.length - text.trimEnd().length)
  if (b <= a) return true
  dispatch?.(wrapLiteral(state.tr, a, b, '**').scrollIntoView())
  return true
}

// ── clipboard ────────────────────────────────────────────────────────────────────────────────────────────────
/** Copy: literal `**x**` -> strong mark for the text/html flavour only. 复制:只给网页格式把 `**x**` 换成 <strong>。 */
export function literalToMarks(frag: Fragment, schema: Schema): Fragment {
  const strong = schema.marks.strong
  if (!strong) return frag
  const out: PMNode[] = []
  frag.forEach((node) => {
    if (!node.isTextblock) {
      out.push(node.isLeaf ? node : node.copy(literalToMarks(node.content, schema)))
      return
    }
    if (node.type.spec.code) {
      out.push(node)
      return
    }
    const spans = boldSpans(node)
    if (!spans.length) {
      out.push(node)
      return
    }
    const delim = new Uint8Array(node.content.size)
    const depth = new Int32Array(node.content.size + 1)
    for (const sp of spans) {
      delim[sp.from] = delim[sp.from + 1] = delim[sp.to - 2] = delim[sp.to - 1] = 1
      depth[sp.from + 2]++
      depth[sp.to - 2]--
    }
    for (let i = 1; i < depth.length; i++) depth[i] += depth[i - 1]
    const kids: PMNode[] = []
    node.forEach((child, offset) => {
      if (!child.isText) {
        kids.push(depth[offset] > 0 ? child.mark(strong.create().addToSet(child.marks)) : child)
        return
      }
      const t = child.text ?? ''
      let i = 0
      while (i < t.length) {
        const at = offset + i
        let j = i + 1
        while (j < t.length && delim[offset + j] === delim[at] && (depth[offset + j] > 0) === (depth[at] > 0)) j++
        if (!delim[at]) kids.push(schema.text(t.slice(i, j), depth[at] > 0 ? strong.create().addToSet(child.marks) : child.marks))
        i = j
      }
    })
    out.push(node.copy(Fragment.fromArray(kids)))
  })
  return Fragment.fromArray(out)
}

/** Paste / drop: strong marks (HTML <b> / <strong>, our own copies) -> literal `**`, so the document stays mark-free.
 *  粘贴 / 拖入:加粗属性换成字面 `**`。 */
export function marksToLiteral(frag: Fragment, schema: Schema): Fragment {
  const out: PMNode[] = []
  frag.forEach((node) => {
    if (!node.isTextblock) {
      out.push(node.isLeaf ? node : node.copy(marksToLiteral(node.content, schema)))
      return
    }
    if (node.type.spec.code || !node.content.size) {
      out.push(node)
      return
    }
    let any = false
    node.forEach((c) => { if (c.marks.some((m) => m.type.name === 'strong')) any = true })
    if (!any) {
      out.push(node)
      return
    }
    const kids: PMNode[] = []
    let open: string | null = null
    let lastMarks: readonly Mark[] = []
    node.forEach((child) => {
      const sm = child.marks.find((m) => m.type.name === 'strong')
      const rest = sm ? sm.removeFromSet(child.marks) : child.marks
      if (sm && !open) {
        open = sm.attrs.marker === '_' ? '__' : '**'
        kids.push(schema.text(open, rest.filter((m) => m.isInSet(lastMarks))))
      } else if (!sm && open) {
        kids.push(schema.text(open, lastMarks.filter((m) => m.isInSet(rest))))
        open = null
      }
      kids.push(child.isText ? schema.text(child.text ?? '', rest) : child.mark(rest))
      lastMarks = rest
    })
    if (open) kids.push(schema.text(open, []))
    out.push(node.copy(Fragment.fromArray(kids)))
  })
  return Fragment.fromArray(out)
}

export const literalPaste = (slice: Slice, schema: Schema): Slice =>
  new Slice(marksToLiteral(slice.content, schema), slice.openStart, slice.openEnd)

function literalClipboardSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema)
  const ser = Object.create(base) as DOMSerializer
  ser.serializeFragment = (frag, options, target) => base.serializeFragment(literalToMarks(frag, schema), options, target)
  return ser
}

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

/** The editor plugin. Install only with the switch on (MarkdownBlock does), before the presets' keymaps.
 *  编辑器插件。只在开关开着时装,且排在 preset 的键位之前。 */
export function literalBoldPlugin() {
  return $prose((ctx) => {
    const schema = ctx.get(schemaCtx)
    const clip = literalClipboardSerializer(schema)
    let view: EditorView | null = null
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    return new Plugin<LBState>({
      key: literalBoldKey,
      state: {
        init: (_config, state) => ({ deco: buildLiteralBoldDecorations(state), pending: [] }),
        apply: (tr, prev, oldState, newState) => {
          // ⚠️ Not editorFocused(newState): this plugin is registered before editorFocusPlugin (Mod-b must beat the
          // presets' keymaps), and a plugin's apply only sees the fields of the plugins before it. Same rule as that plugin.
          // 别读 editorFocused(newState):本插件排在 editorFocusPlugin 前面,apply 时新状态里还没有它的字段;照它的规则自己算。
          const m = tr.getMeta(editorFocusKey) as boolean | undefined
          const focus = typeof m === 'boolean' ? m : editorFocused(oldState)
          const focusChanged = focus !== editorFocused(oldState)
          const selChanged = !oldState.selection.eq(newState.selection)
          const flush = tr.getMeta(literalBoldKey) === 'flush'
          if (!tr.docChanged && !selChanged && !focusChanged && !flush) return prev
          const deco = tr.docChanged ? prev.deco.map(tr.mapping, tr.doc) : prev.deco
          const pending: Array<[number, number]> = tr.docChanged
            ? prev.pending.map(([a, b]) => [tr.mapping.map(a, -1), tr.mapping.map(b, 1)])
            : prev.pending.slice()
          if (tr.docChanged) pending.push(...changedRanges(tr))
          const o = oldState.selection
          pending.push([tr.mapping.map(o.from, -1), tr.mapping.map(o.to, 1)], [newState.selection.from, newState.selection.to])
          // IME composition: keep the decorations exactly as they were (mapped) until the text is committed —
          // restyling the text node being composed makes the browser show half the delimiters.
          // 组字中不重算(只映射):改正在组字的那段文字的样式,浏览器会露出半边定界符。
          if (view?.composing) return { deco, pending }
          return { deco: rescan(deco, newState, focus, pending), pending: [] }
        },
      },
      view: (v) => {
        view = v
        return {
          destroy: () => {
            view = null
            if (flushTimer) clearTimeout(flushTimer)
          },
        }
      },
      props: {
        decorations: (state) => literalBoldKey.getState(state)?.deco ?? DecorationSet.empty,
        attributes: { 'data-literal-bold': '1' }, // checks assert the switch is really on 台架据此断言开关开着
        clipboardSerializer: clip,
        transformPasted: (slice, v) => literalPaste(slice, v.state.schema),
        handleKeyDown: (v, e) => {
          const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
          if (!mod || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b' || !v.editable) return false
          return toggleLiteralBold(v.state, v.dispatch)
        },
        handleDOMEvents: {
          // After a composition the commit transaction normally rescans; this covers one that ends with no change.
          // 组字结束一般会跟一笔提交事务顺带重扫;这里兜「结束了但没改字」的情形。
          compositionend: (v) => {
            if (flushTimer) clearTimeout(flushTimer)
            flushTimer = setTimeout(() => {
              flushTimer = null
              if (v.isDestroyed || v.composing || !literalBoldKey.getState(v.state)?.pending.length) return
              v.dispatch(v.state.tr.setMeta(literalBoldKey, 'flush').setMeta('addToHistory', false))
            }, 40)
            return false
          },
        },
      },
    })
  })
}
