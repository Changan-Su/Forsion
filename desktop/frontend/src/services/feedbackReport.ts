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
  const payload = await buildSessionLogPayload(cfg, session, options)
  const json = JSON.stringify(redactFeedback({ ...payload, feedbackSelection: options }), null, 2)
  return {
    json,
    filename: `tangu-feedback-${session?.id.slice(0, 8) || 'app'}-${new Date().toISOString().slice(0, 10)}.json`,
    bytes: new TextEncoder().encode(json).byteLength,
    missing: Object.entries(payload.sources).filter(([, state]) => state !== 'included').map(([key]) => key),
    truncated: !!payload.messagesTruncated || !!payload.activityLogTruncated,
  }
}
