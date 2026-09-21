import { useState } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { downloadBlob, renderBoard, sceneForExport, type ExportFormat } from './files'
import type { ImageBoard } from './model'

export function ExportPanel({ board, selection, onClose }: { board: ImageBoard; selection: string[]; onClose(): void }) {
  const { t } = useI18n()
  const [format, setFormat] = useState<ExportFormat>('png'), [scale, setScale] = useState(1), [background, setBackground] = useState('transparent'), [quality, setQuality] = useState(.92)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const scene = sceneForExport(board, selection), bounds = scene?.bounds
  const width = Math.round((bounds?.w || 0) * scale), height = Math.round((bounds?.h || 0) * scale)
  const invalid = !bounds || width < 1 || height < 1 || width * height > 40_000_000 || Math.max(width, height) > 16384
  return <section className="ims-export ims-panel" aria-label={t('imageStudio.exportOptions')}>
    <div className="ims-section-head"><h3>{t('imageStudio.exportOptions')}</h3><button aria-label={t('imageStudio.close')} onClick={onClose}><X size={15} /></button></div>
    <div className="ims-fields"><label>{t('imageStudio.format')}<select aria-label={t('imageStudio.format')} value={format} onChange={e => setFormat(e.target.value as ExportFormat)}>{['png', 'jpeg', 'webp', 'svg'].map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}</select></label>
      <label>{t('imageStudio.scale')}<select aria-label={t('imageStudio.scale')} value={scale} onChange={e => setScale(Number(e.target.value))}>{[.5, 1, 2, 3].map(s => <option key={s} value={s}>{s}×</option>)}</select></label>
      <label>{t('imageStudio.background')}<select aria-label={t('imageStudio.background')} value={background} onChange={e => setBackground(e.target.value)}><option value="transparent">{t('imageStudio.transparent')}</option><option value="#ffffff">{t('imageStudio.white')}</option><option value="#000000">{t('imageStudio.black')}</option></select></label>
      {(format === 'jpeg' || format === 'webp') && <label>{t('imageStudio.quality')}<input aria-label={t('imageStudio.quality')} type="range" min=".1" max="1" step=".05" value={quality} onChange={e => setQuality(Number(e.target.value))} /></label>}
    </div>
    <p>{width} × {height} px · {t(selection.length ? 'imageStudio.selectedOnly' : 'imageStudio.allVisible')}</p>
    {format === 'svg' && <p>{t('imageStudio.svgHint')}</p>}
    {format === 'jpeg' && background === 'transparent' && <p>{t('imageStudio.jpegHint')}</p>}
    {invalid && <p role="alert">{t('imageStudio.exportLimit')}</p>}
    <button className="ims-primary" disabled={busy || invalid} onClick={async () => {
      setBusy(true); setError('')
      try { downloadBlob(await renderBoard(board, selection, { format, scale, background, quality }), `${board.name}.${format === 'jpeg' ? 'jpg' : format}`) } catch (e) { setError(String(e)) } finally { setBusy(false) }
    }}>{busy ? <Loader2 className="ims-spin" size={15} /> : <Download size={15} />}{t('imageStudio.download')}</button>
    {error && <p role="alert">{t('imageStudio.error', { error })}</p>}
  </section>
}
