import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent, AuthStatusInfo, UiMessage } from '../types'
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

  it('usage 事件存 runCost/costLimit,越 80% 提示一次;status compacted 落一条系统提示', () => {
    const ref = { current: 'a1' }
    let seq = 0 // per-run 单调:compacted/costwarn 的消息 id 掺 seq 防撞
    const emit = (type: string, payload: Record<string, unknown> = {}) => {
      useApp.getState().reduceEvent('s1', 'r1', ref, { seq: ++seq, type, payload } as AgentRunEvent)
    }
    // activeId 指向别的会话:警告必须落进产生事件的 s1,不是用户正看的会话
    useApp.setState({ activeId: 'other' })

    emit('usage', { prompt: 100, total: 25, costTotal: 500, costLimit: 20000 })
    expect(useApp.getState().usageBySession.s1).toMatchObject({ runCost: 500, costLimit: 20000 })
    const before = useApp.getState().messagesBySession.s1.length

    // 越过 80% 阈值 → s1 流里落系统提示一次;再涨不重复提示
    emit('usage', { prompt: 100, total: 25, costTotal: 16_500, costLimit: 20000 })
    const afterWarn = useApp.getState().messagesBySession.s1
    expect(afterWarn.length).toBe(before + 1)
    expect(afterWarn[afterWarn.length - 1]).toMatchObject({ role: 'system' })
    expect(afterWarn[afterWarn.length - 1].content).toContain('cost.nearCap')
    expect(useApp.getState().messagesBySession.other).toBeUndefined()
    emit('usage', { prompt: 100, total: 25, costTotal: 17_000, costLimit: 20000 })
    expect(useApp.getState().messagesBySession.s1.length).toBe(before + 1)

    // context_info 整包落存(H5/H8/B2)
    emit('status', { phase: 'context_info', ctxWindow: 272000, ctxWindowSource: 'family', sections: [{ k: 'skills', tokens: 1200 }], files: ['/p/AGENTS.md'], filesTruncated: true, historyCount: 8, historyTokens: 4200, thinkingRequested: 'high', thinkingEffective: 'medium' })
    expect(useApp.getState().ctxInfoBySession.s1).toMatchObject({
      ctxWindow: 272000, ctxWindowSource: 'family', filesTruncated: true, historyCount: 8, historyTokens: 4200,
      thinkingRequested: 'high', thinkingEffective: 'medium',
    })
    expect(useApp.getState().ctxInfoBySession.s1.sections[0]).toEqual({ k: 'skills', tokens: 1200 })

    // 自动压缩提示:机械档带 savedChars;compacting 阶段不落消息;forced+fallback 用机械措辞不谎称摘要
    emit('status', { phase: 'compacting', forced: true, iteration: 2 })
    expect(useApp.getState().messagesBySession.s1.length).toBe(before + 1)
    emit('status', { phase: 'compacted', savedChars: 1234, iteration: 2 })
    let msgs = useApp.getState().messagesBySession.s1
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'system', content: 'ctx.compacted.auto' })
    emit('status', { phase: 'compacted', forced: true, iteration: 3 })
    msgs = useApp.getState().messagesBySession.s1
    expect(msgs[msgs.length - 1].content).toBe('ctx.compacted.forced')
    emit('status', { phase: 'compacted', forced: true, fallback: true, savedChars: 99, iteration: 4 })
    msgs = useApp.getState().messagesBySession.s1
    expect(msgs[msgs.length - 1].content).toBe('ctx.compacted.auto')
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

// /compact 进度条:百分比是客户端估算(接口一次性返回),所以真正会坏的是生命周期——
// 起步不为 0、自己走到 100 骗人、完成后不撤(条子永远挂在流末尾)、失败路径漏掉收尾。
const compactMock = vi.hoisted(() => vi.fn())
const createSessionMock = vi.hoisted(() => vi.fn())
const startRunMock = vi.hoisted(() => vi.fn())
const restoreCpMock = vi.hoisted(() => vi.fn())
const deleteMsgsMock = vi.hoisted(() => vi.fn())
vi.mock('../services/backendService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  compactSession: (...a: unknown[]) => compactMock(...a),
  createSession: (...a: unknown[]) => createSessionMock(...a),
  putSessionConfig: () => Promise.resolve({}),
  updateSession: () => Promise.resolve({}),
  restoreCheckpoint: (...a: unknown[]) => restoreCpMock(...a),
  deleteMessages: (...a: unknown[]) => deleteMsgsMock(...a),
}))
vi.mock('../services/agentRunService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startRun: (...a: unknown[]) => startRunMock(...a),
}))

// 新会话必须**当场把模型写进会话**,而不是等用户显式选了才写:用户靠的是「上次用哪个下次还用哪个」
// (cfg.modelId),此时 newChatModel 是空的。不写进去 → 引擎按 profile.defaultModelId 建库 →
// 发送后药丸跳回默认模型,且第二轮真的换成默认模型跑(第二轮读会话自己的 model_id)。
describe('appStore.send 新会话固化模型', () => {
  beforeEach(() => {
    useApp.setState(initial, true)
    useApp.setState({
      tr: ((k: string) => k) as AppState['tr'],
      activeId: null,
      newChatModel: null, // 本次没有显式选 —— 全靠记忆
      cfg: { ...useApp.getState().cfg, modelId: 'remembered-model' },
      modelsResp: { models: [], defaultModelId: 'backend-default' } as unknown as AppState['modelsResp'],
    })
    createSessionMock.mockReset()
    startRunMock.mockReset()
    // 建会话之后就够断言了;让 startRun 抛错在此收尾,免得拖进 SSE 订阅。
    startRunMock.mockRejectedValue(new Error('stop here'))
  })

  const created = (id: string, modelId: string | null) =>
    ({ id, title: 'New Chat', model_id: modelId, created_at: '', updated_at: '' })

  it('没显式选模型时,建会话带上记忆的 cfg.modelId(而非留给引擎默认)', async () => {
    createSessionMock.mockImplementation((_cfg: unknown, init: { model_id?: string }) =>
      Promise.resolve(created('s-new', init?.model_id ?? 'backend-default')))

    await useApp.getState().send('你好', [])

    expect(createSessionMock).toHaveBeenCalledTimes(1)
    expect(createSessionMock.mock.calls[0][1]).toMatchObject({ model_id: 'remembered-model' })
    // 会话记录随之带上它 → 输入栏药丸(读 activeSession.model_id)不会跳回默认
    expect(useApp.getState().sessions.find((s) => s.id === 's-new')?.model_id).toBe('remembered-model')
    // 本轮真正发出去的也是同一个,三处同源
    expect(startRunMock.mock.calls[0]?.[1]).toMatchObject({ modelId: 'remembered-model' })
  })

  it('空态显式选过模型时以它为准(优先于记忆)', async () => {
    useApp.setState({ newChatModel: 'picked-model' })
    createSessionMock.mockImplementation((_cfg: unknown, init: { model_id?: string }) =>
      Promise.resolve(created('s-new', init?.model_id ?? 'backend-default')))

    await useApp.getState().send('你好', [])

    expect(createSessionMock.mock.calls[0][1]).toMatchObject({ model_id: 'picked-model' })
    expect(startRunMock.mock.calls[0]?.[1]).toMatchObject({ modelId: 'picked-model' })
  })
})

describe('appStore.compact 进度', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useApp.setState(initial, true)
    useApp.setState({ tr: ((k: string) => k) as AppState['tr'], activeId: 's1' })
    compactMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  const pct = () => useApp.getState().compactingBySession.s1

  it('0 起步 → 缓动但永不自行到 100 → 完成冲 100 → 停一拍后撤', async () => {
    let finish: (v: unknown) => void = () => {}
    compactMock.mockReturnValue(new Promise((r) => { finish = r }))

    const p = useApp.getState().compact('s1')
    expect(pct()).toBe(0)

    await vi.advanceTimersByTimeAsync(10_000)
    const mid = pct()!
    expect(mid).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(50_000)
    expect(pct()!).toBeGreaterThan(mid) // 单调推进
    expect(pct()!).toBeLessThanOrEqual(90) // 上界:没拿到响应就绝不满格

    finish({ ok: true, summarizedCount: 3 })
    await p
    expect(pct()).toBe(100)
    await vi.advanceTimersByTimeAsync(800)
    expect(pct()).toBeUndefined() // 撤干净,否则条子永久挂在流末尾
  })

  it('压缩中重复触发不叠第二次', async () => {
    let finish: (v: unknown) => void = () => {}
    compactMock.mockReturnValue(new Promise((r) => { finish = r }))
    const p = useApp.getState().compact('s1')
    await useApp.getState().compact('s1')
    expect(compactMock).toHaveBeenCalledTimes(1)
    finish({ ok: true })
    await p
  })

  it('接口抛错也把进度收干净', async () => {
    compactMock.mockRejectedValue(new Error('boom'))
    await useApp.getState().compact('s1')
    expect(pct()).toBe(100)
    await vi.advanceTimersByTimeAsync(800)
    expect(pct()).toBeUndefined()
  })
})

// 工作区展开态:手风琴(展开一个收起其余)已按用户要求去掉 —— 每个工作区各自开合,互不影响。
describe('toggleOpenWorkspace', () => {
  beforeEach(() => { useApp.setState({ openWorkspaceKeys: [] }) })
  const keys = (): string[] => useApp.getState().openWorkspaceKeys

  it('多个工作区可以同时展开', () => {
    useApp.getState().toggleOpenWorkspace('a')
    useApp.getState().toggleOpenWorkspace('b')
    expect(keys()).toEqual(['a', 'b'])
  })

  it('再点一次只收自己', () => {
    useApp.getState().toggleOpenWorkspace('a')
    useApp.getState().toggleOpenWorkspace('b')
    useApp.getState().toggleOpenWorkspace('a')
    expect(keys()).toEqual(['b'])
  })

  it('显式 open=true 幂等(联动 effect 会反复调)', () => {
    useApp.getState().toggleOpenWorkspace('a', true)
    const before = keys()
    useApp.getState().toggleOpenWorkspace('a', true)
    expect(keys()).toBe(before) // 同一个引用 = 没有多余的 set,不会把订阅者刷醒
  })

  // Codex 评审:收起后再进入同一个工作区,activeWorkspaceKey 值没变 —— 展开这件事不能挂在
  // 「监听 activeWorkspaceKey 变化」的 effect 上,必须由 setActiveWorkspaceKey 自己保证。
  it('「进入」永远保证它是展开的(哪怕 activeWorkspaceKey 没变)', () => {
    useApp.setState({ activeWorkspaceKey: null })
    useApp.getState().setActiveWorkspaceKey('a')
    expect(keys()).toEqual(['a'])
    useApp.getState().toggleOpenWorkspace('a', false) // 用户手动收起,active 仍是 a
    expect(keys()).toEqual([])
    useApp.getState().setActiveWorkspaceKey('a') // 再点进去 —— 值没变,但必须重新展开
    expect(keys()).toEqual(['a'])
  })
})

// 401 ≠ 云端登录过期:引擎的端点鉴权是逐字比对 spawn 时的 env token 快照,凭据一漂本地接口整片 401,
// 而云端登录完好 —— 那时弹「登录已过期」既是假话,又把「本地会话列表加载失败」推给用户自己去重登。
// 这两条挂了 = 那个 bug 回来了(2026-08-13)。
describe('handleAuthExpired:401 先复检真实登录态', () => {
  const auth = (patch: Partial<AuthStatusInfo>): AuthStatusInfo =>
    ({ loggedIn: true, cloudUrl: 'https://forsion.net', username: 'u', tokenSource: 'tangu-login', ...patch })
  let restarts = 0
  const arm = (status: AuthStatusInfo | null): void => {
    restarts = 0
    ;(globalThis as any).window = {
      tangu: {
        authStatus: () => Promise.resolve(status),
        backendRestart: () => { restarts += 1; return Promise.resolve({}) },
      },
    }
    useApp.setState({ ...initial, tr: (k) => k, toast: () => {}, authInfo: auth({}) }, true)
  }

  afterEach(() => { delete (globalThis as any).window; vi.restoreAllMocks() })

  it('云端仍认账 → 重启引擎自愈,不进过期态', async () => {
    arm(auth({ tokenValid: null }))
    useApp.getState().handleAuthExpired()
    await vi.waitFor(() => expect(restarts).toBe(1))
    expect(useApp.getState().connState).not.toBe('err')
    expect(useApp.getState().settingsOpen).toBe(false) // 没有把用户弹去登录页
    expect(useApp.getState().authInfo?.loggedIn).toBe(true)
  })

  it('服务端已登出 → 照旧走过期 UX', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000) // 越过 handleAuthExpired 的 10s 去抖
    arm(auth({ loggedIn: false }))
    useApp.getState().handleAuthExpired()
    await vi.waitFor(() => expect(useApp.getState().connState).toBe('err'))
    expect(useApp.getState().settingsOpen).toBe(true)
    expect(restarts).toBe(0) // 真过期不重启引擎
  })
})

// 回退(B1):三档各自只做该做的事。最要紧的两条不变量——① 代码回滚失败绝不接着删对话
// (对话删了没法重来,而代码没回滚的「回退」是假的);② 仅回退对话时不自动重发(类 Claude Code:
// 原文回输入框,改不改由用户定)。
describe('appStore.rewindTo', () => {
  const msgs = (): UiMessage[] => ([
    { id: 'u1', role: 'user', content: '第一问', status: 'done', timestamp: 100 },
    { id: 'a1', role: 'assistant', content: '答一', status: 'done', timestamp: 110 },
    { id: 'u2', role: 'user', content: '第二问', status: 'done', timestamp: 200 },
    { id: 'a2', role: 'assistant', content: '答二', status: 'done', timestamp: 210 },
  ])

  beforeEach(() => {
    useApp.setState(initial, true)
    useApp.setState({
      tr: ((k: string) => k) as AppState['tr'],
      toast: () => {},
      activeId: 's1',
      messagesBySession: { s1: msgs() },
      runningBySession: {},
    })
    restoreCpMock.mockReset()
    deleteMsgsMock.mockReset()
    startRunMock.mockReset()
    restoreCpMock.mockResolvedValue({ restored: ['/w/a.ts'], deleted: [], skipped: [], failed: [] })
    deleteMsgsMock.mockResolvedValue({ ok: true, deleted: 2 })
  })

  it("mode='code':按该消息时间戳回滚,不动对话", async () => {
    await useApp.getState().rewindTo('u2', 'code', 's1')
    expect(restoreCpMock.mock.calls[0]?.[2]).toBe(200)
    expect(deleteMsgsMock).not.toHaveBeenCalled()
    expect(useApp.getState().messagesBySession.s1).toHaveLength(4)
  })

  it("mode='conversation':截断该条及之后 + 原文回输入框,且不重发", async () => {
    await useApp.getState().rewindTo('u2', 'conversation', 's1')
    expect(restoreCpMock).not.toHaveBeenCalled()
    expect(deleteMsgsMock.mock.calls[0]?.[2]).toEqual(['u2', 'a2'])
    expect(useApp.getState().messagesBySession.s1.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(useApp.getState().steerRestoreBySession.s1).toBe('第二问')
    expect(startRunMock).not.toHaveBeenCalled()
  })

  it("mode='both':两边都做", async () => {
    await useApp.getState().rewindTo('u2', 'both', 's1')
    expect(restoreCpMock).toHaveBeenCalledTimes(1)
    expect(useApp.getState().messagesBySession.s1).toHaveLength(2)
  })

  it('代码回滚失败 → 对话保持原样(不做一半)', async () => {
    restoreCpMock.mockRejectedValue(new Error('disk on fire'))
    await useApp.getState().rewindTo('u2', 'both', 's1')
    expect(deleteMsgsMock).not.toHaveBeenCalled()
    expect(useApp.getState().messagesBySession.s1).toHaveLength(4)
  })

  it('运行中拒绝回退', async () => {
    useApp.setState({ runningBySession: { s1: 'r1' } })
    await useApp.getState().rewindTo('u2', 'both', 's1')
    expect(restoreCpMock).not.toHaveBeenCalled()
    expect(deleteMsgsMock).not.toHaveBeenCalled()
  })
})

// 计划卡重载后不该消失:plan 事件不落库,计划全文在 exit_plan_mode 的 tool_call 参数里。
describe('recordToUi 计划回填', () => {
  it('从 exit_plan_mode 的参数还原 planProposal', () => {
    const m = recordToUi({
      id: 'a9', role: 'model', content: '计划已提交',
      tool_calls: [{ id: 'c1', function: { name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 计划\n1. 做事' }) } }],
      tool_results: [{ tool_call_id: 'c1', content: 'ok' }],
    })
    expect(m.planProposal).toBe('# 计划\n1. 做事')
  })

  it('参数残缺/非计划工具 → 不设 planProposal', () => {
    expect(recordToUi({ id: 'a10', role: 'model', content: '', tool_calls: [{ id: 'c1', function: { name: 'exit_plan_mode', arguments: '{bad json' } }] }).planProposal).toBeUndefined()
    expect(recordToUi({ id: 'a11', role: 'model', content: '', tool_calls: [{ id: 'c2', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }).planProposal).toBeUndefined()
  })
})
