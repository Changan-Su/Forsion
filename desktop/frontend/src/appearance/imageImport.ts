import { validAppearanceImage, type AppearanceAsset } from '../../../shared/startupAppearance'
import { ICON_CORNER_RATIO } from '../../../shared/iconShape'

export const MAX_IMPORT_BYTES = 20_000_000
export const MAX_IMPORT_PIXELS = 64_000_000
export const APPEARANCE_ACCEPT = '.png,.jpg,.jpeg,.svg,.gif,.webp,image/png,image/jpeg,image/svg+xml,image/gif,image/webp'
export type ImportFailure = 'format' | 'size' | 'dimensions' | 'decode' | 'encode'
export class AppearanceImportError extends Error {
  constructor(public readonly reason: ImportFailure) { super(reason) }
}
export interface ImportedAppearance {
  name: string
  source: HTMLCanvasElement
  width: number
  height: number
  bytes: number
  animated: boolean
  /** Only small, bounded animated artwork may be persisted without re-encoding. */
  original?: string
}
export interface ImageFraming { mode: 'fit' | 'crop'; zoom: number; x: number; y: number }
export const DEFAULT_FRAMING: ImageFraming = { mode: 'fit', zoom: 1, x: 0.5, y: 0.5 }
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v))

/** Sniff actual bytes: some file pickers return an empty or generic MIME type. */
export function appearanceImageType(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512))
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(head)) return 'image/gif'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp'
  // XML comments/declarations can precede SVG; the browser still validates the full image.
  const xml = new TextDecoder().decode(bytes.subarray(0, 65536)).replace(/^\uFEFF/, '').replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').trimStart()
  if (/^(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i.test(xml)) return 'image/svg+xml'
  return null
}
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new AppearanceImportError('decode'))
    reader.readAsDataURL(blob)
  })
}
function canvas(size: number): HTMLCanvasElement {
  const result = document.createElement('canvas')
  result.width = result.height = size
  return result
}
export async function importAppearanceFile(file: File): Promise<ImportedAppearance> {
  if (file.size > MAX_IMPORT_BYTES) throw new AppearanceImportError('size')
  const bytes = new Uint8Array(await file.arrayBuffer().catch(() => { throw new AppearanceImportError('decode') }))
  const mime = appearanceImageType(bytes)
  if (!mime) throw new AppearanceImportError('format')
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { image.src = ''; reject(new AppearanceImportError('decode')) }, 15000)
      image.onload = () => { clearTimeout(timer); resolve() }
      image.onerror = () => { clearTimeout(timer); reject(new AppearanceImportError('decode')) }
      image.src = url
    })
    const width = image.naturalWidth, height = image.naturalHeight
    if (!width || !height) throw new AppearanceImportError('decode')
    if (width > 16384 || height > 16384 || width * height > MAX_IMPORT_PIXELS) throw new AppearanceImportError('dimensions')
    // Bound the working bitmap too. Photo orientation is applied by the browser decoder.
    const scale = Math.min(1, 2048 / Math.max(width, height))
    const source = canvas(1)
    source.width = Math.max(1, Math.round(width * scale)); source.height = Math.max(1, Math.round(height * scale))
    const ctx = source.getContext('2d')
    if (!ctx) throw new AppearanceImportError('encode')
    ctx.drawImage(image, 0, 0, source.width, source.height)
    const text = mime === 'image/svg+xml' ? new TextDecoder().decode(bytes) : ''
    const animated = mime === 'image/gif' || (mime === 'image/webp' && new TextDecoder('latin1').decode(bytes).includes('ANIM'))
      || (mime === 'image/png' && new TextDecoder('latin1').decode(bytes).includes('acTL'))
      || (mime === 'image/svg+xml' && /<(?:animate\w*|set)\b|@keyframes|animation\s*:/i.test(text))
    const original = animated && file.size <= 1_400_000 && width <= 4096 && height <= 4096 ? await dataUrl(blob) : undefined
    return { name: file.name.slice(0, 160) || 'Image', source, width, height, bytes: file.size, animated, original }
  } catch (e) {
    throw e instanceof AppearanceImportError ? e : new AppearanceImportError('decode')
  } finally { image.onload = image.onerror = null; image.src = ''; URL.revokeObjectURL(url) }
}

/** Shared by the live preview and final encoding so saved pixels match the crop. */
export function drawAppearanceImage(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, framing: ImageFraming, size: number, rounded = false): void {
  const w = source.width, h = source.height
  ctx.clearRect(0, 0, size, size)
  ctx.save()
  if (rounded) {
    ctx.beginPath(); ctx.roundRect(0, 0, size, size, size * ICON_CORNER_RATIO); ctx.clip()
  }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
  if (framing.mode === 'crop') {
    const side = Math.min(w, h) / clamp(framing.zoom, 1, 4)
    ctx.drawImage(source, (w - side) * clamp(framing.x, 0, 1), (h - side) * clamp(framing.y, 0, 1), side, side, 0, 0, size, size)
  } else {
    const scale = Math.min(size / w, size / h)
    ctx.drawImage(source, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale)
  }
  ctx.restore()
}
export function encodeAppearanceImport(input: ImportedAppearance, slot: 'icon' | 'splash', framing: ImageFraming): AppearanceAsset {
  const result = canvas(slot === 'icon' ? 256 : 1024)
  const ctx = result.getContext('2d')
  if (!ctx) throw new AppearanceImportError('encode')
  drawAppearanceImage(ctx, input.source, framing, result.width, slot === 'icon')
  let image = result.toDataURL('image/png')
  if (slot === 'splash' && input.original && framing.mode === 'fit') image = input.original
  else if (!validAppearanceImage(image, slot === 'icon')) {
    // Preserve transparency; lossy WebP helps photos without painting a solid background.
    for (const quality of [0.9, 0.75, 0.55]) {
      image = result.toDataURL('image/webp', quality)
      if (validAppearanceImage(image, slot === 'icon')) break
    }
    if (!validAppearanceImage(image, slot === 'icon')) {
      result.width = result.height = 256
      drawAppearanceImage(ctx, input.source, framing, 256, slot === 'icon')
      image = result.toDataURL('image/png')
    }
  }
  if (!validAppearanceImage(image, slot === 'icon')) throw new AppearanceImportError('encode')
  const posterCanvas = canvas(256)
  const posterCtx = posterCanvas.getContext('2d')
  if (!posterCtx) throw new AppearanceImportError('encode')
  drawAppearanceImage(posterCtx, input.source, framing, 256)
  const poster = posterCanvas.toDataURL('image/png')
  return { id: 'upload', label: input.name, image, ...(slot === 'splash' ? { poster } : {}) }
}
