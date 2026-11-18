/** 整块颜色的「对谁上色」与「上色」(Notion 对齐 A1)。存法与读写在 blocks/markdown/blockColor.ts。
 *
 *  可上色:段落、标题、列表项、待办、引用(和 Notion 同);标注 / 折叠块等 A5 定存法;表格、代码、公式、图片不给。
 *  - 块菜单(把手选中一块)→ 那一块;选中整只列表 → 它的每一项(含嵌套项)。
 *  - 跨块选区(框选 / Shift 选多块)→ 选区盖到的每个顶层块按上一条展开;分栏行 / 列里往下找。
 *  - 斜杠 / 光标 → 光标所在的块:列表项或引用的第一段 = 那个容器,其余段 = 段落自己。
 *  一次上色 = 一个事务、一个撤销步。 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { NodeSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import { containerTakesColor, hasBlockColor, isCalloutQuote, normalizeBlockColor } from '../blocks/markdown/blockColor'
import { CALLOUT_COLOR_NAMES, readCalloutToken, withCalloutMeta, type CalloutMeta } from '../../../../shared/amadeus/calloutToken'

export type ColorChannel = 'bg' | 'fg'
export interface ColorTarget { pos: number; node: PMNode }

const TEXT = new Set(['paragraph', 'heading'])
const PASS_THROUGH = new Set(['amadeusColumnRow', 'amadeusColumnCell'])

/** 只有一张图(或图 + 空白)的段落 = 图片块:不给上色(图片用对齐和说明)。 */
function imageOnly(node: PMNode): boolean {
  let img = false, other = false
  node.forEach((c) => { if (c.type.name === 'image') img = true; else if (!(c.isText && !c.text?.trim())) other = true })
  return img && !other
}

function textTarget(node: PMNode): boolean {
  return TEXT.has(node.type.name) && !imageOnly(node)
}

/** 一个块(及其该展开的内部)里能上色的节点。 */
function collect(node: PMNode, pos: number, out: ColorTarget[]): void {
  const name = node.type.name
  if (textTarget(node)) { out.push({ pos, node }); return }
  if (name === 'list_item') {
    if (containerTakesColor(node)) out.push({ pos, node })
    // 子列表里的项也算(选中整只列表 / 跨块选区时一起上色)
    node.forEach((child, off) => { if (/_list$/.test(child.type.name)) collect(child, pos + 1 + off, out) })
    return
  }
  if (/_list$/.test(name)) { node.forEach((child, off) => collect(child, pos + 1 + off, out)); return }
  // 标注 / 折叠块(A5):底色写进令牌的元数据位 `[!tip|🚀 blue]`,没有字色
  if (name === 'blockquote') { if (isCalloutQuote(node) ? calloutTokenEditable(node) : containerTakesColor(node)) out.push({ pos, node }); return }
  if (PASS_THROUGH.has(name)) node.forEach((child, off) => collect(child, pos + 1 + off, out))
}

/** 块菜单 / 跨块选区的目标。range = blockLayer.topRangeOf(跨块选区),没有就看 NodeSelection。 */
export function colorTargetsOf(state: EditorState, range: { from: number; to: number } | null): ColorTarget[] {
  const out: ColorTarget[] = []
  if (range) {
    state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (PASS_THROUGH.has(node.type.name)) return true // 分栏行 / 列:往下找它们里面的块
      collect(node, pos, out)
      return false
    })
    return out
  }
  const sel = state.selection
  if (sel instanceof NodeSelection) collect(sel.node, sel.from, out)
  return out
}

/** 光标所在的块(斜杠命令用)。表格单元格、代码块、标注里的标题行 → 没有目标。 */
export function colorTargetAtCursor(state: EditorState): ColorTarget | null {
  const { $from } = state.selection
  const tb = $from.parent
  if (!textTarget(tb)) return null
  for (let d = $from.depth - 1; d >= 1; d--) {
    const n = $from.node(d)
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') return null
    if (n.type.name === 'list_item' || n.type.name === 'blockquote') {
      // 标注:标题行 = 整只标注(底色进元数据位,A5);正文里的段落 = 段落自己(下面 break 之后那一支)
      if (n.type.name === 'blockquote' && isCalloutQuote(n)) { if ($from.index(d) === 0) return calloutTokenEditable(n) ? { pos: $from.before(d), node: n } : null; break }
      // 容器的第一段 = 容器本身;其余段 = 段落自己
      if ($from.index(d) === 0) return containerTakesColor(n) ? { pos: $from.before(d), node: n } : null
      break
    }
  }
  return { pos: $from.before($from.depth), node: tb }
}

/** 标注的底色在令牌里(A5);别的块在 attr 里。 */
const isCallout = (n: PMNode): boolean => n.type.name === 'blockquote' && isCalloutQuote(n)

/** 令牌能不能按文字改:标题段从开头起、盖住整个令牌的必须全是文本节点。
 *  段首有 HTML 原子(A1 留着的 `<span data-amadeus-bg>`、手写的 span)时,textContent 的下标和文档位置对不上(原子占位置、不占字),
 *  照下标替换会删掉原子、把令牌尾巴留进标题(Codex 评审 A5 #1);Obsidian 也不认令牌前有东西的标注 —— 这种不改。 */
export function calloutTokenEditable(bq: PMNode): boolean {
  const first = bq.firstChild
  const t = first && first.isTextblock ? readCalloutToken(first.textContent) : null
  if (!first || !t) return false
  let covered = 0
  for (let i = 0; i < first.childCount && covered < t.token.length; i++) {
    const c = first.child(i)
    if (!c.isText) return false
    covered += c.text!.length
  }
  return covered >= t.token.length
}

/** 改标注令牌的元数据位(图标 / 底色),写进 tr。块颜色和换图标共用这一个写入口。改了返回 true。 */
export function setCalloutMeta(tr: Transaction, bqPos: number, patch: Partial<Pick<CalloutMeta, 'icon' | 'color'>>): boolean {
  const node = tr.doc.nodeAt(bqPos)
  if (!node || !isCallout(node) || !calloutTokenEditable(node)) return false
  const r = withCalloutMeta(node.firstChild!.textContent, patch)
  if (!r) return false
  tr.insertText(r.head, bqPos + 2 + r.from, bqPos + 2 + r.to)
  return true
}
function colorOf(t: ColorTarget, ch: ColorChannel): string {
  if (!isCallout(t.node)) return normalizeBlockColor(t.node.attrs[ch])
  return ch === 'bg' ? readCalloutToken(t.node.firstChild!.textContent)?.meta.color ?? '' : ''
}

/** 选中的全是标注:块菜单只给「背景」页、不给「更多颜色」(元数据位只存语义名)。 */
export const onlyCallouts = (targets: ColorTarget[]): boolean => targets.length > 0 && targets.every((t) => isCallout(t.node))

/** 这些目标当前的颜色:全一样 → 那个值,不一样 / 没有 → ''。 */
export function sharedColor(targets: ColorTarget[], ch: ColorChannel): string {
  const vals = new Set(targets.map((t) => colorOf(t, ch)))
  return vals.size === 1 ? [...vals][0] : ''
}

/** 上色(值 '' = 清除;只改 patch 里给了的那一路)。一个事务、单独一个撤销步;什么都没变返回 null。
 *  base:接着别的改动往下写(斜杠:删 `/查询` 和上色同一个事务);目标位置要在 base 里不变(都在被删的那段之前)。 */
export function blockColorTr(state: EditorState, targets: ColorTarget[], patch: Partial<Record<ColorChannel, string>>, base?: Transaction): Transaction | null {
  if (!targets.length) return null
  const next = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, normalizeBlockColor(v)])) as Partial<Record<ColorChannel, string>>
  let tr = base ?? closeHistory(state.tr)
  let changed = false
  // 从后往前改:标注改的是令牌文字(长度会变),先改后面的,前面目标的位置就不受影响(Codex 评审 A5 前置)
  for (const t of [...targets].sort((a, b) => b.pos - a.pos)) {
    const node = tr.doc.nodeAt(t.pos)
    if (!node || node.type !== t.node.type) continue
    if (isCallout(node)) {
      // 只有底色;值只收语义名(九色 + accent),「更多颜色」的 hex 对标注不生效
      if (!('bg' in next) || (next.bg && !(CALLOUT_COLOR_NAMES as readonly string[]).includes(next.bg))) continue
      if (setCalloutMeta(tr, t.pos, { color: next.bg })) changed = true
      // 引用先上过整块颜色、后来才写成标注:attr 上的颜色存不下(写盘时标注不写段首标记),一并清掉,显示和存盘一致
      if (hasBlockColor(node.attrs)) { tr = tr.setNodeMarkup(t.pos, undefined, { ...tr.doc.nodeAt(t.pos)!.attrs, bg: '', fg: '' }); changed = true }
      continue
    }
    const attrs = { ...node.attrs, ...next }
    if ((['bg', 'fg'] as const).every((k) => normalizeBlockColor(attrs[k]) === normalizeBlockColor(node.attrs[k]))) continue
    tr = tr.setNodeMarkup(t.pos, undefined, attrs)
    changed = true
  }
  return changed ? tr : null
}

/** 派发上色,并把撤销组封口:否则紧接着在这一段打的字会和上色并成一步,一次撤销连字带色一起没了(Codex 评审 #4)。 */
export function dispatchBlockColor(view: EditorView, tr: Transaction): void {
  view.dispatch(tr)
  view.dispatch(closeHistory(view.state.tr))
}
