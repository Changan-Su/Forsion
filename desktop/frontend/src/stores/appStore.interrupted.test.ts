/**
 * 不是用户按停的中断(中断任务续跑方案 B,D1 / D4):
 *  - 在线收到 error { interrupted: <原因> }:不当用户停下(「⏹ 已停止」+ 告诉模型「用户停的」那个「继续生成」),也不当失败(红色失败行);
 *    气泡安静收住,没等到结果的工具调用记成「结果未知」;
 *  - 看门狗遇到引擎记为 interrupted / failed 的 run,不因为有半截正文就标「完成」;
 *  - 引擎重启后插的中断说明行 + 自动续跑的新 run 由 pollSession 拉回来、接上订阅;
 *  - run 状态 interrupted 不当失败(重开对话不补红色失败行)、也不当在跑(按停不空转)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent, UiMessage } from '../types'
const service = vi.hoisted(() => ({ subscribe: vi.fn(), stop: vi.fn(), active: vi.fn(), messages: vi.fn(), history: vi.fn() }))
vi.mock('../services/agentRunService', async (original) => ({
  ...await original<typeof import('../services/agentRunService')>(),
  subscribeRunEvents: service.subscribe, abortRunAndWait: service.stop, listActiveRuns: service.active,
}))
vi.mock('../services/backendService', async (original) => ({
  ...await original<typeof import('../services/backendService')>(), listMessages: service.messages, listHistory: service.history,
}))
import { useApp } from './appStore'
import { abortAllTanguRuns, withFailedRuns } from '../tangu/store/tanguSlice'
import '../tangu/store/standalone'
import { inflightOf } from '../tangu/inflightTool'

const SID = 'int-session'
const initial = useApp.getState()
const receivers = new Map<string, (event: AgentRunEvent) => void>()
let seq = 0
const emit = (type: string, payload: unknown = {}, run = 'run-1') => receivers.get(run)!({ seq: ++seq, type, payload })
const authStatus = vi.fn(async () => ({ loggedIn: true, tokenValid: false }))
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); seq = 0; receivers.clear()
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, tangu: { authStatus } })
  useApp.setState(initial, true)
  useApp.setState({ activeId: SID, tr: (k) => k, toast: vi.fn(), authInfo: { loggedIn: true } as never,
    messagesBySession: { [SID]: [
      { id: 'u1', role: 'user', content: 'merge the weekly notes', status: 'done', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: 2 },
    ] },
    runningBySession: {}, stoppingBySession: {},
  })
  service.subscribe.mockImplementation((_target, run: string, callback, signal: AbortSignal) => {
    receivers.set(run, callback)
    return new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }) })
  })
  service.active.mockResolvedValue([])
  service.messages.mockResolvedValue([{ id: 'a1', content: 'half of the answer' }])
  service.history.mockResolvedValue({ messages: [], failedRuns: [] })
  useApp.getState().subscribeRun(SID, 'run-1', 'a1')
})
afterEach(async () => { abortAllTanguRuns(); await Promise.resolve(); useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })
const msg = (id = 'a1'): UiMessage => useApp.getState().messagesBySession[SID].find((m) => m.id === id)!

describe('live interrupted error', () => {
  it('ends the bubble quietly: not a user stop, not a failure; unfinished tool calls become outcome-unknown', async () => {
    emit('token', { delta: 'half of ' })
    emit('tool_call', { id: 'c-read', name: 'read_file', arguments: '{"path":"a.md"}' })
    emit('tool_result', { id: 'c-read', result: 'ok' })
    emit('tool_call', { id: 'c-write', name: 'write_file', arguments: '{"path":"b.md"}' })
    emit('error', { error: 'interrupted', aborted: true, interrupted: 'app_update', content: 'half of the answer' })
    const m = msg()
    expect(m.status).toBe('stopped')
    expect(m.error).toBe('interrupted:app_update')
    expect(m.content).toBe('half of the answer')
    expect(useApp.getState().runningBySession[SID]).toBeUndefined()
    const [read, write] = m.toolEvents!
    expect(read).toMatchObject({ id: 'c-read', done: true, result: 'ok' })
    expect(inflightOf(read)).toBeUndefined()
    expect(write).toMatchObject({ id: 'c-write', done: true, result: undefined, isError: false })
    expect(inflightOf(write)).toEqual({ state: 'started' })
    await vi.advanceTimersByTimeAsync(1)
    expect(authStatus).not.toHaveBeenCalled() // 不是出错:不去复检登录态
  })

  it('a reason the client does not know yet still ends quietly', () => {
    emit('error', { error: 'interrupted', aborted: true, interrupted: 'brand_new_reason' })
    expect(msg()).toMatchObject({ status: 'stopped', error: 'interrupted' })
  })

  it('control: a user stop and a real failure keep today\'s rendering', () => {
    emit('error', { error: 'aborted', aborted: true })
    expect(msg()).toMatchObject({ status: 'stopped', error: undefined })
    useApp.setState({ messagesBySession: { [SID]: [{ id: 'a2', role: 'assistant', content: '', status: 'streaming', timestamp: 3 }] } })
    useApp.getState().subscribeRun(SID, 'run-2', 'a2')
    emit('error', { error: 'fetch failed' }, 'run-2')
    expect(msg('a2')).toMatchObject({ status: 'error', error: 'fetch failed' })
  })
})

describe('watchdog × the run status the engine recorded (D4)', () => {
  it('interrupted: not marked done even though half an answer was persisted', async () => {
    service.active.mockResolvedValue([{ id: 'run-1', status: 'interrupted', assistant_message_id: 'a1' }])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'stopped', error: 'interrupted', content: 'half of the answer' })
    expect(useApp.getState().runningBySession[SID]).toBeUndefined()
  })

  it('failed: shows the reason the engine recorded instead of "done"', async () => {
    service.active.mockResolvedValue([{ id: 'run-1', status: 'failed', assistant_message_id: 'a1' }])
    service.history.mockResolvedValue({
      messages: [{ id: 'a1', content: 'half of the answer' }],
      failedRuns: [{ assistant_message_id: 'a1', user_message_id: 'u1', error: 'stale: process restarted', timestamp: 2 }],
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'error', error: 'stale: process restarted', content: 'half of the answer' })
  })

  it('control: a run that simply vanished from the list keeps the old reconciliation', async () => {
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'done', content: 'half of the answer' })
  })
})

describe('after the engine restarts', () => {
  it('pollSession picks up the interrupted-notice row and attaches to the recovery run', async () => {
    emit('error', { error: 'interrupted', aborted: true, interrupted: 'engine_restart', content: 'half of the answer' })
    const notice = '<turn_resume>\n[auto-resume: engine_restart]\nThe agent engine was restarted… </turn_resume>'
    service.history.mockResolvedValue({
      messages: [
        { id: 'u1', role: 'user', content: 'merge the weekly notes', timestamp: 1 },
        { id: 'a1', role: 'model', content: 'half of the answer', timestamp: 2 },
        { id: 'r1', role: 'user', content: notice, timestamp: 3 },
      ],
      failedRuns: [],
    })
    service.active.mockResolvedValue([{ id: 'run-recovery', status: 'running', assistant_message_id: 'a-rec' }])
    await useApp.getState().pollSession(SID)
    const list = useApp.getState().messagesBySession[SID]
    expect(list.map((m) => m.id)).toEqual(['u1', 'a1', 'r1', 'a-rec'])
    expect(list.find((m) => m.id === 'a1')).toMatchObject({ status: 'stopped', error: 'interrupted:engine_restart' }) // 本地那份不被冲成别的
    expect(useApp.getState().runningBySession[SID]).toBe('run-recovery')
    expect(service.subscribe.mock.calls.map((c) => c[1])).toContain('run-recovery')
  })

  it('a stop that lands on a run the engine recorded as interrupted settles as a stop, not a 10s spin', async () => {
    service.stop.mockResolvedValue('interrupted')
    expect(await useApp.getState().stop(SID)).toBe(true)
    expect(msg().status).toBe('stopped')
    expect(useApp.getState().runningBySession[SID]).toBeUndefined()
  })
})

describe('reopening a conversation', () => {
  it('an interrupted run is not painted as a failure', () => {
    const ui: UiMessage[] = [{ id: 'u', role: 'user', content: 'hi', status: 'done', timestamp: 1 }, { id: 'a', role: 'assistant', content: 'half', status: 'done', timestamp: 2 }]
    expect(withFailedRuns(ui, [{ assistant_message_id: 'a', user_message_id: 'u', error: 'interrupted:app_quit', timestamp: 2 }])).toEqual(ui)
    expect(withFailedRuns(ui, [{ assistant_message_id: 'x', user_message_id: 'u', error: 'interrupted', timestamp: 2 }])).toEqual(ui)
    expect(withFailedRuns(ui, [{ assistant_message_id: 'a', user_message_id: 'u', error: 'stale: process restarted', timestamp: 2 }])[1]).toMatchObject({ status: 'error' })
  })

  it('abortRunAndWait treats interrupted as terminal', async () => {
    vi.useRealTimers()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/abort') ? { success: true, settled: true, status: 'interrupted' } : { runs: [] })))
    const { connectionTarget } = await import('../services/engine/targets')
    const { abortRunAndWait: realAbortRunAndWait } = await vi.importActual<typeof import('../services/agentRunService')>('../services/agentRunService')
    expect(await realAbortRunAndWait(connectionTarget({ backendUrl: 'https://example.test', token: 't' } as never), 'r', 's')).toBe('interrupted')
  })
})
