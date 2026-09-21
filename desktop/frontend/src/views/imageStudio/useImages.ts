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
