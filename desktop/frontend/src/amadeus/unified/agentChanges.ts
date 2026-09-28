/** Agent 改了打开着的笔记 → 编辑器里的呈现(评审 G3-03,波次 1)。
 *
 *  回灌(reconcileDiff 的多段最小替换)认出是 Tangu 写的(stores/agentWriteLedger)时,把每一处改动记成
 *  「新区间 + 旧片段」交给本插件:正文上画 `am-agent-change` 装饰,页面底部挂一个胶囊
 *  「Tangu 修改了 N 处 · 逐处查看 · 全部撤回 · 保留」(AgentChangeCapsule)。
 *
 *  不变量:
 *   - 装饰与旧片段**只在内存**(插件状态),序列化器看不见,一个字节都不落盘。
 *   - 回灌本身照旧 addToHistory:false(拍板 #7):撤回 Agent 的改动走胶囊,不混进 Cmd+Z。
 *   - 「全部撤回」= 一次普通的用户编辑(进撤销栈、走现有防抖 + CAS 保存链);「保留」只清标记,零写入。
 *   - 用户在某处改过之后,那一处的内容不再等于 Agent 写下的样子 →「全部撤回」跳过它(不拿旧片段盖掉用户的字),
 *     跳过几处就说几处。
 *  区间始终两两不相交:同一处被 Agent 连改两次时合并成一处,旧片段取「第一次改之前」的样子。 */
import { $prose } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Transform } from '@milkdown/kit/prose/transform'
import type { Fragment, Node as ProseNode, Slice } from '@milkdown/kit/prose/model'
import { sameNodeLoose, type ReconcileChange } from './reconcileDiff'

export interface AgentChange {
  id: number
  /** 当前文档里的区间 [from, to)(随每个事务映射)。纯删除时 from === to。 */
  from: number
  to: number
  /** 被 Agent 换掉的旧内容(「全部撤回」拿它放回去)。 */
  old: Slice
  /** Agent 写下的内容(判「用户改过没有」:区间里现在的内容还等不等于它)。 */
  after: Fragment
}
export interface AgentChangesState {
  changes: AgentChange[]
  /** 「逐处查看」当前停在哪一处(id);null = 还没开始看。 */
  current: number | null
}
type Meta = { add: ReconcileChange[]; before: ProseNode } | { clear: true } | { current: number | null }

export const agentChangesKey = new PluginKey<AgentChangesState>('amAgentChanges')
let seq = 0

/** 两段 Fragment 宽松相等(忽略标题 id 这类由插件回填的属性 —— 回灌后 syncHeadingId 会补一笔)。 */
function fragLooseEq(a: Fragment, b: Fragment): boolean {
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) if (!sameNodeLoose(a.child(i), b.child(i))) return false
  return true
}

/** 把一次 Agent 回灌的改动并进现有集合。`before` = 回灌前的文档(现有区间与 add 的 oldFrom/oldTo 都在它的坐标系),
 *  `tr` = 回灌事务。在回灌前坐标里把「现有区间 + 本次每一步」按相交 / 相接聚成簇:只含本次一步的簇直接记;
 *  簇里有旧标记(同一处被连改)就整簇并成一处,旧片段 = 回灌前文档上把簇里每处旧标记换回它自己的旧片段后、
 *  并集区间的内容(= 第一次改之前的样子)。只含旧标记、本次没碰的簇原样过映射。 */
function addChanges(prev: AgentChange[], add: ReconcileChange[], before: ProseNode, tr: Transaction): AgentChange[] {
  type Item = { a: number; b: number; e?: AgentChange; c?: ReconcileChange }
  const items: Item[] = [
    ...prev.map((e) => ({ a: e.from, b: e.to, e })),
    ...add.map((c) => ({ a: c.oldFrom, b: c.oldTo, c })),
  ].sort((x, y) => x.a - y.a || x.b - y.b)
  const clusters: Item[][] = []
  for (const it of items) {
    const last = clusters[clusters.length - 1]
    const lastEnd = last ? Math.max(...last.map((x) => x.b)) : -1
    // 相接也并(a === lastEnd):两处紧挨着的改动在用户眼里就是一处,也免得撤回时两段旧片段的边界互相踩。
    if (last && it.a <= lastEnd && (it.c || last.some((x) => x.c))) last.push(it)
    else clusters.push([it])
  }
  const out: AgentChange[] = []
  for (const cl of clusters) {
    const olds = cl.filter((x) => x.e).map((x) => x.e!)
    const news = cl.filter((x) => x.c).map((x) => x.c!)
    if (!news.length) {
      // 本次没碰的旧标记:过映射。起点右结合、终点左结合(与用户编辑同口径)。
      for (const e of olds) {
        const from = tr.mapping.map(e.from, 1)
        out.push({ ...e, from, to: Math.max(from, tr.mapping.map(e.to, -1)) })
      }
      continue
    }
    if (!olds.length && news.length === 1) {
      const c = news[0]
      out.push({ id: ++seq, from: c.from, to: c.to, old: c.old, after: tr.doc.slice(c.from, c.to).content })
      continue
    }
    const ua = Math.min(...cl.map((x) => x.a))
    const ub = Math.max(...cl.map((x) => x.b))
    const scratch = new Transform(before)
    for (const e of [...olds].sort((x, y) => y.from - x.from)) scratch.replace(e.from, e.to, e.old)
    const sa = scratch.mapping.map(ua, -1)
    const sb = scratch.mapping.map(ub, 1)
    const from = tr.mapping.map(ua, -1)
    const to = tr.mapping.map(ub, 1)
    out.push({ id: ++seq, from, to, old: scratch.doc.slice(sa, sb), after: tr.doc.slice(from, to).content })
  }
  return out.sort((a, b) => a.from - b.from)
}

function decorate(state: EditorState, st: AgentChangesState): DecorationSet | null {
  if (!st.changes.length) return null
  const decos: Decoration[] = []
  const size = state.doc.content.size
  for (const c of st.changes) {
    const cls = `am-agent-change${st.current === c.id ? ' is-current' : ''}`
    const from = Math.min(c.from, size)
    const to = Math.min(c.to, size)
    if (to > from) {
      decos.push(Decoration.inline(from, to, { class: cls, 'data-agent-change': String(c.id) }))
      // 没有行内内容的整块(分割线 / 嵌入卡 / 图片块)行内装饰画不上,给节点本身挂类。
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isBlock && node.isLeaf && pos >= from && pos + node.nodeSize <= to) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: `${cls} am-agent-change-block` }))
        }
        return !node.isTextblock
      })
    } else {
      // 纯删除:在原处放一个小记号,告诉用户「这里少了东西」。
      decos.push(Decoration.widget(from, () => {
        const el = document.createElement('span')
        el.className = `am-agent-del${st.current === c.id ? ' is-current' : ''}`
        el.setAttribute('data-agent-change', String(c.id))
        return el
      }, { side: -1, key: `am-agent-del-${c.id}-${st.current === c.id ? 1 : 0}`, ignoreSelection: true }))
    }
  }
  return DecorationSet.create(state.doc, decos)
}

/** 宿主拿插件状态变化(胶囊的 N / 当前第几处)。回调经 ref 现读:editorPlugins 是只建一次的稳定引用。 */
export function createAgentChanges(onState: { current: (st: AgentChangesState) => void }): MilkdownPlugin[] {
  return [$prose(() => agentChangesPlugin(onState))].flat()
}

/** 裸 PM 插件(单测直接挂在 EditorState 上)。 */
export function agentChangesPlugin(onState: { current: (st: AgentChangesState) => void }): Plugin<AgentChangesState> {
  return new Plugin<AgentChangesState>({
    key: agentChangesKey,
    state: {
      init: () => ({ changes: [], current: null }),
      apply(tr, st) {
        const meta = tr.getMeta(agentChangesKey) as Meta | undefined
        if (meta && 'clear' in meta) return { changes: [], current: null }
        if (meta && 'add' in meta) {
          const changes = addChanges(st.changes, meta.add, meta.before, tr)
          return { changes, current: changes.some((c) => c.id === st.current) ? st.current : null }
        }
        let next = st
        if (tr.docChanged && st.changes.length) {
          // 区间两端的结合方向:起点右结合、终点左结合 —— 用户贴着 Agent 那段的边上打字,不算进那一处。
          next = {
            ...st,
            changes: st.changes.map((c) => {
              const from = tr.mapping.map(c.from, 1)
              return { ...c, from, to: Math.max(from, tr.mapping.map(c.to, -1)) }
            }),
          }
        }
        if (meta && 'current' in meta) next = { ...next, current: meta.current }
        return next
      },
    },
    props: {
      decorations(state) {
        const st = agentChangesKey.getState(state)
        return st ? decorate(state, st) : null
      },
    },
    view: (editorView) => {
      // 编辑器重建(换 key / 切源码回来)时新插件状态是空的:先报一次,别让胶囊挂着上一个实例的 N。
      const init = agentChangesKey.getState(editorView.state)
      if (init) onState.current(init)
      return {
        update(view, prev) {
          const st = agentChangesKey.getState(view.state)
          if (st && st !== agentChangesKey.getState(prev)) onState.current(st)
        },
      }
    },
  })
}

/** 回灌事务打上「这是 Agent 的改动」标记(UnifiedPage 的回灌路径调;恢复草稿那条绝不能调)。 */
export function markAgentChanges(tr: Transaction, before: ProseNode, changes: ReconcileChange[]): Transaction {
  return changes.length ? tr.setMeta(agentChangesKey, { add: changes, before } satisfies Meta) : tr
}

/** 「全部撤回」:用户没动过的每一处换回旧片段,一次普通用户编辑(进撤销栈,走防抖 + CAS 保存)。
 *  返回 { reverted, skipped };skipped = 用户改过、没撤的处数。 */
export function revertAgentChanges(view: EditorView): { reverted: number; skipped: number } {
  const st = agentChangesKey.getState(view.state)
  if (!st?.changes.length) return { reverted: 0, skipped: 0 }
  const tr = view.state.tr
  let reverted = 0
  let skipped = 0
  // 区间两两不相交:自后向前换,前面的坐标不受影响。
  for (const c of [...st.changes].sort((a, b) => b.from - a.from)) {
    if (!fragLooseEq(view.state.doc.slice(c.from, c.to).content, c.after)) { skipped++; continue }
    tr.replace(c.from, c.to, c.old)
    reverted++
  }
  view.dispatch(tr.setMeta(agentChangesKey, { clear: true } satisfies Meta).scrollIntoView())
  return { reverted, skipped }
}

/** 「保留」:只清标记与旧片段,文档不动、零写入。 */
export function keepAgentChanges(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(agentChangesKey, { clear: true } satisfies Meta))
}

/** 「逐处查看」:停到下一处(循环),返回它的区间起点;没有改动返回 null。 */
export function nextAgentChange(view: EditorView): AgentChange | null {
  const st = agentChangesKey.getState(view.state)
  if (!st?.changes.length) return null
  const i = st.changes.findIndex((c) => c.id === st.current)
  const c = st.changes[(i + 1) % st.changes.length]
  view.dispatch(view.state.tr.setMeta(agentChangesKey, { current: c.id } satisfies Meta))
  return c
}
