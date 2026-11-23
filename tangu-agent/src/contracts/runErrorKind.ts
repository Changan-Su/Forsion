/**
 * 失败 run 的类别(插件开发优化方案 2026-11-23 第三节「报错先归类再出文案」)。
 *
 * 引擎在 error 事件上带 errorKind(手里有 LlmError 的状态码 / code,判得比原文准);桌面按类别出中英文案,原文收进「看原文」。
 * 旧引擎不带、落库的旧行只有原文、子会话回报只有那一轮的 error 列 —— 所以这里另给一份**只看原文**的认法,两边共用:
 * 引擎的额度认法(llm/retry.ts quotaExhaustedText)和桌面的额度文案(QuotaRelay)都从这里取,别各抄一份。
 */
export type RunErrorKind = 'rate_limit' | 'quota' | 'auth' | 'network' | 'context' | 'other'
export const RUN_ERROR_KINDS: readonly RunErrorKind[] = ['rate_limit', 'quota', 'auth', 'network', 'context', 'other']
export const isRunErrorKind = (v: unknown): v is RunErrorKind => typeof v === 'string' && (RUN_ERROR_KINDS as readonly string[]).includes(v)

/** 订阅额度 / 账单配额 / 余额用完(几小时才重置,或要充值;不是秒级限流)。额度用完接力(llm/quotaRelay.ts)只认这一组。
 *  11-23 加「no credits」一族:第一轮 dogfood 里 openai-2 报「You have no credits remaining」,旧规则认不出,白重试 / 直接失败、界面整段英文。 */
export const QUOTA_EXHAUSTED_RE = /usage limit|usage_limit_reached|usage_not_included|insufficient_quota|quota exceeded|exceeded your current quota|out of budget|billing_hard_limit|no credits|out of credits|insufficient[_ ](?:credits?|balance|funds)|credit balance is too low|余额不足|账户欠费/i
/** 写着一分钟以内的窗口、又没提按天 / 余额的「quota exceeded」是限流(Gemini …PerMinute、Vertex requests_per_minute、
 *  百炼 Allocated quota exceeded 其实是 TPM):照常退避重试,也不触发额度接力(借 magpie d83f887a7)。按天的仍算额度用完。 */
const SHORT_WINDOW = /per ?minute|perminute|_per_minute|\b[RT]PM\b|per ?second|allocated quota exceeded/i
const LONG_WINDOW = /per ?day|perday|_per_day|daily|per ?month|monthly|balance|credit|insufficient_quota|usage_limit_reached|billing_hard_limit/i
export const quotaExhaustedText = (msg: string): boolean => QUOTA_EXHAUSTED_RE.test(msg) && !(SHORT_WINDOW.test(msg) && !LONG_WINDOW.test(msg))

/** 秒级限流的措辞(额度用完另算,先判):「Rate limit reached for … TPM … Please try again in 3.877s」、rate_limit_exceeded、Too Many Requests。 */
export const RATE_LIMIT_RE = /rate[ _-]?limit|too many requests|tokens per min|requests per min|\b[RT]PM\b|allocated quota exceeded/i

/**
 * 报错正文里服务端点名的等待(毫秒):「Please try again in 3.877s」「try again in 928ms」「try again in 1m30s」。
 * Codex 流里的失败没有响应头(llm/openaiResponses.ts 的 response.failed),等待时间只在正文里。没写 → undefined。
 * 单位按整词认:「20ms」是 20 毫秒,不是 20 分钟。
 */
export function tryAgainMsFromText(text: string): number | undefined {
  const m = /(?:try again|retry(?:ing)?|available again) (?:in|after) ~?\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])\s*)+)/i.exec(text)
  if (!m) return undefined
  let total = 0
  for (const p of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])/gi)) {
    const n = Number(p[1])
    const u = p[2].toLowerCase()
    total += u === 'ms' || u.startsWith('milli') ? n : u.startsWith('h') ? n * 3_600_000 : u === 'm' || u.startsWith('min') ? n * 60_000 : n * 1000
  }
  return Number.isFinite(total) ? Math.round(total) : undefined
}

const AUTH_RE = /provided authentication token is expired|try signing in again|expired credentials|invalid or expired|token (?:has |is )?expired|unauthorized|invalid[ _-]?api[ _-]?key|incorrect api key|(?:^|\D)401(?:\D|$)/i
const NETWORK_RE = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|premature close|network ?error|terminated|timed? ?out/i
const CONTEXT_RE = /context[_ ]length[_ ]exceeded|exceeds the context window|maximum context length|context window|input_too_large|over the model input budget|prompt is too long|request_too_large/i

/**
 * 只看原文的归类(旧引擎 / 落库行 / 子会话回报)。引擎有 LlmError 时用 llm/runErrorKind.ts 的 classifyRunError(先看状态码)。
 * 次序:额度先于限流(额度用完常以 429 返回);登录失效先于网络(xAI 用 502 包的认证失败)。
 */
export function classifyRunErrorText(raw: string | undefined | null): RunErrorKind {
  const t = String(raw || '')
  if (!t) return 'other'
  if (quotaExhaustedText(t) || /token_quota_exceeded/i.test(t)) return 'quota'
  if (RATE_LIMIT_RE.test(t) || /(?:^|\D)429(?:\D|$)/.test(t)) return 'rate_limit'
  if (AUTH_RE.test(t)) return 'auth'
  if (CONTEXT_RE.test(t)) return 'context'
  if (NETWORK_RE.test(t)) return 'network'
  return 'other'
}
