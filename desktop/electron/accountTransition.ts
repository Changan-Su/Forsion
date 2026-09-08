import { randomUUID } from 'node:crypto'

interface Renderer {
  id: number
  send(channel: string, payload: unknown): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}
interface AckEvents {
  on(channel: string, listener: (event: { sender: { id: number } }, requestId: string, error?: string) => void): unknown
  removeListener(channel: string, listener: (event: { sender: { id: number } }, requestId: string, error?: string) => void): unknown
}

/** Every live editor must flush and retire its document before credentials change. */
export function waitForAccountRenderers(renderers: Renderer[], events: AckEvents, timeoutMs = 15000): Promise<void> {
  if (!renderers.length) return Promise.resolve()
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const pending = new Set(renderers.map((r) => r.id))
    const destroyed = new Map<Renderer, () => void>()
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      events.removeListener('auth:ready', onReady)
      for (const [renderer, listener] of destroyed) renderer.removeListener('destroyed', listener)
      if (error) reject(error)
      else resolve()
    }
    const onReady = (event: { sender: { id: number } }, receivedId: string, error?: string): void => {
      if (receivedId !== requestId || !pending.has(event.sender.id)) return
      if (error) { finish(new Error(`Unable to save an open editor: ${error}`)); return }
      pending.delete(event.sender.id)
      if (!pending.size) finish()
    }
    const timer = setTimeout(() => finish(new Error('An open editor did not finish saving. Account change cancelled.')), timeoutMs)
    events.on('auth:ready', onReady)
    for (const renderer of renderers) {
      const onDestroyed = (): void => onReady({ sender: renderer }, requestId)
      destroyed.set(renderer, onDestroyed)
      renderer.once('destroyed', onDestroyed)
    }
    try {
      for (const renderer of renderers) renderer.send('auth:will-change', { requestId })
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}
