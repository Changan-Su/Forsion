import type { Box } from '../../amadeus/unified/canvasKit/geometry'
import { boardItems, imageSize, type ImageBoard, type StudioImage } from './model'

export const EDIT_RATIO_PRESETS = ['1:1', '4:5', '5:4', '2:3', '3:2', '16:9', '9:16'] as const
export const ENGINE_IMAGE_RATIOS = ['1:1', '2:3', '3:2', '16:9', '9:16'] as const
export type ImageSourceMode = 'current' | 'original'
export type GenerationKind = 'generate' | 'edit'
export type GenerationStatus = 'preparing' | 'running' | 'failed'

export interface GenerationPlaceholder extends Box {
  id: string
  generationId: string
  boardId: string
  sessionId: string
  toolId?: string
  sourceIds: string[]
  kind: GenerationKind
  status: GenerationStatus
  aspect: number
  ratio: string
  index: number
  count: number
  createdAt: number
}

export interface OutputRatioPlan {
  aspect: number
  requested: string
  engine: typeof ENGINE_IMAGE_RATIOS[number]
  originalLabel: string
}

export interface GenerationRequest {
  count: number
  aspect: number
  ratio: string
  kind: GenerationKind
  sourceIds?: string[]
}

const ratioValue = (ratio: string): number => {
  const [w, h] = ratio.split(':').map(Number)
  return w > 0 && h > 0 ? w / h : 1
}

export function formatAspectRatio(width: number, height: number): string {
  const aspect = width > 0 && height > 0 ? width / height : 1
  const familiar = EDIT_RATIO_PRESETS.find(ratio => Math.abs(Math.log(ratioValue(ratio) / aspect)) < .012)
  if (familiar) return familiar
  return aspect >= 1 ? `${Number(aspect.toFixed(2))}:1` : `1:${Number((1 / aspect).toFixed(2))}`
}

export function outputRatioPlan(image: StudioImage, choice: string): OutputRatioPlan {
  const size = imageSize(image), originalLabel = formatAspectRatio(size.w, size.h)
  const requested = choice === 'original' ? originalLabel : choice
  const aspect = choice === 'original' ? size.w / size.h : ratioValue(requested)
  const engine = ENGINE_IMAGE_RATIOS.reduce((best, ratio) =>
    Math.abs(Math.log(ratioValue(ratio) / aspect)) < Math.abs(Math.log(ratioValue(best) / aspect)) ? ratio : best)
  return { aspect, requested, engine, originalLabel }
}

export function centerCropForAspect(width: number, height: number, aspect: number): Box | undefined {
  if (!(width > 0 && height > 0 && aspect > 0)) return undefined
  const current = width / height
  if (Math.abs(Math.log(current / aspect)) < .001) return undefined
  if (current > aspect) {
    const w = height * aspect
    return { x: (width - w) / 2, y: 0, w, h: height }
  }
  const h = width / aspect
  return { x: 0, y: (height - h) / 2, w: width, h }
}

export function generationBoxes(board: ImageBoard, request: GenerationRequest, pending: readonly Box[] = []): Box[] {
  const sourceIds = new Set(request.sourceIds || [])
  const sources = board.images.filter(image => sourceIds.has(image.id))
  const obstacles = [...boardItems(board), ...pending]
  const maxSide = sources.length ? Math.min(360, Math.max(sources[0].w, sources[0].h)) : 320
  const aspect = Math.max(.2, Math.min(5, request.aspect || 1))
  const w = aspect >= 1 ? maxSide : maxSide * aspect
  const h = aspect >= 1 ? maxSide / aspect : maxSide
  const right = sources.length
    ? Math.max(...sources.map(source => source.x + source.w))
    : obstacles.length ? Math.max(...obstacles.map(item => item.x + item.w)) : -32
  const y = sources.length ? Math.min(...sources.map(source => source.y)) : 0
  return Array.from({ length: Math.max(1, Math.min(4, Math.round(request.count) || 1)) }, (_, index) => ({
    x: right + 32 + index * (w + 32), y, w, h,
  }))
}

export function imageToolRequest(name: string, rawArguments?: string): GenerationRequest | null {
  if (name !== 'generate_image' && name !== 'edit_image') return null
  let args: Record<string, unknown> = {}
  try { args = rawArguments ? JSON.parse(rawArguments) : {} } catch { /* streamed arguments are incomplete */ }
  const ratio = typeof args.size === 'string' && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(args.size) ? args.size : '1:1'
  const count = Number.isInteger(args.n) ? Number(args.n) : 1
  return { count: Math.max(1, Math.min(4, count)), aspect: ratioValue(ratio), ratio, kind: name === 'edit_image' ? 'edit' : 'generate' }
}
