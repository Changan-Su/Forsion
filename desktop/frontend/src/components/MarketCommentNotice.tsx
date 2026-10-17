import type { InboxMessage } from '../services/backendService'
import { MarketNotifications } from './MarketDiscussion'
import { openMarketItem } from './MarketPluginCards'
import { registerMessages, useI18n } from '../i18n'

registerMessages({ 'market.openDiscussion': { zh: '查看插件评论', en: 'Open plugin comments' } })
export function marketCommentThread(message: Pick<InboxMessage, 'sender_kind' | 'thread'>): { itemId: string; commentId: string; itemName: string } | null {
  if (message.sender_kind !== 'server') return null
  try {
    const value = typeof message.thread === 'string' ? JSON.parse(message.thread) : message.thread
    if (value?.kind !== 'market-comment' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.itemId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.commentId)) return null
    return { itemId: value.itemId, commentId: value.commentId, itemName: String(value.itemName || '').slice(0, 200) }
  } catch { return null }
}
export function MarketCommentNotice({ message }: { message: InboxMessage }) {
  const { t } = useI18n()
  const thread = marketCommentThread(message)
  if (!thread) return null
  return <section><button className="btn sm" onClick={() => openMarketItem({ id: thread.itemId, name: thread.itemName }, true)}>{t('market.openDiscussion')}</button><MarketNotifications key={thread.itemId} itemId={thread.itemId} /></section>
}
