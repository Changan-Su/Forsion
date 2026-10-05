/**
 * 灵动岛此刻该显示什么(纯函数;单测 `npm run test:liveisland`)。接线在 liveIsland.ts。
 *
 * 只看 runningBySession 里的会话。调用方把结果序列化后比对、没变就不碰原生 —— messagesBySession
 * 每个 token 都换引用,直接按 store 变化打原生会把通知更新打爆(系统每秒只收几条,多的静默丢掉)。
 */
import type { ApprovalRequest, SessionRecord, UiMessage } from '@/types'
import { pendingPromptsOf } from '@/views/chat2/approvalQueue'

/** 岛上那张待批审批在通知上能答到哪一步(原生据此放「拒绝 / 允许」两个按钮,见 LiveIslandPlugin.addAnswers)。 */
export interface IslandAsk {
  messageId: string
  approvalId: string
  /** 放不放「允许」。放的时候 detail = 这次请求的完整内容,通知展开后整段可见。 */
  allow: boolean
  detail?: string
}

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
  /** 岛上显示的是一张能在通知上答的审批时才有。 */
  ask?: IslandAsk
}

/** 请求内容短到通知展开后能整段显示:再长就只给「拒绝」,要批准得进会话看完整的审批卡 ——
 *  看不全的命令不该能被一键批准(截断的那半句可能才是要紧的)。 */
const WHOLE_MAX_CHARS = 120
const WHOLE_MAX_LINES = 3
/** 预览就是请求全文的工具(引擎 services/approvals.ts 的 rawPreview:命令原样写、不截断)。写文件 / 改文件那几件的预览
 *  只是一行摘要(`write boot.sh (2200 chars)`),改了什么在审批卡上另算 —— 通知上看不到的东西不能在通知上批。
 *  新工具默认不在表里:先确认它的预览写全了再加。 */
const WHOLE_PREVIEW_TOOLS = new Set(['run_bash', 'run_background'])

/**
 * 通知上能怎么答这张审批。
 *  - 远程来源的:不放按钮(同桌面 approvalDelivery 的口径:点通知到完整审批卡上答)。
 *  - 「允许」只给普通审批(档位本就要问 / 你自己写的规则要问)里的命令类工具,且命令能整段显示;
 *    写文件 / 改文件、越界写入、受保护路径、设备操控、只能在执行设备上批的,一律只给「拒绝」。
 *  - 「拒绝」是安全方向,其余情况都给。
 * 岛(deriveIsland)与兑现(liveIsland.ts 的 answer)共用这一个判据:按钮上有什么,点下去才认什么。
 */
export function shadeAsk(messageId: string, req: ApprovalRequest): IslandAsk | undefined {
  if (req.remote) return undefined
  const ask = { messageId, approvalId: req.approvalId }
  const detail = (req.preview || '').trim()
  const whole = detail.length > 0 && detail.length <= WHOLE_MAX_CHARS && detail.split('\n').length <= WHOLE_MAX_LINES
  const ordinary = !req.localOnly && (req.reason?.kind === 'mode' || req.reason?.kind === 'custom-ask')
  return ordinary && whole && WHOLE_PREVIEW_TOOLS.has(req.name) ? { ...ask, allow: true, detail } : { ...ask, allow: false }
}

/**
 * 通知按钮送回来的一次作答该不该认。原生只是把按钮上的几个 id 原样转回来,这里照**此刻**的消息重判:
 * 那张审批得还在待批,点的动作得是这张审批此刻还给得出的;对不上(早答过了 / 串是别人拼的)→ null,什么都不做。
 * 认的是「这张审批」而不是「岛上此刻显示的那张」:手指落下的瞬间岛换成了另一个会话的审批,这一下答的仍是
 * 按钮所属的那张(也就是用户读到的那张),不会答到新换上来的头上。
 * 「允许」只会变成 approve,永远不是「总是允许」。
 */
export function shadeAnswer(
  e: Partial<Record<'messageId' | 'approvalId' | 'action', unknown>>,
  messages: UiMessage[] | undefined,
): { messageId: string; approvalId: string; action: 'approve' | 'reject' } | null {
  const item = pendingPromptsOf(messages).find((p) => p.kind === 'approval' && p.id === e.approvalId && p.messageId === e.messageId)
  if (item?.kind !== 'approval') return null
  const ask = shadeAsk(item.messageId, item.req)
  const action = e.action === 'approve' ? 'approve' : e.action === 'reject' ? 'reject' : null
  if (!ask || !action || (action === 'approve' && !ask.allow)) return null
  return { messageId: item.messageId, approvalId: item.id, action }
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
    // 审批 / 提问按整个会话找(与输入框上方的托盘同源):run 往后跑会切出新段,待办不一定挂在末条助手消息上
    const prompts = pendingPromptsOf(messages[sessionId])
    const waiting = prompts.find((p) => p.kind === 'approval')
    const approval = waiting?.req
    const inquiry = prompts.find((p) => p.kind !== 'approval')?.req
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
      ask: waiting && shadeAsk(waiting.messageId, waiting.req),
    }
  })
  if (!items.length) return null
  // 岛只有一个位置:等你动手的排最前,其次最近开跑的。
  items.sort((a, b) => Number(b.attention) - Number(a.attention) || b.since - a.since)
  const { attention: _attention, ask, ...top } = items[0]
  return { ...top, more: items.length - 1, ...(ask ? { ask } : {}) }
}
