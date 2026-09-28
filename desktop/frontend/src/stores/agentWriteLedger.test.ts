// 归属账本(评审 G3-03 + Codex 复核 P0):写类工具在途 / 刚成功才算「Tangu 写的」;失败立即撤销;每次写入只认领一次;
// 带完整内容 / new_string 的写入要核得上盘上正文;路径口径统一;中止的调用有上限。
import { beforeEach, describe, expect, it } from 'vitest'
import { AGENT_EDITING_MAX_MS, AGENT_WRITE_GRACE_MS, AGENT_WRITE_OPEN_MAX_MS, agentEditing, claimAgentWrite, noteAgentWriteEnd, noteAgentWriteLive, noteAgentWriteStart, resetAgentWriteLedger, subscribeAgentWrites } from './agentWriteLedger'
import { agentWriteChecks, agentWriteTargets } from './deskPlan'

describe('agentWriteLedger', () => {
  beforeEach(() => resetAgentWriteLedger())

  it('在途即算;成功结束后宽限期内仍算,过了不算', () => {
    noteAgentWriteStart('c1', ['/v/a.md'], 1000)
    expect(claimAgentWrite('/v/b.md', 'x', 1500)).toBe(false)
    noteAgentWriteEnd('c1', true, 2000)
    expect(claimAgentWrite('/v/a.md', 'x', 2000 + AGENT_WRITE_GRACE_MS + 1)).toBe(false)
    noteAgentWriteStart('c1b', ['/v/a.md'], 3000)
    noteAgentWriteEnd('c1b', true, 3000)
    expect(claimAgentWrite('/v/a.md', 'x', 3000 + AGENT_WRITE_GRACE_MS - 1)).toBe(true)
  })

  it('① 工具调用失败 → 立即撤销,不留宽限', () => {
    noteAgentWriteStart('c2', ['/v/a.md'], 0)
    noteAgentWriteEnd('c2', false, 10)
    expect(claimAgentWrite('/v/a.md', 'someone else', 11)).toBe(false)
  })

  it('② 每次写入只认领一次:之后同路径、内容不同的回灌不再归属;同一份正文再来一遍(重复通知 / 双标签)仍算', () => {
    noteAgentWriteStart('c3', ['/v/a.md'], 0)
    noteAgentWriteEnd('c3', true, 5)
    expect(claimAgentWrite('/v/a.md', 'agent text', 10)).toBe(true)
    expect(claimAgentWrite('/v/a.md', 'agent text', 12)).toBe(true)
    expect(claimAgentWrite('/v/a.md', 'user edit in another editor', 20)).toBe(false)
  })

  it('③ write_file 带完整内容:盘上正文对不上就不归属、也不消费(真正那次写入还能认领)', () => {
    noteAgentWriteStart('c4', [{ path: '/v/a.md', full: '# T\r\n\nbody\n' }], 0)
    expect(claimAgentWrite('/v/a.md', '# T\n\nsomething else\n', 5)).toBe(false)
    expect(claimAgentWrite('/v/a.md', '# T\n\nbody', 6)).toBe(true) // 换行统一、尾部空白不计
  })

  it('③ edit_file 带 new_string:盘上正文得包含它', () => {
    noteAgentWriteStart('c5', [{ path: '/v/a.md', includes: ['AGENT 改过'] }], 0)
    expect(claimAgentWrite('/v/a.md', '第一段原文', 5)).toBe(false)
    expect(claimAgentWrite('/v/a.md', '第一段 AGENT 改过。', 6)).toBe(true)
  })

  it('收不到结果的调用(run 中止)过了上限就作废', () => {
    noteAgentWriteStart('c6', ['/v/a.md'], 0)
    expect(claimAgentWrite('/v/a.md', 'x', AGENT_WRITE_OPEN_MAX_MS + 1)).toBe(false)
  })

  it('路径口径:反斜杠 / 叠斜杠 / 尾斜杠都认', () => {
    noteAgentWriteStart('c7', ['C:\\vault\\\\notes\\a.md'], 0)
    expect(claimAgentWrite('C:/vault/notes/a.md', 'x', 1)).toBe(true)
  })
})

describe('agentWriteChecks', () => {
  it('write_file 带完整内容;edit_file / multi_edit 带 new_string;apply_patch 只给路径', () => {
    expect(agentWriteChecks('write_file', JSON.stringify({ path: 'a.md', content: 'hi' }), '/v')).toEqual([{ path: '/v/a.md', full: 'hi' }])
    expect(agentWriteChecks('edit_file', JSON.stringify({ path: 'a.md', old_string: 'x', new_string: 'y' }), '/v')).toEqual([{ path: '/v/a.md', includes: ['y'] }])
    expect(agentWriteChecks('multi_edit', JSON.stringify({ path: 'a.md', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }), '/v')).toEqual([{ path: '/v/a.md', includes: ['b', 'd'] }])
    expect(agentWriteChecks('apply_patch', JSON.stringify({ patch: '*** Update File: a.md\n' }), '/v')).toEqual([{ path: '/v/a.md' }])
  })
})

describe('agentEditing(评审 G3-05:「Tangu 正在改这篇」提示)', () => {
  beforeEach(() => resetAgentWriteLedger())

  it('流式阶段登记即提示;tool_call 接手仍提示;结果回来(成功 / 失败)即撤', () => {
    const seen: number[] = []
    const off = subscribeAgentWrites(() => seen.push(1))
    noteAgentWriteLive('s1', '/v//a.md/', 0)
    expect(agentEditing('/v/a.md', 10)).toBe(true)
    expect(agentEditing('/v/b.md', 10)).toBe(false)
    noteAgentWriteStart('s1', [{ path: '/v/a.md', full: 'x' }], 20)
    expect(agentEditing('/v/a.md', 30)).toBe(true)
    noteAgentWriteEnd('s1', true, 40)
    expect(agentEditing('/v/a.md', 41)).toBe(false)
    noteAgentWriteLive('s2', '/v/a.md', 50)
    noteAgentWriteEnd('s2', false, 60)
    expect(agentEditing('/v/a.md', 61)).toBe(false)
    expect(seen.length).toBeGreaterThanOrEqual(5)
    off()
  })

  it('流式登记不参与归属认领:只有 tool_call 带来的完整内容才核得上(Codex P0 ③ 不被绕开)', () => {
    noteAgentWriteLive('s3', '/v/a.md', 0)
    expect(claimAgentWrite('/v/a.md', 'anything', 5)).toBe(false)
    noteAgentWriteStart('s3', [{ path: '/v/a.md', full: 'agent body' }], 6)
    expect(claimAgentWrite('/v/a.md', 'someone else', 7)).toBe(false)
    expect(claimAgentWrite('/v/a.md', 'agent body', 8)).toBe(true)
  })

  it('中止的写入(收不到 tool_call / tool_result)过了提示窗口就不再提示', () => {
    noteAgentWriteLive('s4', '/v/a.md', 0)
    noteAgentWriteStart('s5', ['/v/b.md'], 0)
    expect(agentEditing('/v/a.md', AGENT_EDITING_MAX_MS)).toBe(true)
    expect(agentEditing('/v/a.md', AGENT_EDITING_MAX_MS + 1)).toBe(false)
    expect(agentEditing('/v/b.md', AGENT_EDITING_MAX_MS + 1)).toBe(false)
  })
})

describe('agentWriteTargets', () => {
  it('write/edit/multi_edit 取 path,相对路径拼 cwd', () => {
    expect(agentWriteTargets('edit_file', JSON.stringify({ path: 'notes/a.md', old_string: 'x', new_string: 'y' }), '/v')).toEqual(['/v/notes/a.md'])
    expect(agentWriteTargets('write_file', JSON.stringify({ path: '/abs/b.md', content: '' }))).toEqual(['/abs/b.md'])
  })
  it('apply_patch 从补丁正文抽路径(含 Move to 的新路径)', () => {
    const patch = '*** Begin Patch\n*** Update File: a.md\n@@\n-x\n+y\n*** Update File: old.md\n*** Move to: new.md\n*** End Patch'
    expect(agentWriteTargets('apply_patch', JSON.stringify({ patch }), '/v')).toEqual(['/v/a.md', '/v/old.md', '/v/new.md'])
  })
  it('非写类工具 / 坏 JSON / 定位不了的相对路径 → 空', () => {
    expect(agentWriteTargets('read_file', JSON.stringify({ path: '/v/a.md' }))).toEqual([])
    expect(agentWriteTargets('edit_file', '{bad')).toEqual([])
    expect(agentWriteTargets('edit_file', JSON.stringify({ path: 'rel.md' }))).toEqual([])
  })
})
