// @vitest-environment happy-dom
// Agent 起草反馈的附件:按调用 id 找会话、「这次运行的报错」取同一条回复的失败调用(退到会话最近的)、凭据过滤、找不到回 null。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAgentFeedbackReport, pickToolErrors } from './agentFeedbackReport'
import { useApp } from '../stores/appStore'
import type { ToolEvent } from '../types'

vi.mock('./backendService', () => ({ listAllMessages: vi.fn(async () => ({ messages: [], complete: true })), getSessionConfig: vi.fn(async () => ({})), getSessionUsage: vi.fn(async () => ({ base: 1, ctx: 1 })), getSessionTimeline: vi.fn(async () => []) }))
vi.mock('./agentRunService', () => ({ currentClientId: () => 'test-client' }))
vi.mock('../agentCommands', () => ({ readUiSettings: () => ({}), buildCommandCatalog: () => [] }))
vi.mock('../diag', () => ({ rendererErrors: [], uiActionLog: [] }))

const ev = (id: string, name: string, isError: boolean, extra: Partial<ToolEvent> = {}): ToolEvent => ({ id, name, done: true, isError, arguments: '{"a":1}', result: isError ? 'Error: boom token=abc123' : 'ok', ...extra })
const snapshot = useApp.getState()
afterEach(() => { useApp.setState(snapshot, true) })

describe('pickToolErrors', () => {
  it('failed calls in the same reply, excluding the draft itself; falls back to the session', () => {
    const here = [ev('a', 'manage_schedule', true), ev('b', 'read_file', false), ev('fd', 'feedback_draft', false)]
    expect(pickToolErrors('fd', here, here).map((e) => e.tool)).toEqual(['manage_schedule'])
    const earlier = [ev('x', 'manage_schedule', true)]
    expect(pickToolErrors('fd', [ev('fd', 'feedback_draft', false)], [...earlier, ev('fd', 'feedback_draft', false)]).map((e) => e.tool)).toEqual(['manage_schedule'])
    const long = ev('l', 't', true, { result: 'x'.repeat(5000) })
    expect(String(pickToolErrors('fd', [long], [long])[0].result)).toMatch(/more chars\]$/)
  })
})

describe('buildAgentFeedbackReport', () => {
  it('finds the session by call id and attaches redacted tool errors', async () => {
    useApp.setState({
      sessions: [{ id: 's1', title: 'Daily digest', model_id: 'm' } as any],
      messagesBySession: { s1: [{ id: 'm1', role: 'model', content: '', toolEvents: [ev('a', 'manage_schedule', true), ev('fd', 'feedback_draft', false)] } as any] },
    } as any)
    const report = await buildAgentFeedbackReport({ callId: 'fd', diagnostics: false, conversation: false, errors: true })
    expect(report?.errorCount).toBe(1)
    const p = JSON.parse(report!.json)
    expect(p.origin).toBe('agent-draft')
    expect(p.session.id).toBe('s1')
    expect(p.toolErrors[0]).toMatchObject({ tool: 'manage_schedule' })
    expect(report!.json).not.toContain('abc123')
    expect(p.messages).toBeUndefined()
  })
  it('colliding call ids: picks by result, and refuses when still ambiguous', async () => {
    const draft = (r: string) => ({ ...ev('fd', 'feedback_draft', false), result: r })
    useApp.setState({
      sessions: [{ id: 'A', title: 'a' } as any, { id: 'B', title: 'b' } as any],
      messagesBySession: {
        A: [{ id: 'm1', role: 'model', content: '', toolEvents: [ev('x', 'secret_tool', true), draft('{"t":"A"}')] } as any],
        B: [{ id: 'm2', role: 'model', content: '', toolEvents: [ev('y', 'manage_schedule', true), draft('{"t":"B"}')] } as any],
      },
    } as any)
    const r = await buildAgentFeedbackReport({ callId: 'fd', result: '{"t":"B"}', errors: true })
    expect(JSON.parse(r!.json).session.id).toBe('B')
    expect(r!.json).not.toContain('secret_tool')
    expect(await buildAgentFeedbackReport({ callId: 'fd', errors: true })).toBeNull()
  })
  it('Basic credentials are fully redacted', async () => {
    useApp.setState({ sessions: [{ id: 's1', title: 't' } as any], messagesBySession: { s1: [{ id: 'm', role: 'model', content: '', toolEvents: [ev('a', 'web_fetch', true, { arguments: '{"headers":"Authorization: Basic dXNlcjpwYXNz"}' }), ev('fd', 'feedback_draft', false)] } as any] } } as any)
    const r = await buildAgentFeedbackReport({ callId: 'fd', errors: true })
    expect(r!.json).not.toContain('dXNlcjpwYXNz')
  })
  it('unknown call → null', async () => {
    useApp.setState({ messagesBySession: {} } as any)
    expect(await buildAgentFeedbackReport({ callId: 'nope', errors: true })).toBeNull()
  })
})
