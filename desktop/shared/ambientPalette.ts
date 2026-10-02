export interface AmbientRect { x: number; y: number; width: number; height: number }
export type AmbientPalette = [string, string, string]

/** Mean visible color per vertical band, with a modest saturation weight so a
 * photograph survives a mostly neutral page. Never returns pixels or image data. */
export function paletteFromRgba(bytes: ArrayLike<number>, width: number, height: number): AmbientPalette | null {
  if (width < 1 || height < 3 || bytes.length < width * height * 4) return null
  const colors: string[] = []
  for (let band = 0; band < 3; band++) {
    const sum = [0, 0, 0]
    let total = 0
    for (let y = Math.floor(height * band / 3); y < Math.floor(height * (band + 1) / 3); y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const rgb = [bytes[i], bytes[i + 1], bytes[i + 2]]
        const weight = bytes[i + 3] / 255 * (1 + 3 * (Math.max(...rgb) - Math.min(...rgb)) / 255)
        for (let c = 0; c < 3; c++) sum[c] += rgb[c] * weight
        total += weight
      }
    }
    if (!total) return null
    colors.push('#' + sum.map((n) => Math.round(n / total).toString(16).padStart(2, '0')).join(''))
  }
  return colors as AmbientPalette
}

export function clampAmbientRect(raw: unknown, width: number, height: number): AmbientRect | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as AmbientRect
  if (![r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const x = Math.max(0, Math.min(width, Math.round(r.x)))
  const y = Math.max(0, Math.min(height, Math.round(r.y)))
  const w = Math.max(0, Math.min(width - x, Math.round(r.width)))
  const h = Math.max(0, Math.min(height - y, Math.round(r.height)))
  return w >= 16 && h >= 16 ? { x, y, width: w, height: h } : null
}
