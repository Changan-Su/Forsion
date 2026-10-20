/** Agent Desk 里的插件工具结果卡片(落点 desk,或用户「在 Desk 打开」的):按调用 id 回到这条会话的消息里找那次调用,
 *  挂同一个渲染器(surface=desk)。展开态在胶囊下面、⋯ 里给「放回对话」;卡片态是只读预览。插件没在跑 → 原始结果。 */
import { useContext, useEffect } from 'react'
import { MessageSquare, Puzzle } from 'lucide-react'
import { useApp } from '../../stores/appStore'
import { useI18n } from '../../i18n'
import { CardMount, returnToolCardToChat, useToolCardOf } from '../../components/PluginToolCard'
import { DeskChromeContext } from './deskChrome'

export function DeskToolCardPane({ sessionId, callId, onQuote }: { sessionId: string; callId: string; onQuote?: (text: string) => void }) {
  const { t } = useI18n()
  const event = useApp((s) => {
    for (const m of s.messagesBySession[sessionId] || []) {
      const ev = m.toolEvents?.find((e) => e.id === callId)
      if (ev) return ev
    }
    return undefined
  })
  const cardOf = useToolCardOf()
  const claim = event ? cardOf(event) : undefined
  const desk = useContext(DeskChromeContext)
  useEffect(() => {
    if (!desk) return
    desk.more.current = [{ label: t('toolCard.putBack'), icon: <MessageSquare size={14} />, run: () => returnToolCardToChat(sessionId, callId) }]
    return () => { desk.more.current = [] }
  }, [desk, sessionId, callId, t])
  if (!event) return <div className="agent-desk-card-empty"><Puzzle size={18} /><span>{t('toolCard.notLoaded')}</span></div>
  const raw = (
    <div className="plugin-tool-card-raw">
      <div className="plugin-tool-card-raw-note">{t('toolCard.noRenderer')}</div>
      <pre>{event.result ?? ''}</pre>
    </div>
  )
  if (!claim) return raw
  return (
    <div className="plugin-tool-card-desk" data-plugin-tool-card-desk={event.name}>
      <CardMount event={event} claim={claim} surface="desk" onQuote={onQuote} fallback={raw} />
    </div>
  )
}
