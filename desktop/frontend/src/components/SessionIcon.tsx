import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle } from 'lucide-react'
import { IconPicker } from '../amadeus/chrome/pageChrome'
import { useApp } from '../stores/appStore'
import { registerMessages } from '../i18n'

registerMessages({
  'session.icon.set': { zh: '设置图标', en: 'Set icon' },
  'session.icon.invalid': { zh: '请选择一个 Emoji 作为会话图标', en: 'Choose one emoji for the session icon' },
  'session.icon.saveFail': { zh: '图标未能保存：{e}', en: 'Could not save the icon: {e}' },
})

export function SessionIcon({ emoji, fallback, size = 17 }: { emoji?: string | null; fallback?: ReactNode; size?: number }) {
  return emoji
    ? <span data-session-emoji={emoji} aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0, fontSize: size, lineHeight: 1 }}>{emoji}</span>
    : <>{fallback ?? <MessageCircle size={size} />}</>
}

/** Native reactive tab slot also respects frozen/split chat leaves. */
export function SessionTabIcon({ params, size }: { params: Record<string, unknown>; size: number }) {
  const emoji = useApp((s) => {
    const id = params.followActive !== false ? s.activeId : params.sessionId
    return s.sessions.find((x) => x.id === id)?.emoji ?? s.archivedSessions.find((x) => x.id === id)?.emoji
  })
  return <SessionIcon emoji={emoji} size={size} />
}

export function SessionIconPicker({ sessionId, current, x, y, onClose, onSave }: {
  sessionId: string; current: string | null; x: number; y: number; onClose: () => void
  onSave?: (emoji: string | null) => Promise<boolean>
}) {
  const saving = useRef(false)
  const pick = async (emoji: string | null) => {
    if (saving.current) return
    saving.current = true
    try {
      if (await (onSave ? onSave(emoji) : useApp.getState().setSessionEmoji(sessionId, emoji))) onClose()
    } finally { saving.current = false }
  }
  return createPortal(<IconPicker x={x} y={y} current={current} onPick={(emoji) => void pick(emoji)} onClose={onClose} />, document.body)
}
