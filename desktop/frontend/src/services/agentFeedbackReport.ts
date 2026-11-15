/**
 * Agent 起草的反馈(Forsion Extend 的 feedback_draft 结果卡)要带的附件:和反馈窗同一份 buildFeedbackReport,
 * 多一项 toolErrors = 「这次运行的报错」。经 ctx.app.buildFeedbackReport 只交给首方内置包(见 pluginStore)。
 *
 * 会话按工具调用 id 找:卡片挂在哪条消息下,宿主内存里就一定有那条消息(messagesBySession)。找不到 = 不知道是哪个会话,
 * 回 null,卡片照实说备不了附件,不拿别的会话顶。
 * 报错取同一条回复里失败的工具调用(feedback_draft 自己除外);那条回复里一个都没有时,退到这个会话最近的 MAX_ERRORS 次失败。
 */
import { useApp } from '../stores/appStore'
import { buildFeedbackReport, type FeedbackReport } from './feedbackReport'
import type { SessionRecord, ToolEvent } from '../types'

const MAX_ERRORS = 10
const MAX_FIELD = 4000

export interface AgentFeedbackReportOptions {
  /** feedback_draft 那次调用的 id(卡片 mount 拿到的 call.id)。 */
  callId: string
  /** 那次调用的结果原文(call.result):调用 id 撞了时用它认准是哪一次。 */
  result?: string
  diagnostics?: boolean
  conversation?: boolean
  errors?: boolean
}
export interface AgentFeedbackReport extends FeedbackReport {
  /** 带上的失败调用条数(没勾「这次运行的报错」时为 0)。 */
  errorCount: number
}

const clip = (s: string | undefined): string => {
  const v = String(s ?? '')
  return v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…[${v.length - MAX_FIELD} more chars]` : v
}

/** 找到这次调用所在的会话与那条消息里的工具事件。 */
/** 只认 feedback_draft 的那次调用;result 给了就要逐字一致。调用 id 会撞(引擎的文本兜底会反复生成同一个 id):
 *  不止一处对得上 = 认不准是哪个会话,回 null,绝不拿别的会话的东西顶。 */
export function locateToolCall(callId: string, result?: string): { sessionId: string; events: ToolEvent[]; all: ToolEvent[] } | null {
  const bySession = useApp.getState().messagesBySession || {}
  const hits: Array<{ sessionId: string; events: ToolEvent[]; all: ToolEvent[] }> = []
  for (const [sessionId, messages] of Object.entries(bySession)) {
    for (const m of messages || []) {
      if (m.toolEvents?.some((e) => e.id === callId && e.name === 'feedback_draft' && (result === undefined || e.result === result))) {
        hits.push({ sessionId, events: m.toolEvents, all: (messages || []).flatMap((x) => x.toolEvents || []) })
      }
    }
  }
  return hits.length === 1 ? hits[0] : null
}

export function pickToolErrors(callId: string, events: ToolEvent[], all: ToolEvent[]): Array<Record<string, unknown>> {
  const failed = (list: ToolEvent[]) => list.filter((e) => e.done && e.isError && e.id !== callId && e.name !== 'feedback_draft')
  const here = failed(events)
  const list = (here.length ? here : failed(all)).slice(-MAX_ERRORS)
  return list.map((e) => ({ tool: e.name, arguments: clip(e.arguments), result: clip(e.result), ...(e.startedAt ? { at: new Date(e.startedAt).toISOString() } : {}), ...(e.elapsedMs != null ? { elapsedMs: e.elapsedMs } : {}) }))
}

export async function buildAgentFeedbackReport(opts: AgentFeedbackReportOptions): Promise<AgentFeedbackReport | null> {
  const callId = typeof opts?.callId === 'string' ? opts.callId : ''
  if (!callId) return null
  const found = locateToolCall(callId, typeof opts.result === 'string' ? opts.result : undefined)
  if (!found) return null
  const s = useApp.getState()
  const session: SessionRecord | null = [...(s.sessions || []), ...(s.archivedSessions || [])].find((x) => x.id === found.sessionId) || null
  const diagnostics = !!opts.diagnostics
  const conversation = !!opts.conversation
  const toolErrors = opts.errors ? pickToolErrors(callId, found.events, found.all) : []
  const report = await buildFeedbackReport(s.cfg, session, { diagnostics, conversation, activity: false },
    { origin: 'agent-draft', draftCallId: callId, ...(opts.errors ? { toolErrors } : {}) })
  return { ...report, errorCount: toolErrors.length }
}
