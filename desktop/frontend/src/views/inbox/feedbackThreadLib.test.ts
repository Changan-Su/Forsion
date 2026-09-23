import { describe, it, expect } from 'vitest'
import { inboxThreadOf, checkAttachments, attachmentTypeOk, FEEDBACK_MAX_BYTES } from './feedbackThreadLib'

const TID = '11111111-1111-4111-8111-111111111111'

describe('inboxThreadOf:只认服务端广播落下来的完整 thread', () => {
  it('对象形态(桌面引擎已解析)与串形态(移动端直存)都认', () => {
    expect(inboxThreadOf({ sender_kind: 'server', thread: { kind: 'feedback', ticketId: TID, event: 'created' } })).toEqual({ ticketId: TID, event: 'created' })
    expect(inboxThreadOf({ sender_kind: 'server', thread: JSON.stringify({ kind: 'feedback', ticketId: TID }) as any })).toEqual({ ticketId: TID })
  })
  it('负对照:agent 信 / 系统信带同形 thread 不算;坏 id / 坏 JSON / 别的 kind 不算', () => {
    expect(inboxThreadOf({ sender_kind: 'agent', thread: { kind: 'feedback', ticketId: TID } })).toBeNull()
    expect(inboxThreadOf({ sender_kind: 'system', thread: { kind: 'feedback', ticketId: TID } })).toBeNull()
    expect(inboxThreadOf({ sender_kind: 'server', thread: { kind: 'feedback', ticketId: '../etc' } })).toBeNull()
    expect(inboxThreadOf({ sender_kind: 'server', thread: '{oops' as any })).toBeNull()
    expect(inboxThreadOf({ sender_kind: 'server', thread: { kind: 'order', ticketId: TID } as any })).toBeNull()
    expect(inboxThreadOf({ sender_kind: 'server', thread: null })).toBeNull()
  })
})

describe('checkAttachments:与服务端 validateAttachments 同口径', () => {
  const png = { name: 'a.png', size: 1024, type: 'image/png' }
  it('放行图片 / 文本 / JSON,mime 空时按扩展名兜底', () => {
    expect(checkAttachments(0, [png, { name: 'log.json', size: 10, type: '' }, { name: 'n.txt', size: 10, type: 'text/plain' }])).toBeNull()
    expect(attachmentTypeOk('', 'x.log')).toBe(true)
    expect(attachmentTypeOk('', 'x.exe')).toBe(false)
  })
  it('超 5 个(含已选)/ 超 5MB / 空文件 / 类型不对各自报对原因', () => {
    expect(checkAttachments(5, [png])).toEqual({ code: 'tooMany', name: '' })
    expect(checkAttachments(0, [{ ...png, size: FEEDBACK_MAX_BYTES + 1 }])).toEqual({ code: 'tooBig', name: 'a.png' })
    expect(checkAttachments(0, [{ ...png, size: 0 }])).toEqual({ code: 'tooBig', name: 'a.png' })
    expect(checkAttachments(0, [{ name: 'v.mp4', size: 10, type: 'video/mp4' }])).toEqual({ code: 'badType', name: 'v.mp4' })
  })
})
