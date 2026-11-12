/** Read receipts belong to rendered chat surfaces, never the global sidebar selection. */
import { useAttention } from '../../stores/attentionStore'
import { useApp } from '../../stores/appStore'

export function messageIsVisible(element: HTMLElement, viewport: HTMLElement): boolean {
  const doc = element.ownerDocument
  if (doc.hidden || !doc.hasFocus() || !element.isConnected) return false
  const r = element.getBoundingClientRect()
  const v = viewport.getBoundingClientRect()
  const left = Math.max(r.left, v.left, 0), right = Math.min(r.right, v.right, doc.documentElement.clientWidth)
  const top = Math.max(r.top, v.top, 0), bottom = Math.min(r.bottom, v.bottom, doc.documentElement.clientHeight)
  if (right <= left || bottom - top < Math.min(24, r.height) || r.height <= 0) return false
  // Hit testing also excludes hidden Space/tab panels and overlays (including the composer).
  const hit = doc.elementFromPoint((left + right) / 2, (top + bottom) / 2)
  return !!hit && element.contains(hit)
}

export function trackChatReadReceipt(viewport: HTMLElement, sessionId: string): () => void {
  let stopped = false
  const check = (): void => {
    if (stopped) return
    const app = useApp.getState()
    const sessions = new Set([sessionId, ...Array.from(viewport.querySelectorAll<HTMLElement>('[data-read-session-id]')).map((el) => el.dataset.readSessionId!).filter(Boolean)])
    for (const id of sessions) {
      const dm = useAttention.getState().dm[id]
      if (!dm?.unread && !app.sessions.some((s) => s.id === id && s.awaiting_user)) continue
      // Unread proactive messages require seeing the proactive message itself. An ordinary
      // reply with an equal/later timestamp cannot acknowledge an unseen proactive message.
      // Canvas cards/readers carry their own session, independent of the global selection.
      const message = [...(app.messagesBySession[id] || [])].reverse().find((m) => m.role === 'assistant' && (!dm?.unread || m.origin?.startsWith('proactive')))
      if (!message || message.status === 'streaming') continue
      const visible = Array.from(viewport.querySelectorAll<HTMLElement>('[id^="tocmsg-"]'))
        .some((el) => el.id === `tocmsg-${message.id}` && messageIsVisible(el, viewport))
      if (visible) useAttention.getState().markRead(id, message.id)
    }
  }
  const timer = setInterval(check, 750)
  viewport.addEventListener('scroll', check, { passive: true })
  const win = viewport.ownerDocument.defaultView
  win?.addEventListener('focus', check)
  return () => {
    stopped = true
    clearInterval(timer)
    viewport.removeEventListener('scroll', check)
    win?.removeEventListener('focus', check)
  }
}
