// 归属账本(评审 G3-03):写类工具在途 / 刚结束才算「Tangu 写的」;路径口径统一;中止的调用有上限。
import { beforeEach, describe, expect, it } from 'vitest'
import { AGENT_WRITE_GRACE_MS, AGENT_WRITE_OPEN_MAX_MS, agentWroteRecently, noteAgentWriteEnd, noteAgentWriteStart, resetAgentWriteLedger } from './agentWriteLedger'
import { agentWriteTargets } from './deskPlan'

describe('agentWriteLedger', () => {
  beforeEach(() => resetAgentWriteLedger())

  it('在途即算;结束后宽限期内仍算,过了不算', () => {
    noteAgentWriteStart('c1', ['/v/a.md'], 1000)
    expect(agentWroteRecently('/v/a.md', 1500)).toBe(true)
    expect(agentWroteRecently('/v/b.md', 1500)).toBe(false)
    noteAgentWriteEnd('c1', 2000)
    expect(agentWroteRecently('/v/a.md', 2000 + AGENT_WRITE_GRACE_MS - 1)).toBe(true)
    expect(agentWroteRecently('/v/a.md', 2000 + AGENT_WRITE_GRACE_MS + 1)).toBe(false)
  })

  it('收不到结果的调用(run 中止)过了上限就作废', () => {
    noteAgentWriteStart('c2', ['/v/a.md'], 0)
    expect(agentWroteRecently('/v/a.md', AGENT_WRITE_OPEN_MAX_MS - 1)).toBe(true)
    expect(agentWroteRecently('/v/a.md', AGENT_WRITE_OPEN_MAX_MS + 1)).toBe(false)
  })

  it('路径口径:反斜杠 / 叠斜杠 / 尾斜杠都认', () => {
    noteAgentWriteStart('c3', ['C:\\vault\\\\notes\\a.md'], 0)
    expect(agentWroteRecently('C:/vault/notes/a.md', 1)).toBe(true)
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
