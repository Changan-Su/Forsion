import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ stop: vi.fn(), start: vi.fn(), steer: vi.fn(), cancel: vi.fn(), expedite: vi.fn() }))
vi.mock('../services/agentRunService', async (original) => ({
  ...await original<typeof import('../services/agentRunService')>(),
  abortRunAndWait: service.stop, startRun: service.start, steerRun: service.steer, cancelSteer: service.cancel,
  expediteSteer: service.expedite,
}))
import { useApp } from './appStore'

const initial = useApp.getState()
const event = (type: string, payload: any = {}) => useApp.getState().reduceEvent('s', 'r', { current: 'a' }, { seq: 1, type, payload })
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  useApp.setState(initial, true)
  useApp.setState({ activeId: 's', tr: (key) => key, toast: vi.fn(),
    messagesBySession: { s: [{ id: 'a', role: 'assistant', content: 'partial work', timestamp: 1, status: 'streaming' }] },
    runningBySession: { s: 'r' }, stoppingBySession: {},
  })
})
afterEach(() => { useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('confirmed stop and restart', () => {
  it('closes a partially generated tool at the steering boundary without claiming execution', () => {
    event('tool_stream', { id: 'partial-call', name: 'write_file', delta: '{"path":' })
    event('turn_boundary', { finalizedAssistantId: 'a', finalizedContent: 'partial work', userMessages: [{ id: 'q', content: 'why?' }], newAssistantId: 'next' })
    const old = useApp.getState().messagesBySession.s.find((m) => m.id === 'a')!
    expect(old.toolEvents?.[0]).toMatchObject({ done: true, isError: true })
    expect(old.toolEvents?.[0].result).toContain('尚未执行')
    expect(useApp.getState().runningBySession.s).toBe('r')
  })
  it('expedites the same run without stopping, withdrawing or resending pending attachments', async () => {
    const item = { id: 'draft', text: 'look at this', attachments: [{ name: 'image.png', mimeType: 'image/png', data: 'AAAA', size: 3 }] }
    useApp.setState({ steerPendingBySession: { s: [item] }, send: vi.fn(async () => true) })
    service.expedite.mockResolvedValue({ ok: true })
    await useApp.getState().steerNow('s')
    expect(service.expedite).toHaveBeenCalledWith(expect.anything(), 'r')
    expect(useApp.getState().steerPendingBySession.s).toEqual([item])
    expect(useApp.getState().runningBySession.s).toBe('r')
    expect(service.stop).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(useApp.getState().send).not.toHaveBeenCalled()
  })

  it('retains the queued message and active task when expediting fails', async () => {
    const item = { id: 'draft', text: 'why?', attachments: [{ name: 'image.png', mimeType: 'image/png', data: 'AAAA', size: 3 }] }
    useApp.setState({ steerPendingBySession: { s: [item] } })
    service.expedite.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true })
    await useApp.getState().steerNow('s')
    expect(useApp.getState().steerPendingBySession.s).toEqual([item])
    expect(service.stop).not.toHaveBeenCalled()
    expect(useApp.getState().toast).toHaveBeenCalled()
    await useApp.getState().steerNow('s')
    expect(service.expedite).toHaveBeenCalledTimes(2)
  })

  it('keeps the run busy until cancellation and cleanup are confirmed, including an early SSE terminal', async () => {
    let finish!: (status: string) => void
    service.stop.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const stopping = useApp.getState().stop('s')
    expect(useApp.getState().stop('s')).toBe(stopping) // repeated click is idempotent
    expect(service.stop).toHaveBeenCalledOnce()
    event('error', { aborted: true, content: 'partial work' })
    expect(useApp.getState().runningBySession.s).toBe('r')
    expect(useApp.getState().stoppingBySession.s).toBe('r')
    expect(useApp.getState().messagesBySession.s[0].status).toBe('streaming')
    finish('aborted')
    expect(await stopping).toBe(true)
    expect(useApp.getState().runningBySession.s).toBeUndefined()
    expect(useApp.getState().messagesBySession.s[0]).toMatchObject({ status: 'stopped', content: 'partial work' })
    event('token', { delta: 'LATE OUTPUT' })
    expect(useApp.getState().messagesBySession.s[0].content).toBe('partial work')
  })

  it('retains the active run on failure, reports it, and permits another stop attempt', async () => {
    service.stop.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('aborted')
    expect(await useApp.getState().stop('s')).toBe(false)
    expect(useApp.getState().runningBySession.s).toBe('r')
    expect(useApp.getState().messagesBySession.s[0].status).toBe('streaming')
    expect(useApp.getState().toast).toHaveBeenLastCalledWith(expect.stringContaining('offline'), true)
    expect(await useApp.getState().stop('s')).toBe(true)
    expect(useApp.getState().runningBySession.s).toBeUndefined()
  })

  it('does not send new work to a run whose stop is still unconfirmed', async () => {
    let fail!: (error: Error) => void
    service.stop.mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    const stopping = useApp.getState().stop('s')
    const sending = useApp.getState().send('restart', [], undefined, undefined, undefined, 's')
    expect(service.start).not.toHaveBeenCalled()
    expect(service.steer).not.toHaveBeenCalled()
    fail(new Error('stop failed'))
    expect(await stopping).toBe(false)
    expect(await sending).toBe(false)
    expect(service.start).not.toHaveBeenCalled()
    expect(service.steer).not.toHaveBeenCalled()
  })

  it('starts a fresh run after confirmed stop and ignores old-run events', async () => {
    vi.stubGlobal('window', { tangu: {} })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    let finish!: (status: string) => void
    service.stop.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    service.start.mockResolvedValue({ runId: 'next', assistantMessageId: 'next-a', userMessageId: 'next-u' })
    useApp.setState({ subscribeRun: vi.fn((sid, runId) => useApp.setState({ runningBySession: { [sid]: runId } })) })
    const stopping = useApp.getState().stop('s')
    const sending = useApp.getState().send('continue', [], undefined, undefined, undefined, 's')
    expect(service.start).not.toHaveBeenCalled()
    finish('aborted')
    expect(await stopping).toBe(true)
    expect(await sending).toBe(true)
    expect(service.start).toHaveBeenCalledOnce()
    expect(service.steer).not.toHaveBeenCalled()
    event('error', { aborted: true })
    event('usage', { prompt: 999_999, total: 999_999 })
    expect(useApp.getState().runningBySession.s).toBe('next')
    expect(useApp.getState().messagesBySession.s.find((m) => m.id === 'next-a')?.status).toBe('streaming')
    expect(useApp.getState().usageBySession.s?.ctx).not.toBe(999_999)
  })
})
