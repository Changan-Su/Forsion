import { describe, expect, it } from 'vitest'
import { childIdsOf, handoffIdsOf, parseSessionMessage } from './ChildSessions'

describe('<session_message> 行(会话互通,11-08 起带 relation=peer)', () => {
  const row = (relation: string) => `<session_message from="s-1" title="Amadeus 离线同步 &amp; 冲突" relation="${relation}">\n备份脚本挪到 4 点\n</session_message>`
  it('relation 原样带出;peer = 树外的会话', () => {
    expect(parseSessionMessage(row('peer'))).toEqual({ from: 's-1', title: 'Amadeus 离线同步 & 冲突', relation: 'peer', body: '备份脚本挪到 4 点' })
    expect(parseSessionMessage(row('child'))?.relation).toBe('child')
  })
  it('不是这种行 → null', () => {
    expect(parseSessionMessage('hello')).toBeNull()
    expect(parseSessionMessage('<session_message from="a" title="b">\nx\n</session_message>')).toBeNull()
  })
})

describe('hand_off_task 开出的会话不进「从这里分出」', () => {
  const id1 = '5c1e0000-0000-4000-8000-000000000001'
  const id2 = '5c1e0000-0000-4000-8000-000000000002'
  const events = [
    { id: 'a', name: 'start_session', arguments: '{}', done: true, result: `Started "查文档" (id ${id1}).` },
    { id: 'b', name: 'hand_off_task', arguments: '{}', done: true, result: `Moved the unfinished task to a new session "写草稿" (id ${id2}).` },
    { id: 'c', name: 'hand_off_task', arguments: '{}', done: true, isError: true, result: `failed (id ${id1})` },
  ]
  it('childIdsOf 只认 start_session,handoffIdsOf 只认成功的 hand_off_task', () => {
    expect(childIdsOf(events)).toEqual([id1])
    expect(handoffIdsOf(events)).toEqual([id2])
    expect(handoffIdsOf(undefined)).toEqual([])
  })
})
