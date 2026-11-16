/**
 * 搜索来源编号:工具结果上的结构化来源(metadata.sources)在两条路上都进 ToolEvent.sources ——
 * 历史行(recordToUi)与直播 tool_result 事件;只认 web_search / web_fetch,老消息 / 别的工具没有。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent, UiMessage } from '../../types'
import { useApp } from '../../stores/appStore'
import { recordToUi } from './tanguSlice'
import '../../i18n.generated'
import './standalone'

const A = 'https://www.hokkaido-ski.jp/niseko/beginner'
const meta = { sources: [{ url: A, site: 'hokkaido-ski.jp', title: '二世谷新手指南', date: '2026-10-28', snippet: '缓坡。' }] }

describe('recordToUi', () => {
  it('落库的 metadata.sources → toolEvents[].sources;别的工具、老消息没有', () => {
    const m = recordToUi({
      id: 'x', role: 'model', content: `[缓坡](${A})`, timestamp: 1,
      tool_calls: [
        { id: 's1', function: { name: 'web_search', arguments: '{"query":"q"}' } },
        { id: 'r1', function: { name: 'read_file', arguments: '{}' } },
        { id: 's0', function: { name: 'web_search', arguments: '{"query":"old"}' } },
      ],
      tool_results: [
        { tool_call_id: 's1', content: 'text', metadata: meta },
        { tool_call_id: 'r1', content: 'text', metadata: meta },
        { tool_call_id: 's0', content: 'old text' },
      ],
    })
    expect(m.toolEvents?.map((e) => e.sources)).toEqual([meta.sources, undefined, undefined])
  })
})

const initial = useApp.getState()
describe('直播 tool_result', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useApp.setState(initial, true)
    useApp.setState({
      tr: (key) => key,
      messagesBySession: { s1: [{ id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: 1 } as UiMessage] },
      configBySession: { s1: {} }, runningBySession: { s1: 'r1' }, usageBySession: { s1: { ctx: 0, base: 10, live: 0 } },
      subChatsBySession: {}, groupVoting: {},
    })
  })
  afterEach(() => vi.useRealTimers())

  it('带 metadata 的结果落进 sources;不带的(老引擎)没有', () => {
    const ref = { current: 'a1' }
    const emit = (type: string, payload: Record<string, unknown>) => useApp.getState().reduceEvent('s1', 'r1', ref, { seq: 1, type, payload } as AgentRunEvent)
    emit('tool_call', { id: 's1', name: 'web_search', arguments: '{"query":"q"}' })
    emit('tool_result', { id: 's1', name: 'web_search', result: 'text', metadata: meta })
    emit('tool_call', { id: 's2', name: 'web_search', arguments: '{"query":"q2"}' })
    emit('tool_result', { id: 's2', name: 'web_search', result: 'text' })
    const evs = useApp.getState().messagesBySession.s1[0].toolEvents!
    expect(evs.map((e) => e.sources)).toEqual([meta.sources, undefined])
  })
})
