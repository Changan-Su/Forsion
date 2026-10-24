// 双链前那枚文件类型图标的认法与画法。拆成单独文件是为了让聊天（components/ChatWikiLink）也能用，
// 而不把编辑器的 milkdown / prosemirror 依赖带进聊天。
import { isPdfLinkInner, parseMediaLinkInner } from '@amadeus-shared/pdfLink'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { isFileRef } from '../../lib/vaultFiles'

export const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

/** 指向文件的双链前面那枚类型图标(2026-10-14 用户选方案 A:单色配色下双链有自己的颜色,指向文件的多一枚图标,
 *  指向笔记的不带)。按名字认种类,与点击时的分派同口径;笔记(裸名 / `.md`)返回 null。路径抄自 lucide(ISC)。 */
export const FILE_ICON = {
  pdf: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  draw: '<path d="M8.3 10a.7.7 0 0 1-.63-1.08L11.4 3a.7.7 0 0 1 1.2-.04L16.3 8.9a.7.7 0 0 1-.57 1.1z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
  db: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  media: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 8 6 4-6 4z"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
}
export function fileIconKind(inner: string, target: string): keyof typeof FILE_ICON | null {
  if (isPdfLinkInner(inner) || /\.pdf$/i.test(target)) return 'pdf'
  if (parseMediaLinkInner(inner)) return 'media'
  if (isDrawingPath(target)) return 'draw'
  if (!isFileRef(target)) return null
  return /\.db$/i.test(target) ? 'db' : IMG_EXT_RE.test(target) ? 'image' : 'file'
}
export type FileIconKind = keyof typeof FILE_ICON
