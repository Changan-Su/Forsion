/**
 * 会话配置 setter 只写自己的键(服务端按键合并):整对象写回会把本地缓存里别的键的旧值一起盖回去 ——
 * 另一个窗口刚收紧的审批档,被这里改个思考档 / 计划模式就悄悄放宽了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from './appStore'

const patchMock = vi.hoisted(() => vi.fn())
const putMock = vi.hoisted(() => vi.fn())
vi.mock('../services/backendService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  patchSessionConfig: (...a: unknown[]) => patchMock(...a),
  putSessionConfig: (...a: unknown[]) => putMock(...a),
}))

const g = globalThis as any
const sent = () => patchMock.mock.calls.map((c) => [c[1], c[2]])

describe('会话配置 setter 只发自己的键', () => {
  beforeEach(() => {
    g.window = {} // rememberDefaults 摸 window.tangu
    patchMock.mockReset().mockResolvedValue({})
    putMock.mockReset().mockResolvedValue({})
    useApp.setState({
      pushNotice: vi.fn(), agentDefs: [],
      configBySession: { s1: { execMode: 'host', cwd: '/p', approvalMode: 'full-auto', groupChat: true, groupAgents: ['a', 'b'], agentSlug: 'a' } },
    })
  })
  afterEach(() => { delete g.window })

  it('思考档 / 计划模式 / 最大轮数:只带那一个键', () => {
    // 计划模式只在不是团队模式的会话里开得了(见下一组),这里换一个普通会话
    useApp.setState((s) => ({ configBySession: { ...s.configBySession, s2: { execMode: 'host', cwd: '/p', approvalMode: 'full-auto', agentSlug: 'a' } } }))
    const st = useApp.getState()
    st.setSessionThinking('high', 's1', false)
    st.setSessionPlanMode(true, 's2')
    st.setSessionMaxIterations(20, 's1')
    expect(sent()).toEqual([['s1', { thinkingLevel: 'high' }], ['s2', { planMode: true }], ['s1', { maxIterations: 20 }]])
    expect(putMock).not.toHaveBeenCalled()
  })

  // 10-05 用户定「团队模式不能开计划模式」(成员各跑各的,不吃会话上的计划模式)。规矩在 patchSessionConfig / setNewChatCfg 一处结算。
  describe('团队模式下没有计划模式', () => {
    const notices = () => (useApp.getState().pushNotice as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])

    it('团队会话里开计划模式:不发、本地不变、说明原因', () => {
      useApp.getState().setSessionPlanMode(true, 's1')
      expect(sent()).toEqual([])
      expect(useApp.getState().configBySession.s1.planMode).toBeUndefined()
      expect(notices()).toEqual(['团队模式下不能开计划模式'])
    })

    it('开团队时计划模式开着:同一笔里关掉并说一声;之后关掉团队,计划模式不会自己回来', () => {
      useApp.setState({ configBySession: { s3: { execMode: 'host', planMode: true } } })
      useApp.getState().setSessionGroup({ groupChat: true, groupAgents: ['a', 'b'] }, 's3')
      expect(sent()).toEqual([['s3', { groupChat: true, groupAgents: ['a', 'b'], planMode: false }]])
      expect(useApp.getState().configBySession.s3).toMatchObject({ groupChat: true, planMode: false })
      expect(notices()).toEqual(['计划模式已关闭：团队模式下不能用'])
      useApp.getState().setSessionGroup({ groupChat: false }, 's3')
      expect(useApp.getState().configBySession.s3).toMatchObject({ groupChat: false, planMode: false })
    })

    it('团队轨道会话缺省就是团队模式;切回普通模式后计划模式照开', () => {
      useApp.setState({ configBySession: { s4: { execMode: 'host', teamSlug: 'crew' } } })
      useApp.getState().setSessionPlanMode(true, 's4')
      expect(sent()).toEqual([])
      useApp.getState().setSessionGroup({ groupChat: false }, 's4')
      useApp.getState().setSessionPlanMode(true, 's4')
      expect(useApp.getState().configBySession.s4.planMode).toBe(true)
      expect(sent()).toEqual([['s4', { groupChat: false }], ['s4', { planMode: true }]])
    })

    it('老会话存着两个都开:碰到别的键时顺手关掉,不打扰', () => {
      useApp.setState({ configBySession: { s5: { execMode: 'host', groupChat: true, groupAgents: ['a', 'b'], planMode: true } } })
      useApp.getState().setSessionMaxIterations(20, 's5')
      expect(sent()).toEqual([['s5', { maxIterations: 20, planMode: false }]])
      expect(notices()).toEqual([])
    })

    it('同一笔里还带着别的键:只有计划模式那一键不作数', () => {
      useApp.getState().patchSessionConfig({ planMode: true, maxIterations: 9 }, 's1')
      expect(sent()).toEqual([['s1', { maxIterations: 9 }]])
      expect(useApp.getState().configBySession.s1).toMatchObject({ maxIterations: 9 })
      expect(useApp.getState().configBySession.s1.planMode).toBeUndefined()
    })

    // 同一笔里删掉团队键(undefined 上线为 null = 删键)再开计划模式:引擎那边删完键就不是团队模式了,两边都放行、不分叉
    it('同一笔里退出团队(删键)并开计划模式:放行,与引擎合并后的结果一致', () => {
      useApp.getState().patchSessionConfig({ groupChat: undefined, planMode: true }, 's1')
      expect(sent()).toEqual([['s1', { groupChat: undefined, planMode: true }]])
      expect(useApp.getState().configBySession.s1).toMatchObject({ planMode: true })
      expect(useApp.getState().configBySession.s1.groupChat).toBeUndefined()
      expect(notices()).toEqual([])
    })

    it('草稿同一条规矩:团队草稿里开不了;开团队时顺手关掉', () => {
      const toast = vi.fn()
      useApp.setState({ toast, newChatCfg: { groupChat: true, groupAgents: ['a', 'b'] } })
      useApp.getState().setNewChatCfg((c) => ({ ...c, planMode: true }))
      expect(useApp.getState().newChatCfg.planMode).toBe(false)
      expect(toast.mock.calls.map((c) => c[0])).toEqual(['团队模式下不能开计划模式'])
      useApp.setState({ newChatCfg: { planMode: true } })
      useApp.getState().setNewChatCfg((c) => ({ ...c, groupChat: true, groupAgents: ['a', 'b'] }))
      expect(useApp.getState().newChatCfg).toMatchObject({ groupChat: true, planMode: false })
      expect(toast.mock.calls.map((c) => c[0])).toEqual(['团队模式下不能开计划模式', '计划模式已关闭：团队模式下不能用'])
      // 不相干的改动不结算、不提示
      useApp.setState({ newChatCfg: { planMode: true } })
      useApp.getState().setNewChatCfg((c) => ({ ...c, maxIterations: 5 }))
      expect(useApp.getState().newChatCfg).toEqual({ planMode: true, maxIterations: 5 })
      expect(toast).toHaveBeenCalledTimes(2)
    })
  })

  it('Ultra:开 = thinkingLevel max + ultra true 一起发;显式换别的档 = 连带删 ultra 键;调用方没表态的 max 不碰 ultra', () => {
    const st = useApp.getState()
    st.setSessionThinking('max', 's1', false, true)
    expect(useApp.getState().configBySession.s1).toMatchObject({ thinkingLevel: 'max', ultra: true })
    st.setSessionThinking('high', 's1', false)
    st.setSessionThinking('max', 's1', false)
    const calls = patchMock.mock.calls.map((c) => c[2])
    expect(calls[0]).toStrictEqual({ thinkingLevel: 'max', ultra: true })
    expect(calls[1]).toHaveProperty('ultra', undefined) // 上线为 null:引擎那边 ultra 会压过 thinkingLevel,不删就等于没换档
    expect(calls[1]).toMatchObject({ thinkingLevel: 'high' })
    expect(calls[2]).toStrictEqual({ thinkingLevel: 'max' }) // 换 Agent 带来的同档:不许顺手关掉用户开的 Ultra
    expect(useApp.getState().configBySession.s1.ultra).toBeUndefined()
  })

  it('切 Chat / Work:草稿里的档位与 Ultra 一起丢掉(留着的 ultra:false 会挡住目标槽的 lastUltra)', () => {
    useApp.setState({ newChatCfg: { thinkingLevel: 'high', ultra: false, agentSlug: 'a' } })
    useApp.getState().setSessionMode('work')
    expect(useApp.getState().newChatCfg).toEqual({ agentSlug: 'a' })
  })

  it('切外部引擎:连带清掉的键以 undefined 送去(上线为 null = 删键),本地同步清掉', () => {
    useApp.getState().setSessionEngine('codex', 's1')
    expect(sent()).toEqual([['s1', { engineId: 'codex', engineModelId: undefined, groupChat: false, groupAgents: undefined, agentSlug: undefined }]])
    expect(useApp.getState().configBySession.s1).toMatchObject({ engineId: 'codex', groupChat: false, approvalMode: 'full-auto' })
  })

  it('setExecConfig 只发变了的键(审批档照发);什么都没变就不写', () => {
    const st = useApp.getState()
    st.setExecConfig({ execMode: 'host', approvalMode: 'readonly', cwd: '/p' }, 's1')
    st.setExecConfig({ execMode: 'host', cwd: '/p' }, 's1')
    expect(sent()).toEqual([['s1', { approvalMode: 'readonly' }]])
  })

  it('老引擎回落 PUT 时拿的是本地最新整对象', () => {
    useApp.getState().setSessionMaxIterations(20, 's1')
    const full = patchMock.mock.calls[0][3] as () => unknown
    expect(full()).toMatchObject({ maxIterations: 20, approvalMode: 'full-auto', groupAgents: ['a', 'b'] })
  })
})
