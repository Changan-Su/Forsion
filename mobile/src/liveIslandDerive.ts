/**
 * 灵动岛此刻该显示什么(纯函数;单测 `npm run test:liveisland`)。接线在 liveIsland.ts。
 *
 * 只看 runningBySession 里的会话。调用方把结果序列化后比对、没变就不碰原生 —— messagesBySession
 * 每个 token 都换引用,直接按 store 变化打原生会把通知更新打爆(系统每秒只收几条,多的静默丢掉)。
 */
import type { SessionRecord, UiMessage } from '@/types'

export interface IslandState {
  sessionId: string
  title: string
  text: string
  /** 状态栏胶囊里的短字(≤7 个字符最稳);空串 = 让系统在胶囊里显示已运行时长。 */
  chip: string
  /** run 起点(毫秒),系统据此走计时器。 */
  since: number
  /** 同时在跑的其余会话数。 */
  more: number
}

type Tr = (key: string, vars?: Record<string, unknown>) => string

export const lastAssistant = (list: UiMessage[] | undefined): UiMessage | undefined => {
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) if (list![i].role === 'assistant') return list![i]
  return undefined
}

export function deriveIsland(
  running: Record<string, string>,
  messages: Record<string, UiMessage[] | undefined>,
  sessions: Array<Pick<SessionRecord, 'id' | 'title'>>,
  since: (sessionId: string) => number,
  tr: Tr,
): IslandState | null {
  const items = Object.keys(running).map((sessionId) => {
    const m = lastAssistant(messages[sessionId])
    const approval = m?.approvals?.find((a) => a.status === 'pending')
    const inquiry = m?.inquiries?.find((q) => q.status === 'pending')
    const tool = m?.toolEvents?.filter((t) => !t.done).pop()
    return {
      sessionId,
      title: sessions.find((s) => s.id === sessionId)?.title || tr('island.untitled'),
      text: approval ? tr('island.approval', { tool: approval.name })
        : inquiry ? tr('island.inquiry')
        : tool ? tr('island.tool', { tool: tool.name })
        : m?.content ? tr('island.writing')
        : tr('island.thinking'),
      chip: approval ? tr('island.chipApproval') : inquiry ? tr('island.chipInquiry') : '',
      since: since(sessionId),
      attention: !!(approval || inquiry),
    }
  })
  if (!items.length) return null
  // 岛只有一个位置:等你动手的排最前,其次最近开跑的。
  items.sort((a, b) => Number(b.attention) - Number(a.attention) || b.since - a.since)
  const { attention: _attention, ...top } = items[0]
  return { ...top, more: items.length - 1 }
}
