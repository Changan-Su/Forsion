import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { usePageStore } from '../store/pageStore'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'colresizer.dragHint': { zh: '拖动调整列宽', en: 'Drag to resize columns' },
})

/** Draggable divider between two adjacent columns; sets their relative widths. */
export function ColumnResizer({
  rowId,
  leftColId,
  rightColId,
}: {
  rowId: string
  leftColId: string
  rightColId: string
}) {
  const resizeColumns = usePageStore((s) => s.resizeColumns)
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)

  const onPointerDown = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const rowEl = ref.current?.closest('.row-cols')
    if (!rowEl) return

    const move = (ev: PointerEvent): void => {
      const leftEl = rowEl.querySelector<HTMLElement>(`[data-col="${leftColId}"]`)
      const rightEl = rowEl.querySelector<HTMLElement>(`[data-col="${rightColId}"]`)
      if (!leftEl || !rightEl) return
      const start = leftEl.getBoundingClientRect().left
      const end = rightEl.getBoundingClientRect().right
      if (end <= start) return
      resizeColumns(rowId, leftColId, rightColId, (ev.clientX - start) / (end - start))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return <div ref={ref} className="col-resizer" onPointerDown={onPointerDown} title={t('colresizer.dragHint')} />
}
