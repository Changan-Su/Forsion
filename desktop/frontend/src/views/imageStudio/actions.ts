import { useImageStudio } from '../../stores/imageStudioStore'
import { boardItems, cloneItems, contains, isFrame, isImage, replaceItems, type StudioItem } from './model'
import { imageAttachment, renderBoard } from './files'
import { promptImageStudio } from './session'
import { translate } from '../../i18n'

// Session clipboard deliberately keeps original Blobs; no OS clipboard access or personal data read.
let clipboard: StudioItem[] = []
export function selectedItems(includeFrameContents = false): StudioItem[] {
  const { activeId, boards, selection } = useImageStudio.getState(), board = activeId ? boards[activeId] : undefined
  if (!board) return []
  const items = boardItems(board), frames = items.filter(i => selection.includes(i.id) && isFrame(i))
  return items.filter(i => selection.includes(i.id) || (includeFrameContents && !isFrame(i) && frames.some(frame => contains(frame, i))))
}
export function copySelection(): void { clipboard = selectedItems(true) }
export function hasCopiedItems(): boolean { return clipboard.length > 0 }
export function pasteSelection(duplicate = false): void {
  const store = useImageStudio.getState(), id = store.activeId
  if (!id) return
  const copies = cloneItems(duplicate ? selectedItems(true) : clipboard)
  if (!copies.length) return
  store.update(id, b => replaceItems(b, [...boardItems(b), ...copies]))
  useImageStudio.setState({ selection: copies.map(i => i.id) })
}
export function removeSelection(): void {
  const store = useImageStudio.getState(), id = store.activeId, ids = new Set(store.selection)
  if (!id) return
  store.update(id, b => replaceItems(b, boardItems(b).filter(i => i.locked || !ids.has(i.id))))
  useImageStudio.setState({ selection: [] })
}
export async function referenceSelection(): Promise<void> {
  const { activeId, boards, selection } = useImageStudio.getState()
  const board = activeId ? boards[activeId] : undefined
  if (!board) return
  const items = boardItems(board).filter(i => selection.includes(i.id) && !i.hidden)
  if (!items.length) return
  if (items.length > 8) throw new Error(translate('imageStudio.referenceLimit'))
  const attachments = items.every(isImage) ? await Promise.all(items.map(image => imageAttachment(image))) : await (async () => {
    const blob = await renderBoard(board, selection, { format: 'png', scale: 1, background: 'transparent', quality: .92 })
    // Reuse attachment bounding and PNG encoding for a composited frame/selection.
    const { makeImage } = await import('./files')
    return [await imageAttachment(await makeImage(blob, `${board.name}.png`, 'import'))]
  })()
  await promptImageStudio(board.id, translate('imageStudio.referencePrompt'), attachments)
}
