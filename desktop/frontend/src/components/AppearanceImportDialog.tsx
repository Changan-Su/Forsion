import { useEffect, useRef, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { AppearanceImportError, DEFAULT_FRAMING, drawAppearanceImage, encodeAppearanceImport, type ImageFraming, type ImportedAppearance } from '../appearance/imageImport'
import type { AppearanceAsset } from '../../../shared/startupAppearance'

export function AppearanceImportDialog({ image, slot, onApply, onCancel }: {
  image: ImportedAppearance
  slot: 'icon' | 'splash'
  onApply(asset: AppearanceAsset): Promise<void>
  onCancel(): void
}) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const preview = useRef<HTMLCanvasElement>(null)
  const thumbnail = useRef<HTMLCanvasElement>(null)
  const [framing, setFraming] = useState<ImageFraming>(DEFAULT_FRAMING)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; framing: ImageFraming } | null>(null)
  const keepsAnimation = slot === 'splash' && !!image.original && framing.mode === 'fit'
  useEffect(() => {
    const el = dialog.current!
    el.showModal()
    return () => el.close()
  }, [])
  useEffect(() => {
    for (const el of [preview.current, thumbnail.current]) {
      const ctx = el?.getContext('2d')
      if (el && ctx) drawAppearanceImage(ctx, image.source, framing, el.width)
    }
  }, [image, framing])
  const apply = async (): Promise<void> => {
    setSaving(true); setError(null)
    let asset: AppearanceAsset
    try { asset = encodeAppearanceImport(image, slot, framing) }
    catch (e) {
      setError(e instanceof AppearanceImportError ? `startupAppearance.error.${e.reason}` : 'startupAppearance.error.encode')
      setSaving(false); return
    }
    try { await onApply(asset) }
    catch { setError('startupAppearance.error.save') }
    finally { setSaving(false) }
  }
  const move = (x: number, y: number): void => setFraming((s) => ({ ...s, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }))
  return <dialog ref={dialog} className="appearance-import" aria-labelledby="appearance-import-title" aria-describedby="appearance-import-hint"
    onCancel={(e) => { e.preventDefault(); if (!saving) onCancel() }}
    onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation() }}>
    <header className="appearance-import-head">
      <div><strong id="appearance-import-title">{t(slot === 'icon' ? 'startupAppearance.importIcon' : 'startupAppearance.importSplash')}</strong><p title={image.name}>{image.name} · {image.width} × {image.height}</p></div>
      <button type="button" className="btn ghost sm" disabled={saving} aria-label={t('startupAppearance.cancel')} onClick={onCancel}><X size={15} /></button>
    </header>
    <fieldset disabled={saving} className="appearance-import-body">
      <div className="seg appearance-import-modes" role="group" aria-label={t('startupAppearance.framing')}>
        {(['fit', 'crop'] as const).map((mode) => <button key={mode} type="button" className={framing.mode === mode ? 'active' : ''} aria-pressed={framing.mode === mode}
          onClick={() => setFraming({ ...DEFAULT_FRAMING, mode })}>{t(`startupAppearance.${mode}`)}</button>)}
      </div>
      <div className={`appearance-import-stage${framing.mode === 'crop' ? ' is-cropping' : ''}`}
        tabIndex={framing.mode === 'crop' && !saving ? 0 : undefined} role={framing.mode === 'crop' ? 'group' : undefined}
        aria-label={t('startupAppearance.cropArea')} aria-describedby="appearance-import-hint"
        onPointerDown={(e) => {
          if (framing.mode !== 'crop' || saving || e.button !== 0) return
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, framing }
          e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus(); e.preventDefault()
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.id !== e.pointerId || saving) return
          const rect = e.currentTarget.getBoundingClientRect()
          const side = Math.min(image.source.width, image.source.height) / d.framing.zoom
          const dx = (e.clientX - d.x) * side / rect.width, dy = (e.clientY - d.y) * side / rect.height
          move(image.source.width > side ? d.framing.x - dx / (image.source.width - side) : 0.5,
            image.source.height > side ? d.framing.y - dy / (image.source.height - side) : 0.5)
        }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
        onKeyDown={(e) => {
          if (framing.mode !== 'crop' || saving || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
          e.preventDefault(); e.stopPropagation()
          const step = e.shiftKey ? 0.1 : 0.02
          move(framing.x + (e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0), framing.y + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0))
        }}>
        <canvas ref={preview} width={512} height={512} style={{ visibility: keepsAnimation ? 'hidden' : undefined }} aria-hidden="true" />
        {keepsAnimation && <img src={image.original} alt="" draggable={false} />}
        {framing.mode === 'crop' && <div className="appearance-import-grid" aria-hidden="true" />}
      </div>
      {framing.mode === 'crop' && <div className="appearance-import-zoom">
        <label htmlFor="appearance-import-zoom">{t('startupAppearance.zoom')}</label>
        <input id="appearance-import-zoom" type="range" min="1" max="4" step="0.01" value={framing.zoom} onChange={(e) => setFraming((s) => ({ ...s, zoom: Number(e.target.value) }))} />
        <button type="button" className="btn ghost sm" title={t('startupAppearance.resetCrop')} aria-label={t('startupAppearance.resetCrop')} onClick={() => setFraming({ ...DEFAULT_FRAMING, mode: 'crop' })}><RotateCcw size={14} /></button>
      </div>}
      <p id="appearance-import-hint" className="appearance-import-hint">{t(framing.mode === 'crop' ? 'startupAppearance.cropHint' : 'startupAppearance.fitHint')}</p>
      <div className="appearance-import-result">
        <canvas ref={thumbnail} width={64} height={64} aria-hidden="true" />
        <p>{t(slot === 'icon' ? 'startupAppearance.iconOutput' : 'startupAppearance.splashOutput')}
          {image.animated && <span>{t(keepsAnimation ? 'startupAppearance.animationKept' : 'startupAppearance.animationStill')}</span>}
        </p>
      </div>
    </fieldset>
    {error && <p role="alert" className="appearance-import-error">{t(error)}</p>}
    <footer><button type="button" className="btn ghost sm" disabled={saving} onClick={onCancel}>{t('startupAppearance.cancel')}</button><button type="button" className="btn sm" disabled={saving} onClick={() => { void apply() }}>{t(saving ? 'startupAppearance.saving' : 'startupAppearance.apply')}</button></footer>
  </dialog>
}
