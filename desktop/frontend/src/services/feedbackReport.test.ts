// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFeedbackReport, redactFeedback } from './feedbackReport'
import { buildSessionLogPayload } from './sessionLog'
import { getSessionConfig, getSessionTimeline, getSessionUsage, listMessages } from './backendService'
import type { SessionRecord, TanguDesktopConfig } from '../types'

vi.mock('./backendService', () => ({ listMessages: vi.fn(), getSessionConfig: vi.fn(), getSessionUsage: vi.fn(), getSessionTimeline: vi.fn() }))
vi.mock('./agentRunService', () => ({ currentClientId: () => 'test-client' }))
vi.mock('../agentCommands', () => ({ readUiSettings: () => ({ mode: 'dark' }), buildCommandCatalog: () => [{ id: 'open-feedback' }] }))
vi.mock('../diag', () => ({ rendererErrors: [{ msg: 'Authorization: Bearer private-secret' }], uiActionLog: [] }))
const cfg = { backendUrl: 'https://engine.example', token: 'not-exported' } as TanguDesktopConfig
const session = { id: 'session-12345678', title: 'Test conversation', model_id: 'model' } as SessionRecord

beforeEach(() => {
  vi.mocked(listMessages).mockResolvedValue([{ content: 'Private conversation' }] as any)
  vi.mocked(getSessionConfig).mockResolvedValue({ apiKey: 'secret-config' } as any)
  vi.mocked(getSessionUsage).mockResolvedValue({ base: 500, ctx: 200 })
  vi.mocked(getSessionTimeline).mockResolvedValue([{ runId: 'run-1', events: [{ type: 'run:done' }] }])
  window.tangu = {
    getConfig: vi.fn().mockResolvedValue({ mode: 'managed', token: 'host-secret' }),
    backendLogs: vi.fn().mockResolvedValue(['token=secret-runtime']),
    appVersion: vi.fn().mockResolvedValue('2.10.2'),
    backendStatus: vi.fn().mockResolvedValue({ running: true }),
    exportActivity: vi.fn().mockResolvedValue(Array.from({ length: 550 }, (_, i) => `260916010000 view.open file${i}`).join('\n')),
  } as any
})
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); delete window.tangu })

describe('feedback diagnostic collection', () => {
  it('keeps upgraded run timing and UI state without collecting unchecked conversation/activity', async () => {
    const report = await buildFeedbackReport(cfg, session, { diagnostics: true, conversation: false, activity: false })
    const p = JSON.parse(report.json)
    expect(p.timeline[0].runId).toBe('run-1')
    expect(p.uiState.settings.mode).toBe('dark')
    expect(p.usage.tokensTotal).toBe(500)
    expect(p.messages).toBeUndefined()
    expect(listMessages).not.toHaveBeenCalled()
    expect(window.tangu!.exportActivity).not.toHaveBeenCalled()
    expect(report.json).not.toMatch(/secret-config|secret-runtime|private-secret|host-secret|not-exported/)
    expect(report.bytes).toBe(new TextEncoder().encode(report.json).byteLength)
  })
  it('conversation-only selection never reads process logs, settings, config or timeline', async () => {
    const report = await buildFeedbackReport(cfg, session, { diagnostics: false, conversation: true, activity: false })
    expect(JSON.parse(report.json).messages[0].content).toBe('Private conversation')
    expect(window.tangu!.backendLogs).not.toHaveBeenCalled()
    expect(window.tangu!.getConfig).not.toHaveBeenCalled()
    expect(getSessionConfig).not.toHaveBeenCalled()
    expect(getSessionTimeline).not.toHaveBeenCalled()
  })
  it('supports app issues without an active session and bounds opt-in activity', async () => {
    const report = await buildFeedbackReport(cfg, null, { diagnostics: true, conversation: false, activity: true })
    const p = JSON.parse(report.json)
    expect(p.session).toBeNull()
    expect(p.activityLog.split('\n')).toHaveLength(500)
    expect(p.activityLog).toContain('file549')
    expect(p.activityLog).not.toContain('file49\n')
    expect(report.truncated).toBe(true)
    expect(window.tangu!.exportActivity).toHaveBeenCalledWith(2)
    expect(getSessionTimeline).not.toHaveBeenCalled()
  })
  it('distinguishes missing/failed sources from a successful empty response', async () => {
    delete window.tangu!.backendLogs
    vi.mocked(getSessionTimeline).mockRejectedValue(new Error('disconnected'))
    vi.mocked(listMessages).mockResolvedValue([])
    const p = await buildSessionLogPayload(cfg, session)
    expect(p.sources).toMatchObject({ backendLogs: 'unavailable', timeline: 'failed', messages: 'included' })
    expect(p.messages).toEqual([])
  })
  it('bounds a stalled host request while retaining available evidence', async () => {
    vi.useFakeTimers()
    window.tangu!.backendLogs = vi.fn(() => new Promise<string[]>(() => {}))
    const pending = buildFeedbackReport(cfg, session, { diagnostics: true, conversation: false })
    await vi.advanceTimersByTimeAsync(8100)
    const report = await pending
    expect(report.missing).toContain('backendLogs')
    expect(JSON.parse(report.json).timeline).toHaveLength(1)
  })
  it('filters credential objects and strings without redacting usage metrics', () => {
    expect(redactFeedback({ access_token: 'secret', nested: { password: 'secret' }, tokensTotal: 500,
      text: 'Bearer abcd1234 token=foo api_key="bar" https://a.test/?token=baz&x=2',
    })).toEqual({ access_token: '[redacted]', nested: { password: '[redacted]' }, tokensTotal: 500,
      text: 'Bearer [redacted] token=[redacted] api_key="[redacted]" https://a.test/?token=[redacted]&x=2' })
  })
})
