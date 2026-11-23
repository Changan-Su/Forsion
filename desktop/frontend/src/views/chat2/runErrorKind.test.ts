/**
 * 报错先归类再出文案(插件开发优化方案 2026-11-23 第三节):
 *  - 失败那一行说人话,原文进「看原文」(describeRunError 的 raw),不再拼在括号里
 *  - 引擎带 errorKind 时按类别说;旧引擎 / 回放的行没有 → 按原文认(与引擎同一份规则 contracts/runErrorKind.ts)
 *  - 「You have no credits remaining」不再整段英文:认成余额用完
 *  - 子会话回报里失败那条的原因、通道排队那一行、新对话按 Agent 记思考档
 */
import { describe, expect, it } from 'vitest'
import { describeRunError, humanizeRunError } from './EditorialMessage'
import { parseChildUpdate } from './ChildSessions'
import { llmRetryLine } from './llmRetryLine'
import { isQuotaText } from './QuotaRelay'
import { stickyDefaults } from '../../../../../tangu-agent/src/contracts/sessionDefaults'

const t = (k: string, v?: Record<string, unknown>) => (v ? `${k}${JSON.stringify(v)}` : k)
const TPM = 'Rate limit reached for gpt-6.2-sol on tokens per min (TPM): Limit 1000000, Used 955313, Requested 109292. Please try again in 3.877s'
const NO_CREDITS = 'You have no credits remaining'

describe('describeRunError', () => {
  it('余额用完:人话 + 原文分开', () => {
    expect(isQuotaText(NO_CREDITS)).toBe(true)
    expect(describeRunError(NO_CREDITS, t)).toEqual({ text: 'chat.err.credits', raw: NO_CREDITS })
  })
  it('限流:按原文认出,原文收进 raw', () => {
    expect(describeRunError(TPM, t)).toEqual({ text: 'chat.err.rate', raw: TPM })
  })
  it('引擎给的类别压过通用规则(状态码只在引擎那边看得到)', () => {
    expect(describeRunError('502 upstream said no', t, '', '', 'rate_limit').text).toBe('chat.err.rate')
    expect(describeRunError('Payment Required', t, '', '', 'quota').text).toBe('chat.err.credits')
    expect(describeRunError('Your input exceeds the context window of this model.', t, '', '', 'context').text).toBe('chat.err.context')
  })
  it('引擎自家错误码照旧走具体那条,不被类别盖掉', () => {
    expect(describeRunError('run_cost_exceeded', t, '', '', 'other').text).toBe('chat.err.runCost')
    expect(describeRunError('Provided authentication token is expired. Please try signing in again.', t, '', '', 'auth').text).toBe('chat.err.subExpired')
  })
  it('认不出的原样一行,没有「看原文」', () => {
    expect(describeRunError('something odd happened', t)).toEqual({ text: 'something odd happened' })
  })
  it('一行口径(旧调用方):人话 + 括号原文', () => {
    expect(humanizeRunError(NO_CREDITS, t)).toBe(`chat.err.credits(${NO_CREDITS})`)
  })
})

describe('子会话回报', () => {
  it('失败那条元素里的原因;老格式(没有原因行)照样认', () => {
    const body = [
      '<child_sessions_update>',
      '<child id="a" title="Probe" status="failed">\nFailed (rate_limit): Rate limit reached. Please try again in 3.877s\n(no reply)\n</child>',
      '<child id="b" title="Old" status="failed">\nfetch failed\n</child>',
      '<child id="c" title="Done" status="finished">\nall good\n</child>',
      '</child_sessions_update>',
    ].join('\n')
    const rows = parseChildUpdate(body)
    expect(rows[0]).toMatchObject({ id: 'a', status: 'failed', failure: { kind: 'rate_limit', error: 'Rate limit reached. Please try again in 3.877s' } })
    expect(rows[1].failure).toBeUndefined()
    expect(rows[2]).toEqual({ id: 'c', title: 'Done', status: 'finished' })
  })
})

describe('通道排队那一行', () => {
  it('限流排队写秒数;并发满了写上限', () => {
    expect(llmRetryLine({ phase: 'queue', reason: 'rate_limit', waitMs: 3877, attempt: 0, max: 0 }, t)).toBe('chat.llmQueueRate{"s":4}')
    expect(llmRetryLine({ phase: 'queue', reason: 'busy', limit: 3, waitMs: 0, attempt: 0, max: 0 }, t)).toBe('chat.llmQueueBusy{"limit":3}')
  })
})

describe('新对话的思考档按 Agent 记', () => {
  const dc = { lastThinkingLevel: 'high', lastThinkingByAgent: { coder: 'xhigh' } } as any
  it('这个 Agent 记过 → 用它的;没记过 → 回落全局那份;chat 不分 Agent', () => {
    expect(stickyDefaults(dc, true, undefined, 'coder').thinkingLevel).toBe('xhigh')
    expect(stickyDefaults(dc, true, undefined, 'writer').thinkingLevel).toBe('high')
    expect(stickyDefaults(dc, true, undefined).thinkingLevel).toBe('high')
    expect(stickyDefaults({ ...dc, lastChatThinkingLevel: 'low' }, false, 'chat', 'coder').thinkingLevel).toBe('low')
  })
})
