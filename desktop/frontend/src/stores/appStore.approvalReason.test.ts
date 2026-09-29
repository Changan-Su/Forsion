// approval_request 的 reason 白名单:引擎新增 kind='control'(建无人值守工作,不吃「总允许」)。
// 白名单漏了它 → reason 被清洗成 undefined → 审批卡照显「本会话总是允许」,用户点了引擎只按一次性批准处理。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent, UiMessage } from '../types'
import { useApp } from './appStore'

const initial = useApp.getState()
const assistant = (): UiMessage => ({ id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: 1 })

describe('appStore approval_request reason 白名单', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useApp.setState(initial, true)
    useApp.setState({
      tr: (key) => key,
      messagesBySession: { s1: [assistant()] },
      configBySession: { s1: {} },
      runningBySession: { s1: 'r1' },
      subChatsBySession: {},
      groupVoting: {},
    })
  })
  afterEach(() => vi.useRealTimers())

  const emit = (payload: Record<string, unknown>) => {
    const ref = { current: 'a1' }
    useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 1, type: 'approval_request', payload } as AgentRunEvent)
  }
  const approvals = () => useApp.getState().messagesBySession.s1.find((m) => m.id === 'a1')!.approvals || []

  it("kind='control' 过白名单,mode 一并保留", () => {
    emit({ approvalId: 'c1', name: 'manage_automation', preview: 'manage_automation set …', reason: { kind: 'control', mode: 'auto-edit' } })
    expect(approvals()[0].reason).toEqual({ kind: 'control', mode: 'auto-edit' })
  })

  it('不认识的 kind 仍被清洗成 undefined(白名单没被放宽成透传)', () => {
    emit({ approvalId: 'b1', name: 'run_bash', preview: 'ls', reason: { kind: 'bogus', mode: 'auto-edit' } })
    emit({ approvalId: 'b2', name: 'run_bash', preview: 'ls', reason: { kind: 'mode', mode: 'weird' } })
    expect(approvals()[0].reason).toBeUndefined()
    expect(approvals()[1].reason).toEqual({ kind: 'mode' }) // 未知档位丢掉,kind 照留
  })
})
