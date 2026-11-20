/** 块拖拽的精确落点 + 落点线。改自 prosemirror-drop-indicator 0.1.4(MIT License, Copyright (c) 2025 ocavue)。
 *
 *  和原库的差别(页面编辑手感方案 2026-11-17 第 1、2 条):
 *  - **不按坐标缓存落点**。原库「坐标没变 = 沿用上次的落点」,dragover 开头还有一道同坐标直接 return:
 *    贴边自动滚动时指针不动、内容在指针下滚过去,线停在滚动前,drop 也落回滚动前那条缝(实测偏 ~290px)。
 *    目标线段仍按 view.dom 的矩形 + doc 缓存 —— 滚动会让矩形变,自然重算。
 *  - 对外给 `evaluate` / `targetAt`:左右页边(view.dom 之外,库的监听收不到)按钳进正文的坐标判定、
 *    按帧自动滚动之后原地重判,都走这一份,与正文里同源。
 *  - `performDrop` 抽成函数:页边松手和插件 handleDrop 共用一套「删 + 插 + 选中」。
 *  - onDrag 多给一个 `point`(判定用的坐标);`event.clientX/Y` 仍是指针真坐标。
 *  - **拖动来源随事务映射**(插件状态 = `DragSource`)。原库(和 prosemirror-view 自己的 drop)插的是 dragstart 时缓存的
 *    `view.dragging.slice`、删的是当前选区或 dragstart 时的 `dragging.node`:拖动途中别处(另一个分栏 / 同步 /
 *    Agent 写盘回灌)改了被拖块,松手就把新字换回旧字;位置挪过还会删错区间。现在 dragstart 记下来源区间,每个事务
 *    映射一次,松手按映射后的区间取**现内容**删 + 插;来源被删 / 换了类型 = 整次拖动作废。 */
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState, Selection } from '@milkdown/kit/prose/state'
import { dropPoint } from '@milkdown/kit/prose/transform'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode, ResolvedPos, Slice } from '@milkdown/kit/prose/model'

export type DropPoint = [number, number]
export interface DropLine { p1: { x: number; y: number }; p2: { x: number; y: number } }
type Target = [pos: number, line: [number, number, number, number]]

export interface DropTargetsOptions {
  /** 逐个候选问一次;返回 false = 不要这个候选,接着问下一个。 */
  onDrag?: (args: { view: EditorView; pos: number; event: DragEvent; point: DropPoint }) => boolean | void
  onShow?: (args: { view: EditorView; pos: number; line: DropLine }) => void
  onHide?: () => void
  /** 这次拖动是复制(按着复制键):复制可以落在源块紧邻的缝上,不算「落回自己」。 */
  isCopy?: (event: DragEvent) => boolean
}

export interface DropTargets {
  /** 每台编辑器一份插件实例(`$prose` 每次调用都要新的)。 */
  createPlugin(): Plugin
  /** 按 point 判一次并画线(没有目标就排隐藏)。返回落点位置或 null。limit = 最多问几个最近的候选(缺省 8,同原库)。 */
  evaluate(view: EditorView, point: DropPoint, event: DragEvent, limit?: number): number | null
  /** 只判不画。 */
  targetAt(view: EditorView, point: DropPoint, event: DragEvent, limit?: number): number | null
}

const isHTMLElement = (n: unknown): n is HTMLElement => n instanceof HTMLElement

// ── 拖动来源 ────────────────────────────────────────────────────────────────────────────────
/** 这次拖起的是文档里的哪一段。存在落点插件的状态里(插件装上它就在,块层不用另挂一个)。 */
export interface DragSource {
  /** 这次拖动的身份 = 它的切片对象(`view.dragging.slice`),记录只认它 —— 漏收 dragend 留下的旧记录不会串到下一次。
   *  不认 `view.dragging` 本身:PM 自己起的节点拖拽,文档一变就换一个新的 Dragging 对象(updateDraggedNode),切片照旧。 */
  token: object
  /** node = 块选区拖的一个节点(⠿ / 图片本体 / PM 自己起拖的选中节点);range = 跨块选区整批(topRangeOf 的整块边界)。 */
  kind: 'node' | 'range'
  from: number
  to: number
  /** 起拖时区间里各子节点的类型名:换了类型、多出或少了块 = 作废。 */
  types: string[]
  /** 各子节点的 anchor 属性(画布卡 / 分栏 cell 带;别的块为 null):同一个槽位换成了另一张卡 = 作废,不冒名顶替。 */
  anchors: Array<string | null>
  /** 某次删除跨过了一端(那一侧连同边界一起没了):作废,不再复活。 */
  dead: boolean
}
const dropTargetsKey = new PluginKey<DragSource | null>('UNIFIED_DROP_TARGETS')

/** 这次拖动的身份(见 DragSource.token);没在拖 = null。 */
export const dragToken = (view: EditorView): object | null => view.dragging?.slice ?? null

/** [from, to) 若是同一个父节点下的若干整块,返回它们的类型名与 anchor;否则 null。 */
function childKeys(doc: ProseNode, from: number, to: number): { types: string[]; anchors: Array<string | null> } | null {
  if (!(from >= 0 && to <= doc.content.size && from < to)) return null
  const $from = doc.resolve(from)
  const $to = doc.resolve(to)
  if (!$from.sameParent($to) || $from.textOffset || $to.textOffset) return null
  const types: string[] = []
  const anchors: Array<string | null> = []
  for (let i = $from.index(); i < $to.index(); i++) {
    const c = $from.parent.child(i)
    types.push(c.type.name)
    anchors.push(typeof c.attrs.anchor === 'string' ? c.attrs.anchor : null)
  }
  return { types, anchors }
}

/** 记下这次拖动的来源(dragstart 时调;null = 这次拖动没有可搬的来源,松手一律作废)。一笔只带 meta 的事务。 */
export function recordDragSource(view: EditorView, token: object, src: { kind: DragSource['kind']; from: number; to: number } | null): void {
  const keys = src ? childKeys(view.state.doc, src.from, src.to) : null
  const value: DragSource | null = src && keys ? { token, ...src, ...keys, dead: false } : null
  if (value === null && !dropTargetsKey.getState(view.state)) return
  view.dispatch(view.state.tr.setMeta(dropTargetsKey, value).setMeta('addToHistory', false))
}

/** 拖动收尾:清掉来源记录(没有就什么都不派发)。 */
export function clearDragSource(view: EditorView): void {
  if (view.isDestroyed || !dropTargetsKey.getState(view.state)) return
  view.dispatch(view.state.tr.setMeta(dropTargetsKey, null).setMeta('addToHistory', false))
}

/** token 这次拖动的来源,映射到 state 此刻的文档。被删 / 换了类型 / 结构不再是那几块 / 不是这次拖动的记录 → null。 */
export function liveDragSource(state: EditorState, token: unknown): { kind: DragSource['kind']; from: number; to: number } | null {
  const s = dropTargetsKey.getState(state)
  if (!s || s.dead || !token || s.token !== token) return null
  const keys = childKeys(state.doc, s.from, s.to)
  if (!keys || keys.types.length !== s.types.length) return null
  if (keys.types.some((t, i) => t !== s.types[i]) || keys.anchors.some((a, i) => a !== s.anchors[i])) return null
  return { kind: s.kind, from: s.from, to: s.to }
}

function targetsOf(view: EditorView): Target[] {
  const stack: Array<[number, typeof view.state.doc]> = [[-1, view.state.doc]]
  const out: Target[] = []
  while (stack.length > 0) {
    const [pos, node] = stack.pop()!
    if (pos >= 0) {
      const dom = view.nodeDOM(pos)
      if (dom && isHTMLElement(dom)) {
        const { top, bottom, left: x1, right: x2 } = dom.getBoundingClientRect()
        out.push([pos, [x1, top, x2, top]], [pos + node.nodeSize, [x1, bottom, x2, bottom]])
      }
    }
    if (node.isBlock && !node.isTextblock) {
      let childPos = pos + 1
      node.forEach((child) => {
        stack.push([childPos, child])
        childPos += child.nodeSize
      })
    }
  }
  return out
}

const pp = (a: DropPoint, x: number, y: number): number => Math.abs(a[0] - x) + Math.abs(a[1] - y)
const pointLine = (p: DropPoint, l: Target[1]): number => Math.min(pp(p, l[0], l[1]), pp(p, l[2], l[3]))

/** 拖的就是这个位置上的块(落回自己)。复制不算(view.dragging.move 是起拖那一刻定的,不跟复制键)。 */
function draggingToItself(view: EditorView, pos: number, copy: boolean): boolean {
  if (!view.dragging?.move || copy) return false
  const sel = view.state.selection
  return sel instanceof NodeSelection && sel.from <= pos && pos <= sel.to
}

function selectionBetween(view: EditorView, $anchor: ResolvedPos, $head: ResolvedPos): Selection {
  return view.someProp('createSelectionBetween', (f) => f(view, $anchor, $head)) || TextSelection.between($anchor, $head)
}

/** 把这次拖着的那块放到 insertPos(move = 原位删掉)。原库 handleDrop 的主体,但内容和要删的区间都取自
 *  **映射到此刻的来源**(liveDragSource),不用 dragstart 时缓存的 `view.dragging.slice` / `dragging.node`。
 *  来源已作废、没记到、或不是单个节点 → 什么都不做、返回 false,调用方按作废收尾(绝不退回缓存切片)。
 *  transformPasted = 照 PM 的 drop 对切片跑一遍 transformPasted 钩子(插件 handleDrop 那条路一直跑,页边那条一直不跑)。 */
export function performDrop(view: EditorView, insertPos: number, move: boolean, opts: { transformPasted?: boolean } = {}): boolean {
  const src = liveDragSource(view.state, dragToken(view))
  if (!src || src.kind !== 'node') return false
  const tr = view.state.tr
  const source = NodeSelection.create(tr.doc, src.from)
  let slice: Slice = source.content()
  if (opts.transformPasted) view.someProp('transformPasted', (f) => { slice = f(slice, view, false) })
  if (move) source.replace(tr)
  const pos = tr.mapping.map(insertPos)
  const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
  const beforeInsert = tr.doc
  if (isNode) tr.replaceRangeWith(pos, pos, slice.content.firstChild!)
  else tr.replaceRange(pos, pos, slice)
  if (tr.doc.eq(beforeInsert)) return true
  const $pos = tr.doc.resolve(pos)
  if (isNode && NodeSelection.isSelectable(slice.content.firstChild!) && $pos.nodeAfter && $pos.nodeAfter.sameMarkup(slice.content.firstChild!)) {
    tr.setSelection(new NodeSelection($pos))
  } else {
    let end = tr.mapping.map(insertPos)
    tr.mapping.maps[tr.mapping.maps.length - 1].forEach((_from, _to, _newFrom, newTo) => { end = newTo })
    tr.setSelection(selectionBetween(view, $pos, tr.doc.resolve(end)))
  }
  view.focus()
  view.dispatch(tr.setMeta('uiEvent', 'drop').setMeta(dropTargetsKey, null))
  return true
}

export function createDropTargets(options: DropTargetsOptions): DropTargets {
  // 目标线段缓存(按 view):view.dom 矩形与 doc 都没变就复用 —— 滚动 / 重排会让矩形变,自然重算。
  const cache = new WeakMap<EditorView, { rect: DOMRect; doc: unknown; targets: Target[] }>()
  const targetsFor = (view: EditorView): Target[] => {
    const rect = view.dom.getBoundingClientRect()
    const doc = view.state.doc
    const c = cache.get(view)
    if (c && c.doc === doc && c.rect.x === rect.x && c.rect.y === rect.y && c.rect.width === rect.width && c.rect.height === rect.height) return c.targets
    const targets = targetsOf(view)
    cache.set(view, { rect, doc, targets })
    return targets
  }
  const pick = (view: EditorView, point: DropPoint, event: DragEvent, limit = 8): Target | undefined => {
    if (!view.editable || view.isDestroyed) return undefined
    const sorted = targetsFor(view).slice().sort((a, b) => pointLine(point, a[1]) - pointLine(point, b[1]) || a[0] - b[0]).slice(0, limit)
    const t = sorted.find((c) => options.onDrag?.({ view, pos: c[0], event, point }) !== false)
    if (t && draggingToItself(view, t[0], options.isCopy?.(event) ?? false)) return undefined
    return t
  }

  // 隐藏照原库:dragend / drop / dragleave 排 30ms,期间来一次 dragover 就作废(指针在块间缝里抖)。
  const hideTimers = new WeakMap<EditorView, { id?: ReturnType<typeof setTimeout>; over: boolean }>()
  const hs = (view: EditorView): { id?: ReturnType<typeof setTimeout>; over: boolean } => {
    let s = hideTimers.get(view)
    if (!s) hideTimers.set(view, (s = { over: false }))
    return s
  }
  const scheduleHide = (view: EditorView): void => {
    const s = hs(view)
    if (s.id) clearTimeout(s.id)
    s.over = false
    s.id = setTimeout(() => {
      if (s.over) return
      options.onHide?.()
    }, 30)
  }

  const evaluate = (view: EditorView, point: DropPoint, event: DragEvent, limit?: number): number | null => {
    hs(view).over = true
    const t = pick(view, point, event, limit)
    if (!t) {
      scheduleHide(view)
      return null
    }
    const [pos, [x1, y1, x2, y2]] = t
    options.onShow?.({ view, pos, line: { p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } } })
    return pos
  }

  return {
    evaluate,
    targetAt: (view, point, event, limit) => pick(view, point, event, limit)?.[0] ?? null,
    createPlugin: () => {
      let pluginView: EditorView | null = null
      return new Plugin<DragSource | null>({
        key: dropTargetsKey,
        state: {
          init: () => null,
          apply(tr, prev) {
            const meta = tr.getMeta(dropTargetsKey) as DragSource | null | undefined
            if (meta !== undefined) return meta
            if (!prev || prev.dead || !tr.docChanged) return prev
            // 起点右结合、终点左结合:紧贴两端插进来的东西不算被拖的那段。端点被一次删除跨过 = 那一侧没了,作废。
            // (整块被换掉时两端落在替换区间的端点上,结合方向不起作用 —— 那种靠 liveDragSource 的类型比对。)
            const a = tr.mapping.mapResult(prev.from, 1)
            const b = tr.mapping.mapResult(prev.to, -1)
            return { ...prev, from: a.pos, to: b.pos, dead: a.deletedAcross || b.deletedAcross || b.pos <= a.pos }
          },
        },
        // 块选区退化的修复:被拖块被整块替换(回灌里改了属性 —— 标题级别、待办勾选)时,PM 把 NodeSelection 映射成
        // 附近的光标,块层的落点路由全按选区判,拖动当场「失效」(没线、松手无反应)。来源还活着就把选区放回来源上。
        // 只修「上一刻选区正是来源、这批事务又没有谁主动设过选区」的退化,不跟主动设选区的事务抢。
        appendTransaction(trs, oldState, newState) {
          const src = dropTargetsKey.getState(newState)
          const was = dropTargetsKey.getState(oldState)
          if (!src || src.kind !== 'node' || !was || was.token !== src.token || !pluginView || dragToken(pluginView) !== src.token) return null
          if (!trs.some((t) => t.docChanged) || trs.some((t) => t.selectionSet)) return null
          const old = oldState.selection
          if (!(old instanceof NodeSelection) || old.from !== was.from) return null
          const sel = newState.selection
          const live = liveDragSource(newState, src.token)
          if (!live || (sel instanceof NodeSelection && sel.from === live.from)) return null
          return newState.tr.setSelection(NodeSelection.create(newState.doc, live.from)).setMeta('addToHistory', false)
        },
        view: (view) => {
          pluginView = view
          const dom = view.dom
          const onOver = (e: DragEvent): void => { evaluate(view, [e.clientX, e.clientY], e) }
          const onOut = (): void => scheduleHide(view)
          // PM 自己起的拖拽(拖选中的节点):它的 dragstart 监听先挂(EditorView 构造时),这里后挂、后跑,view.dragging 已就位。
          // 块层的 ⠿ / 图片本体起拖在 beginBlockDrag 里自己记(token 相同就不重记)。
          const onStart = (): void => {
            const token = dragToken(view)
            if (!token || dropTargetsKey.getState(view.state)?.token === token) return
            const sel = (view.dragging as { node?: Selection } | null)?.node ?? view.state.selection
            recordDragSource(view, token, sel instanceof NodeSelection ? { kind: 'node', from: sel.from, to: sel.to } : null)
          }
          // 拖动一结束就收记录(PM 自己 50ms 后才清 view.dragging,其间来的事务不该再被「修选区」)。
          const onEnd = (): void => {
            scheduleHide(view)
            clearDragSource(view)
          }
          dom.addEventListener('dragstart', onStart)
          dom.addEventListener('dragover', onOver)
          dom.addEventListener('dragend', onEnd)
          dom.addEventListener('drop', onOut)
          dom.addEventListener('dragleave', onOut)
          return {
            destroy: () => {
              pluginView = null
              dom.removeEventListener('dragstart', onStart)
              dom.removeEventListener('dragover', onOver)
              dom.removeEventListener('dragend', onEnd)
              dom.removeEventListener('drop', onOut)
              dom.removeEventListener('dragleave', onOut)
              const s = hideTimers.get(view)
              if (s?.id) clearTimeout(s.id)
              cache.delete(view)
            },
          }
        },
        props: {
          handleDrop(view, event, _slice, move) {
            const token = dragToken(view)
            const tracked = !!token && dropTargetsKey.getState(view.state)?.token === token
            const live = tracked ? liveDragSource(view.state, token) : null
            // 记过来源、来源已作废:先于落点判定吞掉(返回 true)。落点判定按当前选区排除「落回自己」—— 选区已经退化到
            // 别的块(被拖块删了、后面紧跟分隔线 → 块选区落到分隔线上),排除的是它,PM 缺省 drop 就会删掉它、插回旧切片。
            if (tracked && !live) {
              event.preventDefault()
              clearDragSource(view)
              return true
            }
            const t = pick(view, [event.clientX, event.clientY], event)
            if (t) {
              event.preventDefault()
              if (!performDrop(view, t[0], move, { transformPasted: true })) clearDragSource(view)
              return true
            }
            // PM 自己起的节点拖拽、落点插件没给目标:照 PM 缺省 drop 的落点(dropPoint),但搬的是现内容、删的是现位置
            // (缺省 drop 插缓存切片)。⠿ 起的拖拽不归这里 —— dropGuard 吞掉(没线就不落)。
            if (!live || live.kind !== 'node' || view.dom.dataset.dragging === 'true') return false
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
            if (!at) return false
            const doc = view.state.doc
            const insertPos = dropPoint(doc, at.pos, NodeSelection.create(doc, live.from).content()) ?? at.pos
            event.preventDefault()
            performDrop(view, insertPos, move, { transformPasted: true })
            return true
          },
        },
      })
    },
  }
}
