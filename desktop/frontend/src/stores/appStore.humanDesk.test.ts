/** Human Desk × 真 store 动作:右边一次只展开一块、Agent 不抢(只亮点)、离开满时长自动暂停、放上来就切过去。
 *  纯决策在 humanDeskPlan.test.ts;这里钉 store 把它们接对了(deskPresent / deskAutoShow / patchDesk / deskShowFile 这几处)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent } from '../types'
const service = vi.hoisted(() => ({ subscribe: vi.fn(), stop: vi.fn(), active: vi.fn(), messages: vi.fn() }))
vi.mock('../services/agentRunService', async (original) => ({
  ...await original<typeof import('../services/agentRunService')>(),
  subscribeRunEvents: service.subscribe, abortRunAndWait: service.stop, listActiveRuns: service.active,
}))
vi.mock('../services/backendService', async (original) => ({
  ...await original<typeof import('../services/backendService')>(), listMessages: service.messages,
}))
import { useApp } from './appStore'
import { abortAllTanguRuns } from '../tangu/store/tanguSlice'
import { deskItemFor } from './deskPlan'
import { HUMAN_DESK_PAUSE_MS, deskSideOf, humanWatching } from './humanDeskPlan'
import '../tangu/store/standalone'

const SID = 'hd-session'
const initial = useApp.getState()
const note = deskItemFor('/v/定价调研.md', 1)
const csv = deskItemFor('/p/竞品价格.csv', 2)
const side = () => deskSideOf(useApp.getState().deskBySession[SID]?.mode, useApp.getState().humanDeskBySession[SID]?.open)
const human = () => useApp.getState().humanDeskBySession[SID]
const agentDesk = () => useApp.getState().deskBySession[SID]
let receive: (event: AgentRunEvent) => void
let seq = 0
const emit = (type: string, payload: unknown = {}) => receive({ seq: ++seq, type, payload })

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); seq = 0
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  useApp.setState(initial, true)
  useApp.setState({ activeId: SID, tr: (k) => k, toast: vi.fn(), desktopConfig: { agentDeskEnabled: true } as never,
    messagesBySession: { [SID]: [{ id: 'a', role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }] },
    configBySession: { [SID]: { execMode: 'host', cwd: '/p' } as never },
    deskBySession: { [SID]: { items: [csv], size: 'half' } }, humanDeskBySession: {}, runningBySession: {}, stoppingBySession: {},
  })
  service.subscribe.mockImplementation((_t, _r, callback, signal: AbortSignal) => {
    receive = callback
    return new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }) })
  })
  service.stop.mockResolvedValue('aborted'); service.active.mockResolvedValue([]); service.messages.mockResolvedValue([])
})
afterEach(async () => { abortAllTanguRuns(); await Promise.resolve(); useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Human Desk × 真 store', () => {
  it('放上来 = 开始在看 + 右边切到 Human Desk(Agent Desk 原来展开着也收回)', () => {
    useApp.getState().patchDesk(SID, { mode: 'open' })
    expect(side()).toBe('agent')
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    expect(side()).toBe('human')
    expect(agentDesk().mode).toBeUndefined()
    expect(humanWatching(human())).toBe(true)
  })

  it('一次只展开一块:切到 Agent → Human 收回;再切回来 → Agent 收回', () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    useApp.getState().setDeskSide(SID, 'agent')
    expect(side()).toBe('agent')
    expect(human().open).toBeUndefined()
    useApp.getState().setDeskSide(SID, 'human')
    expect(side()).toBe('human')
    expect(agentDesk().mode).toBeUndefined()
    useApp.getState().setDeskSide(SID, null)
    expect(side()).toBeNull()
  })

  it('Agent 不抢:Human Desk 展开时 desk_present 带 half / wide 不撑开,只亮点;切过去点灭', () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    useApp.getState().deskPresent(SID, { views: [{ type: 'file', path: '/p/摘录.md' }], size: 'wide' })
    expect(side()).toBe('human')
    expect(agentDesk().mode).toBeUndefined()
    expect(agentDesk().items.map((x) => x.path)).toEqual(['/p/摘录.md']) // 东西照样放进 Agent Desk
    expect(human().agentDot).toBe(true)
    useApp.getState().setDeskSide(SID, 'agent')
    expect(human().agentDot).toBeUndefined()
  })

  it('两块都收着时 Agent 撑开照今天的规矩(展开 Agent Desk)', () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    useApp.getState().setDeskSide(SID, null)
    useApp.getState().deskPresent(SID, { views: [{ type: 'file', path: '/p/摘录.md' }], size: 'half' })
    expect(side()).toBe('agent')
    expect(human().agentDot).toBeUndefined()
  })

  it('Agent 写文件自动上台:Human Desk 展开时只亮点', async () => {
    useApp.getState().subscribeRun(SID, 'hd-run', 'a')
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    const args = JSON.stringify({ path: 'report.md', content: 'x' })
    emit('tool_call', { id: 'w1', name: 'write_file', arguments: args })
    emit('tool_result', { id: 'w1', result: 'ok', isError: false })
    await vi.advanceTimersByTimeAsync(50)
    expect(agentDesk().items[0].path).toBe('/p/report.md')
    expect(side()).toBe('human')
    expect(human().agentDot).toBe(true)
  })

  it('你点的引用(deskShowFile)= 你的动作:换成 Agent Desk', () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    useApp.getState().deskShowFile(SID, '/p/竞品价格.csv')
    expect(side()).toBe('agent')
  })

  it('切走满一分钟自动暂停;回来接着看;来回切不重新计时', async () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    useApp.getState().setDeskSide(SID, 'agent')
    await vi.advanceTimersByTimeAsync(HUMAN_DESK_PAUSE_MS / 2)
    useApp.getState().setDeskSide(SID, null) // 从 Agent 收起:还是「不在 Human Desk」,不重新计时
    expect(humanWatching(human())).toBe(true)
    await vi.advanceTimersByTimeAsync(HUMAN_DESK_PAUSE_MS / 2 + 10)
    expect(human().paused).toBe(true)
    expect(humanWatching(human())).toBe(false)
    useApp.getState().setDeskSide(SID, 'human')
    expect(humanWatching(human())).toBe(true)
  })

  it('不到时长就回来 → 不暂停', async () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    useApp.getState().setDeskSide(SID, null)
    await vi.advanceTimersByTimeAsync(HUMAN_DESK_PAUSE_MS - 1000)
    useApp.getState().setDeskSide(SID, 'human')
    await vi.advanceTimersByTimeAsync(HUMAN_DESK_PAUSE_MS * 2)
    expect(human().paused).toBeUndefined()
  })

  it('停止 / 继续看;卡片上点「继续看」(人不在 Human Desk 上)也撤掉自动暂停、重新起表', async () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    useApp.getState().humanDeskAct(SID, { type: 'stop' })
    expect(humanWatching(human())).toBe(false)
    useApp.getState().setDeskSide(SID, null)
    await vi.advanceTimersByTimeAsync(HUMAN_DESK_PAUSE_MS + 10)
    expect(human().paused).toBeUndefined() // 停着的不计时
    useApp.getState().humanDeskAct(SID, { type: 'resume' })
    expect(humanWatching(human())).toBe(true)
    await vi.advanceTimersByTimeAsync(HUMAN_DESK_PAUSE_MS + 10)
    expect(human().paused).toBe(true)
    useApp.getState().humanDeskAct(SID, { type: 'resume' })
    expect(humanWatching(human())).toBe(true)
  })

  it('插件工具卡:Agent 自动放进 Desk 时 Human Desk 展开着 → 不撑开、只亮点;你点「放到 Desk」照样切过去', async () => {
    const { showToolCardInDesk } = await import('../components/PluginToolCard')
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    showToolCardInDesk(SID, 'c1', 'card', true)
    expect(side()).toBe('human')
    expect(agentDesk().items.some((x) => x.tool?.callId === 'c1')).toBe(true)
    expect(human().agentDot).toBe(true)
    showToolCardInDesk(SID, 'c2', 'card 2', false)
    expect(side()).toBe('agent')
    expect(human().agentDot).toBeUndefined()
  })

  it('Human Desk 的状态不进 deskBySession', () => {
    useApp.getState().humanDeskAct(SID, { type: 'put', item: note })
    expect(JSON.stringify(agentDesk())).not.toContain('定价调研')
  })
})
