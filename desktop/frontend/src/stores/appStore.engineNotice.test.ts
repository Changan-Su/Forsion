// 外部引擎的提示(status/engine_notice,融合插件:DSH 的审批在工作台里等着):进这一会话的 engineNoticesBySession,
// clear 撤掉,这一轮结束(done / error)清空;事件会持久化回放,畸形的在入口丢掉。
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentRunEvent, UiMessage } from '../types'
import { useApp } from './appStore'
import '../tangu/store/standalone'

const initial = useApp.getState()
const assistant = (): UiMessage => ({ id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: 1 })
const notice = { id: 'dsh-approval-A1', text: { zh: 'DSH 在工作台里等你批准', en: 'DSH is waiting for your approval in the workbench' }, action: { id: 'open-in-workbench', label: { zh: '打开工作台', en: 'Open the workbench' } } }

describe('engine notices', () => {
  beforeEach(() => {
    useApp.setState(initial, true)
    useApp.setState({ tr: (key) => key, messagesBySession: { s1: [assistant()] }, configBySession: { s1: {} }, runningBySession: { s1: 'r1' }, subChatsBySession: {}, groupVoting: {} })
  })
  const emit = (type: string, payload: Record<string, unknown>) => useApp.getState().reduceEvent('s1', 'r1', { current: 'a1' }, { seq: 1, type, payload } as AgentRunEvent)
  const notices = () => useApp.getState().engineNoticesBySession.s1

  it('shows, replaces by id, and clears', () => {
    emit('status', { phase: 'engine_notice', notice })
    expect(notices()).toEqual([notice])
    emit('status', { phase: 'engine_notice', notice: { ...notice, text: { zh: '换了', en: 'changed' } } })
    expect(notices()).toHaveLength(1)
    expect(notices()[0].text.zh).toBe('换了')
    emit('status', { phase: 'engine_notice', notice: { id: notice.id, clear: true } })
    expect(notices()).toEqual([])
  })

  it('malformed ones are dropped at the door; a bad action id loses the button, not the sentence', () => {
    emit('status', { phase: 'engine_notice', notice: { id: 'has spaces', text: { zh: 'x' } } })
    emit('status', { phase: 'engine_notice', notice: { id: 'n2' } })
    expect(notices() ?? []).toEqual([])
    emit('status', { phase: 'engine_notice', notice: { id: 'n3', text: { zh: 'y' }, action: { id: '../../evil', label: { zh: 'z' } } } })
    expect(notices()).toEqual([{ id: 'n3', text: { zh: 'y', en: undefined } }])
  })

  it('the turn ending (done or error) clears them', () => {
    emit('status', { phase: 'engine_notice', notice })
    emit('done', { content: 'ok' })
    expect(notices()).toBeUndefined()
    emit('status', { phase: 'engine_notice', notice })
    emit('error', { error: 'boom' })
    expect(notices()).toBeUndefined()
  })
})
