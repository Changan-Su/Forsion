// 锚标记段:独占一段的 `<!-- a id -->`(取消分栏 / 收回画布卡 / 多锚的栏留下的惰性锚,见 columns.ts「锚永不回收」)。
// 落盘必须原样留着 —— 既有的 `![[笔记#id]]` 靠它找到「紧随其后的那一块」;但在编辑器里它只是一行看不懂的注释,
// 这里把它收起来(和标题折叠的 amx-fold-hidden 同一个做法:节点装饰挂类,CSS display:none)。
//
// 收起之后要守住一条不变式:**看不见的段落永远不收字,落盘那一行永远是 `<!-- a id -->`**。
//   · 键盘那一半(退格 / Delete 跨过锚标记去并真正的上一块 / 下一块)在 keyboard.ts:bsOverAnchorMarks / deleteOverAnchorMarks;
//   · 这里兜其余所有路径(粘贴、输入法、别的命令、程序化的选区):原本独占一段的锚标记被并进了文字 → 按原顺序拆回独占一段;
//     被跨块删除一并删掉、但它指着的那块还剩字 → 插回那块前面;光标 / 块选中落在锚标记段上 → 挪到最近一处看得见的文字。
// 方向键、点击、回车、粘贴本来就会跳过 display:none 的段落(探针 2026-11-18,仓根方案目录 instrument/probe-anchor-marks.cjs)。
import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { Mapping } from '@milkdown/kit/prose/transform'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { BLOCK_MARKER_RE } from '../../../../shared/amadeus/compiler/markers'

/** 这个 html 节点是不是一枚锚标记(值恰好是 `<!-- a id -->`)。 */
export function isAnchorMarkHtml(n: ProseNode | null | undefined): boolean {
  return !!n && n.type.name === 'html' && BLOCK_MARKER_RE.test(String(n.attrs.value ?? '').trim())
}

/** 锚标记段 = 只装着一枚锚标记的段落(columns.ts 的 anchorMarkers 造出来的就是这形态)。 */
export function isAnchorMarkPara(n: ProseNode | null | undefined): boolean {
  return !!n && n.type.name === 'paragraph' && n.childCount === 1 && isAnchorMarkHtml(n.firstChild)
}

export const ANCHOR_MARK_CLASS = 'amx-anchor-mark'

function markDecos(doc: ProseNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (isAnchorMarkPara(node)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: ANCHOR_MARK_CLASS }))
    return false
  })
  return DecorationSet.create(doc, decos)
}

/** 锚标记的 id;不是锚标记 → null。 */
function markIdOf(n: ProseNode | null | undefined): string | null {
  if (!n || n.type.name !== 'html') return null
  const m = BLOCK_MARKER_RE.exec(String(n.attrs.value ?? '').trim())
  return m ? m[1] : null
}

/** 旧文档里的一枚独占一段的锚标记:html 节点位置、所在段落、父容器深度、它指着的那一块(下一个非锚标记兄弟)最后一处文字的位置。 */
type Site = { h: number; para: ProseNode; id: string; depth: number; targetEnd: number | null }
function pureMarkSites(doc: ProseNode): Site[] {
  const out: Site[] = []
  doc.descendants((node, pos, parent, index) => {
    if (!node.isTextblock) return true
    if (!isAnchorMarkPara(node)) return false
    let targetEnd: number | null = null
    if (parent) {
      let p = pos + node.nodeSize
      for (let k = index + 1; k < parent.childCount; k++) {
        const c = parent.child(k)
        if (!isAnchorMarkPara(c)) {
          const last = Selection.findFrom(doc.resolve(p + c.nodeSize), -1, true)
          if (last && last.head > p) targetEnd = last.head
          break
        }
        p += c.nodeSize
      }
    }
    out.push({ h: pos + 1, para: node, id: markIdOf(node.firstChild)!, depth: doc.resolve(pos).depth, targetEnd })
    return false
  })
  return out
}

/** 把混进文字的那一枚锚标记(h = 它的位置)拆回独占一段:[字, 标记, 字] → 字 | 标记 | 字,顺序不变,
 *  前后的字保持原来的块类型(标题仍是标题);只动这一枚,同段里别的行内注释不碰(Codex 评审)。
 *  用 split 不整段重建:光标跟着各自那一段走(整段替换会把光标映射到下一段去,Codex 评审)。 */
function splitOut(tr: Transaction, h: number): Transaction {
  const $h = tr.doc.resolve(h)
  const atom = tr.doc.nodeAt(h)
  const paragraph = $h.parent.type.schema.nodes.paragraph
  if (!atom || !paragraph) return tr
  try {
    if (h + atom.nodeSize < $h.end()) tr.split(h + atom.nodeSize)
    if (h > $h.start()) tr.split(h, 1, [{ type: paragraph }])
    else if ($h.parent.type !== paragraph) tr.setNodeMarkup($h.before(), paragraph)
  } catch {
    // 拆不了(结构不允许)就留着:落盘照旧,只是这一枚锚可能失效 —— 不为它抛错打断用户这一下
  }
  return tr
}

/** 从锚标记段出发朝 dir 找最近一处看得见的文字位置(连着几枚锚标记段一并跳过);这头没有就找另一头,都没有 → null。 */
function escapeFrom(doc: ProseNode, pos: number, dir: 1 | -1): Selection | null {
  for (const d of [dir, -dir] as const) {
    let $at = doc.resolve(pos)
    while (isAnchorMarkPara($at.parent)) {
      const next = Selection.findFrom(doc.resolve(d > 0 ? $at.after() : $at.before()), d, true)
      if (!next) break
      if (!isAnchorMarkPara(next.$head.parent)) return next
      $at = next.$head
    }
  }
  return null
}

/** 用户这一下编辑(粘贴、输入法、命令…);撤销重做是回放、外部回灌是权威内容,都不改写。 */
const userEdit = (t: Transaction): boolean => t.docChanged && !t.getMeta('history$') && t.getMeta('addToHistory') !== false

/** 用户这一下编辑之后的修复:① 原本独占一段、现在混进了文字的锚标记拆回独占一段;② 被一并删掉、但它指着的那一块
 *  还剩着字的锚标记(跨块选中删除 / 剪切,Codex 评审),插回那块字最后落进的那一块前面 —— 文档里别处还有同号的
 *  (拖走、剪切粘贴挪了地方)就不补。 */
function repair(tr: Transaction, trs: readonly Transaction[], old: EditorState, state: EditorState): Transaction {
  const sites = pureMarkSites(old.doc)
  if (!sites.length) return tr
  const mapping = new Mapping()
  for (const t of trs) mapping.appendMapping(t.mapping)
  const live = new Set<string>()
  state.doc.descendants((n) => {
    if (!n.isTextblock) return true
    n.forEach((c) => { const id = markIdOf(c); if (id) live.add(id) })
    return false
  })
  const mixed: number[] = []
  const lost: Array<{ site: Site; at: number }> = []
  for (const s of sites) {
    const r = mapping.mapResult(s.h, 1)
    if (!r.deleted && markIdOf(state.doc.nodeAt(r.pos)) === s.id) {
      const parent = state.doc.resolve(r.pos).parent
      if (!isAnchorMarkPara(parent) && parent.isTextblock && parent.type.name !== 'code_block') mixed.push(r.pos)
      continue
    }
    if (live.has(s.id) || s.targetEnd == null) continue
    const t = mapping.mapResult(s.targetEnd, -1)
    if (!t.deleted) lost.push({ site: s, at: t.pos })
  }
  for (const h of mixed.sort((a, b) => b - a)) tr = splitOut(tr, h)
  // 按原文序逐枚插回:同一块前面的几枚,先插的在前
  for (const { site, at } of lost.sort((a, b) => a.site.h - b.site.h)) {
    const pos = tr.mapping.map(at, -1)
    const $a = tr.doc.resolve(pos)
    try {
      tr.insert($a.depth > site.depth ? $a.before(site.depth + 1) : pos, site.para)
    } catch {
      // 插不进(那一处已不是能放段落的容器)就算了
    }
  }
  return tr
}

export const anchorMarksPlugin = $prose(() => {
  const key = new PluginKey<DecorationSet>('AMX_ANCHOR_MARKS')
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_c, state) => markDecos(state.doc),
      apply: (tr, prev) => (tr.docChanged ? markDecos(tr.doc) : prev),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
    appendTransaction: (trs, old, state) => {
      if (!trs.some((t) => t.docChanged || t.selectionSet)) return null
      let tr = state.tr
      if (trs.some(userEdit)) tr = repair(tr, trs, old, state)
      // 选区头落在锚标记段上 → 挪到看得见的文字。在标记前(段内偏移 0)= 属于上一块的末尾,往回挪;在标记后 = 下一块的开头,往前挪。
      // 有范围的选区只挪头,锚点留着(Codex 评审)。
      const sel = tr.selection
      if (sel instanceof NodeSelection) {
        if (isAnchorMarkPara(sel.node) || (isAnchorMarkHtml(sel.node) && isAnchorMarkPara(sel.$from.parent))) {
          const target = escapeFrom(tr.doc, sel.from + 1, state.selection.head < old.selection.head ? -1 : 1)
          if (target) tr.setSelection(target)
        }
      } else if (isAnchorMarkPara(sel.$head.parent)) {
        const target = escapeFrom(tr.doc, sel.head, sel.$head.parentOffset === 0 ? -1 : 1)
        if (target) tr.setSelection(sel.empty ? target : TextSelection.create(tr.doc, sel.anchor, target.head))
      }
      return tr.docChanged || tr.selectionSet ? tr : null
    },
  })
})

/** 仪器 / 单测用:这份状态里看不见的锚标记段一共几枚。 */
export function anchorMarkCount(state: EditorState): number {
  return pureMarkSites(state.doc).length
}
