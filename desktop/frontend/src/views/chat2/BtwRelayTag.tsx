/** 用户消息上的「来自顺便问」小标(11-22 传话):这条是从顺便问里拟稿、用户点了「发给主对话 / 别的会话」发过来的。
 *  记录在本机(btwRelay.ts,按 会话 + 正文 认),换设备看不到小标。点了打开那段顺便问。 */
import { useSyncExternalStore } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { openBtw } from './btwStore'
import { onRelaysChanged, relayFor } from './btwRelay'

export function BtwRelayTag({ sessionId, content }: { sessionId?: string; content: string }) {
  const { t } = useI18n()
  const rec = useSyncExternalStore(onRelaysChanged, () => relayFor(sessionId, content))
  const title = useApp((s) => (rec ? s.sessions.find((x) => x.id === rec.from)?.title : undefined))
  if (!rec) return null
  return (
    <button type="button" className="t2-relay-tag" data-testid="btw-relay-tag"
      onClick={() => openBtw({ sessionId: rec.from, title, asideId: rec.asideId, messageId: rec.messageId })}>
      <MessageCircleQuestion size={12} />{t('btw.relay.tag')}
    </button>
  )
}
