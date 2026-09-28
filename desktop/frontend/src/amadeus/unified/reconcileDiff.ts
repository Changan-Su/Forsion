/** 外部回灌 → 同实例最小差异事务(评审 2026-09-27 波次 0b:K-05 / D-08)。
 *
 * UnifiedPage 的回灌把盘上新正文 parse 成 `next`,再在**同一个 PM 实例**上把 `cur` 改成它。原先是「顶层子节点
 * 首尾收缩后的单区间」整段 replaceWith,两处毛病叠起来(D-08):
 *  ① 解析出的标题 `id=''`,活文档里的由 syncHeadingIdPlugin 按文字回填 —— 逐节点 eq 对所有标题都判不等,
 *     只要有两个带字的标题,第一个到最后一个之间就整片替换(折叠丢、选区清空、DOM 重建);
 *  ② 即使只改了一处,光标所在的大列表 / 表格 / 引用 / 同一段也是整块换新,光标被 PM 映射甩到块尾。
 * 现做法:顶层块按「宽松相等」(忽略回填类属性)做 LCS 对齐 → 每个不同的区间内再按字符级找首尾差异
 * (Fragment.findDiffStart / findDiffEnd 的宽松版)→ 多段最小替换,自后向前在一个事务里做完。
 * 选区与折叠(headingFold / listFold 的锚都是随 mapping 走的位置)由 PM 映射自然保住;只有光标落在被替换
 * 的区间**里面**时才按原偏移夹回去,不让它被甩到区间一端。
 *
 * K-05(用户拍板 #7):回灌是别人的改动,事务**不进撤销栈**。PM history 会把本地已有的撤销步骤按这次替换的
 * mapping rebase,不清栈 —— Cmd+Z 只撤自己的字(同 MarkdownBlock / canvasStage 的外部同步口径)。
 */
import type { Slice, Node as ProseNode, Fragment } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'

/** 解析时恒为缺省、由插件在活文档里回填的属性:比对时视为相等(否则「没改过的标题」也永远判成变了)。 */
const DERIVED_ATTRS: Record<string, readonly string[]> = { heading: ['id'] }

/** a、b 的节点标记(类型 + 属性 + mark)是否相同 —— 回填类属性按 a 的值算,即忽略。 */
function sameMarkupLoose(a: ProseNode, b: ProseNode): boolean {
  if (a.type !== b.type) return false
  const skip = DERIVED_ATTRS[a.type.name]
  if (!skip) return a.sameMarkup(b)
  const attrs: Record<string, unknown> = { ...b.attrs }
  for (const k of skip) attrs[k] = a.attrs[k]
  return a.hasMarkup(b.type, attrs, b.marks)
}

/** 整棵子树宽松相等(sameMarkupLoose 逐层 + 文本相同)。 */
export function sameNodeLoose(a: ProseNode, b: ProseNode): boolean {
  if (a === b) return true
  if (!sameMarkupLoose(a, b)) return false
  if (a.isText) return a.text === b.text
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) if (!sameNodeLoose(a.child(i), b.child(i))) return false
  return true
}

/** Fragment.findDiffStart 的宽松版(prosemirror-model/src/diff.ts 同构,只把 sameMarkup 换成 sameMarkupLoose)。 */
function diffStart(a: Fragment, b: Fragment, pos: number): number | null {
  for (let i = 0; ; i++) {
    if (i === a.childCount || i === b.childCount) return a.childCount === b.childCount ? null : pos
    const ca = a.child(i)
    const cb = b.child(i)
    if (ca === cb) { pos += ca.nodeSize; continue }
    if (!sameMarkupLoose(ca, cb)) return pos
    if (ca.isText && ca.text !== cb.text) {
      const ta = ca.text ?? ''
      const tb = cb.text ?? ''
      for (let j = 0; ta[j] === tb[j]; j++) pos++
      return pos
    }
    if (ca.content.size || cb.content.size) {
      const inner = diffStart(ca.content, cb.content, pos + 1)
      if (inner != null) return inner
    }
    pos += ca.nodeSize
  }
}

/** Fragment.findDiffEnd 的宽松版。posA / posB = 两段各自的末尾位置。 */
function diffEnd(a: Fragment, b: Fragment, posA: number, posB: number): { a: number; b: number } | null {
  for (let iA = a.childCount, iB = b.childCount; ;) {
    if (iA === 0 || iB === 0) return iA === iB ? null : { a: posA, b: posB }
    const ca = a.child(--iA)
    const cb = b.child(--iB)
    const size = ca.nodeSize
    if (ca === cb) { posA -= size; posB -= size; continue }
    if (!sameMarkupLoose(ca, cb)) return { a: posA, b: posB }
    if (ca.isText && ca.text !== cb.text) {
      const ta = ca.text ?? ''
      const tb = cb.text ?? ''
      let same = 0
      const min = Math.min(ta.length, tb.length)
      while (same < min && ta[ta.length - same - 1] === tb[tb.length - same - 1]) { same++; posA--; posB-- }
      return { a: posA, b: posB }
    }
    if (ca.content.size || cb.content.size) {
      const inner = diffEnd(ca.content, cb.content, posA - 1, posB - 1)
      if (inner) return inner
    }
    posA -= size
    posB -= size
  }
}

/** LCS 表的规模上限(中段块数之积):超了就把整个中段当一个区间(仍会在里面做字符级收缩)。 */
const LCS_MAX_CELLS = 250_000

/** 顶层对齐:返回按文档序排列的「不同区间」[curFrom, curTo) × [nextFrom, nextTo)(子节点下标)。 */
function topLevelGaps(cur: ProseNode, next: ProseNode): Array<[number, number, number, number]> {
  const m = cur.childCount
  const n = next.childCount
  let pre = 0
  while (pre < m && pre < n && sameNodeLoose(cur.child(pre), next.child(pre))) pre++
  let suf = 0
  while (suf < m - pre && suf < n - pre && sameNodeLoose(cur.child(m - 1 - suf), next.child(n - 1 - suf))) suf++
  const a0 = pre, a1 = m - suf, b0 = pre, b1 = n - suf
  const la = a1 - a0, lb = b1 - b0
  if (la === 0 && lb === 0) return []
  if (la === 0 || lb === 0 || la * lb > LCS_MAX_CELLS) return [[a0, a1, b0, b1]]
  // 经典 LCS(自后向前填表,再自前向后取对齐)。
  const w = lb + 1
  const dp = new Uint32Array((la + 1) * w)
  for (let i = la - 1; i >= 0; i--) {
    for (let j = lb - 1; j >= 0; j--) {
      dp[i * w + j] = sameNodeLoose(cur.child(a0 + i), next.child(b0 + j))
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const gaps: Array<[number, number, number, number]> = []
  let i = 0, j = 0, gi = 0, gj = 0
  while (i < la && j < lb) {
    if (sameNodeLoose(cur.child(a0 + i), next.child(b0 + j)) && dp[i * w + j] === dp[(i + 1) * w + j + 1] + 1) {
      if (gi < i || gj < j) gaps.push([a0 + gi, a0 + i, b0 + gj, b0 + j])
      i++; j++; gi = i; gj = j
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
    else j++
  }
  if (gi < la || gj < lb) gaps.push([a0 + gi, a1, b0 + gj, b1])
  return gaps
}

const childStart = (node: ProseNode, index: number): number => {
  let pos = 0
  for (let i = 0; i < index; i++) pos += node.child(i).nodeSize
  return pos
}

interface Step { from: number; to: number; slice: Slice }

/** 算出把 cur 变成 next 的最小替换步(按文档序)。完全相同 = 空数组。 */
export function reconcileSteps(cur: ProseNode, next: ProseNode): Step[] {
  const steps: Step[] = []
  for (const [ca, cb, na, nb] of topLevelGaps(cur, next)) {
    const curFrom = childStart(cur, ca)
    const nextFrom = childStart(next, na)
    const curFrag = cur.content.cut(curFrom, childStart(cur, cb))
    const nextFrag = next.content.cut(nextFrom, childStart(next, nb))
    const start = diffStart(curFrag, nextFrag, curFrom)
    if (start == null) continue // 宽松相等(只差回填属性):不动
    const end = diffEnd(curFrag, nextFrag, curFrom + curFrag.size, nextFrom + nextFrag.size)
    let endA = end ? end.a : curFrom + curFrag.size
    let endB = end ? end.b : nextFrom + nextFrag.size
    // 区间内 next 与 cur 的坐标差(前面的区间可能已改变长度;区间内的共同前缀两边等长)。
    const delta = nextFrom - curFrom
    // 首尾收缩重叠(重复字符:「aa」→「aaa」)时按 prosemirror-view 的口径把较短那侧推到 start,两侧长度差不变。
    if (endA < start) { endB += start - endA; endA = start }
    if (endB - delta < start) { endA += start - (endB - delta); endB = start + delta }
    steps.push({ from: start, to: endA, slice: next.slice(start + delta, endB) })
  }
  return steps
}

/** 回灌事务:cur → next 的多段最小替换;无差异 = null。已设 addToHistory:false(K-05)。 */
export function reconcileTr(state: EditorState, next: ProseNode): Transaction | null {
  const steps = reconcileSteps(state.doc, next)
  if (!steps.length) return null
  const sel = state.selection
  const tr = state.tr
  // 自后向前:前面区间的位置不受后面替换影响,步里的 from/to 始终是 cur 的坐标。
  for (let k = steps.length - 1; k >= 0; k--) {
    const s = steps[k]
    tr.replace(s.from, s.to, s.slice)
  }
  // 光标落在某个被替换区间的**里面**:PM 映射会把它甩到区间一端 —— 按原偏移夹回新内容里(D-08 建议②)。
  if (sel instanceof TextSelection) {
    const clampIn = (pos: number): number | null => {
      for (const s of steps) {
        if (pos > s.from && pos < s.to) {
          const from = tr.mapping.map(s.from, -1)
          return Math.min(from + (pos - s.from), from + s.slice.size, tr.doc.content.size)
        }
      }
      return null
    }
    const head = clampIn(sel.head)
    const anchor = clampIn(sel.anchor)
    if (head != null || anchor != null) {
      const h = head ?? tr.mapping.map(sel.head)
      const a = anchor ?? tr.mapping.map(sel.anchor)
      try {
        tr.setSelection(TextSelection.between(tr.doc.resolve(a), tr.doc.resolve(h)))
      } catch { /* 夹不进合法文字位就交给 PM 的映射结果 */ }
    }
  }
  return tr.setMeta('addToHistory', false)
}
