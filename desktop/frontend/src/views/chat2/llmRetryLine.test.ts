// 对话里那行黄字按阶段出文案(中断任务续跑方案 6.7):断网不倒计时、服务繁忙换说法、其余照旧;zh / en 各钉一遍。
import { describe, expect, it } from 'vitest'
import { translateFor } from '../../i18n'
import { llmRetryLine, llmRetryErrorTail } from './llmRetryLine'

const tIn = (locale: 'zh' | 'en') => (k: string, v?: Record<string, unknown>) => translateFor(locale, k, v)

describe('llmRetryLine', () => {
  it('等网:不倒计时', () => {
    const r = { phase: 'wait_network' as const, attempt: 0, max: 0, waitMs: 0, since: 1 }
    expect(llmRetryLine(r, tIn('zh'))).toBe('网络已断开，恢复后自动接着做')
    expect(llmRetryLine(r, tIn('en'))).toBe('Offline — will continue when the connection is back')
  })
  it('服务过载:说「服务繁忙」', () => {
    const r = { phase: 'retry' as const, attempt: 2, max: 6, waitMs: 2000, overload: true }
    expect(llmRetryLine(r, tIn('zh'))).toBe('服务繁忙，2.0 秒后重试（第 2/6 次）')
    expect(llmRetryLine(r, tIn('en'))).toBe('Service busy — retrying in 2.0s (attempt 2/6)')
  })
  it('普通重试 / 缺 phase 的老数据:照旧', () => {
    expect(llmRetryLine({ phase: 'retry', attempt: 1, max: 3, waitMs: 1200 }, tIn('zh'))).toBe('网络波动，1.2 秒后自动重试（第 1/3 次）')
    expect(llmRetryLine({ attempt: 3, max: 3, waitMs: 4800 }, tIn('en'))).toBe('Network hiccup — retrying in 4.8s (attempt 3/3)')
    expect(llmRetryLine({ attempt: 1, max: 0, waitMs: 1000 }, tIn('zh'))).toBe('网络波动，1.0 秒后自动重试（第 1/? 次）')
  })
  it('报错原文:重试行照旧带,等网行不带(只在悬停提示里)', () => {
    expect(llmRetryErrorTail({ phase: 'retry', attempt: 1, max: 3, waitMs: 1000, error: 'fetch failed' })).toBe('fetch failed')
    expect(llmRetryErrorTail({ phase: 'wait_network', attempt: 0, max: 0, waitMs: 0, error: 'fetch failed' })).toBe('')
    expect(llmRetryErrorTail({ attempt: 1, max: 3, waitMs: 1000 })).toBe('')
  })
})
