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
    const st = useApp.getState()
    st.setSessionThinking('high', 's1', false)
    st.setSessionPlanMode(true, 's1')
    st.setSessionMaxIterations(20, 's1')
    expect(sent()).toEqual([['s1', { thinkingLevel: 'high' }], ['s1', { planMode: true }], ['s1', { maxIterations: 20 }]])
    expect(putMock).not.toHaveBeenCalled()
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
    useApp.getState().setSessionPlanMode(true, 's1')
    const full = patchMock.mock.calls[0][3] as () => unknown
    expect(full()).toMatchObject({ planMode: true, approvalMode: 'full-auto', groupAgents: ['a', 'b'] })
  })
})
