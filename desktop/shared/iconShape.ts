/** Artwork geometry, independent of the current UI theme. */
export const ICON_CORNER_RATIO = 0.22

/** NativeImage bitmaps have premultiplied colour channels and trailing alpha on Desktop platforms. */
export function roundIconBitmap(pixels: Uint8Array, width: number, height: number): void {
  const radius = Math.min(width, height) * ICON_CORNER_RATIO
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = Math.max(radius - (x + 0.5), x + 0.5 - (width - radius), 0)
    const dy = Math.max(radius - (y + 0.5), y + 0.5 - (height - radius), 0)
    if (!dx || !dy) continue
    const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy)))
    const offset = (y * width + x) * 4, alpha = pixels[offset + 3]
    // Already rounded images retain their antialiasing and original transparency.
    const nextAlpha = Math.min(alpha, Math.round(coverage * 255))
    if (alpha > nextAlpha) {
      for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(pixels[offset + c] * nextAlpha / alpha)
      pixels[offset + 3] = nextAlpha
    }
  }
}
