/** 审批提醒信的线程判别(P1 · K3 §3.7):只认服务端广播落下来的完整 thread(同 feedbackThreadLib 的信任口径)。 */
import { describe, it, expect } from 'vitest'
import { approvalThreadOf } from './approvalThreadLib'

const UNIT = '6C1D7A4E-2B3F-4A5C-8D9E-0F1A2B3C4D5E'
const SID = '9f40ad71-5e6c-4d8f-9021-3c4d5e6f7081'
const ok = { kind: 'approval', unitId: UNIT, sessionId: SID, event: 'pending' }

describe('approvalThreadOf', () => {
  it('串形态(移动端 localInbox 直存)与对象形态都认;id 归一成小写', () => {
    expect(approvalThreadOf({ sender_kind: 'server', thread: JSON.stringify(ok) })).toEqual({ unitId: UNIT.toLowerCase(), sessionId: SID })
    expect(approvalThreadOf({ sender_kind: 'server', thread: ok as any })).toEqual({ unitId: UNIT.toLowerCase(), sessionId: SID })
  })
  it('负对照:非服务端发信人 / 坏 id / 别的 event / 别的 kind / 坏 JSON / 空 → null', () => {
    expect(approvalThreadOf({ sender_kind: 'agent', thread: JSON.stringify(ok) })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'system', thread: JSON.stringify(ok) })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'server', thread: JSON.stringify({ ...ok, sessionId: '../x' }) })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'server', thread: JSON.stringify({ ...ok, unitId: 'mac' }) })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'server', thread: JSON.stringify({ ...ok, event: 'done' }) })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'server', thread: JSON.stringify({ ...ok, kind: 'feedback' }) })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'server', thread: '{oops' })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'server', thread: 'null' })).toBeNull()
    expect(approvalThreadOf({ sender_kind: 'server', thread: null })).toBeNull()
  })
})
