import { describe, expect, it } from 'vitest'
import { failReason, landedAnyway, type FailedSend } from './failedSend'

describe('发送失败留在原地', () => {
  it('原因:没状态码 = 连不上;402 / 余量字样 = 余量不足;其余带码 = 被拒', () => {
    expect(failReason(new TypeError('Failed to fetch'))).toBe('offline')
    expect(failReason(Object.assign(new Error('Payment required'), { status: 402 }))).toBe('quota')
    expect(failReason(Object.assign(new Error('余量不足,请充值'), { status: 403 }))).toBe('quota')
    expect(failReason(Object.assign(new Error('engine unreachable'), { status: 503 }))).toBe('refused')
    expect(failReason('boom')).toBe('offline')
  })
  it('断在半路的:失败之后落库了一条字一样的用户消息 = 其实到了', () => {
    const item: FailedSend = { id: 'f1', text: '把圆角改成 12px ', attachments: [], reason: 'offline', detail: '', at: 1_000_000 }
    expect(landedAnyway(item, [{ role: 'user', content: '把圆角改成 12px', timestamp: 1_000_500 }])).toBe(true)
    expect(landedAnyway(item, [{ role: 'user', content: '把圆角改成 12px', timestamp: 100 }])).toBe(false) // 很早以前发过同样的话,不算
    expect(landedAnyway(item, [{ role: 'assistant', content: '把圆角改成 12px', timestamp: 1_000_500 }])).toBe(false)
    expect(landedAnyway(item, [{ role: 'user', content: null, timestamp: 1_000_500 }])).toBe(false)
  })
})
