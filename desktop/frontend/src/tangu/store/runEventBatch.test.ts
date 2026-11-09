import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunEventBatch } from './runEventBatch'
import type { AgentRunEvent } from '../../../../../tangu-agent/src/contracts/clientTypes'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const event = (seq: number, type = 'token', delta = String(seq), extra = {}): AgentRunEvent => ({ seq, type, payload: { delta, ...extra } })

describe('UI delta batching', () => {
  it('shows the first delta immediately, bounds update rate, and preserves every character', () => {
    const got: AgentRunEvent[] = []
    const b = createRunEventBatch((e) => got.push(e))
    for (let i = 0; i < 100; i++) { b.push(event(i, 'token', `🪷${i},`)); vi.advanceTimersByTime(1) }
    expect(got.length).toBe(3)
    expect(got[0].seq).toBe(0)
    vi.advanceTimersByTime(40)
    expect(got.map((e) => e.payload.delta).join('')).toBe(Array.from({ length: 100 }, (_, i) => `🪷${i},`).join(''))
    expect(got.at(-1)?.seq).toBe(99)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['approval_request', 'inquiry', 'tool_call', 'tool_result', 'turn_boundary', 'done', 'error'])('flushes synchronously BEFORE %s', (type) => {
    const got: AgentRunEvent[] = []
    const b = createRunEventBatch((e) => got.push(e))
    b.push(event(1)); b.push(event(2)); b.push(event(3)); b.push({ seq: 4, type, payload: {} })
    expect(got.map((e) => [e.type, e.payload.delta])).toEqual([['token', '1'], ['token', '23'], [type, undefined]])
    vi.runAllTimers()
    expect(got).toHaveLength(3)
  })
  it('does not mix reasoning, tool ids, names or metadata and does not mutate transport events', () => {
    const got: AgentRunEvent[] = []
    const b = createRunEventBatch((e) => got.push(e))
    const events = [event(1), event(2, 'reasoning'), event(3, 'tool_stream', 'a', { id: 'a', name: 'edit' }),
      event(4, 'tool_stream', 'b', { id: 'b', name: 'edit' }), event(5, 'tool_stream', 'c', { id: 'b', name: 'edit' }),
      event(6, 'tool_stream', 'd', { id: 'b', name: 'write' }), event(7, 'tool_stream', 'e', { id: 'b', name: 'write', flag: true })]
    const original = structuredClone(events)
    events.forEach(b.push); b.close()
    expect(events).toEqual(original)
    expect(got.map((e) => e.payload.delta)).toEqual(['1', '2', 'a', 'bc', 'd', 'e'])
  })
  it('flushes once on abort/close, ignores late callbacks, and tolerates reentrant close', () => {
    const got: AgentRunEvent[] = []
    const b = createRunEventBatch((e) => { got.push(e); if (e.type === 'done') b.close() })
    b.push(event(1)); b.push(event(2)); b.push(event(3)); b.close(); b.close(); b.push(event(4))
    vi.runAllTimers()
    expect(got.map((e) => e.payload.delta).join('')).toBe('123')
    expect(vi.getTimerCount()).toBe(0)
    const c = createRunEventBatch((e) => { got.push(e); c.close() })
    c.push({ seq: 5, type: 'done' }); c.close()
    expect(got.at(-1)?.type).toBe('done')
  })
  it('never reorders when a busy renderer delays the timer past its deadline', () => {
    const got: AgentRunEvent[] = []
    const b = createRunEventBatch((e) => got.push(e))
    b.push(event(1)); b.push(event(2))
    vi.setSystemTime(Date.now() + 100)
    b.push(event(3)); b.close()
    expect(got.map((e) => e.payload.delta).join('')).toBe('123')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('batches delegated streams independently and keeps start/done as barriers', () => {
    const got: AgentRunEvent[] = []
    const b = createRunEventBatch((e) => got.push(e))
    b.push(event(0, 'subagent', '', { phase: 'start', subId: 'a' }))
    b.push(event(1, 'subagent', 'a', { phase: 'token', subId: 'a', messageId: 'm1' }))
    b.push(event(2, 'subagent', 'b', { phase: 'token', subId: 'a', messageId: 'm1' }))
    b.push(event(3, 'subagent', 'c', { phase: 'token', subId: 'b', messageId: 'm2' }))
    b.push(event(4, 'subagent', '', { phase: 'done', subId: 'b' }))
    expect(got.map((e) => [e.payload.subId, e.payload.phase, e.payload.delta])).toEqual([
      ['a', 'start', ''], ['a', 'token', 'ab'], ['b', 'token', 'c'], ['b', 'done', ''],
    ])
  })
})
