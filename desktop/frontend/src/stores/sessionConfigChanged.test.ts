/**
 * session_config_changed(agent 经 update_session_settings 改本会话模型 / 思考档):引擎已落库,桌面只同步本地缓存。
 * 钉的病理:桌面每次 run 都拿**自己 store 里**的 model_id / agent_config 起跑 —— 不同步,下一条消息就把引擎刚写的值盖回去,
 * 用户看到「Agent 说切了,药丸没动,下一轮又是旧模型」。另两条红线:不写 API(引擎已写,再写一次会和用户并发改互踩),
 * 不动全局默认 cfg.modelId(agent 改一个会话不该改掉用户新会话的默认模型)。
 * 第二条病理(回放):事件存库、重新订阅从 seq 0 回放 —— 落到本地的必须是**引擎现值**,不是载荷,否则 agent 早先那笔
 * 会盖过用户之后在药丸上的改动。所以处理器是「载荷≠本地 → 读引擎 → 套引擎值;引擎值==载荷才提示」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent } from '../types'
import { useApp } from './appStore'
import { useChildChat } from './childChatStore'

const updateSessionMock = vi.hoisted(() => vi.fn())
const patchSessionConfigMock = vi.hoisted(() => vi.fn())
const getSessionDetailMock = vi.hoisted(() => vi.fn())
const getSessionConfigMock = vi.hoisted(() => vi.fn())
const startRunMock = vi.hoisted(() => vi.fn())
vi.mock('../services/backendService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  updateSession: (...a: unknown[]) => updateSessionMock(...a),
  patchSessionConfig: (...a: unknown[]) => patchSessionConfigMock(...a),
  getSessionDetail: (...a: unknown[]) => getSessionDetailMock(...a),
  getSessionConfig: (...a: unknown[]) => getSessionConfigMock(...a),
}))
vi.mock('../services/agentRunService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startRun: (...a: unknown[]) => startRunMock(...a),
}))

const g = globalThis as any
const initial = useApp.getState()
const initialChild = useChildChat.getState()
const toast = vi.fn()
const setConfig = vi.fn()
const emit = (payload: Record<string, unknown>, sid = 's1', runId = 'r1') =>
  useApp.getState().reduceEvent(sid, runId, { current: 'a1' }, { seq: 1, type: 'session_config_changed', payload } as AgentRunEvent)
// 对账是异步的(读引擎);mock 都是立即 resolve,一个宏任务就把微任务链排空
const flush = () => new Promise((r) => setTimeout(r, 0))
/** 引擎现值:默认 = 「agent 这笔仍是最新」(读回来就是载荷)。个别用例改写成用户后来的值 / 读失败。 */
let engine: { model_id: string; config: Record<string, unknown> }
const session = (id: string, model_id: string) => ({ id, title: id, model_id }) as never
const ctx = (modelId: string) => ({ modelId, ctxWindow: 200_000, ctxWindowSource: 'default', sections: [], files: [], filesTruncated: false, historyCount: 0, historyTokens: 0 }) as never

beforeEach(() => {
  g.window = { tangu: { setConfig } }
  updateSessionMock.mockReset().mockResolvedValue({})
  patchSessionConfigMock.mockReset().mockResolvedValue({})
  engine = { model_id: 'anthropic/opus', config: { execMode: 'host', cwd: '/p', thinkingLevel: 'high' } }
  getSessionDetailMock.mockReset().mockImplementation(async (_c: unknown, id: string) => ({ id, title: id, model_id: engine.model_id }))
  getSessionConfigMock.mockReset().mockImplementation(async () => engine.config)
  startRunMock.mockReset().mockRejectedValue(new Error('stop here')) // 只看起跑参数
  toast.mockReset()
  setConfig.mockReset()
  useChildChat.setState(initialChild, true)
  useApp.setState(initial, true)
  useApp.setState({
    toast,
    tr: (k, v) => (v ? `${k} ${JSON.stringify(v)}` : k),
    cfg: { ...initial.cfg, modelId: 'global-default' },
    modelsResp: { models: [{ id: 'anthropic/opus', name: 'Opus', provider: 'anthropic', source: 'direct' }], directProviders: [], defaultModelId: null },
    activeId: 's1',
    sessions: [session('s1', 'openai/old'), session('s3', 'openai/old')],
    archivedSessions: [session('s2', 'openai/old')],
    configBySession: { s1: { execMode: 'host', cwd: '/p', thinkingLevel: 'low' } },
    ctxInfoBySession: { s1: ctx('openai/old'), s3: ctx('openai/old') },
    messagesBySession: { s1: [] },
    runningBySession: { s1: 'r1' }, // reduceEvent 按 runningBySession 认领事件,不种就整条静默丢弃
  })
})
afterEach(() => { delete g.window })

describe('session_config_changed', () => {
  it('换模型:会话行改写 + 作废本会话 ctx 环 + 提示;不落库、不动全局默认', async () => {
    emit({ sessionId: 's1', modelId: 'anthropic/opus', source: 'agent' })
    await flush()
    const s = useApp.getState()
    expect(s.sessions.find((x) => x.id === 's1')?.model_id).toBe('anthropic/opus')
    expect(s.sessions.find((x) => x.id === 's3')?.model_id).toBe('openai/old')
    expect(s.ctxInfoBySession.s1).toBeUndefined()
    expect(s.ctxInfoBySession.s3).toBeDefined()
    expect(s.cfg.modelId).toBe('global-default')
    expect(setConfig).not.toHaveBeenCalled()
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toBe('appstore.agentSwitchedModel {"model":"Opus"}') // 目录里有名字就报名字
  })

  it('改思考档:只合并 thinkingLevel 键,其余配置原样;不落库', async () => {
    engine.config = { thinkingLevel: 'high', approvalMode: 'full-auto' } // 引擎整份里的别的键不许顺手灌进本地
    emit({ sessionId: 's1', thinkingLevel: 'high', source: 'agent' })
    await flush()
    expect(useApp.getState().configBySession.s1).toEqual({ execMode: 'host', cwd: '/p', thinkingLevel: 'high' })
    expect(patchSessionConfigMock).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toBe('appstore.agentSetThinking {"level":"input.thinkingShort.high"}')
  })

  it('端到端:同步后的下一条消息按 agent 改的模型 / 思考档起跑(不同步 = 被桌面旧值盖回)', async () => {
    engine.config = { thinkingLevel: 'max' }
    emit({ sessionId: 's1', modelId: 'anthropic/opus', thinkingLevel: 'max', source: 'agent' })
    await flush()
    useApp.setState({ runningBySession: {} }) // 本轮 run 已结束
    await useApp.getState().send('next', [])
    expect(startRunMock).toHaveBeenCalledTimes(1)
    const req = startRunMock.mock.calls[0][1]
    expect(req.modelId).toBe('anthropic/opus')
    expect(req.agentConfig.thinkingLevel).toBe('max')
  })

  it('载荷里的 sessionId 优先于 run 所在会话(归档行 / 子聊天缓存一并改)', async () => {
    useChildChat.getState().remember({ id: 's2', title: 's2', model_id: 'openai/old' } as never)
    emit({ sessionId: 's2', modelId: 'anthropic/opus', source: 'agent' })
    await flush()
    expect(getSessionDetailMock.mock.calls[0][1]).toBe('s2')
    const s = useApp.getState()
    expect(s.archivedSessions.find((x) => x.id === 's2')?.model_id).toBe('anthropic/opus')
    expect(useChildChat.getState().sessions.s2?.model_id).toBe('anthropic/opus')
    expect(s.sessions.find((x) => x.id === 's1')?.model_id).toBe('openai/old')
    expect(s.ctxInfoBySession.s1).toBeDefined()
  })

  it('没有 sessionId 就落在 run 自己的会话;目录里没有的模型报 id', async () => {
    engine.model_id = 'x/unknown'
    emit({ modelId: 'x/unknown', source: 'agent' })
    await flush()
    expect(useApp.getState().sessions.find((x) => x.id === 's1')?.model_id).toBe('x/unknown')
    expect(toast.mock.calls[0][0]).toBe('appstore.agentSwitchedModel {"model":"x/unknown"}')
  })

  it('畸形载荷 / 值未变(重放)→ 不读引擎、什么都不动、不提示;没有会话配置时不凭空造残缺条目', async () => {
    emit({ sessionId: 's1', modelId: 42, thinkingLevel: 'ultra-mega' })
    emit({ sessionId: 's1', modelId: 'openai/old', thinkingLevel: 'low' }) // 与现值相同
    emit({ sessionId: 's3', thinkingLevel: 'high' }) // s3 本地没有配置(列表行也没带 agent_config)
    await flush()
    expect(getSessionDetailMock).not.toHaveBeenCalled()
    expect(getSessionConfigMock).not.toHaveBeenCalled()
    const s = useApp.getState()
    expect(s.sessions.find((x) => x.id === 's1')?.model_id).toBe('openai/old')
    expect(s.configBySession.s1.thinkingLevel).toBe('low')
    expect(s.configBySession.s3).toBeUndefined()
    expect(s.ctxInfoBySession.s1).toBeDefined()
    expect(toast).not.toHaveBeenCalled()
  })

  it('本地没有配置但列表行带了 agent_config → 以它为底合并,不丢其余键', async () => {
    useApp.setState({ sessions: [{ id: 's3', title: 's3', model_id: 'openai/old', agent_config: { execMode: 'sandbox', preset: 'chat' } } as never] })
    engine.config = { thinkingLevel: 'medium' }
    emit({ sessionId: 's3', thinkingLevel: 'medium' })
    await flush()
    expect(useApp.getState().configBySession.s3).toEqual({ execMode: 'sandbox', preset: 'chat', thinkingLevel: 'medium' })
  })

  it('迟到的旧 run 事件不认领', async () => {
    emit({ sessionId: 's1', modelId: 'anthropic/opus' }, 's1', 'stale-run')
    await flush()
    expect(useApp.getState().sessions.find((x) => x.id === 's1')?.model_id).toBe('openai/old')
    expect(toast).not.toHaveBeenCalled()
  })

  it('⚠️回放:agent 早先那笔(B)已被用户后来的改动(C)盖过 → 套引擎现值 C,不提示、不回退到 B', async () => {
    // 场景:run 里 agent 切到 B、用户随后在药丸上切回 C(库里 = C);重启 / 第二个窗口从 seq 0 重新订阅,回放出 B。
    // 本地此刻是从库里读的 C → 载荷 B ≠ 本地 C。直接套载荷 = 药丸跳回 B + 下一次 send 按 B 起跑,把用户的选择盖掉。
    useApp.setState({ sessions: [session('s1', 'user/c')], configBySession: { s1: { execMode: 'host', thinkingLevel: 'xhigh' } } })
    engine = { model_id: 'user/c', config: { thinkingLevel: 'xhigh' } }
    emit({ sessionId: 's1', modelId: 'anthropic/opus', thinkingLevel: 'high', source: 'agent' })
    await flush()
    const s = useApp.getState()
    expect(s.sessions.find((x) => x.id === 's1')?.model_id).toBe('user/c')
    expect(s.configBySession.s1.thinkingLevel).toBe('xhigh')
    expect(toast).not.toHaveBeenCalled()
    useApp.setState({ runningBySession: {} })
    await useApp.getState().send('next', [])
    expect(startRunMock.mock.calls[0][1].modelId).toBe('user/c')
    expect(startRunMock.mock.calls[0][1].agentConfig.thinkingLevel).toBe('xhigh')
  })

  it('本地落后、引擎是另一个更新的值 → 跟引擎走,但不冒充「agent 改的」来提示', async () => {
    engine = { model_id: 'other/newer', config: { thinkingLevel: 'max' } }
    emit({ sessionId: 's1', modelId: 'anthropic/opus', thinkingLevel: 'high' })
    await flush()
    expect(useApp.getState().sessions.find((x) => x.id === 's1')?.model_id).toBe('other/newer')
    expect(useApp.getState().configBySession.s1.thinkingLevel).toBe('max')
    expect(toast).not.toHaveBeenCalled()
  })

  it('读引擎期间用户在药丸上改了 → 用户赢(读回来的值比用户这笔旧)', async () => {
    let release!: () => void
    getSessionDetailMock.mockImplementation(() => new Promise((r) => { release = () => r({ id: 's1', title: 's1', model_id: 'anthropic/opus' }) }))
    emit({ sessionId: 's1', modelId: 'anthropic/opus' })
    await flush()
    useApp.getState().setSessionModel('user/pick', 's1', false)
    release()
    await flush()
    expect(useApp.getState().sessions.find((x) => x.id === 's1')?.model_id).toBe('user/pick')
    expect(toast).not.toHaveBeenCalled()
  })

  it('读引擎失败(老引擎 / 断连)→ 退回套载荷,别把同步整个丢了', async () => {
    getSessionDetailMock.mockRejectedValue(new Error('404'))
    getSessionConfigMock.mockRejectedValue(new Error('404'))
    emit({ sessionId: 's1', modelId: 'anthropic/opus', thinkingLevel: 'high' })
    await flush()
    expect(useApp.getState().sessions.find((x) => x.id === 's1')?.model_id).toBe('anthropic/opus')
    expect(useApp.getState().configBySession.s1.thinkingLevel).toBe('high')
    expect(toast).toHaveBeenCalledTimes(2)
  })

  it('改的是后台会话(不是眼前这个)→ 提示点名会话标题,不说「本会话」', async () => {
    useApp.setState({ activeId: 's3', runningBySession: { s1: 'r1' } })
    engine.config = { thinkingLevel: 'high' }
    emit({ sessionId: 's1', modelId: 'anthropic/opus', thinkingLevel: 'high' })
    await flush()
    expect(toast.mock.calls.map((c) => c[0])).toEqual([
      'appstore.agentSwitchedModelIn {"model":"Opus","title":"s1"}',
      'appstore.agentSetThinkingIn {"level":"input.thinkingShort.high","title":"s1"}',
    ])
  })
})
