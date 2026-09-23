import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Maximize2, PanelRight, Square, X } from 'lucide-react'
import { registerMessages, useI18n } from '../../../i18n'
import { OverlayPortal } from '../../lib/overlayPortal'
import './rowPeek.css'

// Loading on demand also keeps the database/editor embedding dependency out of module initialization.
const BodyEditor = lazy(() => import('../markdown/MarkdownBlock').then((m) => ({ default: m.PlainMarkdownEditor })))

registerMessages({
  'dbpeek.close': { zh: '关闭记录', en: 'Close record' },
  'dbpeek.previous': { zh: '上一条记录', en: 'Previous record' },
  'dbpeek.next': { zh: '下一条记录', en: 'Next record' },
  'dbpeek.side': { zh: '侧边预览', en: 'Side peek' },
  'dbpeek.center': { zh: '居中预览', en: 'Center peek' },
  'dbpeek.full': { zh: '展开预览', en: 'Expand preview' },
  'dbpeek.content': { zh: '页面内容', en: 'Page content' },
  'dbpeek.empty': { zh: '在这里写下这条记录的详细内容…', en: 'Write more about this record…' },
  'dbpeek.loading': { zh: '载入内容…', en: 'Loading content…' },
})

export type RowPeekMode = 'side' | 'center' | 'full'

/** A record stays open while properties change, even when it no longer matches the current filter. */
export function RowPeek({ title, databaseName, mode, onModeChange, onClose, onPrevious, onNext, children,
  body, bodyKey, onBodyChange, readOnly = false }: {
  title: string
  databaseName: string
  mode: RowPeekMode
  onModeChange: (mode: RowPeekMode) => void
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
  children: ReactNode
  body?: string
  bodyKey: string
  onBodyChange?: (body: string) => void
  readOnly?: boolean
}) {
  const { t } = useI18n()
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(frame)
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
    }
  }, [])
  const close = (): void => {
    // Pointer-down can unmount a property input before its native blur fires.
    // Dispatch blur while it is still mounted so its draft reaches the store first.
    const active = document.activeElement
    if (active instanceof HTMLElement && panel.current?.contains(active)) active.blur()
    onClose()
  }
  return <OverlayPortal>
    <div className="amx-db-peek-shade" data-mode={mode} contentEditable={false}
      onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close() }}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.defaultPrevented || e.nativeEvent.isComposing) return
        if (e.key === 'Escape') { e.preventDefault(); close(); return }
        if (mode === 'side' || e.key !== 'Tab' || !panel.current?.contains(e.target as Node)) return
        const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]'))
          .filter((el) => el.getClientRects().length && el.getAttribute('aria-hidden') !== 'true')
        const first = controls[0], last = controls[controls.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          e.preventDefault(); last?.focus()
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) {
          e.preventDefault(); first?.focus()
        }
      }}>
      <div ref={panel} className="amx-db-peek" role="dialog" aria-modal={mode !== 'side'} aria-label={title} tabIndex={-1}>
        <div className="amx-db-peek-toolbar">
          <button type="button" title={t('dbpeek.close')} aria-label={t('dbpeek.close')} onClick={close}><X size={17} /></button>
          <span className="amx-db-peek-crumb">{databaseName}</span>
          <button type="button" title={t('dbpeek.previous')} aria-label={t('dbpeek.previous')} disabled={!onPrevious} onClick={onPrevious}><ArrowUp size={16} /></button>
          <button type="button" title={t('dbpeek.next')} aria-label={t('dbpeek.next')} disabled={!onNext} onClick={onNext}><ArrowDown size={16} /></button>
          <span className="amx-db-peek-divider" />
          {([{ id: 'side', icon: PanelRight }, { id: 'center', icon: Square }, { id: 'full', icon: Maximize2 }] as const).map(({ id, icon: Icon }) =>
            <button type="button" key={id} title={t(`dbpeek.${id}`)} aria-label={t(`dbpeek.${id}`)} aria-pressed={mode === id} onClick={() => onModeChange(id)}><Icon size={16} /></button>)}
        </div>
        <div className="amx-db-peek-scroll">
          <h1 className="amx-db-peek-title">{title}</h1>
          <div className="amx-db-peek-properties">{children}</div>
          {(onBodyChange || body !== undefined) && <section className="amx-db-peek-body" aria-label={t('dbpeek.content')}>
            {!body && !readOnly && <p className="amx-db-peek-hint">{t('dbpeek.empty')}</p>}
            <Suspense fallback={<p className="amx-db-peek-hint">{t('dbpeek.loading')}</p>}>
              <BodyEditor key={bodyKey} initial={body ?? ''} onChange={(value) => onBodyChange?.(value)} readOnly={readOnly || !onBodyChange} immediate />
            </Suspense>
          </section>}
        </div>
      </div>
    </div>
  </OverlayPortal>
}
