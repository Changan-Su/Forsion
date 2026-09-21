import { ArrowDown, ArrowUp, CheckCheck, ClipboardPaste, Copy, CopyPlus, Download, Lock, MessageCircle, SlidersHorizontal, Trash2, Unlock, Upload } from 'lucide-react'
import { ContextMenu, type CtxItem } from '../../components/RightPanel'
import { useI18n } from '../../i18n'
import { useImageStudio } from '../../stores/imageStudioStore'
import { copySelection, hasCopiedItems, pasteSelection, referenceSelection, removeSelection } from './actions'
import { downloadBlob, renderImages } from './files'
import { boardItems, isImage, mapItems, reorderItems, type ImageBoard } from './model'

export interface ImageMenuTarget { x: number; y: number; ids: string[] }

export function ImageContextMenu({ target, board, busy, onClose, onImport, onExport, onInspect, run }: {
  target: ImageMenuTarget; board?: ImageBoard; busy: boolean; onClose: () => void
  onImport: () => void; onExport: () => void; onInspect: () => void
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const { t } = useI18n()
  const items = board ? boardItems(board).filter(item => target.ids.includes(item.id)) : []
  const image = items.length === 1 && isImage(items[0]) ? items[0] : undefined
  const unlocked = items.filter(item => !item.locked).map(item => item.id)
  const command = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  // Freeze the right-click target, including multi-selection, while asynchronous jobs update the board.
  const act = (action: () => void) => () => {
    if (board && useImageStudio.getState().activeId !== board.id) return
    useImageStudio.setState({ selection: items.map(item => item.id) })
    action()
  }
  const entries: CtxItem[] = []
  if (image) entries.push(
    { label: t('imageStudio.downloadImage'), icon: <Download size={14} />, disabled: busy, run: act(() => void run(async () => downloadBlob(await renderImages([image], true), image.name.replace(/\.[^.]+$/, '') + '.png'))) },
    { label: t('imageStudio.downloadOriginal'), icon: <Download size={14} />, run: act(() => {
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[image.blob.type] || 'png'
      downloadBlob(image.blob, image.name.replace(/\.[^.]+$/, '') + '-original.' + ext)
    }) },
  )
  if (items.length && board) entries.push(
    { label: t('imageStudio.exportSelection'), icon: <Download size={14} />, disabled: busy, run: act(onExport) },
    { label: t('imageStudio.reference'), icon: <MessageCircle size={14} />, separatorBefore: true, disabled: busy || items.length > 8, run: act(() => void run(referenceSelection)) },
    { label: t('imageStudio.inspector'), icon: <SlidersHorizontal size={14} />, run: act(onInspect) },
    { label: t('imageStudio.copyObjects'), icon: <Copy size={14} />, shortcut: `${command}C`, separatorBefore: true, run: act(copySelection) },
    { label: t('imageStudio.duplicate'), icon: <CopyPlus size={14} />, shortcut: `${command}D`, run: act(() => pasteSelection(true)) },
    { label: t('imageStudio.layerUp'), icon: <ArrowUp size={14} />, separatorBefore: true, disabled: !unlocked.length, run: act(() => useImageStudio.getState().update(board.id, b => reorderItems(b, unlocked, 'up'))) },
    { label: t('imageStudio.layerDown'), icon: <ArrowDown size={14} />, disabled: !unlocked.length, run: act(() => useImageStudio.getState().update(board.id, b => reorderItems(b, unlocked, 'down'))) },
    { label: t(unlocked.length ? 'imageStudio.lock' : 'imageStudio.unlock'), icon: unlocked.length ? <Lock size={14} /> : <Unlock size={14} />, run: act(() => useImageStudio.getState().update(board.id, b => mapItems(b, item => target.ids.includes(item.id) ? { ...item, locked: !!unlocked.length } : item))) },
    { label: t('imageStudio.remove'), icon: <Trash2 size={14} />, shortcut: '⌫', separatorBefore: true, danger: true, disabled: !unlocked.length, run: act(removeSelection) },
  )
  else entries.push(
    { label: t('imageStudio.import'), icon: <Upload size={14} />, disabled: busy, run: onImport },
    { label: t('imageStudio.pasteObjects'), icon: <ClipboardPaste size={14} />, shortcut: `${command}V`, disabled: !board || !hasCopiedItems(), run: act(() => pasteSelection()) },
    { label: t('imageStudio.selectAll'), icon: <CheckCheck size={14} />, disabled: !board?.images.length && !board?.elements?.length, run: () => useImageStudio.setState({ selection: board ? boardItems(board).filter(item => !item.hidden).map(item => item.id) : [] }) },
    { label: t('imageStudio.exportBoard'), icon: <Download size={14} />, separatorBefore: true, disabled: busy || !board || !boardItems(board).some(item => !item.hidden), run: act(onExport) },
  )
  return <ContextMenu menu={{ x: target.x, y: target.y, items: entries }} onClose={onClose} autoFocus />
}
