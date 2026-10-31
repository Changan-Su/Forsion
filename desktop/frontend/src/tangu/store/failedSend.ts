/**
 * 发送失败留在原地(借 Comma,方案页 docs/ToBeImproved/借鉴Comma方案_2026-10-21/more.html §2.4,仓根):
 * startRun / steer 没成的那条不再只弹一条提示、字退回输入框,而是落在会话末尾一条淡掉的气泡,底下「没发出去:原因 · 丢弃 · 重试」。
 */
import type { Attachment } from '../../../../../tangu-agent/src/contracts/clientTypes'

/** offline = 没拿到状态码(网络断了 / 超时 / 引擎没起):请求可能已经到了引擎,重试前得先查一遍。 */
export type FailReason = 'offline' | 'quota' | 'refused'

export interface FailedSend {
  id: string
  text: string
  attachments: Attachment[]
  /** 没传上去的工作区文件(传上去了的不重传) */
  workspaceFiles?: Attachment[]
  skillIds?: string[]
  mentions?: { priorityAgent?: string; mentionAgents?: string[]; mentionProjects?: Array<{ name: string; path: string }> }
  reason: FailReason
  /** 错误原文,放悬停提示里 */
  detail: string
  at: number
  /** 失败那一刻本地已经有的消息 id:「其实到了」只认这之后才冒出来的 */
  known: string[]
}

export function failReason(e: unknown): FailReason {
  const status = (e as { status?: unknown } | null)?.status
  const msg = String((e as Error | null)?.message ?? e ?? '')
  if (status === 402 || /quota|credit|insufficient|余量|额度|积分不足/i.test(msg)) return 'quota'
  return typeof status === 'number' ? 'refused' : 'offline'
}

/** 断在半路的那种(offline):引擎那边是不是其实已经收下了 —— 失败那一刻本地还没有、现在却落了库的用户消息里,有一条字一样的。
 *  ponytail: 按正文认,不给 startRun 加请求号(那要同时改本机引擎和云端 worker);
 *  上限:失败之后又从别的窗口 / 设备发了一模一样的一句,会被当成这条已送达。 */
export function landedAnyway(item: FailedSend, records: Array<{ id: string; role?: string; content?: string | null }>): boolean {
  const known = new Set(item.known)
  return records.some((r) => r.role === 'user' && !known.has(r.id) && (r.content ?? '').trim() === item.text.trim())
}
