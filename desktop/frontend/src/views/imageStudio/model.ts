import type { DisplayFile, UiMessage } from '../../types'
import type { Box } from '../../amadeus/unified/canvasKit/geometry'

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export interface StudioLayer extends Box {
  id: string
  name: string
  locked?: boolean
  hidden?: boolean
}
export interface StudioImage extends StudioLayer {
  blob: Blob
  width: number
  height: number
  source: 'import' | 'generated'
  sourceKey?: string
  /** The source image remains independent; this id only records version lineage. */
  parentId?: string
  prompt?: string
  brightness: number
  contrast: number
  saturation: number
  crop?: Box
  rotation?: number
  flipX?: boolean
  flipY?: boolean
}
export interface StudioElement extends StudioLayer {
  kind: 'text' | 'rectangle' | 'ellipse' | 'frame'
  fill: string
  stroke: string
  strokeWidth: number
  radius: number
  text: string
  fontSize: number
  fontFamily: 'sans-serif' | 'serif' | 'monospace'
  bold: boolean
  align: 'left' | 'center' | 'right'
}
export type StudioItem = StudioImage | StudioElement
export interface ImageBoard {
  version: 1 | 2
  id: string
  name: string
  updatedAt: number
  sessionId: string | null
  images: StudioImage[]
  /** Removed outputs stay acknowledged, so history reload does not resurrect them. */
  collected: string[]
  elements?: StudioElement[]
  order?: string[]
}
export function newBoard(name: string): ImageBoard {
  return { version: 2, id: crypto.randomUUID(), name, updatedAt: Date.now(), sessionId: null, images: [], elements: [], order: [], collected: [] }
}
export function imageBox(width: number, height: number, images: readonly StudioImage[]): Box {
  const scale = Math.min(1, 360 / Math.max(width, height))
  return { x: images.length ? Math.max(...images.map(i => i.x + i.w)) + 32 : 0, y: 0, w: width * scale, h: height * scale }
}
export function collectImageOutputs(messages: readonly UiMessage[]): Array<{ key: string; file: DisplayFile; prompt: string }> {
  const found = new Map<string, { key: string; file: DisplayFile; prompt: string }>()
  let prompt = ''
  for (const message of messages) {
    if (message.role === 'user') prompt = message.content
    for (const [index, file] of (message.displayFiles || []).entries()) {
      if (!IMAGE_TYPES.has(file.mime || '') && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) continue
      if (!file.path && !file.dataUrl) continue
      const key = file.path ? `${file.sourceSessionId || ''}:${file.path}` : `${message.id}:${index}:${file.name}`
      found.set(key, { key, file, prompt })
    }
  }
  return [...found.values()]
}
export function arrangeImages(images: readonly StudioImage[]): StudioImage[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(images.length)))
  return images.map((image, index) => {
    const size = imageSize(image), scale = 300 / Math.max(size.w, size.h)
    return { ...image, x: (index % columns) * 340, y: Math.floor(index / columns) * 360, w: size.w * scale, h: size.h * scale }
  })
}
export function imageFilter(image: StudioImage): string {
  return `brightness(${image.brightness}%) contrast(${image.contrast}%) saturate(${image.saturation}%)`
}
export function isImageBoard(input: unknown): input is ImageBoard {
  const b = input as ImageBoard | null
  if (!b || (b.version !== 1 && b.version !== 2) || typeof b.id !== 'string' || typeof b.name !== 'string') return false
  const valid =
    (b.sessionId === null || typeof b.sessionId === 'string') && Number.isFinite(b.updatedAt)
    && Array.isArray(b.collected) && b.collected.every(k => typeof k === 'string')
    && Array.isArray(b.images) && b.images.every(i => validLayer(i)
      && i.blob instanceof Blob && IMAGE_TYPES.has(i.blob.type) && i.blob.size <= MAX_IMAGE_BYTES
      && [i.x, i.y, i.w, i.h, i.width, i.height, i.brightness, i.contrast, i.saturation].every(Number.isFinite)
      && i.w > 0 && i.h > 0 && i.width > 0 && i.height > 0
      && [i.brightness, i.contrast, i.saturation].every(value => value >= 0 && value <= 200)
      && (i.crop === undefined || validCrop(i.crop, i.width, i.height))
      && (i.rotation === undefined || (Number.isFinite(i.rotation) && i.rotation >= 0 && i.rotation < 360))
      && (i.parentId === undefined || typeof i.parentId === 'string')
      && [i.flipX, i.flipY].every(v => v === undefined || typeof v === 'boolean'))
    && (b.elements === undefined || (Array.isArray(b.elements) && b.elements.every(validElement)))
    && (b.order === undefined || (Array.isArray(b.order) && b.order.every(id => typeof id === 'string')))
  if (!valid) return false
  const ids = [...b.images, ...(b.elements || [])].map(i => i.id)
  return new Set(ids).size === ids.length
}

export const isImage = (item: StudioItem): item is StudioImage => 'blob' in item && item.blob instanceof Blob
export const isFrame = (item: StudioItem): item is StudioElement & { kind: 'frame' } => !isImage(item) && item.kind === 'frame'
const validLayer = (i: StudioLayer): boolean => !!i && typeof i.id === 'string' && typeof i.name === 'string'
  && [i.x, i.y, i.w, i.h].every(n => Number.isFinite(n) && Math.abs(n) <= 1_000_000) && i.w > 0 && i.h > 0
  && [i.locked, i.hidden].every(v => v === undefined || typeof v === 'boolean')
export const validCrop = (c: Box, w: number, h: number): boolean => !!c && [c.x, c.y, c.w, c.h].every(Number.isFinite)
  && c.x >= 0 && c.y >= 0 && c.w >= 1 && c.h >= 1 && c.x + c.w <= w && c.y + c.h <= h
export function validElement(e: StudioElement): boolean {
  return validLayer(e) && !('blob' in e) && ['text', 'rectangle', 'ellipse', 'frame'].includes(e.kind)
    && [e.fill, e.stroke].every(c => typeof c === 'string' && /^(#[\da-f]{6}|transparent)$/i.test(c))
    && [e.strokeWidth, e.radius, e.fontSize].every(Number.isFinite)
    && e.strokeWidth >= 0 && e.strokeWidth <= 100 && e.radius >= 0 && e.radius <= 1000
    && e.fontSize >= 6 && e.fontSize <= 500 && typeof e.text === 'string' && e.text.length <= 10_000
    && ['sans-serif', 'serif', 'monospace'].includes(e.fontFamily) && typeof e.bold === 'boolean'
    && ['left', 'center', 'right'].includes(e.align)
}
export function imageSize(image: StudioImage): { w: number; h: number } {
  const c = image.crop || { w: image.width, h: image.height }, a = (image.rotation || 0) * Math.PI / 180
  return { w: Math.round((Math.abs(c.w * Math.cos(a)) + Math.abs(c.h * Math.sin(a))) * 1e8) / 1e8, h: Math.round((Math.abs(c.w * Math.sin(a)) + Math.abs(c.h * Math.cos(a))) * 1e8) / 1e8 }
}
export function transformImage(image: StudioImage, patch: Partial<StudioImage>): StudioImage {
  const next = { ...image, ...patch }, size = imageSize(next), old = imageSize(image)
  const scale = image.w / old.w, w = size.w * scale, h = size.h * scale
  return { ...next, x: image.x + (image.w - w) / 2, y: image.y + (image.h - h) / 2, w, h }
}
export function boardItems(board: ImageBoard): StudioItem[] {
  const items: StudioItem[] = [...board.images, ...(board.elements || [])]
  const order = new Map((board.order || []).map((id, index) => [id, index]))
  return items.sort((a, b) => Number(isFrame(b)) - Number(isFrame(a)) || (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
}
export function replaceItems(board: ImageBoard, items: StudioItem[]): ImageBoard {
  return { ...board, version: 2, images: items.filter(isImage), elements: items.filter((i): i is StudioElement => !isImage(i)), order: items.map(i => i.id) }
}
export function mapItems(board: ImageBoard, edit: (i: StudioItem) => StudioItem): ImageBoard {
  return replaceItems(board, boardItems(board).map(edit))
}
export const contains = (outer: Box, inner: Box): boolean => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w + .01 && inner.y + inner.h <= outer.y + outer.h + .01
/** A frame moves its currently contained layers; resizing changes only the export area. */
export function moveItems(board: ImageBoard, next: Map<string, Box>): ImageBoard {
  const items = boardItems(board), expanded = new Map(next)
  for (const frame of items.filter(isFrame)) {
    const rect = next.get(frame.id)
    if (!rect || frame.locked || (rect.x === frame.x && rect.y === frame.y)) continue
    for (const item of items) if (!isFrame(item) && !item.locked && !expanded.has(item.id) && contains(frame, item)) {
      expanded.set(item.id, { ...item, x: item.x + rect.x - frame.x, y: item.y + rect.y - frame.y })
    }
  }
  return mapItems(board, i => i.locked || !expanded.has(i.id) ? i : { ...i, ...expanded.get(i.id)! })
}
export function newElement(kind: StudioElement['kind'], name: string, x = 0, y = 0): StudioElement {
  return { id: crypto.randomUUID(), kind, name, x, y, w: kind === 'frame' ? 1080 : 320, h: kind === 'frame' ? 1080 : kind === 'text' ? 120 : 240,
    fill: kind === 'frame' ? '#ffffff' : kind === 'text' ? '#242424' : '#c9c4b8', stroke: '#242424', strokeWidth: 0, radius: 0,
    text: kind === 'text' ? name : '', fontSize: 40, fontFamily: 'sans-serif', bold: false, align: 'left' }
}
export function cloneItems(items: StudioItem[], dx = 32, dy = 32): StudioItem[] {
  return items.map(i => ({ ...i, id: crypto.randomUUID(), locked: false, x: i.x + dx, y: i.y + dy }))
}
export function reorderItems(board: ImageBoard, ids: string[], direction: 'front' | 'back' | 'up' | 'down'): ImageBoard {
  const items = boardItems(board), selected = new Set(ids)
  if (direction === 'front' || direction === 'back') {
    const a = items.filter(i => selected.has(i.id)), b = items.filter(i => !selected.has(i.id))
    return replaceItems(board, direction === 'front' ? [...b, ...a] : [...a, ...b])
  }
  const sign = direction === 'up' ? 1 : -1
  for (let i = sign === 1 ? items.length - 2 : 1; i >= 0 && i < items.length; i -= sign) {
    if (selected.has(items[i].id) && items[i + sign] && !selected.has(items[i + sign].id)) [items[i], items[i + sign]] = [items[i + sign], items[i]]
  }
  return replaceItems(board, items)
}
