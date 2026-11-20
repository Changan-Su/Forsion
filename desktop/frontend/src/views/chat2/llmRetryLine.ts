import type { LlmRetryState } from '../../tangu/store/tanguSlice'
import '../../tangu/messages' // 文案键在 Tangu 片段里

/**
 * 对话里那行黄字(前面的 ⟳ 由 ChatView 画):
 *  - 断网等网 → 「网络已断开，恢复后自动接着做」,不倒计时(引擎每 ~5 秒探一次网,网回来就接着发)
 *  - 服务过载 → 「服务繁忙，{s} 秒后重试（第 n/max 次）」
 *  - 其余 → 「网络波动，{s} 秒后自动重试（第 n/max 次）」
 */
export function llmRetryLine(r: LlmRetryState, t: (key: string, vars?: Record<string, unknown>) => string): string {
  if (r.phase === 'wait_network') return t('chat.llmWaitNetwork')
  const vars = { s: (r.waitMs / 1000).toFixed(1), n: r.attempt, max: r.max || '?' }
  return t(r.overload ? 'chat.llmRetryingBusy' : 'chat.llmRetrying', vars)
}

/** 文案后面那截灰色报错原文。等网那行只说「网络已断开」:原文(fetch failed / 云端连接失败…)只留在悬停提示里。 */
export function llmRetryErrorTail(r: LlmRetryState): string {
  return r.phase === 'wait_network' ? '' : r.error || ''
}
