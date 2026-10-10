import { describe, expect, it } from 'vitest'
import { anchorTraces, isSelfWriteReceipt, memoryChanges, sessionTraces } from './selfUpdates'
import type { HistorianActivityItem, ToolEvent } from '../types'

const receipt = (patch: Record<string, unknown> = {}) => JSON.stringify({ ok: true, action: 'add', scope: 'agent', version: 'v2', entry: { id: 'm-1', content: 'Commit messages carry no trailer.' }, count: 3, chars: 120, limit: 4000, ...patch })
const event = (result: string, patch: Partial<ToolEvent> = {}): ToolEvent => ({ id: 'call-1', name: 'remember', done: true, result, ...patch })

describe('memory receipts', () => {
  it('restores a saved fact with its scope and entry, and deduplicates replayed events', () => {
    expect(memoryChanges([event(receipt()), event(receipt())])).toEqual([{ callId: 'call-1', action: 'add', scope: 'agent', entryId: 'm-1', content: 'Commit messages carry no trailer.' }])
    expect(memoryChanges([event(receipt({ scope: 'project', project: 'Forsion' }))])[0]).toMatchObject({ scope: 'project', project: 'Forsion' })
  })
  it('keeps an update and a forget apart from an add', () => {
    expect(memoryChanges([event(receipt({ action: 'update' }))])[0].action).toBe('update')
    expect(memoryChanges([event(receipt({ action: 'forget', entry: undefined, id: 'm-9' }))])).toEqual([{ callId: 'call-1', action: 'forget', scope: 'agent', entryId: 'm-9', content: '' }])
  })
  it('ignores what did not write: duplicates, list, errors, plain-text receipts, unfinished and foreign calls', () => {
    expect(memoryChanges([
      event(receipt({ duplicate: true })),
      event(JSON.stringify({ version: 'v1', entries: [] })),
      event('Error: fact is required for add'),
      event('已记入长期记忆。'),
      event(receipt(), { done: false }),
      event(receipt(), { isError: true }),
      event(receipt(), { name: 'log_event' }),
      event(receipt({ entry: undefined })),
      event(receipt({ scope: 'global' })),
    ])).toEqual([])
  })
})

describe('tool rows already shown as a receipt', () => {
  it('hides only the calls that produced a receipt', () => {
    expect(isSelfWriteReceipt(event(receipt()))).toBe(true)
    expect(isSelfWriteReceipt(event('Error: memory is full'))).toBe(false)
    expect(isSelfWriteReceipt(event(receipt(), { done: false }))).toBe(false)
    expect(isSelfWriteReceipt(event(receipt(), { name: 'read_file' }))).toBe(false)
    expect(isSelfWriteReceipt({ id: 'h', name: 'manage_harness', done: true, result: '(evolution record is empty)' })).toBe(false)
  })
})

describe('background traces', () => {
  const act = (action: string, detail: string, created_at = '2026-10-10 09:00:10'): HistorianActivityItem => ({ id: `a-${action}`, action, detail, session_ref: 's-1', created_at })
  it('reads the engine timestamp as UTC, with or without a zone', () => {
    const utc = Date.UTC(2026, 9, 10, 9, 0, 10)
    expect(sessionTraces([act('project_memory_added', 'Logs are append-only')])[0].at).toBe(utc)
    expect(sessionTraces([act('project_memory_added', 'x', '2026-10-10T09:00:10.000Z')])[0].at).toBe(utc)
  })
  it('keeps only the writes worth a line and splits their items', () => {
    const traces = sessionTraces([act('title_updated', 'A title'), act('log_appended', 'did x'), act('memory_candidates', 'a | b'),
      act('project_memory_added', 'one | two'), act('project_memory_compacted', '12 -> 5')])
    expect(traces.map((t) => [t.kind, t.items])).toEqual([['project_memory_added', ['one', 'two']], ['project_memory_compacted', []]])
  })
  it('gives one line per adopted note and finds its undo handle among this session’s writes of the same review pass', () => {
    const line = (rev: string, entryId: string, title: string, patch: Record<string, unknown> = {}) => ({ ts: '2026-10-10T09:00:09Z', rev, action: 'upsert', entryId, after: { title }, by: 'historian', sessionId: 's-1', ...patch })
    const journal = [line('r-other', 'h-0', 'Run the check first', { sessionId: 's-2' }), line('r-1', 'h-1', 'Run the check first'), line('r-2', 'h-2', 'Quote the line')]
    const traces = sessionTraces([act('harness_adopted', 'Run the check first | Quote the line')], journal, 's-1')
    expect(traces.map((t) => [t.items, t.undo])).toEqual([
      [['Run the check first'], { entryId: 'h-1', rev: 'r-1', state: 'current' }],
      [['Quote the line'], { entryId: 'h-2', rev: 'r-2', state: 'current' }],
    ])
    const undone = sessionTraces([act('harness_adopted', 'Run the check first | Quote the line')], [...journal, { ts: '2026-10-10T09:05:00Z', rev: 'r-9', action: 'rollback', entryId: 'h-1', after: null }], 's-1')
    expect(undone[0].undo?.state).toBe('undone')
  })
  it('offers no undo when the match is not certain: it must never reach another entry', () => {
    const line = (rev: string, entryId: string, title: string, patch: Record<string, unknown> = {}) => ({ ts: '2026-10-10T09:00:09Z', rev, action: 'upsert', entryId, after: { title }, by: 'historian', sessionId: 's-1', ...patch })
    const none = (detail: string, journal: ReturnType<typeof line>[]) => sessionTraces([act('harness_adopted', detail)], journal, 's-1').every((t) => !t.undo)
    // 新条目的标题里自带「 | 」,拆出来的前半截恰好是早先一条的标题
    expect(none('Run checks | Save evidence', [line('r-old', 'h-old', 'Run checks', { ts: '2026-10-09T09:00:00Z' }), line('r-new', 'h-new', 'Run checks | Save evidence')])).toBe(true)
    // 同名的那一笔是别的轮次写的(会话换过 Agent、或很久以前)
    expect(none('Run checks', [line('r-old', 'h-old', 'Run checks', { ts: '2026-10-10T08:00:00Z' })])).toBe(true)
    // Agent 自己在前台写的、用户手改的,都不是后台采纳的那一笔
    expect(none('Run checks', [line('r-a', 'h-a', 'Run checks', { by: undefined }), line('r-u', 'h-u', 'Run checks', { by: 'user' })])).toBe(true)
    // 同一轮里两笔同名:分不清是哪一笔
    expect(none('Run checks', [line('r-a', 'h-a', 'Run checks'), line('r-b', 'h-b', 'Run checks')])).toBe(true)
  })
  it('anchors a trace to the last reply that existed when it happened, and drops it when there is none', () => {
    const t0 = Date.UTC(2026, 9, 10, 9, 0, 0)
    const messages = [{ id: 'u1', role: 'user', timestamp: t0 }, { id: 'a1', role: 'assistant', timestamp: t0 + 1000 },
      { id: 'u2', role: 'user', timestamp: t0 + 60_000 }, { id: 'a2', role: 'assistant', timestamp: t0 + 61_000 }]
    const trace = (id: string, at: number) => ({ id, kind: 'project_memory_added' as const, at, items: ['x'] })
    const map = anchorTraces(messages, [trace('early', t0 + 10_000), trace('late', t0 + 70_000), trace('before', t0 - 5)])
    expect([...map.entries()].map(([k, v]) => [k, v.map((t) => t.id)])).toEqual([['a1', ['early']], ['a2', ['late']]])
    // 活动流的时刻只到秒:回复在 .100、留痕记成同一秒的 .000,仍落在这条回复上
    expect([...anchorTraces([{ id: 'a9', role: 'assistant', timestamp: t0 + 100 }], [trace('same-second', t0)]).keys()]).toEqual(['a9'])
  })
})
