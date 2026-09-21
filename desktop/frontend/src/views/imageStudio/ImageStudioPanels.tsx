import { useEffect, useState } from 'react'
import { Images, MessageCircle, Download, Copy, Plus, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, Crop, Loader2, Eye, EyeOff, Lock, Unlock, ArrowUp, ArrowDown, Trash2, GitBranch } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { useI18n } from '../../i18n'
import { useImageStudio } from '../../stores/imageStudioStore'
import { useApp } from '../../stores/appStore'
import { ChatView } from '../ChatView'
import { ensureImageSession } from './session'
import { downloadBlob, renderImages } from './files'
import { LayerPreview } from './LayerPreview'
import { CropEditor } from './CropEditor'
import { AIEditPanel } from './AIEditPanel'
import { pasteSelection, referenceSelection, removeSelection } from './actions'
import { alignItems, itemKind } from './scene'
import { boardItems, isImage, mapItems, moveItems, reorderItems, transformImage, imageSize, type StudioImage, type StudioItem, type StudioElement } from './model'
import './messages'
import './imageStudio.css'

export function ImageStudioChat(props: ViewProps) {
  const { t } = useI18n()
  const board = useImageStudio(s => s.activeId ? s.boards[s.activeId] : undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void useImageStudio.getState().hydrate() }, [])
  useEffect(() => { if (board?.sessionId) void useApp.getState().loadSessionHistory(board.sessionId) }, [board?.sessionId])
  if (board?.sessionId) return <div className="ims-chat" data-image-studio-chat={board.id}>
    <ChatView key={board.sessionId} {...props} params={{ ...props.params, followActive: false, sessionId: board.sessionId, childSurface: true }} />
  </div>
  return <div className="ims-panel ims-chat-empty"><MessageCircle size={26} strokeWidth={1.3} /><h3>{t('imageStudio.chat')}</h3><p>{t(board ? 'imageStudio.chatHint' : 'imageStudio.choose')}</p>
    {board && <button className="ims-primary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await ensureImageSession(board.id) } catch (e) { setError(String(e)) } finally { setBusy(false) } }}>{busy ? <Loader2 size={15} className="ims-spin" /> : <Plus size={15} />}{t('imageStudio.connect')}</button>}
    {error && <p role="alert">{t('imageStudio.error', { error })}</p>}
  </div>
}

export function ImageStudioAssets() {
  const { t } = useI18n()
  const board = useImageStudio(s => s.activeId ? s.boards[s.activeId] : undefined)
  const selection = useImageStudio(s => s.selection), [query, setQuery] = useState('')
  const items = board ? boardItems(board).reverse().filter(i => i.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : []
  const patch = (id: string, change: { hidden?: boolean; locked?: boolean }) => board && useImageStudio.getState().update(board.id, b => mapItems(b, i => i.id === id ? { ...i, ...change } : i))
  return <section className="ims-panel ims-layers"><h3>{t('imageStudio.layers')}</h3>
    <input type="search" aria-label={t('imageStudio.searchLayers')} placeholder={t('imageStudio.searchLayers')} value={query} onChange={e => setQuery(e.target.value)} />
    <div className="ims-asset-list">{items.map(item => <div key={item.id} className={`ims-layer-row${selection.includes(item.id) ? ' is-selected' : ''}`} data-layer-id={item.id}>
      <button className="ims-asset" aria-pressed={selection.includes(item.id)} onClick={e => useImageStudio.setState({ selection: e.shiftKey ? selection.includes(item.id) ? selection.filter(id => id !== item.id) : [...selection, item.id] : [item.id] })}>
        <div className="ims-layer-thumb"><LayerPreview item={item} /></div><span><strong>{item.name}</strong><small>{t(`imageStudio.kind.${itemKind(item)}`)}</small></span>
      </button>
      <button aria-label={t(item.hidden ? 'imageStudio.show' : 'imageStudio.hide')} title={t(item.hidden ? 'imageStudio.show' : 'imageStudio.hide')} onClick={() => patch(item.id, { hidden: !item.hidden })}>{item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
      <button aria-label={t(item.locked ? 'imageStudio.unlock' : 'imageStudio.lock')} title={t(item.locked ? 'imageStudio.unlock' : 'imageStudio.lock')} onClick={() => patch(item.id, { locked: !item.locked })}>{item.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
    </div>)}</div>
    {!items.length && <div className="ims-panel-empty"><Images size={26} /><p>{t('imageStudio.noLayers')}</p></div>}
    <p className="ims-caption">{t('imageStudio.layersHint')}</p>
  </section>
}
export function NumberField({ label, value, onChange, min = -100000, max = 100000 }: { label: string; value: number; onChange(n: number): void; min?: number; max?: number }) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100))
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value])
  const commit = () => { const n = Number(draft); if (draft.trim() && Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); else setDraft(String(value)) }
  return <label>{label}<input type="number" aria-label={label} value={draft} min={min} max={max} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /></label>
}
export function ImageStudioInspector() {
  const { t } = useI18n()
  const board = useImageStudio(s => s.activeId ? s.boards[s.activeId] : undefined)
  const selection = useImageStudio(s => s.selection)
  const items = board ? boardItems(board).filter(i => selection.includes(i.id)) : []
  const item = items[0]
  const parent = item && isImage(item) && item.parentId ? board?.images.find(image => image.id === item.parentId) : undefined
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [cropping, setCropping] = useState(false)
  useEffect(() => { setCropping(false); setError('') }, [board?.id, item?.id])
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  if (!board || !item) return <div className="ims-panel ims-panel-empty"><Images size={26} /><p>{t('imageStudio.select')}</p></div>
  const update = (patch: Partial<StudioItem>) => useImageStudio.getState().update(board.id, b => mapItems(b, i => i.id === item.id && !i.locked ? { ...i, ...patch } as StudioItem : i))
  const transform = (patch: Partial<StudioImage>) => { if (isImage(item)) update(transformImage(item, patch)) }
  const geometry = (key: 'x' | 'y' | 'w' | 'h', value: number) => {
    let box = { x: item.x, y: item.y, w: item.w, h: item.h, [key]: value }
    if (isImage(item) && (key === 'w' || key === 'h')) { const size = imageSize(item); box = { ...box, ...(key === 'w' ? { h: value * size.h / size.w } : { w: value * size.w / size.h }) } }
    useImageStudio.getState().update(board.id, b => moveItems(b, new Map([[item.id, box]])))
  }
  return <section className="ims-panel ims-inspector"><h3>{t(items.length > 1 ? 'imageStudio.selection' : 'imageStudio.inspector')}</h3>
    {items.every(isImage) && <AIEditPanel key={`${board.id}:${selection.join(',')}`} board={board} images={items.filter(isImage)} />}
    {items.length === 1 ? <>
      <div className="ims-preview" style={{ aspectRatio: item.w / item.h }}><LayerPreview item={item} /></div>
      <fieldset disabled={item.locked} className="ims-properties">
        <input aria-label={t('imageStudio.layerName')} value={item.name} onChange={e => update({ name: e.target.value })} />
        <div className="ims-fields">{(['x', 'y', 'w', 'h'] as const).map(key => <NumberField key={key} label={t(`imageStudio.${key}`)} value={item[key]} min={key === 'w' || key === 'h' ? 1 : -100000} onChange={value => geometry(key, value)} />)}</div>
        {isImage(item) ? <>
          <div className="ims-meta"><span>{t('imageStudio.original')}</span><span>{item.width} × {item.height}</span></div>
          {parent && <button className="ims-lineage" onClick={() => useImageStudio.setState({ selection: [parent.id] })}><GitBranch size={14} /><span>{t('imageStudio.versionOf')}</span><strong>{parent.name}</strong></button>}
          <div className="ims-button-row ims-transform">
            <button title={t('imageStudio.crop')} aria-label={t('imageStudio.crop')} onClick={() => setCropping(!cropping)}><Crop size={16} /></button>
            <button title={t('imageStudio.rotate')} aria-label={t('imageStudio.rotate')} onClick={() => transform({ rotation: ((item.rotation || 0) + 90) % 360 })}><RotateCw size={16} /></button>
            <button title={t('imageStudio.flipX')} aria-label={t('imageStudio.flipX')} onClick={() => transform({ flipX: !item.flipX })}><FlipHorizontal2 size={16} /></button>
            <button title={t('imageStudio.flipY')} aria-label={t('imageStudio.flipY')} onClick={() => transform({ flipY: !item.flipY })}><FlipVertical2 size={16} /></button>
          </div>
          {cropping && <CropEditor key={item.id} image={item} onCancel={() => setCropping(false)} onApply={crop => { transform({ crop }); setCropping(false) }} />}
          <NumberField label={t('imageStudio.angle')} value={item.rotation || 0} min={0} max={359} onChange={rotation => transform({ rotation })} />
          <button onClick={() => transform({ crop: undefined, rotation: 0, flipX: false, flipY: false })}>{t('imageStudio.resetTransform')}</button>
          <div className="ims-adjustments">{(['brightness', 'contrast', 'saturation'] as const).map(property => <label key={property}><span>{t(`imageStudio.${property}`)}<output>{item[property]}%</output></span><input aria-label={t(`imageStudio.${property}`)} type="range" min="0" max="200" step="5" value={item[property]} onChange={e => update({ [property]: Number(e.target.value) })} /></label>)}</div>
          <button onClick={() => update({ brightness: 100, contrast: 100, saturation: 100 })}><RotateCcw size={14} />{t('imageStudio.reset')}</button>
        </> : <>
          {item.kind === 'frame' && <><label>{t('imageStudio.framePreset')}<select aria-label={t('imageStudio.framePreset')} value="" onChange={e => { const [w, h] = e.target.value.split('x').map(Number); update({ w, h }) }}><option value="" disabled>{t('imageStudio.customSize')}</option><option value="1080x1080">1:1 · 1080 × 1080</option><option value="1080x1350">4:5 · 1080 × 1350</option><option value="1080x1920">9:16 · 1080 × 1920</option><option value="1920x1080">16:9 · 1920 × 1080</option></select></label><p>{t('imageStudio.frameHint')}</p></>}
          {item.kind === 'text' && <>
            <textarea aria-label={t('imageStudio.textContent')} value={item.text} maxLength={10000} rows={4} onChange={e => update({ text: e.target.value })} />
            <div className="ims-fields"><label>{t('imageStudio.font')}<select aria-label={t('imageStudio.font')} value={item.fontFamily} onChange={e => update({ fontFamily: e.target.value as StudioElement['fontFamily'] })}>{(['sans-serif', 'serif', 'monospace'] as const).map(f => <option key={f} value={f}>{t(`imageStudio.font.${f}`)}</option>)}</select></label>
              <NumberField label={t('imageStudio.fontSize')} value={item.fontSize} min={6} max={500} onChange={fontSize => update({ fontSize })} />
            </div>
            <div className="ims-fields"><label>{t('imageStudio.textAlign')}<select aria-label={t('imageStudio.textAlign')} value={item.align} onChange={e => update({ align: e.target.value as StudioElement['align'] })}>{(['left', 'center', 'right'] as const).map(a => <option key={a} value={a}>{t(`imageStudio.align.${a}`)}</option>)}</select></label><label className="ims-checkbox"><input type="checkbox" checked={item.bold} onChange={e => update({ bold: e.target.checked })} />{t('imageStudio.bold')}</label></div>
          </>}
          <div className="ims-fields"><label>{t('imageStudio.fill')}<input type="color" aria-label={t('imageStudio.fill')} value={item.fill === 'transparent' ? '#ffffff' : item.fill} onChange={e => update({ fill: e.target.value })} /></label>
            {item.kind !== 'text' && <label>{t('imageStudio.stroke')}<input type="color" aria-label={t('imageStudio.stroke')} value={item.stroke} onChange={e => update({ stroke: e.target.value })} /></label>}
          </div>
          {item.kind !== 'text' && <><label className="ims-checkbox"><input type="checkbox" checked={item.fill === 'transparent'} onChange={e => update({ fill: e.target.checked ? 'transparent' : '#ffffff' })} />{t('imageStudio.noFill')}</label><div className="ims-fields"><NumberField label={t('imageStudio.strokeWidth')} value={item.strokeWidth} min={0} max={100} onChange={strokeWidth => update({ strokeWidth })} /><NumberField label={t('imageStudio.radius')} value={item.radius} min={0} max={1000} onChange={radius => update({ radius })} /></div></>}
        </>}
      </fieldset>
      {item.locked && <p>{t('imageStudio.lockedHint')}</p>}
      {isImage(item) && item.prompt && <details className="ims-prompt"><summary>{t('imageStudio.prompt')}</summary><p>{item.prompt}</p></details>}
    </> : <><p>{t('imageStudio.selectedCount', { count: items.length })}</p><div className="ims-align">{(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map(axis => <button key={axis} onClick={() => useImageStudio.getState().update(board.id, b => alignItems(b, selection, axis))}>{t(`imageStudio.align.${axis}`)}</button>)}</div></>}
    <div className="ims-button-row"><button title={t('imageStudio.layerUp')} aria-label={t('imageStudio.layerUp')} onClick={() => useImageStudio.getState().update(board.id, b => reorderItems(b, selection, 'up'))}><ArrowUp size={15} /></button><button title={t('imageStudio.layerDown')} aria-label={t('imageStudio.layerDown')} onClick={() => useImageStudio.getState().update(board.id, b => reorderItems(b, selection, 'down'))}><ArrowDown size={15} /></button><button title={t('imageStudio.remove')} aria-label={t('imageStudio.remove')} onClick={removeSelection}><Trash2 size={15} /></button></div>
    <div className="ims-panel-actions">
      <button disabled={busy || items.every(i => i.hidden)} onClick={() => void run(referenceSelection)}><MessageCircle size={14} />{t('imageStudio.reference')}</button>
      <button onClick={() => pasteSelection(true)}><Copy size={14} />{t('imageStudio.duplicate')}</button>
      {items.length === 1 && isImage(item) && <button className="ims-primary" disabled={busy} onClick={() => void run(async () => downloadBlob(await renderImages([item], true), item.name.replace(/\.[^.]+$/, '') + '.png'))}><Download size={14} />{t('imageStudio.export')}</button>}
    </div>{error && <p role="alert">{t('imageStudio.error', { error })}</p>}
  </section>
}
