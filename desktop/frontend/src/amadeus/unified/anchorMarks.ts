// 锚标记段:独占一段的 `<!-- a id -->`(取消分栏 / 收回画布卡 / 多锚的栏留下的惰性锚,见 columns.ts「锚永不回收」)。
// 落盘必须原样留着 —— 既有的 `![[笔记#id]]` 靠它找到「紧随其后的那一块」;但在编辑器里它只是一行看不懂的注释,
// 这里把它收起来(和标题折叠的 amx-fold-hidden 同一个做法:节点装饰挂类,CSS display:none)。
//
// 收起之后要守住一条不变式:**看不见的段落永远不收字,落盘那一行永远是 `<!-- a id -->`**。
//   · 键盘那一半(退格 / Delete 跨过锚标记去并真正的上一块 / 下一块)在 keyboard.ts:bsOverAnchorMarks / deleteOverAnchorMarks;
//   · 这里兜其余所有路径(粘贴、输入法、别的命令、程序化的选区):原本独占一段的锚标记被并进了文字 → 按原顺序拆回独占一段;
//     光标 / 块选中落在锚标记段上 → 挪到最近一处看得见的文字。
// 方向键、点击、回车、粘贴本来就会跳过 display:none 的段落(探针 2026-11-18,仓根方案目录 instrument/probe-anchor-marks.cjs)。
import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, PluginKey, Selection } from '@milkdown/kit/prose/state'
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

/** 旧文档里每一枚「独占一段」的锚标记 html 节点的位置。 */
function pureMarkSites(doc: ProseNode): number[] {
  const out: number[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (isAnchorMarkPara(node)) out.push(pos + 1)
    return false
  })
  return out
}

/** 把混进文字的锚标记拆回独占一段:[字, 标记, 字] → 字 | 标记 | 字,顺序不变(标记仍在它原本指着的那块前面)。 */
function splitMixed(tr: Transaction, paraPos: number): Transaction {
  const para = tr.doc.nodeAt(paraPos)
  if (!para || para.type.name !== 'paragraph') return tr
  const pieces: ProseNode[] = []
  let run: ProseNode[] = []
  const flush = (): void => {
    if (run.length) pieces.push(para.type.create(para.attrs, run))
    run = []
  }
  para.forEach((child) => {
    if (isAnchorMarkHtml(child)) {
      flush()
      pieces.push(para.type.create(null, child))
    } else run.push(child)
  })
  flush()
  return tr.replaceWith(paraPos, paraPos + para.nodeSize, pieces)
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
      if (trs.some(userEdit)) {
        const mapping = new Mapping()
        for (const t of trs) mapping.appendMapping(t.mapping)
        const paras = new Set<number>()
        for (const h of pureMarkSites(old.doc)) {
          const r = mapping.mapResult(h, 1)
          if (r.deleted) continue
          const n = state.doc.nodeAt(r.pos)
          if (!isAnchorMarkHtml(n)) continue
          const $h = state.doc.resolve(r.pos)
          if ($h.parent.type.name === 'paragraph' && $h.parent.childCount > 1) paras.add($h.before())
        }
        for (const p of [...paras].sort((a, b) => b - a)) tr = splitMixed(tr, p)
      }
      const sel = tr.selection
      const onMark = sel instanceof NodeSelection
        ? isAnchorMarkPara(sel.node) || (isAnchorMarkHtml(sel.node) && isAnchorMarkPara(sel.$from.parent))
        : isAnchorMarkPara(sel.$head.parent)
      if (onMark) {
        const dir: 1 | -1 = state.selection.head < old.selection.head ? -1 : 1
        // 这一处只剩锚标记(整栏都是看不见的段)时找不到去处:光标留着,打的字由上面的拆分兜回看得见的段落
        const target = escapeFrom(tr.doc, sel instanceof NodeSelection ? sel.from + 1 : sel.head, dir)
        if (target) tr.setSelection(target)
      }
      return tr.docChanged || tr.selectionSet ? tr : null
    },
  })
})

/** 仪器 / 单测用:这份状态里看不见的锚标记段一共几枚。 */
export function anchorMarkCount(state: EditorState): number {
  return pureMarkSites(state.doc).length
}
