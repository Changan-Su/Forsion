import { describe, it, expect } from 'vitest'
import { parseApprovalUpdate, pendingApprovalsOf } from './approvalQueue'
import type { UiMessage } from '../../types'

describe('parseApprovalUpdate', () => {
  it('按引擎的行头取每张的结局', () => {
    const text = '<approval_update>\nThe user has decided on tool calls that were waiting for approval:\n\n' +
      "[approved] run_bash (call c-1) — $ npm test\nIt has run; its output is now that call's result above.\n\n" +
      "[rejected] write_file (call c-2) — ⚠ Write outside the workspace · write /etc/hosts (1 chars)\nIt was NOT run; that call's result above now says so.\n\n" +
      "[failed] edit_file (call c-3) — edit a.ts\nIt ran and failed; the error is now that call's result above.\n</approval_update>"
    expect(parseApprovalUpdate(text)).toEqual([
      { status: 'approved', name: 'run_bash', callId: 'c-1', preview: '$ npm test' },
      { status: 'rejected', name: 'write_file', callId: 'c-2', preview: '⚠ Write outside the workspace · write /etc/hosts (1 chars)' },
      { status: 'failed', name: 'edit_file', callId: 'c-3', preview: 'edit a.ts' },
    ])
  })
})

describe('pendingApprovalsOf', () => {
  it('扫整个会话、按出现先后;只给团队成员标名字', () => {
    const msgs = [
      { id: 'm1', role: 'assistant', content: '', status: 'done', timestamp: 1, agentName: 'Tangu', approvals: [{ approvalId: 'a', runId: 'r', name: 'run_bash', preview: '', status: 'pending' }] },
      { id: 'm2', role: 'assistant', content: '', status: 'streaming', timestamp: 2, agentName: 'Bo', work: { waiting: true }, approvals: [
        { approvalId: 'b', runId: 'c', name: 'write_file', preview: '', status: 'approved' },
        { approvalId: 'c', runId: 'c', name: 'edit_file', preview: '', status: 'pending' },
      ] },
    ] as unknown as UiMessage[]
    expect(pendingApprovalsOf(msgs).map((p) => [p.messageId, p.req.approvalId, p.agentName])).toEqual([['m1', 'a', undefined], ['m2', 'c', 'Bo']])
  })
})
