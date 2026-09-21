import { boardItems, isFrame, isImage, moveItems, type ImageBoard, type StudioElement, type StudioItem } from './model'
import { unionBox, type Box } from '../../amadeus/unified/canvasKit/geometry'

export const escapeXml = (text: string): string => text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
export const font = (item: StudioElement): string => `${item.bold ? '700' : '400'} ${item.fontSize}px ${item.fontFamily}`
/** Preview and export share explicit line breaks; no foreignObject or external font dependency. */
export function textLines(item: StudioElement): string[] {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = font(item)
  const lines: string[] = []
  for (const paragraph of item.text.split('\n')) {
    let line = ''
    for (const char of Array.from(paragraph)) {
      if (line && ctx.measureText(line + char).width > item.w) { lines.push(line); line = '' }
      line += char
    }
    lines.push(line)
  }
  return lines
}
export function elementMarkup(item: StudioElement): string {
  const { w, h, fill, stroke, strokeWidth } = item
  const style = `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"`
  if (item.kind === 'ellipse') return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, (w - strokeWidth) / 2)}" ry="${Math.max(0, (h - strokeWidth) / 2)}" ${style}/>`
  if (item.kind !== 'text') return `<rect x="${strokeWidth / 2}" y="${strokeWidth / 2}" width="${Math.max(0, w - strokeWidth)}" height="${Math.max(0, h - strokeWidth)}" rx="${item.radius}" ${style}/>`
  const x = item.align === 'center' ? w / 2 : item.align === 'right' ? w : 0
  const anchor = item.align === 'center' ? 'middle' : item.align === 'right' ? 'end' : 'start'
  return `<text fill="${fill}" font-family="${item.fontFamily}" font-size="${item.fontSize}" font-weight="${item.bold ? 700 : 400}" text-anchor="${anchor}" xml:space="preserve">${textLines(item).map((line, index) => `<tspan x="${x}" y="${item.fontSize + index * item.fontSize * 1.25}">${escapeXml(line)}</tspan>`).join('')}</text>`
}
export interface ExportScene { items: StudioItem[]; bounds: Box }
export function exportScene(board: ImageBoard, selection: string[]): ExportScene | null {
  const visible = boardItems(board).filter(i => !i.hidden)
  const chosen = visible.filter(i => selection.includes(i.id))
  if (chosen.length === 1 && isFrame(chosen[0])) {
    const frame = chosen[0]
    return { bounds: frame, items: [frame, ...visible.filter(i => !isFrame(i) && i.x < frame.x + frame.w && i.x + i.w > frame.x && i.y < frame.y + frame.h && i.y + i.h > frame.y)] }
  }
  const items = selection.length ? chosen : visible
  const bounds = unionBox(items)
  return bounds ? { items, bounds } : null
}
export function alignItems(board: ImageBoard, ids: string[], axis: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): ImageBoard {
  const items = boardItems(board), selected = items.filter(i => ids.includes(i.id) && !i.locked)
  const b = unionBox(selected)
  if (!b || selected.length < 2) return board
  const edited = new Map(selected.map(i => [i.id, { ...i,
    x: axis === 'left' ? b.x : axis === 'center' ? b.x + (b.w - i.w) / 2 : axis === 'right' ? b.x + b.w - i.w : i.x,
    y: axis === 'top' ? b.y : axis === 'middle' ? b.y + (b.h - i.h) / 2 : axis === 'bottom' ? b.y + b.h - i.h : i.y,
  }]))
  return moveItems(board, edited)
}

export const itemKind = (item: StudioItem): 'image' | StudioElement['kind'] => isImage(item) ? 'image' : item.kind
