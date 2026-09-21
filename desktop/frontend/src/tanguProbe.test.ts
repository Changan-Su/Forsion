/**
 * `ctx.tangu` 探针的契约。重点是**变更过滤** —— `useApp` 在流式回答期间每收一个 SSE 增量就
 * set 一次 state,裸转发订阅等于把每个订阅了 ctx.tangu 的插件按帧敲一遍(浮层类插件当场掉帧)。
 * 这是本次唯一没有别的仪器覆盖的宿主逻辑:e2e 里插件用的是台架假探针,绕开了这一层。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSpaceStore, useWorkspace } from '@lcl/engine'
import { installTanguProbe, START_CHAT_MAX_PROMPT } from './tanguProbe'
import { readTangu } from './amadeus/plugins/tanguSeam'
import { resolveNewSessionWorkspace, useApp } from './stores/appStore'
import { DONE_HOLD_MS } from './stores/agentStatus'
import type { AgentRunEvent, UiMessage } from './types'

describe('ctx.tangu 探针', () => {
  beforeEach(() => {
    installTanguProbe()
    useApp.setState({
      activeId: null, newChatModel: 'm1', sessions: [], archivedSessions: [],
      modelsResp: undefined, usageBySession: {}, ctxInfoBySession: {}, configBySession: {}, newChatCfg: {},
    } as never)
    useSpaceStore.setState({ activeSpaceId: 'tangu' })
  })

  it('activeModel 跟着「输入栏药丸」那条回退链走;目录里查得到就给展示名', () => {
    const p = readTangu()!
    expect(p.activeModel()).toEqual({ id: 'm1', name: 'm1' }) // 目录空 → 回落成 id,不给空串

    useApp.setState({
      modelsResp: { models: [{ id: 'm1', name: 'Claude Opus 5', provider: 'x', source: 'forsion' }] } as never,
    })
    expect(p.activeModel()).toEqual({ id: 'm1', name: 'Claude Opus 5' })

    // 有活动会话时读会话自己的 model_id(而不是新对话那条链)
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm2', created_at: '', updated_at: '' }] as never,
    })
    expect(p.activeModel()?.id).toBe('m2')
  })

  it('activeSpace 直读 activeSpaceId(不是 getActiveSpace —— 它的 ?? spaces[0] 会报错成别的 Space)', () => {
    expect(readTangu()!.activeSpace()).toBe('tangu')
    useSpaceStore.setState({ activeSpaceId: 'amadeus' })
    expect(readTangu()!.activeSpace()).toBe('amadeus')
  })

  it('models 只暴露对话模型,并给空展示名回落 id', () => {
    useApp.setState({
      modelsResp: {
        models: [
          { id: 'legacy', name: '', provider: 'x', source: 'forsion' },
          { id: 'llm', name: 'Chat', provider: 'x', source: 'forsion', modelType: 'llm' },
          { id: 'image', name: 'Image', provider: 'x', source: 'forsion', modelType: 'image_gen' },
          { id: 'asr', name: 'ASR', provider: 'x', source: 'forsion', modelType: 'asr' },
        ],
      } as never,
    })
    expect(readTangu()!.models()).toEqual([
      { id: 'legacy', name: 'legacy' },
      { id: 'llm', name: 'Chat' },
    ])
  })

  it('agents:名册原样给(含系统 Agent —— 与「选择 Agent」条同口径),空名字回落 slug', () => {
    const def = (slug: string, name: string, createdBy = 'user'): unknown =>
      ({ slug, name, description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '', createdBy, createdAt: '', systemPrompt: '' })
    useApp.setState({ agentDefs: [def('xyra', 'Xyra'), def('muse', 'Muse', 'system'), def('nameless', '')] as never })
    expect(readTangu()!.agents!()).toEqual([
      { slug: 'xyra', name: 'Xyra' },
      { slug: 'muse', name: 'Muse' },
      { slug: 'nameless', name: 'nameless' },
    ])
  })

  it('session:空态会话也给得出来 —— 用量 0 + 新对话的起步档', () => {
    useApp.setState({ newChatCfg: { thinkingLevel: 'high' } as never, desktopConfig: null })
    expect(readTangu()!.session!()).toEqual({ contextWindow: 0, contextTokens: 0, sessionTokens: 0, effort: 'high' })

    // 「不指定」在配置里是空串,不能原样吐出去(插件会拿它当档位名查表)。
    useApp.setState({ newChatCfg: { thinkingLevel: '' } as never })
    expect(readTangu()!.session!().effort).toBeNull()
  })

  it('session:窗口 / 已用 token 与输入框同源;引擎报的窗口盖过目录值', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm1', created_at: '', updated_at: '' }] as never,
      modelsResp: { models: [{ id: 'm1', name: 'M1', provider: 'x', source: 'forsion', contextWindow: 200000 }] } as never,
      usageBySession: { s1: { ctx: 12000, base: 30000, live: 500 } },
    })
    expect(readTangu()!.session!()).toMatchObject({ contextWindow: 200000, contextTokens: 12000, sessionTokens: 30500 })

    useApp.setState({
      configBySession: { s1: { thinkingLevel: 'xhigh' } } as never,
      ctxInfoBySession: { s1: { ctxWindow: 1000000, thinkingRequested: 'xhigh', thinkingEffective: 'xhigh', modelId: 'm1' } } as never,
    })
    expect(readTangu()!.session!()).toMatchObject({ contextWindow: 1000000, effort: 'xhigh' })
  })

  it('session:刚改完思考档还没跑新 run → 报**新选的档**,不是上一次 run 的旧档', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm1', created_at: '', updated_at: '' }] as never,
      modelsResp: { models: [{ id: 'm1', name: 'M1', provider: 'x', source: 'forsion', contextWindow: 200000 }] } as never,
      // 上一轮跑的是 medium;setSessionThinking **不作废 ctxInfo**,所以这条会留着
      ctxInfoBySession: { s1: { ctxWindow: 500000, thinkingRequested: 'medium', thinkingEffective: 'medium', modelId: 'm1' } } as never,
      configBySession: { s1: { thinkingLevel: 'max' } } as never, // 用户刚把药丸拨到 max
    })
    const got = readTangu()!.session!()
    expect(got.effort).toBe('max')          // 药丸说 max,面板就得说 max
    expect(got.contextWindow).toBe(500000)  // ⚠️窗口不跟着作废:换档不影响上下文预算
  })

  it('session:引擎把请求档降了档(能力表 clamp)→ 报**生效档**,那才是真跑的', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm1', created_at: '', updated_at: '' }] as never,
      ctxInfoBySession: { s1: { ctxWindow: 200000, thinkingRequested: 'high', thinkingEffective: 'medium', modelId: 'm1' } } as never,
      configBySession: { s1: { thinkingLevel: 'high' } } as never,
    })
    expect(readTangu()!.session!().effort).toBe('medium')
  })

  it('session:ctxInfo 属于别的模型时整条作废(窗口和思考档出自同一条事件,不能只挡一半)', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm2', created_at: '', updated_at: '' }] as never,
      configBySession: { s1: { thinkingLevel: 'low' } } as never,
      modelsResp: { models: [{ id: 'm2', name: 'M2', provider: 'x', source: 'forsion', contextWindow: 64000 }] } as never,
      // 切模型后 SSE 重放复活的旧 run 事件:窗口 100 万、思考档 max,两个都是上一把模型的
      ctxInfoBySession: { s1: { ctxWindow: 1000000, thinkingEffective: 'max', modelId: 'm1' } } as never,
    })
    const got = readTangu()!.session!()
    expect(got.contextWindow).toBe(64000)  // 回落到目录值,不是 100 万
    expect(got.effort).toBe('low')          // 回落到会话配置档,不是 max
  })

  it('subscribe 只在 (模型, Space) 真变了时回调 —— 无关的 store 变更一律不响', () => {
    const p = readTangu()!
    let n = 0
    const off = p.subscribe(() => { n++ })

    // ① 与模型/Space 无关的 state 变更(模拟流式回答里每个增量都 set 一次)
    for (let i = 0; i < 5; i++) useApp.setState({ toastMsg: `tick ${i}` } as never)
    expect(n).toBe(0)

    // ② 同一个值重复写入也不响
    useApp.setState({ newChatModel: 'm1' })
    expect(n).toBe(0)

    // ③ 模型真变了 → 响一次
    useApp.setState({ newChatModel: 'm9' })
    expect(n).toBe(1)

    // ④ Space 真变了 → 再响一次
    useSpaceStore.setState({ activeSpaceId: 'inbox' })
    expect(n).toBe(2)

    // ⑤ 退订之后不再响(禁用插件后还在收回调 = 泄漏)
    off()
    useApp.setState({ newChatModel: 'm10' })
    useSpaceStore.setState({ activeSpaceId: 'amadeus' })
    expect(n).toBe(2)
  })
})

describe('waitBackend(ctx.automation 的后端等待)', () => {
  // 判据是 cfgLoaded && connState==='ok',不是「cfg 对象存在」——初值就是个假地址。
  // 负对照(已实跑红):readyCfg 改成只看 cfgLoaded → 「connState 不是 ok 不 resolve」红。
  const cfg = { backendUrl: 'http://t', token: 'tok', modelId: '' }
  it('已就绪即刻 resolve 当前 cfg', async () => {
    installTanguProbe()
    useApp.setState({ cfg, cfgLoaded: true, connState: 'ok' } as never)
    await expect(readTangu()!.waitBackend!(1000)).resolves.toEqual(cfg)
  })
  it('未就绪则等到就绪;connState 不是 ok 不算就绪;调用时才读 store', async () => {
    vi.useFakeTimers()
    try {
      installTanguProbe()
      useApp.setState({ cfg: { ...cfg, token: '' }, cfgLoaded: false, connState: 'idle' } as never)
      let got: unknown = 'pending'
      const p = readTangu()!.waitBackend!(60_000).then((v) => { got = v })
      await vi.advanceTimersByTimeAsync(1000)
      useApp.setState({ cfgLoaded: true, connState: 'err', cfg } as never)
      await vi.advanceTimersByTimeAsync(1000)
      expect(got).toBe('pending')
      useApp.setState({ connState: 'ok' } as never)
      await p
      expect(got).toEqual(cfg)
    } finally {
      vi.useRealTimers()
    }
  })
  it('超时给 null,不抛', async () => {
    vi.useFakeTimers()
    try {
      installTanguProbe()
      useApp.setState({ cfgLoaded: false, connState: 'idle' } as never)
      const p = readTangu()!.waitBackend!(500)
      await vi.advanceTimersByTimeAsync(500)
      await expect(p).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('subscribeReady(宿主重放 ensure 的边沿)', () => {
  // 判据与 waitBackend 共用 readyCfg。负对照(已实跑红):subscribeReady 改成「就绪即回调」(去掉 !last)→ 「已就绪重复 set 不响」红。
  const cfg = { backendUrl: 'http://t', token: 'tok', modelId: '' }
  it('只在 !ok→ok 边沿响一次;订阅时已就绪不补发;ok 期间无关 set 不响;err→ok 再响;退订后不响', () => {
    installTanguProbe()
    useApp.setState({ cfg, cfgLoaded: true, connState: 'ok' } as never)
    let n = 0
    const off = readTangu()!.subscribeReady!(() => { n++ })
    expect(n).toBe(0)
    useApp.setState({ toastMsg: 'x' } as never)
    useApp.setState({ connState: 'ok' } as never)
    expect(n).toBe(0)
    useApp.setState({ connState: 'err' } as never)
    expect(n).toBe(0)
    useApp.setState({ connState: 'ok' } as never)
    expect(n).toBe(1)
    useApp.setState({ connState: 'idle' } as never)
    useApp.setState({ cfgLoaded: false, connState: 'ok' } as never) // cfg 没回填不算就绪
    expect(n).toBe(1)
    useApp.setState({ cfgLoaded: true } as never)
    expect(n).toBe(2)
    off()
    useApp.setState({ connState: 'err' } as never)
    useApp.setState({ connState: 'ok' } as never)
    expect(n).toBe(2)
  })
})

describe('subscribeAgentStatus(Desk 伴随面 / ctx.tangu.subscribeAgentStatus 的变更过滤)', () => {
  // 契约同 subscribe:流式期间每个 token 都 set 一次 store,裸转发 = 把订阅插件按帧敲一遍。
  // 负对照(已实跑红):去掉 statusKey 比较(每次 refs 变了就回调)→「50 个 token 0 次回调」红;
  // 去掉 arm() 定时器 → 「余韵到期回落 idle」红;
  // statusRefs 退回不含 configBySession / newChatCfg 的老形状 → 「换会话的 Agent」「草稿的 Agent」两条红
  // (键里有 agentSlug 也没用 —— fire() 先在引用全等那一步早退了)。
  const T0 = 5_000_000
  const user = (id: string, ts: number): UiMessage => ({ id, role: 'user', content: 'hi', status: 'done', timestamp: ts })
  const asst = (over: Partial<UiMessage> = {}): UiMessage => ({ id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: T0 + 1, ...over })
  const run = (msg: UiMessage, extra: Record<string, unknown> = {}): void => useApp.setState({
    activeId: 's1',
    messagesBySession: { s1: [user('u1', T0), msg] },
    runningBySession: { s1: 'r1' },
    stoppingBySession: {},
    runStatsBySession: { s1: { runId: 'r1', startedAt: T0, tokens: 0, thinkMs: 0, thinkTracked: true } },
    llmRetryBySession: {},
    groupVoting: {},
    ...extra,
  } as never)
  const text = (s: string): Partial<UiMessage> => ({ content: s, segments: [{ t: 'text', text: s }] })

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 100 })
    installTanguProbe()
    run(asst())
  })
  afterEach(() => { vi.useRealTimers() })

  it('每次真变化响一次;token / 无关 set 不响;done 响一次、余韵到期再响一次;切会话响一次;退订后不响', () => {
    const p = readTangu()!
    expect(p.agentStatus!().phase).toBe('thinking')
    const seen: string[] = []
    const off = p.subscribeAgentStatus!((s) => { seen.push(s.tool ? `${s.phase}:${s.tool}` : s.phase) })

    for (let i = 0; i < 5; i++) useApp.setState({ toastMsg: `tick ${i}` } as never)
    expect(seen).toEqual([])

    run(asst(text('H')))
    expect(seen).toEqual(['speaking'])
    let body = 'H'
    for (let i = 0; i < 50; i++) { body += 'x'; run(asst(text(body))) }
    expect(seen).toEqual(['speaking']) // ← 50 个 token 增量 0 次回调
    expect(p.agentStatus!().textChars).toBe(51) // 拉取式照样拿得到最新字符数

    const tool = { id: 't1', name: 'read_file', done: false, startedAt: T0 + 200 }
    run(asst({ ...text(body), toolEvents: [tool], segments: [{ t: 'text', text: body }, { t: 'tools', ids: ['t1'] }] }))
    expect(seen).toEqual(['speaking', 'tool:read_file'])

    run(asst({ ...text(body), toolEvents: [tool], segments: [{ t: 'tools', ids: ['t1'] }],
      approvals: [{ approvalId: 'p1', runId: 'r1', name: 'read_file', preview: '', status: 'pending' }] }))
    expect(seen.at(-1)).toBe('waiting:read_file')

    // run 结束:消息 done + runStats.finishedAt + running 删除(endRun 的形状)
    const fin = Date.now()
    useApp.setState({
      messagesBySession: { s1: [user('u1', T0), asst({ ...text(body), status: 'done' })] },
      runningBySession: {},
      runStatsBySession: { s1: { runId: 'r1', startedAt: T0, tokens: 0, thinkMs: 0, thinkTracked: true, finishedAt: fin } },
    } as never)
    expect(seen.at(-1)).toBe('done')
    const n = seen.length
    vi.advanceTimersByTime(DONE_HOLD_MS - 100)
    expect(seen.length).toBe(n) // 余韵内不响
    vi.advanceTimersByTime(200)
    expect(seen.length).toBe(n + 1)
    expect(seen.at(-1)).toBe('idle')

    useApp.setState({ activeId: 's2', messagesBySession: { ...useApp.getState().messagesBySession, s2: [] } } as never)
    expect(seen.length).toBe(n + 2) // idle → idle,但 sessionId 变了 → 响
    expect(p.agentStatus!().sessionId).toBe('s2')

    off()
    run(asst(text('again')))
    vi.advanceTimersByTime(10_000)
    expect(seen.length).toBe(n + 2)
  })

  it('显式 null = 草稿:恒 idle,活动会话怎么变都不响', () => {
    const p = readTangu()!
    const seen: unknown[] = []
    const off = p.subscribeAgentStatus!((s) => seen.push(s), null)
    expect(p.agentStatus!(null)).toMatchObject({ phase: 'idle', sessionId: null })
    run(asst(text('Hello')))
    useApp.setState({ activeId: 's9' } as never)
    expect(seen).toEqual([])
    off()
  })

  // 2026-09-20:换 Agent 只动 configBySession(selectSessionAgent),statusRefs 里没有它的话
  // fire() 在「引用全等」那一步就早退了 —— 键里加了 agentSlug 也永远算不到。两头都得改。
  it('换会话的 Agent → 响一次并带上新 slug;只改名册里的展示名不响', () => {
    const p = readTangu()!
    useApp.setState({ defaultAgentSlug: 'xyra', agentDefs: [] } as never)
    expect(p.agentStatus!()).toMatchObject({ agentSlug: 'xyra' })
    const seen: Array<string | undefined> = []
    const off = p.subscribeAgentStatus!((s) => seen.push(s.agentSlug))

    useApp.setState({ configBySession: { s1: { agentSlug: 'muse' } } } as never)
    expect(seen).toEqual(['muse'])

    useApp.setState({ agentDefs: [{ slug: 'muse', name: 'Muse 2.0' }] } as never)
    expect(seen).toEqual(['muse']) // 只是改了展示名 → 不把插件叫醒
    expect(p.agentStatus!().agentName).toBe('Muse 2.0') // 拉取式照样是最新的
    off()
  })

  it('草稿(null)的 Agent 跟着新对话配置走,改了要响', () => {
    const p = readTangu()!
    useApp.setState({ defaultAgentSlug: 'xyra', newChatCfg: {} } as never)
    const seen: Array<string | undefined> = []
    const off = p.subscribeAgentStatus!((s) => seen.push(s.agentSlug), null)
    expect(p.agentStatus!(null)).toMatchObject({ phase: 'idle', sessionId: null, agentSlug: 'xyra' })
    useApp.setState({ newChatCfg: { agentSlug: 'muse' } } as never)
    expect(seen).toEqual(['muse'])
    off()
  })

  it('订阅那一刻正在 done 余韵里 → 到期照样回落一次', () => {
    const fin = Date.now() - 1000
    useApp.setState({
      messagesBySession: { s1: [user('u1', T0), asst({ ...text('ok'), status: 'done' })] },
      runningBySession: {},
      runStatsBySession: { s1: { runId: 'r1', startedAt: T0, tokens: 0, thinkMs: 0, thinkTracked: true, finishedAt: fin } },
    } as never)
    const p = readTangu()!
    expect(p.agentStatus!().phase).toBe('done')
    const seen: string[] = []
    const off = p.subscribeAgentStatus!((s) => seen.push(s.phase))
    vi.advanceTimersByTime(DONE_HOLD_MS)
    expect(seen).toEqual(['idle'])
    off()
  })

  it('插件回调抛错不冒进 store 的 set', () => {
    const off = readTangu()!.subscribeAgentStatus!(() => { throw new Error('plugin bug') })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => run(asst(text('x')))).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    off()
  })})

// 真 reducer 驱动(不是手搓 setState):done / error 的 reducer 先 patchMessage(气泡落定)、后 endRun(清 running),
// 两次 set 之间订阅者曾看到一个假 thinking(每个 run 收尾都冒)。团队 run 的成员占位气泡 activity = 任务句子,
// 曾被当成工具名 → 整个团队 run 报 tool:<任务>。
// 负对照(已实跑红):agentStatus.ts 去掉「刚落定气泡续 speaking」那条 return → done / error 两条红;
// tool 阶段退回从 work.activity 猜工具名 → 「团队成员占位」红;appStore 的 team_activity 不写 work.tool → 同一条红。
describe('subscribeAgentStatus × 真 reduceEvent', () => {
  const T0 = 6_000_000
  const ref = { current: 'a1' }
  let seq = 0
  const emit = (type: string, payload: Record<string, unknown> = {}): void =>
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: ++seq, type, payload } as AgentRunEvent)
  const label = (st: { phase: string; tool?: string }): string => (st.tool ? `${st.phase}:${st.tool}` : st.phase)

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 100 })
    // done 的 reducer 在「活动会话」分支里读 window.tangu(自动朗读);node 环境没有 window。
    vi.stubGlobal('window', {})
    installTanguProbe()
    ref.current = 'a1'
    useApp.setState({
      activeId: 's1',
      messagesBySession: { s1: [
        { id: 'u1', role: 'user', content: 'hi', status: 'done', timestamp: T0 },
        { id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: T0 + 1 },
      ] },
      runningBySession: { s1: 'r1' },
      stoppingBySession: {},
      runStatsBySession: { s1: { runId: 'r1', startedAt: T0, tokens: 0, thinkMs: 0, thinkTracked: true } },
      llmRetryBySession: {},
      groupVoting: {},
      usageBySession: {},
      steerPendingBySession: {},
      teamWorkBySession: {},
      authInfo: null,
    } as never)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  for (const [term, payload] of [['done', { content: 'Hello world' }], ['error', { error: 'boom' }]] as const) {
    it(`token → ${term}:speaking 之后直接 ${term},中间没有假 thinking`, () => {
      const seen: string[] = []
      const off = readTangu()!.subscribeAgentStatus!((st) => seen.push(label(st)), 's1')
      emit('reasoning', { delta: 'hmm' })
      emit('token', { delta: 'Hello' })
      emit('token', { delta: ' world' })
      expect(seen.at(-1)).toBe('speaking')
      emit(term, payload)
      off()
      const i = seen.lastIndexOf('speaking')
      expect(seen.slice(i)).toEqual(['speaking', term])
    })
  }

  it('团队成员占位(activity = 任务句子)报 thinking;team_activity 的工具才报 tool', () => {
    const seen: string[] = []
    const off = readTangu()!.subscribeAgentStatus!((st) => seen.push(label(st)), 's1')
    emit('team_member', { phase: 'start', slug: 'writer', name: 'Writer', messageId: 'm-w1', cycle: 1, sessionId: 'cs1', runId: 'cr1', task: '调研竞品并写一份对比报告' })
    emit('team_member', { phase: 'start', slug: 'coder', name: 'Coder', messageId: 'm-c1', cycle: 1, sessionId: 'cs2', runId: 'cr2', task: 'Implement the parser' })
    expect(readTangu()!.agentStatus!('s1')).toMatchObject({ phase: 'thinking', messageId: 'm-c1' })
    expect(seen.filter((x) => x.startsWith('tool'))).toEqual([])
    emit('team_activity', { slug: 'coder', name: 'Coder', messageId: 'm-c1', tool: 'web_search', argsPreview: '{"q":"x"}' })
    expect(seen.at(-1)).toBe('tool:web_search')
    // 展示文案照旧是「工具 + 参数」(EditorialMessage 渲染它),工具名单列
    const bubble = useApp.getState().messagesBySession.s1.find((m) => m.id === 'm-c1')
    expect(bubble?.work).toMatchObject({ tool: 'web_search', activity: 'web_search {"q":"x"}' })
    off()
  })
})

describe('startChat(ctx.tangu.startChat 的执行半;放行规则在 pluginStore)', () => {
  const openView = vi.fn()
  const send = vi.fn(async () => true)
  const refreshAgents = vi.fn()
  const def = (slug: string) => ({ slug, name: slug, description: '', model: '', tools: [] })

  beforeEach(() => {
    vi.useRealTimers()
    installTanguProbe()
    openView.mockReset()
    send.mockReset().mockResolvedValue(true)
    refreshAgents.mockReset()
    useWorkspace.setState({ openView } as never)
    useSpaceStore.setState({ activeSpaceId: 'tangu' })
    useApp.setState({
      activeId: 'old', sessions: [], agentDefs: [def('live3d-importer')], pendingDraft: null,
      newChatWs: null, newChatCfg: { thinkingLevel: 'low' }, newChatModel: 'm0', send, refreshAgents,
    } as never)
  })

  it('空 / 超长提示词 → ok:false,界面一动不动', async () => {
    const p = readTangu()!
    expect(await p.startChat!({ prompt: '   ' })).toMatchObject({ ok: false })
    expect(await p.startChat!({ prompt: 'x'.repeat(START_CHAT_MAX_PROMPT + 1) })).toMatchObject({ ok: false })
    expect(openView).not.toHaveBeenCalled()
    expect(useApp.getState().activeId).toBe('old')
  })

  it('不认识的 Agent:刷一次名册再等,仍没有 → ok:false 且不动界面', async () => {
    vi.useFakeTimers()
    const r = readTangu()!.startChat!({ agent: 'nope', prompt: 'hi' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await r).toEqual({ ok: false, error: 'unknown agent: nope' })
    expect(refreshAgents).toHaveBeenCalledTimes(1)
    expect(openView).not.toHaveBeenCalled()
    expect(useApp.getState().activeId).toBe('old')
  })

  it('名册晚到(插件刚装、捆绑 Agent 刚播种):刷回来就认', async () => {
    refreshAgents.mockImplementation(() => { setTimeout(() => useApp.setState({ agentDefs: [def('fresh')] } as never), 50) })
    const r = await readTangu()!.startChat!({ agent: 'fresh', prompt: 'hi' })
    expect(r).toEqual({ ok: true })
    expect(useApp.getState().newChatCfg.agentSlug).toBe('fresh')
  })

  it('预填:清成空白草稿 → 选 Agent → cwd 成本机工作区 → 主区开聊天 → 草稿进输入框;不送出', async () => {
    const r = await readTangu()!.startChat!({ agent: 'live3d-importer', prompt: '  Import this model  ', cwd: '/v/Live3D' })
    expect(r).toEqual({ ok: true })
    const s = useApp.getState()
    expect(s.activeId).toBeNull()
    expect(s.newChatCfg).toEqual({ agentSlug: 'live3d-importer' }) // 旧草稿配置(thinkingLevel: low)已清
    expect(s.newChatModel).toBeNull()
    expect(s.newChatWs).toEqual({ key: '/v/Live3D', name: 'Live3D', kind: 'local', path: '/v/Live3D' })
    expect(resolveNewSessionWorkspace(s, 'desktop')).toMatchObject({ kind: 'local', path: '/v/Live3D' }) // send() 建会话时就用它
    expect(s.pendingDraft).toBe('Import this model')
    expect(openView).toHaveBeenCalledWith('chat', { followActive: true, reuseKey: 'primary' }, 'main')
    expect(send).not.toHaveBeenCalled()
  })

  it('送出:send(prompt, [], …, null) 建新会话,返回新会话 id', async () => {
    send.mockImplementation(async () => {
      useApp.setState({ sessions: [{ id: 'new1', title: '', created_at: '', updated_at: '' }], activeId: 'new1' } as never)
      return true
    })
    const r = await readTangu()!.startChat!({ agent: 'live3d-importer', prompt: 'go', send: true })
    expect(r).toEqual({ ok: true, sessionId: 'new1' })
    expect(send).toHaveBeenCalledWith('go', [], undefined, undefined, undefined, null)
    expect(useApp.getState().pendingDraft).toBeNull()
  })

  it('送出失败(后端没连上等,send 已 toast)→ ok:false,不抛', async () => {
    send.mockResolvedValue(false)
    expect(await readTangu()!.startChat!({ prompt: 'go', send: true })).toEqual({ ok: false, error: 'send failed' })
    send.mockRejectedValue(new Error('boom'))
    expect(await readTangu()!.startChat!({ prompt: 'go', send: true })).toMatchObject({ ok: false })
  })

  it('等名册期间调用方已失活(插件被禁用)→ 不再动界面', async () => {
    let live = true
    refreshAgents.mockImplementation(() => { live = false; useApp.setState({ agentDefs: [def('late')] } as never) })
    const r = await readTangu()!.startChat!({ agent: 'late', prompt: 'hi', alive: () => live })
    expect(r).toEqual({ ok: false, error: 'plugin disabled' })
    expect(openView).not.toHaveBeenCalled()
    expect(useApp.getState().activeId).toBe('old')
  })

  it('站在主页 Space 时先切回 Tangu(主页没有聊天主区)—— 只断言判据,切换本身是 setActiveSpace 的事', async () => {
    // setActiveSpace 会真去搭布局,node 里不跑;这里只钉「不在主页就不切」。
    useSpaceStore.setState({ activeSpaceId: 'amadeus' })
    await readTangu()!.startChat!({ prompt: 'hi' })
    expect(useSpaceStore.getState().activeSpaceId).toBe('amadeus')
  })
})
