import { useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { SelectField } from '../../components/SelectField'
import { type StudioImage, validCrop } from './model'
import type { Box } from '../../amadeus/unified/canvasKit/geometry'
import { useBlobUrl } from './useImages'

export function CropEditor({ image, onApply, onCancel }: { image: StudioImage; onApply(crop: Box): void; onCancel(): void }) {
  const { t } = useI18n(), src = useBlobUrl(image.blob)
  const [crop, setCrop] = useState<Box>(image.crop || { x: 0, y: 0, w: image.width, h: image.height })
  const [ratioPick, setRatioPick] = useState('')
  const drag = useRef<{ pointer: number; x: number; y: number; base: Box; edge: string; sx: number; sy: number } | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const clamp = (b: Box): Box => {
    const x = Math.max(0, Math.min(image.width - 1, Math.round(b.x))), y = Math.max(0, Math.min(image.height - 1, Math.round(b.y)))
    return { x, y, w: Math.max(1, Math.min(image.width - x, Math.round(b.w))), h: Math.max(1, Math.min(image.height - y, Math.round(b.h))) }
  }
  return <div className="ims-crop" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}>
    <h4>{t('imageStudio.crop')}</h4><p>{t('imageStudio.cropHint')}</p>
    <div ref={host} className="ims-crop-stage" style={{ aspectRatio: image.width / image.height }} onPointerDown={e => {
      const rect = e.currentTarget.getBoundingClientRect(), edge = (e.target as HTMLElement).dataset.edge || 'move'
      drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, base: crop, edge, sx: image.width / rect.width, sy: image.height / rect.height }
      e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault()
    }} onPointerMove={e => {
      const d = drag.current
      if (!d || d.pointer !== e.pointerId) return
      const dx = (e.clientX - d.x) * d.sx, dy = (e.clientY - d.y) * d.sy, b = d.base
      if (d.edge === 'move') setCrop(clamp({ ...b, x: Math.max(0, Math.min(image.width - b.w, b.x + dx)), y: Math.max(0, Math.min(image.height - b.h, b.y + dy)) }))
      else {
        const left = d.edge.includes('w') ? Math.max(0, Math.min(b.x + b.w - 1, b.x + dx)) : b.x
        const top = d.edge.includes('n') ? Math.max(0, Math.min(b.y + b.h - 1, b.y + dy)) : b.y
        const right = d.edge.includes('e') ? Math.min(image.width, Math.max(b.x + 1, b.x + b.w + dx)) : b.x + b.w
        const bottom = d.edge.includes('s') ? Math.min(image.height, Math.max(b.y + 1, b.y + b.h + dy)) : b.y + b.h
        setCrop(clamp({ x: left, y: top, w: right - left, h: bottom - top }))
      }
    }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      {src && <img src={src} alt={image.name} draggable={false} />}
      <div className="ims-crop-box" style={{ left: `${crop.x / image.width * 100}%`, top: `${crop.y / image.height * 100}%`, width: `${crop.w / image.width * 100}%`, height: `${crop.h / image.height * 100}%` }}>
        {['nw', 'ne', 'sw', 'se'].map(edge => <span key={edge} data-edge={edge} className={`ims-crop-handle ${edge}`} />)}
      </div>
    </div>
    {/* 比例是「套一下」的动作,不是持久值:选中的项只用来显示;空串是占位,选它不动裁剪框。 */}
    <SelectField size="sm" field="ims-crop-ratio" ariaLabel={t('imageStudio.cropRatio')} value={ratioPick} onChange={v => {
      if (!v) return
      setRatioPick(v)
      const ratio = Number(v) || image.width / image.height
      const w = Math.min(image.width, image.height * ratio), h = w / ratio
      setCrop(clamp({ x: (image.width - w) / 2, y: (image.height - h) / 2, w, h }))
    }} options={[{ value: '', label: t('imageStudio.cropRatio') }, { value: '0', label: t('imageStudio.original') },
      ...([[1, '1:1'], [.8, '4:5'], [2 / 3, '2:3'], [16 / 9, '16:9'], [9 / 16, '9:16']] as const).map(([value, name]) => ({ value: String(value), label: name }))]} />
    <div className="ims-fields">{(['x', 'y', 'w', 'h'] as const).map(key => <label key={key}>{t(`imageStudio.${key}`)}<input type="number" aria-label={t(`imageStudio.crop.${key}`)} value={crop[key]} min={key === 'x' || key === 'y' ? 0 : 1} max={key === 'x' || key === 'w' ? image.width : image.height} onChange={e => setCrop(clamp({ ...crop, [key]: Number(e.target.value) || 0 }))} /></label>)}</div>
    <div className="ims-button-row"><button onClick={onCancel}>{t('imageStudio.cancel')}</button><button className="ims-primary" disabled={!validCrop(crop, image.width, image.height)} onClick={() => onApply(crop)}>{t('imageStudio.applyCrop')}</button></div>
  </div>
}
