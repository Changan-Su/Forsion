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
  it('断在半路的:失败那一刻本地还没有、现在落了库的用户消息里有一条字一样的 = 其实到了', () => {
    const item: FailedSend = { id: 'f1', text: '继续 ', attachments: [], reason: 'offline', detail: '', at: 1_000_000, known: ['u1', 'a1'] }
    expect(landedAnyway(item, [{ id: 'u1', role: 'user', content: '继续' }, { id: 'u9', role: 'user', content: '继续' }])).toBe(true)
    // 十秒前刚发过一句一模一样的(本地早就有了):不算这条到了(Codex 评审 P2)
    expect(landedAnyway(item, [{ id: 'u1', role: 'user', content: '继续' }])).toBe(false)
    expect(landedAnyway(item, [{ id: 'a9', role: 'assistant', content: '继续' }])).toBe(false)
    expect(landedAnyway(item, [{ id: 'u9', role: 'user', content: null }])).toBe(false)
  })
})
