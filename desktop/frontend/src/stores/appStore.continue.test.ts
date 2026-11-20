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
import { TURN_RESUME_MARKER, isContinuationRow, turnResumeMarker } from '../../../../tangu-agent/src/contracts/turnResume'
import { isLatestAnswer, turnHasOutput } from '../views/chat2/continueTurn'
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

  it('two clicks before the run starts send only one continue', async () => {
    let release!: (v: unknown) => void
    service.start.mockImplementationOnce(() => new Promise((r) => { release = r }))
    const first = useApp.getState().continueRun('s')
    await vi.advanceTimersByTimeAsync(0)
    expect(await useApp.getState().continueRun('s')).toBe(false) // 额度按钮 / 右栏卡在往返途中又点一下
    release({ runId: 'next', assistantMessageId: 'next-a', userMessageId: 'next-u' })
    expect(await first).toBe(true)
    expect(service.start).toHaveBeenCalledOnce()
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

// 停下 / 写到输出上限后的「继续生成」(2026-11-15,借鉴 DeepSeek chat-demo 方案 ①):按原因换那一行的说法。
describe('continue after a stop or a length cut', () => {
  it('sends the reason-specific marker', async () => {
    expect(await useApp.getState().continueRun('s', { reason: 'length' })).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    const sent = String(service.start.mock.calls[0][1].message)
    expect(sent).toBe(turnResumeMarker('length'))
    expect(sent).toContain('output length limit')
    expect(sent).toContain('mid-sentence')
    expect(service.del).not.toHaveBeenCalled()
  })

  it('the stopped marker says the user stopped it', async () => {
    expect(await useApp.getState().continueRun('s', { reason: 'stopped' })).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(String(service.start.mock.calls[0][1].message)).toContain('The user stopped your previous response')
  })

  it('the error marker is unchanged and every variant is a continuation row', () => {
    // 11-10 落库 / 台架里那句的原文,逐字钉住(只和 turnResumeMarker() 比是自证,Codex 评审 11-15)
    const LEGACY = '<turn_resume>\n' +
      'Your previous response stopped because of an error (not because the user interrupted it). Everything produced before the error — text, tool calls and their results — was kept and is shown above. ' +
      'Continue exactly where it stopped: do not repeat what you already wrote and do not restart the task. ' +
      'If a tool call was cut off or has no result, check the current state before running it again.\n' +
      '</turn_resume>'
    expect(TURN_RESUME_MARKER).toBe(LEGACY)
    expect(turnResumeMarker()).toBe(LEGACY)
    expect(turnResumeMarker('error')).toBe(LEGACY)
    for (const r of ['error', 'length', 'stopped'] as const) expect(isContinuationRow(turnResumeMarker(r))).toBe(true)
  })
})

describe('isLatestAnswer', () => {
  const u = (id: string, content: string): UiMessage => ({ id, role: 'user', content, timestamp: 0, status: 'done' })
  const a = (id: string): UiMessage => ({ id, role: 'assistant', content: 'x', timestamp: 0, status: 'stopped' })
  it('looks past interrupt / resume rows and local notices', () => {
    expect(isLatestAnswer([u('u', 'hi'), a('a'), u('i', '<turn_interrupted>stopped</turn_interrupted>')], 'a')).toBe(true)
    expect(isLatestAnswer([u('u', 'hi'), a('a'), { id: 'n', role: 'system', content: 'note', timestamp: 0 }], 'a')).toBe(true)
  })
  it('is false once a newer question or answer follows', () => {
    expect(isLatestAnswer([u('u', 'hi'), a('a'), u('u2', 'next')], 'a')).toBe(false)
    expect(isLatestAnswer([u('u', 'hi'), a('a'), u('r', TURN_RESUME_MARKER), a('b')], 'a')).toBe(false)
    expect(isLatestAnswer(undefined, 'a')).toBe(false)
  })
})
