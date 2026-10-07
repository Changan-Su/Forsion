import { buildSessionLogPayload, type SessionLogOptions } from './sessionLog'
import type { SessionRecord, TanguDesktopConfig } from '../types'

export const FEEDBACK_TEXT_LIMIT = 9000
export const FEEDBACK_LOG_LIMIT = 5 * 1024 * 1024

/** Best-effort credential filtering, not a promise that arbitrary user content is private. */
export function redactFeedback(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,})\b/g, '[redacted]')
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)(?:["']?)\s*[:=]\s*["']?)([^\s,"';&}]+)/gi, '$1[redacted]')
  if (Array.isArray(value)) return value.map(redactFeedback)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, /^(?:token|.*api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie|set-cookie)$/i.test(key)
      ? '[redacted]' : redactFeedback(entry),
  ]))
  return value
}

export interface FeedbackReport {
  json: string
  filename: string
  bytes: number
  missing: string[]
  truncated: boolean
}

export async function buildFeedbackReport(cfg: TanguDesktopConfig, session: SessionRecord | null, options: SessionLogOptions): Promise<FeedbackReport> {
  const payload = await buildSessionLogPayload(cfg, session, { ...options, maxBytes: FEEDBACK_LOG_LIMIT })
  let body = redactFeedback({ ...payload, feedbackSelection: options }) as Record<string, any>
  const encode = (value: unknown): { json: string; bytes: number } => {
    const json = JSON.stringify(value, null, 2)
    return { json, bytes: new TextEncoder().encode(json).byteLength }
  }
  let out = encode(body)
  const all: unknown[] = body.messages || []
  if (out.bytes > FEEDBACK_LOG_LIMIT && all.length) {
    // 超限时从最旧的消息开始丢,留住最新的。ponytail: 二分整份重新序列化(约 13 次),嫌慢再改成逐条累加字节。
    const keep = (count: number) => ({ ...body, messageCount: count, messagesTruncated: true, messages: all.slice(all.length - count) })
    let lo = 0, hi = all.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (encode(keep(mid)).bytes <= FEEDBACK_LOG_LIMIT) lo = mid
      else hi = mid - 1
    }
    body = keep(lo)
    out = encode(body)
  }
  return {
    ...out,
    filename: `tangu-feedback-${session?.id.slice(0, 8) || 'app'}-${new Date().toISOString().slice(0, 10)}.json`,
    missing: Object.entries(payload.sources).filter(([, state]) => state !== 'included').map(([key]) => key),
    truncated: !!body.messagesTruncated || !!body.activityLogTruncated,
  }
}
