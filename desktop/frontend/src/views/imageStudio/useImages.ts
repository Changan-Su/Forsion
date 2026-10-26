import { useEffect, useState } from 'react'
import { useApp } from '../../stores/appStore'
import { useImageStudio } from '../../stores/imageStudioStore'
import { targetFor } from '../../components/InlineFiles'
import { collectImageOutputs, imageBox, type ImageBoard } from './model'
import { makeImage } from './files'
import type { UiMessage } from '../../types'
import { centerCropForAspect, imageToolRequest } from './generation'

const EMPTY: UiMessage[] = []
const collecting = new Set<string>()
export function useBlobUrl(blob: Blob): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(blob); setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}
/** 图里有没有透明像素(走查续七 7.8:只有带透明的图才在后面画棋盘格)。每个 blob 解码一次、记在 WeakMap 里,
 *  不在重绘时算。JPEG 没有 alpha 通道,不解码直接 false。
 *  ponytail: 会话内缓存、不落进图层元数据 —— 免得改项目的存盘格式;真要跨会话省这一次解码再挪进 makeImage。 */
const alphaCache = new WeakMap<Blob, Promise<boolean>>()
export function blobHasAlpha(blob: Blob): Promise<boolean> {
  let hit = alphaCache.get(blob)
  if (!hit) {
    hit = /jpe?g/i.test(blob.type) ? Promise.resolve(false) : (async () => {
      const bitmap = await createImageBitmap(blob)
      try {
        // 长边压到 512 采样:透明角 / 抠图边缘这种成片的透明压不掉,大图也不卡。
        const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height))
        const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
        const ctx = new OffscreenCanvas(w, h).getContext('2d')
        if (!ctx) return false
        ctx.drawImage(bitmap, 0, 0, w, h)
        const data = ctx.getImageData(0, 0, w, h).data
        for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true
        return false
      } finally { bitmap.close() }
    })().catch(() => false)
    alphaCache.set(blob, hit)
  }
  return hit
}
export function useHasAlpha(blob: Blob | null): boolean {
  const [alpha, setAlpha] = useState(false)
  useEffect(() => {
    if (!blob) { setAlpha(false); return }
    let alive = true
    void blobHasAlpha(blob).then(value => { if (alive) setAlpha(value) })
    return () => { alive = false }
  }, [blob])
  return alpha
}
export function useCollectImages(board: ImageBoard, onError: (message: string) => void, retry: number): void {
  const messages = useApp(s => board.sessionId ? s.messagesBySession[board.sessionId] || EMPTY : EMPTY)
  const running = useApp(s => !!(board.sessionId && s.runningBySession[board.sessionId]))
  useEffect(() => {
    if (!board.sessionId) return
    for (const event of messages.flatMap(message => message.toolEvents || [])) {
      const request = imageToolRequest(event.name, event.arguments)
      if (!request) continue
      if (!event.done) useImageStudio.getState().bindGenerationTool(board.id, board.sessionId, event.id, request)
      else if (event.isError || /^Error:/i.test(event.result || '')) useImageStudio.getState().failGeneration(board.id, { sessionId: board.sessionId, toolId: event.id })
    }
  }, [board.id, board.sessionId, messages])
  useEffect(() => {
    if (!board.sessionId || running) return
    const timer = window.setTimeout(() => {
      const state = useImageStudio.getState()
      const ids = (state.placeholders[board.id] || []).filter(item => item.sessionId === board.sessionId && item.status === 'running').map(item => item.id)
      if (ids.length) state.failGeneration(board.id, { ids })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [board.id, board.sessionId, messages, running])
  useEffect(() => {
    const sessionId = board.sessionId
    if (!sessionId) return
    let cancelled = false
    const outputs = collectImageOutputs(messages)
    void (async () => {
      for (const output of outputs) {
        if (cancelled) return
        const current = useImageStudio.getState().boards[board.id]
        if (!current || current.collected.includes(output.key) || collecting.has(output.key)) continue
        collecting.add(output.key)
        try {
          const app = useApp.getState()
          const mode = app.configBySession[output.file.sourceSessionId || sessionId]?.execMode || 'sandbox'
          const data = await targetFor(output.file, app.cfg, sessionId, mode).load()
          if (cancelled) return
          if (!data || 'tooLarge' in data) throw new Error(output.file.name)
          const blob = new Blob([data.bytes as BlobPart], { type: data.mimeType || output.file.mime })
          const image = await makeImage(blob, output.file.name, 'generated')
          if (cancelled) return
          const placement = useImageStudio.getState().takeGeneration(board.id, sessionId)
          const crop = placement ? centerCropForAspect(image.width, image.height, placement.aspect) : undefined
          useImageStudio.getState().update(board.id, b => b.collected.includes(output.key) ? b : ({
            ...b, collected: [...b.collected, output.key], images: [...b.images, {
              ...image,
              ...(placement ? { x: placement.x, y: placement.y, w: placement.w, h: placement.h } : imageBox(image.width, image.height, b.images)),
              ...(crop ? { crop } : {}),
              ...(placement?.sourceIds[0] ? { parentId: placement.sourceIds[0] } : {}),
              sourceKey: output.key, prompt: output.prompt,
            }],
          }))
        } catch (e) { if (!cancelled) onError(String(e)) }
        finally { collecting.delete(output.key) }
      }
    })()
    return () => { cancelled = true }
  }, [board.id, board.sessionId, messages, onError, retry])
}
