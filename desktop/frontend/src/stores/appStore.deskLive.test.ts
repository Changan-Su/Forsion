/** Agent Desk 直播 × 真 store 动作:分段流出的路径 → 直播中点下格引用只变 mode → 1.5 秒内落盘接棒。
 *  纯决策在 deskPlan.test.ts;这里钉 store 动作把它们接对了(deskLiveSync / deskShowFile / deskAutoShow 的节流豁免)。 */
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
import '../tangu/store/standalone'

const SID = 'desk-session'
const initial = useApp.getState()
let receive: (event: AgentRunEvent) => void
let seq = 0
const emit = (type: string, payload: unknown = {}) => receive({ seq: ++seq, type, payload })
const notes = deskItemFor('/p/notes.txt', 1)
const report = deskItemFor('/p/report.md', 2)
const desk = () => useApp.getState().deskBySession[SID]
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); seq = 0
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  useApp.setState(initial, true)
  useApp.setState({ activeId: SID, tr: (k) => k, toast: vi.fn(), desktopConfig: { agentDeskEnabled: true } as never,
    messagesBySession: { [SID]: [{ id: 'a', role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }] },
    configBySession: { [SID]: { execMode: 'host', cwd: '/p' } as never },
    deskBySession: { [SID]: { items: [notes, report], size: 'half' } }, runningBySession: {}, stoppingBySession: {},
  })
  service.subscribe.mockImplementation((_t, _r, callback, signal: AbortSignal) => {
    receive = callback
    return new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }) })
  })
  service.stop.mockResolvedValue('aborted'); service.active.mockResolvedValue([]); service.messages.mockResolvedValue([])
  useApp.getState().subscribeRun(SID, 'desk-run', 'a')
})
afterEach(async () => { abortAllTanguRuns(); await Promise.resolve(); useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Agent Desk 直播 × 真 store', () => {
  it('分段路径 → 点下格引用只变 mode → 1.5 秒内落盘 = [report(新), notes]', async () => {
    const args = JSON.stringify({ path: 'report.md', content: 'new body' })
    const cut = args.indexOf('report.md') + 3 // 切在路径中间:"rep" | "ort.md"…
    emit('tool_stream', { id: 'w1', name: 'write_file', delta: args.slice(0, cut) })
    await vi.advanceTimersByTimeAsync(50)
    expect(desk().items.map((x) => [x.path, !!x.live])).toEqual([['', true], ['/p/report.md', false]]) // 半截路径不认
    emit('tool_stream', { id: 'w1', name: 'write_file', delta: args.slice(cut) })
    await vi.advanceTimersByTimeAsync(50)
    expect(desk().items.map((x) => [x.path, !!x.live])).toEqual([['/p/report.md', true], ['/p/notes.txt', false]])
    const before = desk().items
    useApp.getState().deskShowFile(SID, '/p/notes.txt')
    expect(desk().items).toBe(before) // 条目原样
    expect(desk().mode).toBe('open')
    emit('tool_call', { id: 'w1', name: 'write_file', arguments: args })
    emit('tool_result', { id: 'w1', result: 'ok', isError: false }) // 距直播格上台远不到 1.5 秒:直播格不受节流
    await vi.advanceTimersByTimeAsync(50)
    expect(desk().items.map((x) => [x.path, !!x.live])).toEqual([['/p/report.md', false], ['/p/notes.txt', false]])
  })
})
