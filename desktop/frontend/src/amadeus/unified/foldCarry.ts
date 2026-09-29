// 折叠(标题小节 / 列表子项)在「整段搬走 / 复制 / 移出本篇」时跟着内容走(评审 B-04)。
// 折叠是会话态装饰,锚 = 标题 / 列表项的文档位置,平时随事务 mapping 存活。但 delete+insert 式的搬动里,
// 被删区间内的锚会落在**删除点** —— 那里恰好是另一枚标题时,两个折叠插件的 apply 会把它当「整节点替换」
// 留下来(见 headingFold apply 的 deleted 注),于是折叠「迁移」到邻居身上:搬走 `## 小节`,`## 下节` 被折起。
// 所以搬动类事务自己算好新锚,同一个 tr 上挂 meta `set`,不交给 mapping 猜。
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { foldedSectionAfter, headingFoldKey, hiddenRanges } from './headingFold'
import { listFoldKey } from './listFold'

/** [from, to)(同一容器里的一段整块兄弟)里的折叠标题,把它们藏起来的小节一并收进来,返回新的 to。
 *  「折起来的标题 = 一个整体」:键盘搬、拖、复制、移到别的笔记都按这个单位走(Notion 收起的 toggle heading 同)。
 *  小节只在标题自己的容器里算,嵌套的子级折叠天然落在外层小节之内。 */
export function withFoldedSections(state: EditorState, from: number, to: number): number {
  let end = to
  let $f
  try {
    $f = state.doc.resolve(from)
  } catch {
    return to
  }
  const parent = $f.parent
  let pos = from
  for (let i = $f.index(); i < parent.childCount && pos < end; i++) {
    const n = parent.child(i)
    if (n.type.name === 'heading') {
      const after = foldedSectionAfter(state, pos)
      if (after != null && after > end) end = after
    }
    pos += n.nodeSize
  }
  return end
}

/** 这次事务把 [from, to) 搬到了 newStart(tr.doc 坐标)/ 复制了一份到 newStart / 整段删掉(drop)。
 *  区间内的锚跟着内容走(复制 = 原件与副本都折着),区间外的照常 mapping。两种折叠各挂一枚 `set`。 */
export function carryFolds(
  state: EditorState,
  tr: Transaction,
  m: { from: number; to: number; newStart?: number; copy?: boolean; drop?: boolean },
): void {
  for (const key of [headingFoldKey, listFoldKey] as const) {
    const folded = key.getState(state)?.folded
    if (!folded?.length) continue
    const next: number[] = []
    for (const p of folded) {
      const inside = p >= m.from && p < m.to
      if (!inside || m.copy) next.push(tr.mapping.map(p))
      if (inside && !m.drop && m.newStart != null) next.push(m.newStart + (p - m.from))
    }
    tr.setMeta(key, { set: next })
  }
}

/** 搬 / 拖 / 复制的善后(接在 carryFolds 之后,同一个 tr):搬完不许把原本看得见的块藏进折叠小节。
 *  md 的小节是**结构**(到下一个同级或更高级标题为止):把折起的小节放到无标题的前言之前,前言就成了它的正文;
 *  把段落往下搬过一枚折起的标题,段落就进了那一节 —— 盖住这些块的折叠一律展开(与「拖放落进折叠小节 = 展开」
 *  同一口径),块绝不凭空消失。moved = 本次搬动的原区间与新起点(复制时原件不动、副本落在 newStart)。 */
export function unfoldNewlyHidden(
  state: EditorState,
  tr: Transaction,
  moved: { from: number; to: number; newStart: number },
): void {
  const set = (tr.getMeta(headingFoldKey) as { set?: number[] } | undefined)?.set
  if (!set?.length) return
  const oldRanges = hiddenRanges(state.doc, headingFoldKey.getState(state)?.folded ?? [])
  const wasHidden = (p: number): boolean => oldRanges.some((rg) => p >= rg.start && p < rg.after)
  const size = moved.to - moved.from
  const inv = tr.mapping.invert()
  const keep = set.filter((fp) => hiddenRanges(tr.doc, [fp]).every((rg) => {
    const $s = tr.doc.resolve(rg.start)
    const parent = $s.parent
    let p = rg.start
    for (let i = $s.index(); i < parent.childCount && p < rg.after; i++) {
      const np = p
      p += parent.child(i).nodeSize
      const op = np >= moved.newStart && np < moved.newStart + size ? moved.from + (np - moved.newStart) : inv.map(np)
      if (!wasHidden(op)) return false
    }
    return true
  }))
  if (keep.length !== set.length) tr.setMeta(headingFoldKey, { set: keep })
}
