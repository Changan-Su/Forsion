/**
 * 插件发的收件箱信(ctx.inbox,2026-10-17):发件人显示名 + 正文下那块插件自己画的卡,按插件 id 登记。
 * 只认「本机系统消息 + 发件人 `plugin:<id>`」—— 服务端广播 / agent 信冒用同名 sender_id 也拿不到插件的卡。
 */
import { create } from 'zustand'
import type { InboxMessage } from '../../services/backendService'

export interface PluginInboxCard {
  sender?: () => string
  mount?(el: HTMLElement, msg: { id: string }): (() => void) | void
}

export const useInboxCards = create<Record<string, PluginInboxCard>>(() => ({}))

export function inboxCardOf(m: Pick<InboxMessage, 'sender_kind' | 'sender_id'>, cards = useInboxCards.getState()): PluginInboxCard | undefined {
  if (m.sender_kind !== 'system' || !m.sender_id?.startsWith('plugin:')) return undefined
  return cards[m.sender_id.slice('plugin:'.length)]
}

export function setInboxCard(pluginId: string, card: PluginInboxCard | null): void {
  useInboxCards.setState((s) => {
    const next = { ...s }
    if (card) next[pluginId] = card
    else delete next[pluginId]
    return next
  }, true)
}
