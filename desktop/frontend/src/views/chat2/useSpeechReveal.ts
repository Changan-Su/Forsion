import { useLayoutEffect, useState } from 'react'
import type { UiMessage } from '../../types'

/** Presentation only: the complete remark is already persisted before this short reveal starts. */
export function useSpeechReveal(message: UiMessage): UiMessage {
  const [frame, setFrame] = useState({ id: '', at: 0, count: Infinity })
  const at = message.revealAt || 0
  const eligible = !!at && Date.now() - at < 2000 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const count = frame.id === message.id && frame.at === at ? frame.count : eligible ? 0 : Infinity
  useLayoutEffect(() => {
    if (!eligible || !message.content) return
    const chars = Array.from(message.content)
    const duration = Math.min(900, Math.max(180, chars.length * 3))
    const started = performance.now()
    let raf = 0
    const tick = (): void => {
      const progress = Math.min(1, (performance.now() - started) / duration)
      setFrame({ id: message.id, at, count: progress === 1 ? Infinity : Math.ceil(chars.length * progress) })
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [message.id, at, message.content]) // eligibility is sampled only when a new remark arrives
  if (!Number.isFinite(count)) return message
  const content = Array.from(message.content).slice(0, count).join('')
  return { ...message, content, segments: content ? [{ t: 'text', text: content }] : [], teamDone: false }
}
