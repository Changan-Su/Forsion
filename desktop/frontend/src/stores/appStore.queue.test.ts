import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ start: vi.fn(), steer: vi.fn(), compact: vi.fn() }))
vi.mock('../services/agentRunService', async (original) => ({
  ...await original<typeof import('../services/agentRunService')>(),
  startRun: service.start, steerRun: service.steer,
}))
vi.mock('../services/backendService', async (original) => ({
  ...await original<typeof import('../services/backendService')>(),
  compactSession: service.compact,
}))
import { useApp } from './appStore'

// 运行中的 /compact、/refine 排到本轮结束后执行(Codex 同款);排在它们后面的消息也跟着排,不插队 steer。
const initial = useApp.getState()
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('window', { tangu: {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  useApp.setState(initial, true)
  useApp.setState({ activeId: 's', tr: (key) => key, toast: vi.fn(), pushNotice: vi.fn(),
    messagesBySession: { s: [{ id: 'a', role: 'assistant', content: 'working', timestamp: 1, status: 'streaming' }] },
    runningBySession: { s: 'r' }, stoppingBySession: {},
    subscribeRun: vi.fn((sid, runId) => useApp.setState({ runningBySession: { [sid]: runId } })),
  })
  service.steer.mockResolvedValue({ ok: true, userMessageId: 'u-steer' })
  service.start.mockResolvedValue({ runId: 'next', assistantMessageId: 'next-a', userMessageId: 'next-u' })
})
afterEach(() => { useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })

const queued = () => (useApp.getState().steerPendingBySession.s || []).filter((p) => p.localOnly).map((p) => p.text)

describe('queued commands while a run is active', () => {
  it('queues /compact, holds later messages behind it, then compacts and sends in order after the run', async () => {
    let finishCompact!: (r: unknown) => void
    service.compact.mockImplementation(() => new Promise((resolve) => { finishCompact = resolve }))

    await useApp.getState().compact('s', 'api surface')
    expect(await useApp.getState().send('continue', [], undefined, undefined, undefined, 's')).toBe(true)
    expect(service.compact).not.toHaveBeenCalled()
    expect(service.steer).not.toHaveBeenCalled() // 排在 /compact 之后:不插进当前 run
    expect(queued()).toEqual(['/compact api surface', 'continue'])

    useApp.getState().reduceEvent('s', 'r', { current: 'a' }, { seq: 1, type: 'done', payload: { content: 'ok' } })
    expect(service.compact).toHaveBeenCalledWith(expect.anything(), 's', expect.anything(), 'api surface')
    expect(queued()).toEqual(['continue'])
    // 压缩进行中不起新 run
    expect(service.start).not.toHaveBeenCalled()

    finishCompact({ ok: true, summarizedCount: 3 })
    await vi.advanceTimersByTimeAsync(800)
    expect(service.start).toHaveBeenCalledOnce()
    expect(service.start.mock.calls[0][1]).toMatchObject({ sessionId: 's', message: 'continue' })
    expect(queued()).toEqual([])
  })

  it('keeps both /compact requests at different positions and sends a plain "/compact" text as a message', async () => {
    service.compact.mockResolvedValue({ ok: true })
    await useApp.getState().compact('s')
    await useApp.getState().send('more work', [], undefined, undefined, undefined, 's')
    await useApp.getState().compact('s')
    await useApp.getState().compact('s') // 相邻重复点击只留一条
    await useApp.getState().send('/compact', [], undefined, undefined, undefined, 's') // 实时转写等调用方:正文恰好是 /compact 的普通消息
    expect(queued()).toEqual(['/compact', 'more work', '/compact', '/compact'])
    expect((useApp.getState().steerPendingBySession.s || []).map((p) => !!p.compact)).toEqual([true, false, true, false])
  })

  it('does not let a new message overtake a queued message whose startRun is still in flight', async () => {
    let resolveStart!: (r: unknown) => void
    service.start.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve }))
    useApp.setState({ steerPendingBySession: { s: [{ id: 'q1', text: 'first', localOnly: true }] } })
    useApp.getState().reduceEvent('s', 'r', { current: 'a' }, { seq: 1, type: 'done', payload: { content: 'ok' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.start).toHaveBeenCalledOnce()
    await useApp.getState().send('second', [], undefined, undefined, undefined, 's')
    expect(service.start).toHaveBeenCalledOnce() // 在途期间不抢跑
    expect(queued()).toEqual(['second'])
    resolveStart({ runId: 'next', assistantMessageId: 'next-a', userMessageId: 'next-u' })
    await vi.advanceTimersByTimeAsync(0)
    expect(useApp.getState().runningBySession.s).toBe('next')
    expect(queued()).toEqual(['second']) // 等 next 收尾再发
  })

  it('puts a failed queued send back at the head and retries it before newer messages', async () => {
    service.start.mockRejectedValueOnce(new Error('offline'))
    useApp.setState({ steerPendingBySession: { s: [{ id: 'q1', text: 'first', localOnly: true }, { id: 'q2', text: 'second', localOnly: true }] } })
    useApp.getState().reduceEvent('s', 'r', { current: 'a' }, { seq: 1, type: 'done', payload: { content: 'ok' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(queued()).toEqual(['first', 'second'])
    expect(useApp.getState().runningBySession.s).toBeUndefined()
    await useApp.getState().send('third', [], undefined, undefined, undefined, 's') // 空闲时有队 → 入队并重试队首
    await vi.advanceTimersByTimeAsync(0)
    expect(service.start).toHaveBeenCalledTimes(2)
    expect(service.start.mock.calls[1][1]).toMatchObject({ message: 'first' })
    expect(queued()).toEqual(['second', 'third'])
  })

  it('releases the dispatch lock if a queued startRun hangs, so the queue is not wedged', async () => {
    service.start.mockImplementationOnce(() => new Promise(() => {})) // 永不返回
    useApp.setState({ steerPendingBySession: { s: [{ id: 'q1', text: 'first', localOnly: true }, { id: 'q2', text: 'second', localOnly: true }] } })
    useApp.getState().reduceEvent('s', 'r', { current: 'a' }, { seq: 1, type: 'done', payload: { content: 'ok' } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(service.start).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(service.start).toHaveBeenCalledTimes(2)
    expect(service.start.mock.calls[1][1]).toMatchObject({ message: 'second' })
  })

  it('still steers plain messages when nothing is queued, but queues /refine', async () => {
    await useApp.getState().send('look here', [], undefined, undefined, undefined, 's')
    expect(service.steer).toHaveBeenCalledOnce()
    await useApp.getState().send('/refine tone', [], undefined, undefined, undefined, 's')
    expect(service.steer).toHaveBeenCalledOnce()
    expect(queued()).toEqual(['/refine tone'])
  })
})
