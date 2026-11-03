import type { Rect } from './windowGeometry'

/** Mask stale Chromium frames while Windows shrinks a transparent HWND. The
 * region follows the card's current CSS radius in DIP; CSS still paints AA.
 * Leave one DIP outside the curve so the native region cannot cut that AA off.
 */
export function miniResizeShape(width: number, height: number, radius: number): Rect[] {
  const r = Math.min(Math.ceil(Math.max(0, radius)), Math.floor(width / 2), Math.floor(height / 2))
  if (!r) return []
  const rows: Rect[] = [{ x: 0, y: r, width, height: height - 2 * r }]
  for (let y = 0; y < r; y++) {
    const inset = Math.max(0, Math.floor(r - Math.sqrt(r * r - (r - y - .5) ** 2)) - 1)
    rows.push({ x: inset, y, width: width - 2 * inset, height: 1 },
      { x: inset, y: height - 1 - y, width: width - 2 * inset, height: 1 })
  }
  return rows.filter(row => row.width > 0 && row.height > 0)
}
