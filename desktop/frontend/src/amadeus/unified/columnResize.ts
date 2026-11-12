import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { closeHistory } from '@milkdown/kit/prose/history'
import { zoomOf } from '@lcl/engine'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'columnwidth.adjust': { zh: '调整列宽', en: 'Adjust column widths' },
  'columnwidth.drag': { zh: '左右拖动调列宽', en: 'Drag sideways to resize columns' },
  'columnwidth.pair': { zh: '第 {left} 列 / 第 {right} 列', en: 'Column {left} / column {right}' },
  'columnwidth.equal': { zh: '均分', en: 'Equal widths' },
  'columnwidth.done': { zh: '完成', en: 'Done' },
  'columnwidth.cancel': { zh: '取消', en: 'Cancel' },
})

const clamp = (fraction: number): number => Math.min(.85, Math.max(.15, fraction))
export const columnCells = (row: HTMLElement): HTMLElement[] => Array.from(row.children).filter((e): e is HTMLElement => e instanceof HTMLElement && e.hasAttribute('data-amx-colcell'))

/** A preview owns only two presentation effects. It never writes a stale row over concurrent edits. */
export function columnWidthPreview(view: EditorView, row: HTMLElement, index: number) {
  const cells = columnCells(row), left = cells[index], right = cells[index + 1]
  let node: ProseNode | undefined
  const position = (): number => view.posAtDOM(row, 0) - 1
  try { node = view.state.doc.nodeAt(position()) ?? undefined } catch { return null }
  if (!view.editable || !left || !right || node?.type.name !== 'amadeusColumnRow' || index + 1 >= node.childCount) return null
  const original = node
  const a = Number(original.child(index).attrs.width) || 1, b = Number(original.child(index + 1).attrs.width) || 1
  const sum = a + b, start = a / sum
  let fraction = start
  let leftEffect: Animation | null = null, rightEffect: Animation | null = null
  const valid = (): boolean => {
    try { return !view.isDestroyed && view.editable && row.isConnected && view.state.doc.nodeAt(position()) === original } catch { return false }
  }
  const restore = (): void => {
    leftEffect?.cancel(); rightEffect?.cancel()
    leftEffect = null; rightEffect = null
  }
  const effect = (el: HTMLElement, current: Animation | null, width: number): Animation => {
    // Writing style attributes inside PM content triggers DOMObserver, which redraws the saved width
    // during a drag. A zero-duration presentation effect previews without mutating document DOM.
    const frames = [{ flexGrow: String(width) }, { flexGrow: String(width) }]
    if (current) { (current.effect as KeyframeEffect).setKeyframes(frames); return current }
    return el.animate(frames, { fill: 'forwards' }) // default zero duration: presentation only, no tween
  }
  return {
    row, index, left, right, start, valid,
    get fraction() { return fraction },
    preview(value: number): boolean {
      if (!Number.isFinite(value) || !valid()) { restore(); return false }
      fraction = clamp(value)
      leftEffect = effect(left, leftEffect, sum * fraction)
      rightEffect = effect(right, rightEffect, sum * (1 - fraction))
      return true
    },
    cancel: restore,
    commit(): boolean {
      if (!valid()) { restore(); return false }
      restore()
      if (Math.abs(fraction - start) < .00001) return true
      let at = position() + 1
      let tr = closeHistory(view.state.tr)
      for (let i = 0; i < original.childCount; i++) {
        const cell = original.child(i)
        if (i === index || i === index + 1) tr = tr.setNodeMarkup(at, undefined, { ...cell.attrs, width: Math.round(sum * (i === index ? fraction : 1 - fraction) * 10000) / 10000 })
        at += cell.nodeSize
      }
      // Resizing must not dissolve an intentionally empty column.
      view.dispatch(tr.setMeta('amxColumns', true).setMeta('amxColumnsKeepEmpty', true))
      return true
    },
  }
}
export type ColumnWidthPreview = NonNullable<ReturnType<typeof columnWidthPreview>>

export function selectedColumnPair(view: EditorView): { row: HTMLElement; index: number } | null {
  const p = view.state.selection.$from
  for (let d = p.depth; d > 0; d--) {
    if (p.node(d).type.name !== 'amadeusColumnRow') continue
    const row = view.nodeDOM(p.before(d))
    const index = Math.min(p.index(d), p.node(d).childCount - 2)
    return row instanceof HTMLElement && index >= 0 ? { row, index } : null
  }
  return null
}

/** Pointer-only affordance outside PM content; touch uses the column menu instead. */
export function installColumnResize(view: EditorView, container: HTMLElement, root: HTMLElement, origin: (el: HTMLElement) => { x: number; y: number }) {
  const line = document.createElement('div'), hint = document.createElement('span')
  line.className = 'amx-column-boundary'; line.setAttribute('aria-hidden', 'true')
  line.append(hint); container.append(line)
  let hovered: { row: HTMLElement; index: number } | null = null
  let active: ColumnWidthPreview | null = null, pointerId: number | null = null
  let captured: HTMLElement | null = null
  let y = 0, startX = 0, pixels = 1
  const hide = (): void => { line.removeAttribute('data-visible'); hovered = null }
  const paint = (): void => {
    const pair = active ?? hovered
    if (!pair || !pair.row.isConnected) { hide(); return }
    const cells = columnCells(pair.row), l = cells[pair.index], r = cells[pair.index + 1]
    if (!l || !r) { hide(); return }
    const rowRect = pair.row.getBoundingClientRect(), seam = (l.getBoundingClientRect().right + r.getBoundingClientRect().left) / 2
    const z = zoomOf(line), o = origin(line)
    line.style.left = `${(seam - o.x) / z}px`
    line.style.top = `${(rowRect.top - o.y) / z}px`
    line.style.height = `${rowRect.height / z}px`
    hint.style.top = `${Math.max(0, Math.min(rowRect.height - 24 * z, y - rowRect.top)) / z}px`
    hint.textContent = active ? `${Math.round(active.fraction * 100)} : ${100 - Math.round(active.fraction * 100)}` : translate('columnwidth.drag')
    hint.style.left = seam + 180 * z > root.getBoundingClientRect().right ? 'auto' : '10px'
    hint.style.right = hint.style.left === 'auto' ? '10px' : 'auto'
    line.dataset.visible = 'true'
  }
  const hit = (e: PointerEvent): typeof hovered => {
    if (!view.editable || e.pointerType === 'touch' || e.buttons || view.dragging) return null
    const row = e.target
    if (!(row instanceof HTMLElement) || !row.classList.contains('amx-ucolrow') || !view.dom.contains(row)) return null
    const cells = columnCells(row)
    for (let index = 0; index + 1 < cells.length; index++) {
      if (e.clientX >= cells[index].getBoundingClientRect().right && e.clientX <= cells[index + 1].getBoundingClientRect().left) return { row, index }
    }
    return null
  }
  const hover = (e: PointerEvent): void => {
    if (active) return
    hovered = hit(e); y = e.clientY
    if (hovered) paint(); else hide()
  }
  const stop = (commit: boolean): void => {
    const preview = active
    const id = pointerId, capture = captured
    active = null; pointerId = null
    captured = null
    try { if (id != null && capture?.hasPointerCapture(id)) capture.releasePointerCapture(id) } catch { /* detached */ }
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancelPointer, true)
    window.removeEventListener('lostpointercapture', cancelPointer, true)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('blur', cancel)
    hide()
    if (preview) { if (commit) preview.commit(); else preview.cancel() }
  }
  const cancel = (): void => stop(false)
  const cancelPointer = (e: PointerEvent): void => { if (e.pointerId === pointerId) cancel() }
  const move = (e: PointerEvent): void => {
    if (!active || e.pointerId !== pointerId) return
    if (!active.preview(active.start + (e.clientX - startX) / pixels)) { cancel(); return }
    e.preventDefault(); y = e.clientY; paint()
  }
  const up = (e: PointerEvent): void => { if (e.pointerId === pointerId) stop(true) }
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel() }
  }
  const down = (e: PointerEvent): void => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    // pointerdown has buttons=1; reuse the last geometric hit without relying on a preceding move.
    const row = e.target
    if (!(row instanceof HTMLElement) || !row.classList.contains('amx-ucolrow') || !view.dom.contains(row)) return
    const cells = columnCells(row)
    const index = cells.findIndex((cell, i) => i + 1 < cells.length && e.clientX >= cell.getBoundingClientRect().right && e.clientX <= cells[i + 1].getBoundingClientRect().left)
    if (index < 0) return
    stop(false)
    active = columnWidthPreview(view, row, index)
    if (!active) return
    e.preventDefault(); e.stopPropagation()
    pointerId = e.pointerId; startX = e.clientX; y = e.clientY
    try { row.setPointerCapture(e.pointerId); captured = row } catch { /* synthetic pointer in a harness */ }
    pixels = active.left.getBoundingClientRect().width + active.right.getBoundingClientRect().width
    paint()
    window.addEventListener('pointermove', move, { capture: true, passive: false })
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancelPointer, true)
    window.addEventListener('lostpointercapture', cancelPointer, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancel)
  }
  const leave = (): void => { if (!active) hide() }
  const scroll = (): void => { if (active) paint(); else hide() }
  root.addEventListener('pointermove', hover)
  root.addEventListener('pointerleave', leave)
  container.addEventListener('pointerdown', down)
  window.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', scroll)
  return {
    update(): void { if (active && !active.valid()) cancel(); else if (!view.editable) hide() },
    destroy(): void {
      cancel(); line.remove()
      root.removeEventListener('pointermove', hover)
      root.removeEventListener('pointerleave', leave)
      container.removeEventListener('pointerdown', down)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', scroll)
    },
  }
}
