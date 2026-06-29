import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent, UiMessage } from '../types'
import { useApp } from './appStore'

const initial = useApp.getState()
const assistant = (): UiMessage => ({
  id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: 1,
})

describe('appStore.reduceEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useApp.setState(initial, true)
    useApp.setState({
      tr: (key) => key,
      messagesBySession: { s1: [assistant()] },
      configBySession: { s1: { planMode: true } },
      runningBySession: { s1: 'r1' },
      usageBySession: { s1: { ctx: 0, base: 10, live: 0 } },
      subChatsBySession: {},
      groupVoting: {},
      toasts: [],
    })
  })

  afterEach(() => vi.useRealTimers())

  it('覆盖消息、工具、审批、询问、计划、群聊、用量、转向及子聊天事件', () => {
    const ref = { current: 'a1' } as { current: string; group?: boolean; groupSeen?: boolean; reuseNext?: boolean; groupEnded?: boolean }
    const emit = (type: string, payload: Record<string, unknown> = {}) => {
      useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 1, type, payload } as AgentRunEvent)
    }

    emit('token', { delta: 'hello' })
    emit('reasoning', { delta: 'think' })
    emit('system_prompt', { content: 'system' })
    emit('tool_stream', { id: 't1', name: 'run_shell', delta: 'npm ' })
    emit('tool_call', { id: 't1', name: 'run_shell', arguments: 'npm test' })
    emit('tool_result', { id: 't1', result: 'ok', elapsedMs: 12 })
    emit('display_file', { name: 'out.png', mime: 'image/png', path: '/out.png' })
    emit('approval_request', { approvalId: 'p1', name: 'run_shell', preview: 'npm test' })
    emit('approval_result', { approvalId: 'p1', action: 'approve' })
    emit('inquiry_request', { inquiryId: 'q1', question: 'Continue?', options: ['Yes'] })
    emit('inquiry_result', { inquiryId: 'q1', answer: 'Yes' })
    emit('plan', { plan: '1. test' })
    emit('todo', { todos: [{ status: 'pending', content: 'test' }] })
    emit('plan_approved', { file: 'plan.md' })
    // 群聊首位发言人:就地把占位气泡(a1)改成后端下发的持久 messageId(此处仍为 a1)并盖发言人身份。
    emit('group_speaker', { phase: 'start', slug: 'xyra', name: 'Xyra', round: 1, messageId: 'a1' })
    emit('group_speaker', { phase: 'end', slug: 'xyra', round: 1, messageId: 'a1' })
    emit('group_voting')
    emit('group_vote', { round: 1, endCount: 1, total: 2, votes: [] })
    emit('group_ended', { rounds: 1, reason: 'vote' })
    emit('usage', { prompt: 100, total: 25 })
    emit('turn_boundary', { finalizedAssistantId: ref.current, finalizedContent: 'final', userMessages: [{ id: 'u2', content: 'steer' }], newAssistantId: 'a2' })
    emit('subchat', { id: 'sub1', kind: 'subagent', title: 'Worker' })
    emit('subagent', { subId: 'sub1', phase: 'start', label: 'Worker' })
    emit('subagent', { subId: 'sub1', phase: 'token', delta: 'work' })
    emit('subagent', { subId: 'sub1', phase: 'tool', name: 'read_file', preview: 'a.ts' })
    emit('subagent', { subId: 'sub1', phase: 'done' })

    const state = useApp.getState()
    const first = state.messagesBySession.s1.find((m) => m.id === 'a1')!
    expect(first).toMatchObject({ content: 'final', reasoning: 'think', systemPrompt: 'system', planProposal: '1. test' })
    expect(first.toolEvents?.[0]).toMatchObject({ id: 't1', done: true, result: 'ok' })
    expect(first.approvals?.[0].status).toBe('approved')
    expect(first.inquiries?.[0]).toMatchObject({ status: 'answered', answer: 'Yes' })
    expect(state.configBySession.s1.planMode).toBe(false)
    expect(state.groupVoting.s1).toBe(false)
    expect(state.usageBySession.s1).toMatchObject({ ctx: 100, live: 25 })
    expect(ref.current).toBe('a2')
    expect(state.subChatsBySession.s1[0]).toMatchObject({ id: 'sub1', streaming: false })
    expect(state.subChatsBySession.s1[0].segs).toHaveLength(2)
  })

  it('done 与 error 正确收尾并过期未决操作', () => {
    useApp.setState({
      messagesBySession: { s1: [{ ...assistant(), approvals: [{ approvalId: 'p', runId: 'r1', name: 'x', arguments: '', preview: '', status: 'pending' }], inquiries: [{ inquiryId: 'q', runId: 'r1', question: '?', options: [], status: 'pending' }] }] },
    })
    const ref = { current: 'a1' }
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 1, type: 'done', payload: { content: 'done' } })
    expect(useApp.getState().messagesBySession.s1[0]).toMatchObject({ content: 'done', status: 'done' })
    expect(useApp.getState().messagesBySession.s1[0].approvals?.[0].status).toBe('expired')
    expect(useApp.getState().runningBySession.s1).toBeUndefined()

    useApp.setState({ messagesBySession: { s1: [assistant()] }, runningBySession: { s1: 'r2' } })
    useApp.getState().reduceEvent('s1', 'r2', ref, { seq: 2, type: 'error', payload: { error: 'boom' } })
    expect(useApp.getState().messagesBySession.s1[0]).toMatchObject({ status: 'error', error: 'boom' })
    expect(useApp.getState().runningBySession.s1).toBeUndefined()
  })

  it('turn_boundary 的 finalizedId 不匹配时回退到 assistantRef,不孤立气泡也不丢身份', () => {
    // 乐观气泡 a1 带 agent 身份;后端给了一个列表里没有的 finalizedAssistantId(模拟 id 不一致)。
    useApp.setState({ messagesBySession: { s1: [{ ...assistant(), agentId: 'qinche', agentName: '秦彻' }] } })
    const ref = { current: 'a1' }
    useApp.getState().reduceEvent('s1', 'r1', ref, {
      seq: 1, type: 'turn_boundary',
      payload: { finalizedAssistantId: 'server-mismatch', finalizedContent: 'reply', newAssistantId: 'a2' },
    } as AgentRunEvent)
    const list = useApp.getState().messagesBySession.s1
    // a1 被收尾(非孤立的「思考中」),新段 a2 继承 秦彻 身份(非退回 TANGU)。
    expect(list.find((m) => m.id === 'a1')).toMatchObject({ content: 'reply', status: 'done' })
    expect(list.find((m) => m.id === 'a2')).toMatchObject({ agentId: 'qinche', agentName: '秦彻', status: 'streaming' })
    expect(ref.current).toBe('a2')
  })

  it('会话配置 action 显式作用于目标 session，而非全局 activeId', () => {
    useApp.setState({ activeId: 's1', configBySession: { s1: { planMode: false }, s2: { planMode: false } } })
    useApp.getState().setSessionPlanMode(true, 's2')
    expect(useApp.getState().configBySession.s1.planMode).toBe(false)
    expect(useApp.getState().configBySession.s2.planMode).toBe(true)
  })
})
