import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ start: vi.fn(), steer: vi.fn(), del: vi.fn(), list: vi.fn(), branch: vi.fn() }))
vi.mock('../services/agentRunService', async (original) => ({
  ...await original<typeof import('../services/agentRunService')>(),
  startRun: service.start, steerRun: service.steer,
}))
vi.mock('../services/backendService', async (original) => ({
  ...await original<typeof import('../services/backendService')>(),
  deleteMessages: service.del, listMessages: service.list, branchSession: service.branch,
}))
import { useApp } from './appStore'
import '../tangu/store/standalone'
import { TURN_RESUME_MARKER } from '../../../../tangu-agent/src/contracts/turnResume'
import { turnHasOutput } from '../views/chat2/continueTurn'
import type { UiMessage } from '../types'

// 失败行的「继续生成」与「重新生成」(2026-11-10 用户反馈:报错 / 额度用完只有一个重试,前面生成的白费)。
const failed: UiMessage[] = [
  { id: 'u1', role: 'user', content: 'write the report', timestamp: 1, status: 'done' },
  { id: 'a1', role: 'assistant', content: 'Part one is done…', timestamp: 2, status: 'error', error: 'quota exhausted' },
]
const initial = useApp.getState()
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('window', { tangu: {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  useApp.setState(initial, true)
  useApp.setState({ activeId: 's', tr: (key) => key, toast: vi.fn(), pushNotice: vi.fn(),
    messagesBySession: { s: failed }, runningBySession: {}, stoppingBySession: {},
    subscribeRun: vi.fn((sid, runId) => useApp.setState({ runningBySession: { [sid]: runId } })),
  })
  service.list.mockResolvedValue([])
  service.del.mockResolvedValue({ ok: true })
  service.start.mockResolvedValue({ runId: 'next', assistantMessageId: 'next-a', userMessageId: 'next-u' })
})
afterEach(() => { useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('continue after a failed turn', () => {
  it('sends the resume marker without deleting anything', async () => {
    expect(await useApp.getState().continueRun('s')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(service.del).not.toHaveBeenCalled()
    expect(service.start).toHaveBeenCalledOnce()
    expect(service.start.mock.calls[0][1]).toMatchObject({ message: TURN_RESUME_MARKER })
    const ids = useApp.getState().messagesBySession.s.map((m) => m.id)
    expect(ids.slice(0, 2)).toEqual(['u1', 'a1']) // 失败那条原样留着
  })

  it('does nothing while a run is active', async () => {
    useApp.setState({ runningBySession: { s: 'r' } })
    expect(await useApp.getState().continueRun('s')).toBe(false)
    expect(service.start).not.toHaveBeenCalled()
  })

  it('retry after a continue walks past the resume row to the real question', async () => {
    useApp.setState({ messagesBySession: { s: [
      ...failed,
      { id: 'r1', role: 'user', content: TURN_RESUME_MARKER, timestamp: 3, status: 'done' },
      { id: 'a2', role: 'assistant', content: '', timestamp: 4, status: 'error', error: 'boom' },
    ] } })
    await useApp.getState().retry('s')
    await vi.advanceTimersByTimeAsync(0)
    expect(service.del).toHaveBeenCalledWith(expect.anything(), 's', ['u1', 'a1', 'r1', 'a2'])
    expect(service.start.mock.calls[0][1]).toMatchObject({ message: 'write the report' })
  })

  it('regenerate from an answer after a resume row also resends the real question', async () => {
    useApp.setState({ messagesBySession: { s: [
      ...failed,
      { id: 'r1', role: 'user', content: TURN_RESUME_MARKER, timestamp: 3, status: 'done' },
      { id: 'a2', role: 'assistant', content: 'Part two.', timestamp: 4, status: 'done' },
    ] } })
    useApp.getState().regenerate('a2', 's')
    await vi.advanceTimersByTimeAsync(0)
    expect(service.del).toHaveBeenCalledWith(expect.anything(), 's', ['u1', 'a1', 'r1', 'a2'])
    expect(service.start.mock.calls[0][1]).toMatchObject({ message: 'write the report' })
  })
})

describe('turnHasOutput', () => {
  const u = (id: string, content: string): UiMessage => ({ id, role: 'user', content, timestamp: 0, status: 'done' })
  const a = (id: string, content: string, extra: Partial<UiMessage> = {}): UiMessage => ({ id, role: 'assistant', content, timestamp: 0, status: 'error', ...extra })
  it('is false when the failed turn produced nothing', () => {
    expect(turnHasOutput([u('u', 'hi'), a('a', '')])).toBe(false)
    expect(turnHasOutput(undefined)).toBe(false)
  })
  it('counts text or tool calls in the failed turn', () => {
    expect(turnHasOutput([u('u', 'hi'), a('a', 'half an answer')])).toBe(true)
    expect(turnHasOutput([u('u', 'hi'), a('a', '', { toolEvents: [{ id: 't', name: 'read_file', arguments: '{}', done: true }] })])).toBe(true)
  })
  it('looks through earlier continue rows of the same turn, but not past the real question', () => {
    expect(turnHasOutput([u('u', 'hi'), a('a', 'first half'), u('r', TURN_RESUME_MARKER), a('b', '')])).toBe(true)
    expect(turnHasOutput([u('u0', 'old'), a('a0', 'old answer'), u('u', 'new question'), a('b', '')])).toBe(false)
  })
})
