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
  skillIds?: string[]
  mentions?: { priorityAgent?: string; mentionAgents?: string[]; mentionProjects?: Array<{ name: string; path: string }> }
  reason: FailReason
  /** 错误原文,放悬停提示里 */
  detail: string
  at: number
}

export function failReason(e: unknown): FailReason {
  const status = (e as { status?: unknown } | null)?.status
  const msg = String((e as Error | null)?.message ?? e ?? '')
  if (status === 402 || /quota|credit|insufficient|余量|额度|积分不足/i.test(msg)) return 'quota'
  return typeof status === 'number' ? 'refused' : 'offline'
}

/** 断在半路的那种(offline):引擎那边是不是其实已经收下了 —— 失败之后落库的用户消息里有一条字一样的。
 *  ponytail: 按正文 + 时间认,不给 startRun 加请求号(那要同时改本机引擎和云端 worker);上限:失败后又手发了一条一模一样的,会被当成已送达。 */
export function landedAnyway(item: FailedSend, records: Array<{ role?: string; content?: string | null; timestamp?: number | string }>): boolean {
  const since = item.at - 60_000
  return records.some((r) => r.role === 'user' && (r.content ?? '').trim() === item.text.trim() && new Date(r.timestamp ?? 0).getTime() >= since)
}
