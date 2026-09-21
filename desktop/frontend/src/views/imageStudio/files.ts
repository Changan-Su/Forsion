import { translate } from '../../i18n'
import type { Attachment } from '../../types'
import { imageFilter, imageSize, isImage, IMAGE_TYPES, MAX_IMAGE_BYTES, isImageBoard, newBoard, type StudioImage, type ImageBoard } from './model'
import { unionBox } from '../../amadeus/unified/canvasKit/geometry'
import { elementMarkup, escapeXml, exportScene, type ExportScene } from './scene'
import type { ImageSourceMode } from './generation'

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  if (!IMAGE_TYPES.has(blob.type) || blob.size > MAX_IMAGE_BYTES) throw new Error(translate('imageStudio.importLimit'))
  const image = await createImageBitmap(blob)
  if (image.width * image.height > 40_000_000) { image.close(); throw new Error(translate('imageStudio.tooLarge')) }
  return image
}
export async function makeImage(blob: Blob, name: string, source: StudioImage['source']): Promise<StudioImage> {
  if (!IMAGE_TYPES.has(blob.type) || blob.size > MAX_IMAGE_BYTES) throw new Error(translate('imageStudio.importLimit'))
  // File objects may point at a mutable OS file. Capture bytes before storing or exporting:
  // overwriting/moving the imported file must never invalidate the project's original.
  blob = new Blob([await blob.arrayBuffer()], { type: blob.type })
  const bitmap = await decodeImage(blob)
  const image: StudioImage = { id: crypto.randomUUID(), name, blob, width: bitmap.width, height: bitmap.height, x: 0, y: 0, w: 0, h: 0, source, brightness: 100, contrast: 100, saturation: 100 }
  bitmap.close()
  return image
}
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
export async function imageAttachment(image: StudioImage, source: ImageSourceMode = 'current'): Promise<Attachment> {
  // Current sends the visible crop and adjustments. Original deliberately strips every non-destructive parameter.
  const input = source === 'original' ? {
    ...image, crop: undefined, rotation: 0, flipX: false, flipY: false,
    brightness: 100, contrast: 100, saturation: 100,
  } : image
  const blob = await renderImages([input], true, 1536)
  if (blob.size > 5_900_000) throw new Error(translate('imageStudio.referenceBytes'))
  const url = await blobDataUrl(blob)
  return { name: image.name.replace(/\.[^.]+$/, '') + '.png', mimeType: 'image/png', data: url.split(',')[1], size: blob.size }
}
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
export async function renderImages(images: readonly StudioImage[], original = false, maxSide?: number): Promise<Blob> {
  const boxes = original && images.length === 1 ? [{ ...images[0], x: 0, y: 0, ...imageSize(images[0]) }] : images
  const bounds = unionBox(boxes)
  if (!bounds) throw new Error(translate('imageStudio.select'))
  const scale = maxSide ? Math.min(1, maxSide / Math.max(bounds.w, bounds.h)) : 1
  const w = Math.ceil(bounds.w * scale), h = Math.ceil(bounds.h * scale)
  if (w * h > 40_000_000 || Math.max(w, h) > 16384) throw new Error(translate('imageStudio.exportLimit'))
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  for (const box of boxes) {
    const bitmap = await decodeImage(box.blob)
    const c = box.crop || { x: 0, y: 0, w: box.width, h: box.height }, size = imageSize(box)
    ctx.save()
    ctx.filter = imageFilter(box)
    ctx.translate((box.x - bounds.x + box.w / 2) * scale, (box.y - bounds.y + box.h / 2) * scale)
    ctx.scale(box.w * scale / size.w, box.h * scale / size.h)
    ctx.rotate((box.rotation || 0) * Math.PI / 180)
    ctx.scale(box.flipX ? -1 : 1, box.flipY ? -1 : 1)
    ctx.drawImage(bitmap, c.x, c.y, c.w, c.h, -c.w / 2, -c.h / 2, c.w, c.h)
    ctx.restore()
    bitmap.close()
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'))
}
export async function exportProject(board: ImageBoard): Promise<void> {
  const images = await Promise.all(board.images.map(async ({ blob, ...image }) => ({ ...image, dataUrl: await blobDataUrl(blob) })))
  downloadBlob(new Blob([JSON.stringify({ ...board, version: 2, images, sessionId: null, collected: [] })], { type: 'application/json' }), `${board.name}.forsion-image.json`)
}
export async function importProject(file: File): Promise<ImageBoard> {
  if (file.size > 128 * 1024 * 1024) throw new Error(translate('imageStudio.tooLarge'))
  const data = JSON.parse(await file.text())
  if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.images) || data.images.length > 200 || (data.elements !== undefined && (!Array.isArray(data.elements) || data.elements.length > 500))) throw new Error('Unsupported Image Studio project')
  const images = await Promise.all(data.images.map(async (value: Record<string, unknown>) => {
    if (typeof value.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(value.dataUrl)) throw new Error('Invalid image data')
    const [prefix, base64] = value.dataUrl.split(',')
    if (base64.length > MAX_IMAGE_BYTES * 1.4) throw new Error(translate('imageStudio.importLimit'))
    const raw = atob(base64)
    const blob = new Blob([Uint8Array.from(raw, c => c.charCodeAt(0))], { type: prefix.slice(5, -7) })
    const image = await makeImage(blob, String(value.name || ''), 'import')
    return { ...image, id: value.id, source: value.source === 'generated' ? 'generated' : 'import', parentId: typeof value.parentId === 'string' ? value.parentId : undefined, prompt: typeof value.prompt === 'string' ? value.prompt : undefined, x: value.x, y: value.y, w: value.w, h: value.h, brightness: value.brightness, contrast: value.contrast, saturation: value.saturation, crop: value.crop, rotation: value.rotation, flipX: value.flipX, flipY: value.flipY, locked: value.locked, hidden: value.hidden }
  }))
  const board = { ...newBoard(String(data.name || translate('imageStudio.untitled'))), images, elements: data.elements || [], order: data.order || [] }
  if (!isImageBoard(board)) throw new Error('Invalid Image Studio project')
  return board
}

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'svg'
export interface ExportOptions { format: ExportFormat; scale: number; background: string; quality: number }
export function sceneForExport(board: ImageBoard, selection: string[]): ExportScene | null {
  const scene = exportScene(board, selection)
  if (scene?.items.length === 1 && isImage(scene.items[0])) {
    const item = { ...scene.items[0], x: 0, y: 0, ...imageSize(scene.items[0]) }
    return { items: [item], bounds: item }
  }
  return scene
}
export async function renderBoard(board: ImageBoard, selection: string[], options: ExportOptions): Promise<Blob> {
  const scene = sceneForExport(board, selection)
  if (!scene) throw new Error(translate('imageStudio.select'))
  const { bounds, items } = scene
  const width = Math.round(bounds.w * options.scale), height = Math.round(bounds.h * options.scale)
  if (width < 1 || height < 1 || width * height > 40_000_000 || Math.max(width, height) > 16384) throw new Error(translate('imageStudio.exportLimit'))
  const background = options.format === 'jpeg' && options.background === 'transparent' ? '#ffffff' : options.background
  if (!/^(#[\da-f]{6}|transparent)$/i.test(background)) throw new Error('Invalid background')
  const markup: string[] = []
  if (background !== 'transparent') markup.push(`<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="${background}"/>`)
  for (const item of items) {
    if (isImage(item)) {
      const src = await blobDataUrl(await renderImages([item], true))
      markup.push(`<image x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" preserveAspectRatio="none" href="${src}"/>`)
    } else markup.push(`<svg x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" viewBox="0 0 ${item.w} ${item.h}" overflow="hidden">${elementMarkup(item)}</svg>`)
  }
  const svg = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}"><title>${escapeXml(board.name)}</title>${markup.join('')}</svg>`], { type: 'image/svg+xml' })
  if (options.format === 'svg') return svg
  const url = URL.createObjectURL(svg), img = new Image()
  try {
    img.src = url; await img.decode()
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(img, 0, 0)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Export failed')), `image/${options.format}`, options.quality))
  } finally { URL.revokeObjectURL(url) }
}
