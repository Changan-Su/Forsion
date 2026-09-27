import { describe, it, expect } from 'vitest'
import { parseApprovalUpdate, pendingPromptsOf, type TrayItem } from './approvalQueue'
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

describe('pendingPromptsOf', () => {
  it('审批 / 提问 / 计划拍板一起收:扫整个会话、按出现先后;已兑现的不收;只给团队成员标名字', () => {
    const msgs = [
      { id: 'm1', role: 'assistant', content: '', status: 'done', timestamp: 1, agentName: 'Tangu', approvals: [{ approvalId: 'a', runId: 'r', name: 'run_bash', preview: '', status: 'pending' }] },
      { id: 'm2', role: 'assistant', content: '', status: 'streaming', timestamp: 2, agentName: 'Bo', work: { waiting: true }, approvals: [
        { approvalId: 'b', runId: 'c', name: 'write_file', preview: '', status: 'approved' },
        { approvalId: 'c', runId: 'c', name: 'edit_file', preview: '', status: 'pending' },
      ], inquiries: [{ inquiryId: 'q1', runId: 'c', question: '用哪个库?', options: [], status: 'pending' }] },
      // 打回→重交:同一条消息攒了两个计划询问,旧的已答 —— 托盘只收待答的那个,且配上当前这版计划
      { id: 'm3', role: 'assistant', content: '', status: 'streaming', timestamp: 3, planProposal: '# v2', inquiries: [
        { inquiryId: 'p1', runId: 'r', question: '?', options: [], status: 'answered', answer: '改一下', kind: 'plan' },
        { inquiryId: 'p2', runId: 'r', question: '?', options: [], status: 'pending', kind: 'plan' },
      ] },
      // plan 事件缺失(没有 planProposal):计划询问按通用提问兜底,不丢
      { id: 'm4', role: 'assistant', content: '', status: 'streaming', timestamp: 4, inquiries: [{ inquiryId: 'p3', runId: 'r', question: '批准?', options: [], status: 'pending', kind: 'plan' }] },
    ] as unknown as UiMessage[]
    expect(pendingPromptsOf(msgs).map((p: TrayItem) => [p.kind, p.messageId, p.id, p.agentName, p.kind === 'plan' ? p.plan : undefined])).toEqual([
      ['approval', 'm1', 'a', undefined, undefined],
      ['approval', 'm2', 'c', 'Bo', undefined],
      ['inquiry', 'm2', 'q1', 'Bo', undefined],
      ['plan', 'm3', 'p2', undefined, '# v2'],
      ['inquiry', 'm4', 'p3', undefined, undefined],
    ])
  })
})
