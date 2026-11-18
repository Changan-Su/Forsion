/** 块拖拽的精确落点 + 落点线。改自 prosemirror-drop-indicator 0.1.4(MIT License, Copyright (c) 2025 ocavue)。
 *
 *  和原库的差别(页面编辑手感方案 2026-11-17 第 1、2 条):
 *  - **不按坐标缓存落点**。原库「坐标没变 = 沿用上次的落点」,dragover 开头还有一道同坐标直接 return:
 *    贴边自动滚动时指针不动、内容在指针下滚过去,线停在滚动前,drop 也落回滚动前那条缝(实测偏 ~290px)。
 *    目标线段仍按 view.dom 的矩形 + doc 缓存 —— 滚动会让矩形变,自然重算。
 *  - 对外给 `evaluate` / `targetAt`:左右页边(view.dom 之外,库的监听收不到)按钳进正文的坐标判定、
 *    按帧自动滚动之后原地重判,都走这一份,与正文里同源。
 *  - `performDrop` 抽成函数:页边松手和插件 handleDrop 共用一套「删 + 插 + 选中」。
 *  - onDrag 多给一个 `point`(判定用的坐标);`event.clientX/Y` 仍是指针真坐标。 */
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { Selection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { ResolvedPos, Slice } from '@milkdown/kit/prose/model'

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

/** 把拖着的 slice 放到 insertPos(move = 原位删掉)。原库 handleDrop 的主体。 */
export function performDrop(view: EditorView, insertPos: number, slice: Slice, move: boolean): void {
  const tr = view.state.tr
  if (move) {
    const node = (view.dragging as { node?: { replace(tr: unknown): void } } | null)?.node
    if (node) node.replace(tr)
    else tr.deleteSelection()
  }
  const pos = tr.mapping.map(insertPos)
  const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
  const beforeInsert = tr.doc
  if (isNode) tr.replaceRangeWith(pos, pos, slice.content.firstChild!)
  else tr.replaceRange(pos, pos, slice)
  if (tr.doc.eq(beforeInsert)) return
  const $pos = tr.doc.resolve(pos)
  if (isNode && NodeSelection.isSelectable(slice.content.firstChild!) && $pos.nodeAfter && $pos.nodeAfter.sameMarkup(slice.content.firstChild!)) {
    tr.setSelection(new NodeSelection($pos))
  } else {
    let end = tr.mapping.map(insertPos)
    tr.mapping.maps[tr.mapping.maps.length - 1].forEach((_from, _to, _newFrom, newTo) => { end = newTo })
    tr.setSelection(selectionBetween(view, $pos, tr.doc.resolve(end)))
  }
  view.focus()
  view.dispatch(tr.setMeta('uiEvent', 'drop'))
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
    createPlugin: () => new Plugin({
      key: new PluginKey('UNIFIED_DROP_TARGETS'),
      view: (view) => {
        const dom = view.dom
        const onOver = (e: DragEvent): void => { evaluate(view, [e.clientX, e.clientY], e) }
        const onOut = (): void => scheduleHide(view)
        dom.addEventListener('dragover', onOver)
        dom.addEventListener('dragend', onOut)
        dom.addEventListener('drop', onOut)
        dom.addEventListener('dragleave', onOut)
        return {
          destroy: () => {
            dom.removeEventListener('dragover', onOver)
            dom.removeEventListener('dragend', onOut)
            dom.removeEventListener('drop', onOut)
            dom.removeEventListener('dragleave', onOut)
            const s = hideTimers.get(view)
            if (s?.id) clearTimeout(s.id)
            cache.delete(view)
          },
        }
      },
      props: {
        handleDrop(view, event, slice, move) {
          const t = pick(view, [event.clientX, event.clientY], event)
          if (!t) return false
          event.preventDefault()
          performDrop(view, t[0], slice, move)
          return true
        },
      },
    }),
  }
}
