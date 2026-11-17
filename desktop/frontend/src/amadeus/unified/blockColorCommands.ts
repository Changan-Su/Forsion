/** 整块颜色的「对谁上色」与「上色」(Notion 对齐 A1)。存法与读写在 blocks/markdown/blockColor.ts。
 *
 *  可上色:段落、标题、列表项、待办、引用(和 Notion 同);标注 / 折叠块等 A5 定存法;表格、代码、公式、图片不给。
 *  - 块菜单(把手选中一块)→ 那一块;选中整只列表 → 它的每一项(含嵌套项)。
 *  - 跨块选区(框选 / Shift 选多块)→ 选区盖到的每个顶层块按上一条展开;分栏行 / 列里往下找。
 *  - 斜杠 / 光标 → 光标所在的块:列表项或引用的第一段 = 那个容器,其余段 = 段落自己。
 *  一次上色 = 一个事务、一个撤销步。 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { NodeSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import { containerTakesColor, isCalloutQuote, normalizeBlockColor } from '../blocks/markdown/blockColor'

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
  if (name === 'blockquote') { if (!isCalloutQuote(node) && containerTakesColor(node)) out.push({ pos, node }); return }
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
      if (n.type.name === 'blockquote' && isCalloutQuote(n)) return null
      // 容器的第一段 = 容器本身;其余段 = 段落自己
      if ($from.index(d) === 0) return containerTakesColor(n) ? { pos: $from.before(d), node: n } : null
      break
    }
  }
  return { pos: $from.before($from.depth), node: tb }
}

/** 这些目标当前的颜色:全一样 → 那个值,不一样 / 没有 → ''。 */
export function sharedColor(targets: ColorTarget[], ch: ColorChannel): string {
  const vals = new Set(targets.map((t) => normalizeBlockColor(t.node.attrs[ch])))
  return vals.size === 1 ? [...vals][0] : ''
}

/** 上色(值 '' = 清除;只改 patch 里给了的那一路)。一个事务、单独一个撤销步;什么都没变返回 null。 */
export function blockColorTr(state: EditorState, targets: ColorTarget[], patch: Partial<Record<ColorChannel, string>>): Transaction | null {
  if (!targets.length) return null
  const next = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, normalizeBlockColor(v)])) as Partial<Record<ColorChannel, string>>
  let tr = closeHistory(state.tr)
  let changed = false
  for (const t of targets) {
    const node = tr.doc.nodeAt(t.pos)
    if (!node || node.type !== t.node.type) continue
    const attrs = { ...node.attrs, ...next }
    if ((['bg', 'fg'] as const).every((k) => normalizeBlockColor(attrs[k]) === normalizeBlockColor(node.attrs[k]))) continue
    tr = tr.setNodeMarkup(t.pos, undefined, attrs)
    changed = true
  }
  return changed ? tr : null
}
