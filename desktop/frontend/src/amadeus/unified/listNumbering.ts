import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { NodeSelection, type EditorState } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'

export interface NumberedList { pos: number; node: ProseNode; previousStart: number | null }

/** Explicit continuation is a snapshot of the previous sibling list's end.
 * Never cross a parent, visual indent, heading, or horizontal rule. */
export function numberedListAt(state: EditorState): NumberedList | null {
  const sel = state.selection
  let pos: number | null = sel instanceof NodeSelection && sel.node.type.name === 'ordered_list' ? sel.from : null
  if (pos == null) for (let d = sel.$from.depth; d > 0; d--) {
    if (sel.$from.node(d).type.name === 'ordered_list') { pos = sel.$from.before(d); break }
  }
  if (pos == null) return null
  const node = state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'ordered_list') return null
  const $pos = state.doc.resolve(pos)
  let previousStart: number | null = null
  for (let i = $pos.index() - 1; i >= 0; i--) {
    const prior = $pos.parent.child(i)
    if (prior.type.name === 'heading' || prior.type.name === 'hr' || prior.type.name === 'horizontal_rule') break
    if (prior.type.name !== 'ordered_list' || Number(prior.attrs.indent ?? 0) !== Number(node.attrs.indent ?? 0)) continue
    const start = Number(prior.attrs.order ?? 1) + prior.childCount
    previousStart = validListStart(start) ? start : null
    break
  }
  return { pos, node, previousStart }
}

export const validListStart = (value: number): boolean => Number.isSafeInteger(value) && value >= 1 && value <= 999999999

export function setListStart(view: EditorView, list: NumberedList, start: number): boolean {
  if (!view.editable || !validListStart(start) || view.state.doc.nodeAt(list.pos) !== list.node) return false
  if (list.node.attrs.order === start) return true
  view.dispatch(closeHistory(view.state.tr).setNodeMarkup(list.pos, undefined, { ...list.node.attrs, order: start }))
  return true
}

/** CSS list markers are not DOM nodes. Only the first line's gutter belongs to
 * the number; right-clicking actual text must keep the system editing menu. */
export function numberedMarkerAt(view: EditorView, event: { target: EventTarget | null; clientX: number; clientY: number }): number | null {
  const target = event.target instanceof Element ? event.target : null
  if (!target || !view.editable) return null
  let li: Element | null = target.closest('li')
  if (!li && target.matches('ol')) {
    li = [...target.children].find((child) => {
      const r = child.getBoundingClientRect()
      return child.tagName === 'LI' && event.clientY >= r.top && event.clientY <= r.bottom
    }) ?? null
  }
  if (!li || li.parentElement?.tagName !== 'OL' || li.hasAttribute('data-checked') || !view.dom.contains(li)) return null
  const first = li.querySelector(':scope > p') ?? li
  const r = first.getBoundingClientRect()
  const style = getComputedStyle(first)
  const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5
  const scale = first instanceof HTMLElement && first.offsetHeight ? r.height / first.offsetHeight : 1
  if (event.clientX >= r.left || event.clientX < r.left - 70 * scale || event.clientY < r.top || event.clientY > r.top + line * scale) return null
  const $pos = view.state.doc.resolve(view.posAtDOM(li, 0))
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'ordered_list') return $pos.before(d)
  return null
}

export function installNumberedMarkerLongPress(view: EditorView, open: (pos: number, x: number, y: number) => void): () => void {
  let timer = 0
  let origin: { id: number; x: number; y: number } | null = null
  const clear = (): void => { window.clearTimeout(timer); timer = 0; origin = null }
  const down = (event: PointerEvent): void => {
    clear()
    if (event.pointerType === 'mouse') return
    const pos = numberedMarkerAt(view, event)
    if (pos == null) return
    const doc = view.state.doc
    origin = { id: event.pointerId, x: event.clientX, y: event.clientY }
    timer = window.setTimeout(() => {
      if (!view.isDestroyed && view.state.doc === doc && origin) open(pos, origin.x, origin.y)
      clear()
    }, 500)
  }
  const move = (event: PointerEvent): void => {
    if (origin && (event.pointerId !== origin.id || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8)) clear()
  }
  view.dom.addEventListener('pointerdown', down)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', clear)
  window.addEventListener('pointercancel', clear)
  return () => {
    clear()
    view.dom.removeEventListener('pointerdown', down)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', clear)
    window.removeEventListener('pointercancel', clear)
  }
}
