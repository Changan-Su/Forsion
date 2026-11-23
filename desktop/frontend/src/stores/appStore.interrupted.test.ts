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
const service = vi.hoisted(() => ({ subscribe: vi.fn(), stop: vi.fn(), active: vi.fn(), messages: vi.fn(), history: vi.fn(), config: vi.fn(), usage: vi.fn() }))
vi.mock('../services/agentRunService', async (original) => ({
  ...await original<typeof import('../services/agentRunService')>(),
  subscribeRunEvents: service.subscribe, abortRunAndWait: service.stop, listActiveRuns: service.active,
}))
vi.mock('../services/backendService', async (original) => ({
  ...await original<typeof import('../services/backendService')>(), listMessages: service.messages, listHistory: service.history,
  getSessionConfig: service.config, getSessionUsage: service.usage,
}))
import { useApp } from './appStore'
import { abortAllTanguRuns, withFailedRuns, withInterruptedTurns } from '../tangu/store/tanguSlice'
import { interruptedNoticeMarker } from '../../../../tangu-agent/src/contracts/turnResume'
import { summarizeTask } from '../views/chat2/taskFacts'
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
  service.config.mockResolvedValue({})
  service.usage.mockResolvedValue({ base: 0, ctx: 0 })
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
    service.history.mockResolvedValue({ messages: [{ id: 'a1', role: 'model', content: 'half of the answer' }], failedRuns: [] })
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

  it('control: a run the engine recorded as done is reconciled from the database as before', async () => {
    service.active.mockResolvedValue([{ id: 'run-1', status: 'done', assistant_message_id: 'a1' }])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'done', content: 'half of the answer' })
    expect(service.history).not.toHaveBeenCalled()
  })

  // 评审 #7:列表只给最近五条、在跑的排前;这个 run 被挤出去 = 查不到它的终态,不能因为有半截正文就说「完成」
  it('a run pushed out of the list: not marked done; history clues decide, otherwise "event stream interrupted"', async () => {
    service.active.mockResolvedValue([1, 2, 3, 4, 5].map((n) => ({ id: `newer-${n}`, status: 'done' })))
    service.history.mockResolvedValue({ messages: [{ id: 'u1', role: 'user', content: 'x' }, { id: 'a1', role: 'model', content: 'half of the answer' }], failedRuns: [] })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'error', error: 'app.eventStreamInterrupted', content: 'half of the answer' })
    expect(useApp.getState().runningBySession[SID]).toBeUndefined() // 也不一直挂着「在跑」
  })

  it('a run pushed out of the list whose answer is followed by a reasoned interrupted notice settles quietly with that reason', async () => {
    service.active.mockResolvedValue([])
    service.history.mockResolvedValue({
      messages: [
        { id: 'u1', role: 'user', content: 'x' },
        { id: 'a1', role: 'model', content: 'half of the answer' },
        { id: 'n1', role: 'user', content: interruptedNoticeMarker('app_update') },
      ],
      failedRuns: [],
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'stopped', error: 'interrupted:app_update', content: 'half of the answer' })
  })

  it('a run pushed out of the list with a failure record shows that failure', async () => {
    service.active.mockResolvedValue([])
    service.history.mockResolvedValue({ messages: [], failedRuns: [{ assistant_message_id: 'a1', user_message_id: 'u1', error: 'quota exceeded', timestamp: 2 }] })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'error', error: 'quota exceeded' })
  })

  it('interrupted in the list takes the reason from the notice that follows; aborted elsewhere = stopped', async () => {
    service.active.mockResolvedValue([{ id: 'run-1', status: 'interrupted', assistant_message_id: 'a1' }])
    service.history.mockResolvedValue({
      messages: [{ id: 'a1', role: 'model', content: 'half of the answer' }, { id: 'n1', role: 'user', content: interruptedNoticeMarker('engine_restart') }],
      failedRuns: [],
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg()).toMatchObject({ status: 'stopped', error: 'interrupted:engine_restart' })
    useApp.setState({ messagesBySession: { [SID]: [{ id: 'a2', role: 'assistant', content: '', status: 'streaming', timestamp: 3 }] } })
    useApp.getState().subscribeRun(SID, 'run-2', 'a2')
    service.active.mockResolvedValue([{ id: 'run-2', status: 'aborted', assistant_message_id: 'a2' }])
    service.messages.mockResolvedValue([{ id: 'a2', content: 'some text' }])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(msg('a2')).toMatchObject({ status: 'stopped', content: 'some text' })
    expect(msg('a2').error).toBeUndefined()
  })
})

// 评审 #7:关着自动续跑冷开对话,被打断那一轮的回答行(落库不带状态)不能记成 done —— 右栏 / 摘要会说「已完成」
describe('history restore: the answer right before a reasoned interrupted notice', () => {
  const rows = (extra: unknown[] = []) => [
    { id: 'u1', role: 'user', content: 'merge the weekly notes', timestamp: 1 },
    { id: 'a1', role: 'model', content: 'half of the answer', timestamp: 2 },
    { id: 'n1', role: 'user', content: interruptedNoticeMarker('app_quit'), timestamp: 3 },
    ...extra,
  ]
  const LOAD = 'hist-load' // loadSessionHistory 每个会话只拉一次(模块级记账):用自己的会话,别占掉后面用 SID 的测试
  const facts = (sid: string) => summarizeTask(useApp.getState().messagesBySession[sid], false, '/tmp')
  beforeEach(() => { abortAllTanguRuns(); useApp.setState({ connState: 'ok', messagesBySession: { [SID]: [] }, runningBySession: {} }) })

  it('loadSessionHistory: stopped with the reason, and the task summary does not say done', async () => {
    service.history.mockResolvedValue({ messages: rows(), failedRuns: [] })
    await useApp.getState().loadSessionHistory(LOAD)
    expect(useApp.getState().messagesBySession[LOAD].find((m) => m.id === 'a1')).toMatchObject({ status: 'stopped', error: 'interrupted:app_quit', content: 'half of the answer' })
    expect(facts(LOAD).state).toBe('interrupted') // 不说「已停止」(暗示用户停的),也不说已完成
  })

  it('pollSession: same; a second poll with nothing new keeps the very same list (no churn)', async () => {
    service.history.mockResolvedValue({ messages: rows(), failedRuns: [] })
    await useApp.getState().pollSession(SID)
    expect(msg()).toMatchObject({ status: 'stopped', error: 'interrupted:app_quit' })
    expect(facts(SID).state).toBe('interrupted')
    const before = useApp.getState().messagesBySession[SID]
    await useApp.getState().pollSession(SID)
    expect(useApp.getState().messagesBySession[SID]).toBe(before)
  })

  it('controls: no answer in that turn, a user stop notice, or an answer further back are left alone', () => {
    const done = (id: string, content = 'ok'): UiMessage => ({ id, role: 'assistant', content, status: 'done', timestamp: 2 })
    const u = (id: string, content: string): UiMessage => ({ id, role: 'user', content, status: 'done', timestamp: 1 })
    const sys: UiMessage = { id: 's', role: 'system', content: 'compacted', status: 'done', timestamp: 2 }
    // 那一轮还没回答:说明前面是用户那一句 —— 不能越过它把上一轮的回答改掉
    const noAnswer = [done('a0'), u('u1', 'next'), u('n1', interruptedNoticeMarker('crash'))]
    expect(withInterruptedTurns(noAnswer)).toBe(noAnswer)
    // 用户按停留下的老式说明(不带原因):照旧
    const userStop = [u('u1', 'x'), done('a1'), u('n1', '<turn_interrupted>\nThe user stopped this turn.\n</turn_interrupted>')]
    expect(withInterruptedTurns(userStop)).toBe(userStop)
    // 中间只隔着系统行:照样认
    const withSys = withInterruptedTurns([u('u1', 'x'), done('a1'), sys, u('n1', interruptedNoticeMarker('engine_restart'))])
    expect(withSys[1]).toMatchObject({ status: 'stopped', error: 'interrupted:engine_restart' })
    // 已是失败 / 在跑的不动
    const failed: UiMessage = { ...done('a1'), status: 'error', error: 'quota' }
    expect(withInterruptedTurns([u('u1', 'x'), failed, u('n1', interruptedNoticeMarker('crash'))])[1]).toBe(failed)
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

// 引擎边跑边落库:还在跑的那一轮,回答行(半截正文 + 占位工具结果)已经在历史里了。重开对话 / pollSession 接上它时
// 订阅从 seq 0 回放 —— 不能把正文再拼一遍,在跑的那一步也不能画成「被打断」。
describe('attaching to a run that is still going while its row is already persisted', () => {
  const persisted = {
    id: 'a-live', role: 'model', content: 'step one done', timestamp: 3,
    tool_calls: [{ id: 'c1', function: { name: 'run_bash', arguments: '{"command":"ls"}' } }],
    tool_results: [{ tool_call_id: 'c1', name: 'run_bash', inflight: { state: 'started', sideEffect: 'system' } }],
  }
  const replay = (run: string) => {
    emit('token', { delta: 'step one done' }, run)
    emit('tool_call', { id: 'c1', name: 'run_bash', arguments: '{"command":"ls"}' }, run)
  }
  const check = async (run: string) => {
    const live = () => useApp.getState().messagesBySession[SID].find((m) => m.id === 'a-live')!
    expect(live()).toMatchObject({ status: 'streaming', content: '' }) // 清成空的在跑气泡,等回放
    replay(run)
    expect(live().content).toBe('step one done') // 不是 'step one donestep one done'
    expect(live().toolEvents?.[0]).toMatchObject({ id: 'c1', done: false })
    expect(inflightOf(live().toolEvents![0])).toBeUndefined()
    emit('tool_result', { id: 'c1', result: 'a.md' }, run)
    expect(live().toolEvents?.[0]).toMatchObject({ done: true, result: 'a.md' })
    emit('done', { content: 'step one done' }, run)
    expect(live()).toMatchObject({ status: 'done', content: 'step one done' })
  }
  beforeEach(() => {
    abortAllTanguRuns()
    useApp.setState({ runningBySession: {}, messagesBySession: {} })
    service.history.mockResolvedValue({ messages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }, persisted], failedRuns: [] })
    service.active.mockResolvedValue([{ id: 'run-live', status: 'running', assistant_message_id: 'a-live' }])
  })
  it('via loadSessionHistory', async () => {
    useApp.setState({ connState: 'ok' })
    await useApp.getState().loadSessionHistory(SID)
    expect(useApp.getState().runningBySession[SID]).toBe('run-live')
    await check('run-live')
  })
  it('reattaches to the live answer while slow configuration is still pending', async () => {
    vi.useRealTimers()
    const sid = 'slow-config-live'
    useApp.setState({ connState: 'ok', activeId: sid })
    let release!: () => void
    service.config.mockReturnValueOnce(new Promise(resolve => { release = () => resolve({}) }))
    const opened = useApp.getState().loadSessionHistory(sid)
    try {
      await vi.waitFor(() => expect(useApp.getState().runningBySession[sid]).toBe('run-live'))
      expect(useApp.getState().messagesBySession[sid].some(m => m.id === 'u1')).toBe(true)
    } finally { release(); await opened }
  })
  it('via pollSession', async () => {
    await useApp.getState().pollSession(SID)
    expect(useApp.getState().runningBySession[SID]).toBe('run-live')
    await check('run-live')
  })
  it('a real tool_result clears a placeholder that is still on the row', () => {
    useApp.setState({ messagesBySession: { [SID]: [{ id: 'a-x', role: 'assistant', content: '', status: 'streaming', timestamp: 4,
      toolEvents: [{ id: 'c9', name: 'read_file', done: true, result: undefined, isError: false, inflight: { state: 'started' } } as never] }] } })
    useApp.getState().subscribeRun(SID, 'run-x', 'a-x')
    emit('tool_result', { id: 'c9', result: 'body' }, 'run-x')
    const ev = useApp.getState().messagesBySession[SID][0].toolEvents![0]
    expect(ev).toMatchObject({ done: true, result: 'body' })
    expect(inflightOf(ev)).toBeUndefined()
  })
})

describe('paged poll reconciliation', () => {
  const numbers = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
  const page = (keys: number[], details = keys, removed: number[] = []) => ({
    page: { ids: keys.map(String), versions: Object.fromEntries(keys.map(n => [n, '0'])), older: true,
      newer: false, missing: false, removed: removed.map(String) },
    messages: details.map(n => ({ id: String(n), timestamp: 42, history_order: n, role: 'user', content: 'row' })),
    failedRuns: [],
  })
  const open = async (sid: string, keys: number[]) => {
    abortAllTanguRuns()
    useApp.setState({ activeId: sid, connState: 'ok', runningBySession: {}, messagesBySession: {} })
    service.history.mockResolvedValueOnce(page(keys))
    await useApp.getState().loadSessionHistory(sid)
  }
  it('keeps same-ms messages in engine order as they age out of the tail', async () => {
    const sid = 'page-ties'
    await open(sid, numbers(1, 24))
    service.history.mockResolvedValueOnce(page(numbers(2, 25), [25]))
    await useApp.getState().pollSession(sid)
    expect(useApp.getState().messagesBySession[sid].map(m => m.id)).toEqual(numbers(1, 25).map(String))
  })
  it('catches up after a burst even when the old last messages were deleted', async () => {
    const sid = 'page-bridge'
    await open(sid, numbers(77, 100))
    service.history.mockResolvedValueOnce(page(numbers(107, 130), numbers(107, 130), [99, 100]))
      .mockResolvedValueOnce(page(numbers(101, 130)))
    await useApp.getState().pollSession(sid)
    expect(service.history.mock.lastCall?.at(-1)).toEqual({ afterId: '98' })
    expect(useApp.getState().messagesBySession[sid].map(m => m.id)).toEqual([...numbers(77, 98), ...numbers(101, 130)].map(String))
  })
})
