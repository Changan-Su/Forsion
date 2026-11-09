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
import '../tangu/store/standalone'

const initial = useApp.getState()
let receive: (event: AgentRunEvent) => void
let reject: (error: Error) => void
let seq = 0
const emit = (type: string, payload: unknown = {}) => receive({ seq: ++seq, type, payload })
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); seq = 0
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  useApp.setState(initial, true)
  useApp.setState({ activeId: 'batch-session', tr: (k) => k, toast: vi.fn(),
    messagesBySession: { 'batch-session': [{ id: 'a', role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }] },
    runningBySession: {}, stoppingBySession: {},
  })
  service.subscribe.mockImplementation((_target, _run, callback, signal: AbortSignal) => {
    receive = callback
    return new Promise<void>((resolve, fail) => { reject = fail; signal.addEventListener('abort', () => resolve(), { once: true }) })
  })
  service.stop.mockResolvedValue('aborted')
  service.active.mockResolvedValue([])
  service.messages.mockResolvedValue([{ id: 'a', content: 'AB' }])
  useApp.getState().subscribeRun('batch-session', 'batch-run', 'a')
})
afterEach(async () => { abortAllTanguRuns(); await Promise.resolve(); useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })
const message = () => useApp.getState().messagesBySession['batch-session'][0]

describe('run subscription batching × real store lifecycle', () => {
  it('settles the exact last delta before done, without leaving timers or corrupting another session', async () => {
    emit('token', { delta: 'A' }); emit('token', { delta: 'B' }); emit('token', { delta: 'C' })
    expect(message().content).toBe('A')
    useApp.setState({ activeId: 'another-session' })
    emit('done')
    expect(message()).toMatchObject({ content: 'ABC', status: 'done' })
    expect(useApp.getState().runningBySession['batch-session']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(message().content).toBe('ABC')
  })
  it('flushes buffered output on a confirmed stop even when no terminal frame arrives', async () => {
    emit('token', { delta: 'A' }); emit('token', { delta: 'B' })
    expect(await useApp.getState().stop('batch-session')).toBe(true)
    expect(message()).toMatchObject({ content: 'AB', status: 'stopped' })
    emit('token', { delta: 'LATE' })
    await vi.advanceTimersByTimeAsync(100)
    expect(message().content).toBe('AB')
  })
  it('keeps tool arguments intact across call/result boundaries', () => {
    emit('tool_stream', { id: 'tool', name: 'test_tool', delta: '{"text":' })
    emit('tool_stream', { id: 'tool', name: 'test_tool', delta: '"🙂"}' })
    emit('tool_call', { id: 'tool', name: 'test_tool', arguments: '{"text":"🙂"}' })
    expect(message().toolEvents?.[0]).toMatchObject({ arguments: '{"text":"🙂"}', done: false })
    emit('token', { delta: 'after' }); emit('token', { delta: ' tool' }); emit('done')
    expect(message().content).toBe('after tool')
  })
  it('flushes before a transport failure and rejects delayed data from an invalidated run', async () => {
    emit('token', { delta: 'A' }); emit('token', { delta: 'B' })
    reject(new Error('connection lost'))
    await vi.advanceTimersByTimeAsync(1)
    expect(message()).toMatchObject({ content: 'AB', status: 'error' })
    expect(useApp.getState().runningBySession['batch-session']).toBeUndefined()
  })
  it('flushes BEFORE the watchdog applies the authoritative database snapshot', async () => {
    await vi.advanceTimersByTimeAsync(29999)
    emit('token', { delta: 'A' }); emit('token', { delta: 'B' })
    expect(message().content).toBe('A')
    await vi.advanceTimersByTimeAsync(1)
    expect(message()).toMatchObject({ content: 'AB', status: 'done' }) // old order produced ABB
    expect(useApp.getState().runningBySession['batch-session']).toBeUndefined()
  })
  it('ignores a watchdog database read that resolves after the run has been replaced', async () => {
    let finish!: (rows: unknown[]) => void
    service.messages.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(30000)
    useApp.setState({ runningBySession: { 'batch-session': 'new-run' } })
    finish([{ id: 'a', content: 'STALE DATABASE' }])
    await vi.advanceTimersByTimeAsync(1)
    expect(message().content).toBe('')
    expect(useApp.getState().runningBySession['batch-session']).toBe('new-run')
  })
})
