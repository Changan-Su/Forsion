import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Columns2 } from 'lucide-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useI18n } from '../../i18n'
import { isCoarsePointer } from '../../touch'
import { OverlayAt } from '../lib/clampMenu'
import { columnWidthPreview, selectedColumnPair, type ColumnWidthPreview } from './columnResize'
import './columnResize.css'

function WidthDialog({ preview, anchor, close }: { preview: ColumnWidthPreview; anchor: HTMLElement; close: () => void }) {
  const { t } = useI18n()
  const [fraction, setFraction] = useState(preview.start)
  const range = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => range.current?.focus({ preventScroll: true }))
    return () => { cancelAnimationFrame(frame); preview.cancel() }
  }, [preview])
  const change = (value: number): void => {
    if (!preview.preview(value)) { close(); return }
    setFraction(preview.fraction)
  }
  const finish = (): void => { preview.commit(); close() }
  const r = anchor.getBoundingClientRect()
  return createPortal(<OverlayAt className="ui-popover amx-column-width" role="dialog" aria-label={t('columnwidth.adjust')}
    x={r.left} y={r.bottom + 6} anchorTop={r.top - 6}
    onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      else if (e.key === 'Enter' && e.target === range.current) { e.preventDefault(); e.stopPropagation(); finish() }
      else if (e.target === range.current && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault(); e.stopPropagation(); change(fraction + (e.key === 'ArrowRight' ? .05 : -.05))
      }
    }}>
    <div className="amx-column-width-title">{t('columnwidth.adjust')}</div>
    <div className="amx-column-width-values"><span>{t('columnwidth.pair', { left: preview.index + 1, right: preview.index + 2 })}</span><output>{Math.round(fraction * 100)} : {100 - Math.round(fraction * 100)}</output></div>
    <input ref={range} type="range" min="15" max="85" step="1" value={fraction * 100} aria-label={t('columnwidth.adjust')}
      aria-valuetext={`${Math.round(fraction * 100)} : ${100 - Math.round(fraction * 100)}`} onChange={(e) => change(Number(e.target.value) / 100)} />
    <div className="amx-column-width-actions">
      <button onClick={() => change(.5)}>{t('columnwidth.equal')}</button>
      <button onClick={close}>{t('columnwidth.cancel')}</button>
      <button onClick={finish}>{t('columnwidth.done')}</button>
    </div>
  </OverlayAt>, document.body)
}

export function ColumnWidthMenu({ view, restore, onDone }: { view: EditorView; restore: () => boolean; onDone: () => void }) {
  const { t } = useI18n()
  const [opened, setOpened] = useState<{ anchor: HTMLElement; preview: ColumnWidthPreview } | null>(null)
  if (!selectedColumnPair(view)) return null
  return <>
    <button role="menuitem" tabIndex={-1} data-act="columnWidth" aria-haspopup="dialog" onClick={(e) => {
      if (!restore()) { onDone(); return }
      const pair = selectedColumnPair(view)
      const preview = pair && columnWidthPreview(view, pair.row, pair.index)
      if (preview) setOpened({ anchor: e.currentTarget, preview })
    }}><Columns2 size={13} />{t('columnwidth.adjust')}</button>
    {opened && <WidthDialog {...opened} close={() => { setOpened(null); onDone(); if (!isCoarsePointer()) view.focus() }} />}
  </>
}
