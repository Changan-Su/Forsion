// 块菜单(⠿)「转换为」的落地(评审 B-05):单块走 applyTrigger(与 slash / 工具栏 / 空格触发符同一套转换),
// 跨块选区逐块转换。放在独立模块里,UnifiedPage 只管接线。
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { canJoin } from '@milkdown/kit/prose/transform'
import { applyTrigger, type Trigger } from '../blocks/markdown/blockTriggers'

const LIST_KINDS = new Set<Trigger['kind']>(['bullet', 'ordered', 'task'])

/** 把 [from, to)(整块边界,来自 topRangeOf)里的每个文本块都转成 trig。返回是否至少转成了一块。
 *  自下而上逐块做:后面的块先变,前面块的位置不受影响;相邻的改动在撤销史里并成一步。
 *  列表类转换逐块包出来的是一串单项列表 → 最后把区间内相邻的同类列表并成一只(Notion 同:选中几段转列表 = 一只列表)。 */
export function turnBlocksInto(view: EditorView, from: number, to: number, trig: Trigger): boolean {
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
