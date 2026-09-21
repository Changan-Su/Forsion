import type { Attachment } from '../../types'
import type { StudioImage } from './model'
import { blobDataUrl, imageAttachment, renderImages, decodeImage } from './files'
import { translate } from '../../i18n'
import { EDIT_RATIO_PRESETS, type ImageSourceMode, type OutputRatioPlan } from './generation'

export type EditMode = 'edit' | 'background' | 'expand'
export const EDIT_RATIOS = EDIT_RATIO_PRESETS
/** 渲染档位 = 图像 API 的 `quality`(OpenAI 没有 effort 这个字段)。'' = 不指定,跟随上游缺省。
 *  xhigh / max 只有 gpt-image-2.5 一档的模型有,且逐档变贵(实测 low 425 → xhigh 1650 output tokens)。 */
export const EDIT_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export function expansionBox(width: number, height: number, ratio: string, margin: number) {
  const [rw, rh] = ratio.split(':').map(Number), factor = 1 + Math.max(.1, Math.min(1, margin))
  const w = Math.ceil(Math.max(width * factor, height * factor * rw / rh))
  const h = Math.ceil(w * rh / rw)
  return { w, h, x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2) }
}
export async function editAttachments(images: StudioImage[], mode: EditMode, ratio: string, margin: number, source: ImageSourceMode): Promise<Attachment[]> {
  if (!images.length || images.length > 8) throw new Error(translate('imageStudio.ai.referenceLimit'))
  if (mode !== 'expand') return Promise.all(images.map(image => imageAttachment(image, source)))
  const blob = await renderImages([images[0]], true, 1024), bitmap = await decodeImage(blob)
  try {
    const box = expansionBox(bitmap.width, bitmap.height, ratio, margin)
    const scale = Math.min(1, 1536 / Math.max(box.w, box.h))
    const canvas = document.createElement('canvas'); canvas.width = Math.round(box.w * scale); canvas.height = Math.round(box.h * scale)
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(bitmap, box.x * scale, box.y * scale, bitmap.width * scale, bitmap.height * scale)
    const expanded = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed')), 'image/png'))
    const url = await blobDataUrl(expanded)
    return [{ name: 'expand-reference.png', mimeType: 'image/png', size: expanded.size, data: url.split(',')[1] }]
  } finally { bitmap.close() }
}
export function editPrompt(mode: EditMode, instruction: string, ratio: OutputRatioPlan, n: number, source: ImageSourceMode, quality = ''): string {
  return [
    translate(`imageStudio.ai.prompt.${mode}`),
    translate(`imageStudio.ai.sourcePrompt.${mode === 'expand' ? 'current' : source}`),
    instruction.trim(),
    translate('imageStudio.ai.outputPrompt', { ratio: ratio.requested, engineRatio: ratio.engine, count: n }),
    quality ? translate('imageStudio.ai.qualityPrompt', { quality }) : '',
  ].filter(Boolean).join('\n\n')
}
