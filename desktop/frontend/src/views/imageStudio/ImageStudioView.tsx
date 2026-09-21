import { useCallback, useEffect, useRef, useState } from 'react'
import { Images, Plus, Upload, Download, Undo2, Redo2, LayoutGrid, SlidersHorizontal, Layers, MessageCircle, Trash2, Loader2, ArrowUpRight, FileDown, FolderOpen, Type, Square, Circle, Frame, MousePointer2, Hand, Copy, Sparkles, X } from 'lucide-react'
import { useWorkspace, type ViewProps } from '@lcl/engine'
import { CanvasChrome, CanvasMiniMap, useCanvasViewport, useCanvasGestures, hostSize, zoomAt, gridLayerStyle, type ResizeEdge } from '../../amadeus/unified/canvasKit'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useImageStudio } from '../../stores/imageStudioStore'
import { LayerPreview } from './LayerPreview'
import { ExportPanel } from './ExportPanel'
import { ImageContextMenu, type ImageMenuTarget } from './ImageContextMenu'
import { copySelection, pasteSelection, referenceSelection, removeSelection } from './actions'
import { useCollectImages } from './useImages'
import { makeImage, exportProject, importProject } from './files'
import { arrangeImages, imageBox, boardItems, replaceItems, moveItems, newElement, isImage, imageSize, type ImageBoard, type StudioElement } from './model'
import { promptImageStudio } from './session'
import type { GenerationPlaceholder } from './generation'
import './messages'
import './imageStudio.css'

const EMPTY_PLACEHOLDERS: GenerationPlaceholder[] = []

export function ImageStudioView(_props: ViewProps) {
  const { t } = useI18n()
  const ready = useImageStudio(s => s.ready), error = useImageStudio(s => s.error)
  const id = useImageStudio(s => s.activeId)
  useEffect(() => {
    void useImageStudio.getState().hydrate()
    const flush = () => { void useImageStudio.getState().flush() }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const state = useImageStudio.getState()
      if (state.saving || (state.ready && state.error)) { flush(); event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', beforeUnload); flush() }
  }, [])
  if (!ready) return <div className="ims-panel ims-panel-empty">{error ? <><p role="alert">{t('imageStudio.error', { error })}</p><button onClick={() => void useImageStudio.getState().hydrate()}>{t('imageStudio.retry')}</button></> : <Loader2 className="ims-spin" />}</div>
  return <ImageCanvas key={id || 'new'} />
}
function ImageCanvas() {
  const { t } = useI18n()
  const board = useImageStudio(s => s.activeId ? s.boards[s.activeId] : undefined)
  const boards = useImageStudio(s => s.boards)
  const saving = useImageStudio(s => s.saving), saveError = useImageStudio(s => s.error)
  const past = useImageStudio(s => board ? s.past[board.id]?.length || 0 : 0)
  const future = useImageStudio(s => board ? s.future[board.id]?.length || 0 : 0)
  const selection = useImageStudio(s => s.selection)
  const placeholders = useImageStudio(s => board ? s.placeholders[board.id] || EMPTY_PLACEHOLDERS : EMPTY_PLACEHOLDERS)
  const running = useApp(s => !!(board?.sessionId && s.runningBySession[board.sessionId]))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [exporting, setExporting] = useState(false), [hand, setHand] = useState(false), [spaceHand, setSpaceHand] = useState(false)
  const pan = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null)
  const [snap, setSnap] = useState(true), [mini, setMini] = useState(false), [dropping, setDropping] = useState(false)
  const host = useRef<HTMLDivElement>(null), picker = useRef<HTMLInputElement>(null), projectPicker = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<ImageMenuTarget | null>(null)
  const closeMenu = useCallback(() => { setMenu(null); host.current?.focus({ preventScroll: true }) }, [])
  const view = useCanvasViewport(host, `image-studio:${board?.id || ''}`, undefined, { x: 56, y: 64, z: 1 })
  const images = board?.images || []
  const items = board ? boardItems(board) : []
  const visible = items.filter(i => !i.hidden)
  const visibleWithPlaceholders = [...visible, ...placeholders]
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const reportError = useCallback((message: string) => { if (active.current) setError(message) }, [])
  useCollectImages(board || EMPTY_BOARD, reportError, retry)
  const gesture = useCanvasGestures(host, view, {
    boxes: () => new Map(visible.map(i => [i.id, i])), identity: () => board?.id,
    commit: next => { if (board) useImageStudio.getState().update(board.id, b => moveItems(b, next)) },
    constrain: (next, op) => {
      if (op.kind !== 'resize') return next
      const image = images.find(i => i.id === op.key), box = next.get(op.key)
      if (!image || !box) return next
      const size = imageSize(image), w = Math.max(48, box.w), h = w * size.h / size.w
      return new Map(next).set(op.key, { ...box, w, h })
    },
    hitKey: target => target.closest<HTMLElement>('[data-image-id]')?.dataset.imageId || null,
    isEditing: key => !!items.find(i => i.id === key)?.locked,
    hitEdge: target => target.dataset.resize as ResizeEdge || null,
    onDelete: ids => { if (board) useImageStudio.getState().update(board.id, b => replaceItems(b, boardItems(b).filter(i => i.locked || !ids.includes(i.id)))) },
    onDoubleClick: key => { if (key) { useImageStudio.setState({ selection: [key] }); useWorkspace.getState().openView('image-studio-inspector', {}, 'right') } },
    onContextMenu: (key, at) => {
      const ids = key ? (gesture.sel.includes(key) ? gesture.sel : [key]) : []
      gesture.setSel(ids)
      useImageStudio.setState({ selection: ids })
      setMenu({ x: at.clientX, y: at.clientY, ids })
    },
    minW: 48, minH: 48, repel: false,
  }, snap)
  useEffect(() => gesture.bind(host.current), [gesture.bind])
  useEffect(() => view.bindWheel(host.current), [view.bindWheel])
  useEffect(() => {
    const clear = () => { setSpaceHand(false); pan.current = null }
    window.addEventListener('blur', clear)
    return () => window.removeEventListener('blur', clear)
  }, [])
  const previousSelection = useRef(gesture.sel)
  useEffect(() => {
    if (previousSelection.current === gesture.sel) return
    previousSelection.current = gesture.sel
    useImageStudio.setState({ selection: gesture.sel })
  }, [gesture.sel])
  useEffect(() => {
    if (selection.join('|') !== gesture.sel.join('|')) {
      gesture.setSel(selection)
      const image = items.find(i => i.id === selection[0])
      if (image) {
        const { w, h } = hostSize(host.current), vp = view.vpRef.current
        const cx = (image.x + image.w / 2) * vp.z + vp.x, cy = (image.y + image.h / 2) * vp.z + vp.y
        if (cx < 0 || cx > w || cy < 0 || cy > h) view.centerOn(image.x + image.w / 2, image.y + image.h / 2)
      }
    }
  }, [selection, gesture.setSel]) // eslint-disable-line react-hooks/exhaustive-deps
  const previousCount = useRef(0)
  useEffect(() => {
    const count = items.length + placeholders.length
    if (count > previousCount.current) view.fitTo(visibleWithPlaceholders, 64)
    previousCount.current = count
  }, [items, placeholders, view.fitTo]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { reportError(String(e)) } finally { if (active.current) setBusy(false) }
  }
  const currentOrNew = () => board?.id || useImageStudio.getState().create(t('imageStudio.untitled'))
  const importFiles = async (files: File[]) => {
    // Read every file before mutating the board; a bad file never silently creates a partial import.
    const added = await Promise.all(files.map(file => makeImage(file, file.name, 'import')))
    if (!added.length) return
    const id = currentOrNew()
    useImageStudio.getState().update(id, b => {
      const next = [...b.images]
      for (const image of added) next.push({ ...image, ...imageBox(image.width, image.height, next) })
      return { ...b, images: next }
    })
  }
  const seed = (key: string) => void run(async () => { const id = currentOrNew(); await promptImageStudio(id, t(key)) })
  const openPanel = (type: string) => useWorkspace.getState().openView(type, {}, type === 'image-studio-chat' ? 'left' : 'right')
  const selected = items.filter(i => selection.includes(i.id))
  const liveItems = board && gesture.live ? boardItems(moveItems(board, gesture.live)) : items
  const addElement = (kind: StudioElement['kind']) => {
    const id = currentOrNew(), { w, h } = hostSize(host.current)
    const element = newElement(kind, t(`imageStudio.new.${kind}`), (w / 2 - view.vp.x) / view.vp.z, (h / 2 - view.vp.y) / view.vp.z)
    element.x -= element.w / 2; element.y -= element.h / 2
    useImageStudio.getState().update(id, b => replaceItems(b, [...boardItems(b), element]))
    useImageStudio.setState({ selection: [element.id] }); openPanel('image-studio-inspector')
  }
  const zoomBy = (factor: number) => { const { w, h } = hostSize(host.current); view.setVp(zoomAt(view.vp, view.vp.z * factor, w / 2, h / 2)) }
  return <div className="ims" onKeyDownCapture={e => {
    if ((e.target as HTMLElement).closest('input, select, textarea, button, [contenteditable="true"]')) return
    const command = e.metaKey || e.ctrlKey, key = e.key.toLowerCase()
    let handled = true
    if (command && key === 'z' && board) useImageStudio.getState().undo(board.id, e.shiftKey)
    else if (command && key === 'c') copySelection()
    else if (command && key === 'v') pasteSelection()
    else if (command && key === 'd') pasteSelection(true)
    else if (command && key === 'e') setExporting(true)
    else if (!command && key === 't') addElement('text')
    else if (!command && key === 'f') addElement('frame')
    else if (!command && key === 'h') setHand(true)
    else if (!command && key === 'v') setHand(false)
    else if (key === ' ') setSpaceHand(true)
    else if (key === 'escape') { setHand(false); setExporting(false); handled = false }
    else handled = false
    if (handled) { e.preventDefault(); e.stopPropagation() }
  }} onKeyUpCapture={e => { if (e.key === ' ') { setSpaceHand(false); e.preventDefault(); e.stopPropagation() } }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setSpaceHand(false); pan.current = null } }}>
    <header className="ims-header">
      <div className="ims-brand"><Images size={18} /><span>{t('imageStudio.title')}</span></div>
      <div className="ims-project-picker"><select aria-label={t('imageStudio.projects')} value={board?.id || ''} onChange={e => useImageStudio.getState().open(e.target.value)}><option value="" disabled>{t('imageStudio.projects')}</option>{Object.values(boards).sort((a, b) => b.updatedAt - a.updatedAt).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select><button title={t('imageStudio.new')} aria-label={t('imageStudio.new')} onClick={() => useImageStudio.getState().create(t('imageStudio.untitled'))}><Plus size={16} /></button></div>
      <div className="ims-head-actions"><button title={t('imageStudio.restore')} aria-label={t('imageStudio.restore')} onClick={() => projectPicker.current?.click()}><FolderOpen size={16} /></button><button disabled={!board || busy} title={t('imageStudio.backup')} aria-label={t('imageStudio.backup')} onClick={() => board && void run(() => exportProject(board))}><FileDown size={16} /></button><button className="ims-primary" disabled={!visible.length || busy} onClick={() => setExporting(!exporting)}><Download size={14} /><span>{t('imageStudio.exportOptions')}</span></button></div>
    </header>
    <div className="ims-toolbar" role="toolbar" aria-label={t('imageStudio.title')}>
      <button disabled={busy} onClick={() => picker.current?.click()}><Upload size={15} /><span>{t('imageStudio.import')}</span></button>
      <div className="ims-divider" />
      <button disabled={!past} title={t('imageStudio.undo')} aria-label={t('imageStudio.undo')} onClick={() => board && useImageStudio.getState().undo(board.id)}><Undo2 size={15} /></button><button disabled={!future} title={t('imageStudio.redo')} aria-label={t('imageStudio.redo')} onClick={() => board && useImageStudio.getState().undo(board.id, true)}><Redo2 size={15} /></button>
      <button disabled={!images.some(i => !i.locked && !i.hidden)} title={t('imageStudio.arrange')} aria-label={t('imageStudio.arrange')} onClick={() => { if (board) { const arranged = arrangeImages(images.filter(i => !i.locked && !i.hidden)); useImageStudio.getState().update(board.id, b => ({ ...b, images: b.images.map(i => arranged.find(a => a.id === i.id) || i) })); view.fitTo(arranged) } }}><LayoutGrid size={15} /></button>
      <button disabled={!selected.length} title={t('imageStudio.remove')} aria-label={t('imageStudio.remove')} onClick={removeSelection}><Trash2 size={15} /></button>
      <button disabled={!selected.length} title={t('imageStudio.duplicate')} aria-label={t('imageStudio.duplicate')} onClick={() => pasteSelection(true)}><Copy size={15} /></button>
      <button disabled={!selected.length || busy} title={t('imageStudio.reference')} aria-label={t('imageStudio.reference')} onClick={() => void run(referenceSelection)}><MessageCircle size={15} /></button>
      <span className="ims-toolbar-space" />
      {([['image-studio-chat', MessageCircle, 'imageStudio.chat'], ['image-studio-assets', Layers, 'imageStudio.assets'], ['image-studio-inspector', SlidersHorizontal, 'imageStudio.inspector']] as const).map(([type, Icon, key]) => <button key={type} title={t(key)} aria-label={t(key)} onClick={() => openPanel(type)}><Icon size={16} /></button>)}
    </div>
    {exporting && board && <ExportPanel board={board} selection={selection} onClose={() => setExporting(false)} />}
    {saveError && <div className="ims-error" role="alert">{t('imageStudio.saveError')}<button onClick={() => void useImageStudio.getState().flush()}>{t('imageStudio.retry')}</button></div>}
    {error && <div className="ims-error" role="alert">{t('imageStudio.error', { error })}<button onClick={() => { setError(''); setRetry(n => n + 1) }}>{t('imageStudio.retry')}</button></div>}
    <div ref={host} className={`ims-stage${hand || spaceHand ? ' is-panning' : ''}`} tabIndex={0}
      onContextMenu={e => e.stopPropagation()}
      onPointerDownCapture={e => {
        if (e.button === 2 || !(hand || spaceHand) || (e.target as HTMLElement).closest('.amx-stage-tools, .amx-stage-hud, .amx-stage-minimap')) return
        e.stopPropagation(); e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId)
        pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.vp.x, vy: view.vp.y }
      }} onPointerMoveCapture={e => {
        const p = pan.current
        if (!p || p.id !== e.pointerId) return
        e.stopPropagation(); const { u } = hostSize(host.current)
        view.setVp({ ...view.vp, x: p.vx + (e.clientX - p.x) / u, y: p.vy + (e.clientY - p.y) / u })
      }} onPointerUpCapture={e => { if (pan.current?.id === e.pointerId) { e.stopPropagation(); pan.current = null } }} onPointerCancel={() => { pan.current = null }} aria-label={t('imageStudio.title')} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true) } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false) }} onDrop={e => { e.preventDefault(); setDropping(false); if (!busy) void run(() => importFiles(Array.from(e.dataTransfer.files))) }}>
      <div className="ims-grid" style={gridLayerStyle(view.vp)} />
      <div className="ims-world" style={{ transform: `translate(${view.vp.x}px, ${view.vp.y}px) scale(${view.vp.z})` }}>{visible.map(image => {
        const rect = liveItems.find(i => i.id === image.id) || image
        return <div key={image.id} data-image-id={image.id} className={`ims-layer ${isImage(image) ? 'ims-image' : `ims-${image.kind}`}${gesture.sel.includes(image.id) ? ' is-selected' : ''}${image.locked ? ' is-locked' : ''}`} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <LayerPreview item={image} /><div className="ims-image-label">{image.name}</div>
          {gesture.sel.includes(image.id) && !image.locked && <div className="ims-resize" data-resize="se" />}
        </div>
      })}{placeholders.map(item => {
        const source = images.find(image => image.id === item.sourceIds[0])
        return <div key={item.id} data-generation-id={item.id} className={`ims-generation${item.status === 'failed' ? ' is-failed' : ''}`} style={{ left: item.x, top: item.y, width: item.w, height: item.h }} role={item.status === 'failed' ? 'alert' : 'status'} aria-live="polite" onPointerDown={event => event.stopPropagation()}>
          <div className="ims-generation-sheen" />
          <div className="ims-generation-copy"><Sparkles size={20} strokeWidth={1.5} /><strong>{t(item.kind === 'edit' ? 'imageStudio.generation.editing' : 'imageStudio.generation.creating')}</strong>
            <span>{item.status === 'failed' ? t('imageStudio.generation.failed') : t(item.status === 'preparing' ? 'imageStudio.generation.preparing' : 'imageStudio.generation.running')}</span>
            {source && <small>{t('imageStudio.generation.versionOf', { name: source.name })}</small>}
            {item.count > 1 && <small>{item.index + 1} / {item.count}</small>}
          </div>
          {item.status === 'failed' && <div className="ims-generation-actions amx-stage-tools"><button onClick={() => openPanel('image-studio-chat')}>{t('imageStudio.generation.openChat')}</button><button title={t('imageStudio.generation.dismiss')} aria-label={t('imageStudio.generation.dismiss')} onClick={() => useImageStudio.getState().removeGeneration(board!.id, item.id)}><X size={14} /></button></div>}
        </div>
      })}{gesture.marquee && <div className="ims-marquee" style={{ left: gesture.marquee.x, top: gesture.marquee.y, width: gesture.marquee.w, height: gesture.marquee.h }} />}</div>
      {!items.length && !placeholders.length && <div className="ims-empty amx-stage-tools"><div className="ims-eyebrow">{t('imageStudio.title')} <span>/</span> {t('imageStudio.new')}</div><h1>{t('imageStudio.headline')}</h1><p>{t('imageStudio.intro')}</p>
        <div className="ims-starters">{(['poster', 'product', 'illustration'] as const).map(key => <button key={key} disabled={busy} onClick={() => seed(`imageStudio.${key}Prompt`)}><span>{t(`imageStudio.${key}`)}</span><ArrowUpRight size={14} /></button>)}</div>
        <button className="ims-empty-import" disabled={busy} onClick={() => picker.current?.click()}><Upload size={16} />{t('imageStudio.import')}</button><small>{t('imageStudio.importLimit')}</small>
      </div>}
      {!placeholders.length && (running || busy) && <div className="ims-progress amx-stage-tools" role="status"><Loader2 size={15} className="ims-spin" />{t(running ? 'imageStudio.generating' : 'imageStudio.busy')}</div>}
      {dropping && <div className="ims-drop"><Upload size={28} />{t('imageStudio.drop')}</div>}
      <div className="ims-create-tools amx-stage-tools" role="toolbar" aria-label={t('imageStudio.canvasTools')}>
        <button title={t('imageStudio.selectTool')} aria-label={t('imageStudio.selectTool')} aria-pressed={!hand} onClick={() => { setHand(false); host.current?.focus() }}><MousePointer2 size={17} /></button>
        <button title={t('imageStudio.handTool')} aria-label={t('imageStudio.handTool')} aria-pressed={hand} onClick={() => { setHand(true); host.current?.focus() }}><Hand size={17} /></button>
        <span />
        {([['text', Type], ['rectangle', Square], ['ellipse', Circle], ['frame', Frame]] as const).map(([kind, Icon]) => <button key={kind} title={t(`imageStudio.add.${kind}`)} aria-label={t(`imageStudio.add.${kind}`)} onClick={() => addElement(kind)}><Icon size={17} /></button>)}
      </div>
      {mini && <CanvasMiniMap hostRef={host} vp={view.vp} items={visibleWithPlaceholders.map(i => ({ key: i.id, kind: 'card', box: i }))} onCenter={view.centerOn} />}
      <CanvasChrome zoom={view.vp.z} onZoomBy={zoomBy} onFit={() => view.fitTo(visibleWithPlaceholders)} snap={snap} onSnap={setSnap} mini={mini} onMini={setMini} />
    </div>
    <footer className="ims-footer"><span title={t('imageStudio.hint')}>{board ? t(saveError ? 'imageStudio.unsaved' : saving ? 'imageStudio.saving' : 'imageStudio.local') : t('imageStudio.empty')}</span>{board && <input aria-label={t('imageStudio.name')} value={board.name} onChange={e => useImageStudio.getState().update(board.id, b => ({ ...b, name: e.target.value }), false)} />}<span>{t('imageStudio.itemCount', { count: items.length })}</span></footer>
    {menu && <ImageContextMenu target={menu} board={board} busy={busy} onClose={closeMenu} onImport={() => picker.current?.click()} onExport={() => setExporting(true)} onInspect={() => openPanel('image-studio-inspector')} run={run} />}
    <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; void run(() => importFiles(files)) }} />
    <input ref={projectPicker} type="file" accept=".json" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(async () => { const imported = await importProject(file); const id = useImageStudio.getState().create(imported.name); useImageStudio.getState().update(id, b => ({ ...imported, id: b.id })) }) }} />
  </div>
}
const EMPTY_BOARD: ImageBoard = { version: 1, id: '', name: '', updatedAt: 0, sessionId: null, images: [], collected: [] }
