import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent, UiMessage } from '../types'
import { useApp, recordToUi, type AppState } from './appStore'

// 助手消息身份还原:历史/重载的助手消息按「每条存的 agent_slug」显示真实作者,
// 否则只能回退到「会话默认 agent」(就是 Christina 被显示成默认 Tangu Arioso 的 bug)。
describe('recordToUi agent 身份', () => {
  const resolveGroup = (name: string) => (name === 'Host' ? { slug: '__host__', color: '#000' } : { color: '#111' })
  const resolveSlug = (slug: string) => ({ christina: 'Christina', xyra: 'Tangu Arioso' }[slug])

  it('用 agent_slug 还原 agentId + agentName(单聊,不染色)', () => {
    const m = recordToUi({ id: 'm1', role: 'model', content: '早上好', agent_slug: 'christina' }, resolveGroup, resolveSlug)
    expect(m.agentId).toBe('christina')
    expect(m.agentName).toBe('Christina')
    expect(m.agentColor).toBeUndefined() // 单聊不用群聊彩色名
  })

  it('群聊 🗣 前缀优先于 agent_slug', () => {
    const m = recordToUi({ id: 'm2', role: 'model', content: '**🗣 Host**\n大家好', agent_slug: 'christina' }, resolveGroup, resolveSlug)
    expect(m.agentId).toBe('__host__')
    expect(m.agentName).toBe('Host')
    expect(m.content).toBe('大家好')
  })

  it('旧消息无 agent_slug → 不盖身份(留给会话回退)', () => {
    const m = recordToUi({ id: 'm3', role: 'model', content: 'hi' }, resolveGroup, resolveSlug)
    expect(m.agentId).toBeUndefined()
    expect(m.agentName).toBeUndefined()
  })

  it('agent_slug 不在册 → 设 agentId 但 name 留空(回退会话名,不退默认头像)', () => {
    const m = recordToUi({ id: 'm4', role: 'model', content: 'hi', agent_slug: 'ghost' }, resolveGroup, resolveSlug)
    expect(m.agentId).toBe('ghost')
    expect(m.agentName).toBeUndefined()
  })
})

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

  it('status/llm_retry 设置重试横幅,流恢复(下一个非 status 事件)即自清', () => {
    const ref = { current: 'a1' }
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 1, type: 'status', payload: { phase: 'llm_retry', attempt: 2, max: 3, waitMs: 3000, error: 'fetch failed' } } as AgentRunEvent)
    expect(useApp.getState().llmRetryBySession.s1).toMatchObject({ attempt: 2, max: 3, waitMs: 3000, error: 'fetch failed' })
    // 其他 status(如 generating)不清横幅——重试等待期引擎不会发别的事件,防御性保持。
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 2, type: 'status', payload: { phase: 'generating' } } as AgentRunEvent)
    expect(useApp.getState().llmRetryBySession.s1).toBeTruthy()
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 3, type: 'token', payload: { delta: 'hi' } } as AgentRunEvent)
    expect(useApp.getState().llmRetryBySession.s1).toBeUndefined()
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

  // steer 等待区:入队不上屏,turn_boundary 注入才进对话;run 终结余量回填输入框。
  it('turn_boundary 注入把等待区消息移入对话,附件随注入迁移(事件只带 id/content)', () => {
    const att = [{ name: 'p.png', mimeType: 'image/png', data: 'x', size: 1 }]
    useApp.setState({ steerPendingBySession: { s1: [{ id: 'u2', text: 'steer', attachments: att }] } })
    const ref = { current: 'a1' }
    useApp.getState().reduceEvent('s1', 'r1', ref, {
      seq: 1, type: 'turn_boundary',
      payload: { finalizedAssistantId: 'a1', finalizedContent: 'seg A', userMessages: [{ id: 'u2', content: 'steer' }], newAssistantId: 'a2' },
    } as AgentRunEvent)
    const st = useApp.getState()
    expect(st.steerPendingBySession.s1).toHaveLength(0)
    expect(st.messagesBySession.s1.find((m) => m.id === 'u2')).toMatchObject({ role: 'user', content: 'steer', attachments: att })
  })

  // Codex 评审 #1:turn_boundary(SSE)可能抢在 steer POST 响应前到达。
  it('steerAcceptPatch:消息已上屏或 run 已易主 → 不进等待区;↑ 历史始终记', async () => {
    const { steerAcceptPatch } = await import('./appStore')
    const base = { runningBySession: { s1: 'r1' }, steerPendingBySession: {}, steerSentBySession: {} }
    // 正常:进等待区 + 记历史
    const ok = steerAcceptPatch({ ...base, messagesBySession: {} } as any, 's1', 'r1', { id: 'u9', text: 'hi' })
    expect((ok.steerPendingBySession as any).s1).toHaveLength(1)
    expect((ok.steerSentBySession as any).s1).toEqual(['hi'])
    // 已上屏(注入抢先):只记历史
    const raced = steerAcceptPatch({ ...base, messagesBySession: { s1: [{ id: 'u9', role: 'user', content: 'hi', status: 'done', timestamp: 1 } as any] } } as any, 's1', 'r1', { id: 'u9', text: 'hi' })
    expect(raced.steerPendingBySession).toBeUndefined()
    expect((raced.steerSentBySession as any).s1).toEqual(['hi'])
    // run 已易主/终结:只记历史
    const ended = steerAcceptPatch({ ...base, runningBySession: {}, messagesBySession: {} } as any, 's1', 'r1', { id: 'u9', text: 'hi' })
    expect(ended.steerPendingBySession).toBeUndefined()
  })

  it('run 终结时未注入的插话回填输入框;迟到的旧 run 终结不碰新 run 的等待区', () => {
    useApp.setState({ steerPendingBySession: { s1: [{ id: 'u9', text: '还没送达' }] } })
    const ref = { current: 'a1' }
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 1, type: 'error', payload: { error: 'aborted', aborted: true } } as AgentRunEvent)
    let st = useApp.getState()
    expect(st.steerPendingBySession.s1).toHaveLength(0)
    expect(st.steerRestoreBySession.s1).toBe('还没送达')
    // 新 run r2 活跃、等待区有 r2 的插话;旧 run r1 的终结事件迟到 → 守卫拦下,不许清 r2 的队列。
    useApp.setState({ runningBySession: { s1: 'r2' }, steerPendingBySession: { s1: [{ id: 'u10', text: '新 run 的' }] }, steerRestoreBySession: {} })
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 2, type: 'error', payload: { error: 'aborted', aborted: true } } as AgentRunEvent)
    st = useApp.getState()
    expect(st.steerPendingBySession.s1).toHaveLength(1)
    expect(st.steerRestoreBySession.s1).toBeUndefined()
  })

  it('plan_approved auto=true → 该 run done 后自动发起执行(合成用户消息)', () => {
    const sendMock = vi.fn<AppState['send']>(async () => true)
    useApp.setState({ send: sendMock })
    const ref = { current: 'a1' }
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 1, type: 'plan_approved', payload: { auto: true } } as AgentRunEvent)
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 2, type: 'done', payload: { content: '计划稿' } } as AgentRunEvent)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0]).toBe('plan.autoKickoff') // tr 桩原样回 key
    expect(sendMock.mock.calls[0][5]).toBe('s1')
    // 不带 auto 的批准绝不自动开工
    useApp.setState({ runningBySession: { s1: 'r3' }, messagesBySession: { s1: [assistant()] } })
    useApp.getState().reduceEvent('s1', 'r3', ref, { seq: 3, type: 'plan_approved', payload: {} } as AgentRunEvent)
    useApp.getState().reduceEvent('s1', 'r3', ref, { seq: 4, type: 'done', payload: { content: 'x' } } as AgentRunEvent)
    expect(sendMock).toHaveBeenCalledTimes(1)
    // Codex 评审 #4:auto 标记按 runId 记——计划 run 被打断(error→endRun)后标记必须作废,
    // 该会话后续无关 run 的 done 不许莫名「自动开始执行」。
    useApp.setState({ runningBySession: { s1: 'r5' }, messagesBySession: { s1: [assistant()] } })
    useApp.getState().reduceEvent('s1', 'r5', ref, { seq: 5, type: 'plan_approved', payload: { auto: true } } as AgentRunEvent)
    useApp.getState().reduceEvent('s1', 'r5', ref, { seq: 6, type: 'error', payload: { error: 'aborted', aborted: true } } as AgentRunEvent)
    useApp.setState({ runningBySession: { s1: 'r6' }, messagesBySession: { s1: [assistant()] } })
    useApp.getState().reduceEvent('s1', 'r6', ref, { seq: 7, type: 'done', payload: { content: 'y' } } as AgentRunEvent)
    expect(sendMock).toHaveBeenCalledTimes(1) // 仍是最初那一次,泄漏=会变 2
  })
})
