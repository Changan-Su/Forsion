import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { finishedReplyCount, tailTodoOf } from './tailTodo'
import { summarizeTask } from './taskFacts'
import { todosFromArgs } from '../../tangu/store/tanguSlice'

type St = 'pending' | 'in_progress' | 'completed'
const list = (...s: St[]) => s.map((status, i) => ({ content: `step ${i + 1}`, status }))
const u = (id: string): UiMessage => ({ id, role: 'user', content: id, status: 'done', timestamp: 0 })
const a = (id: string, extra: Partial<UiMessage> = {}): UiMessage => ({ id, role: 'assistant', content: id, status: 'done', timestamp: 0, ...extra })

describe('tailTodoOf: only this turn\'s list goes to the tail', () => {
  it('a finished list stays in its own answer while an unrelated next turn runs', () => {
    const msgs = [u('u1'), a('a1', { todos: list('completed', 'completed') }), u('u2'), a('a2', { status: 'streaming' })]
    expect(tailTodoOf(msgs, true)).toBeNull()
  })
  it('a stopped half-done list does not follow an unrelated next turn either (B1)', () => {
    const msgs = [u('u1'), a('a1', { status: 'stopped', todos: list('completed', 'in_progress') }), u('u2'), a('a2', { status: 'streaming' })]
    expect(tailTodoOf(msgs, true)).toBeNull()
  })
  it('the running answer\'s own list is in the tail', () => {
    const msgs = [u('u1'), a('a1', { status: 'streaming', todos: list('completed', 'in_progress') })]
    expect(tailTodoOf(msgs, true)?.id).toBe('a1')
  })
  it('an emptied list (todo_write([])) means no list this turn, not "look further back"', () => {
    const msgs = [u('u1'), a('a1', { todos: list('in_progress') }), u('u2'), a('a2', { status: 'streaming', todos: [] })]
    expect(tailTodoOf(msgs, true)).toBeNull()
  })
  it('idle: the last answer\'s unfinished list stays in the tail; a finished one does not', () => {
    expect(tailTodoOf([u('u1'), a('a1', { status: 'stopped', todos: list('completed', 'in_progress') })], false)?.id).toBe('a1')
    expect(tailTodoOf([u('u1'), a('a1', { todos: list('completed', 'completed') })], false)).toBeNull()
    expect(tailTodoOf([u('u1'), a('a1', { todos: list('in_progress') }), u('u2'), a('a2')], false)).toBeNull()
  })
  it('idle: hidden rows (team summary) are skipped when finding the last answer', () => {
    const msgs = [u('u1'), a('a1', { todos: list('in_progress') }), a('sum', { teamSummary: true })]
    expect(tailTodoOf(msgs, false, (m) => !!m.teamSummary)?.id).toBe('a1')
  })
})

describe('right panel progress follows the same per-turn rule', () => {
  it('a new turn without a list shows no list', () => {
    const msgs = [u('u1'), a('a1', { todos: list('completed', 'completed') }), u('u2'), a('a2', { status: 'streaming' })]
    expect(summarizeTask(msgs, true).todos).toEqual([])
  })
  it('a steered segment carries the list after the injected user message', () => {
    const msgs = [u('u1'), a('a1'), u('steer'), a('a2', { status: 'streaming', todos: list('completed', 'in_progress') })]
    expect(summarizeTask(msgs, true).todos).toHaveLength(2)
  })
})

describe('finishedReplyCount', () => {
  it('counts only finished visible answers', () => {
    const msgs = [u('u1'), a('a1'), a('sum', { teamSummary: true }), a('sys', { role: 'system' } as any), u('u2'), a('a2', { status: 'streaming', content: '' })]
    expect(finishedReplyCount(msgs, (m) => !!m.teamSummary)).toBe(1)
    expect(finishedReplyCount([u('u1'), a('err', { content: '', status: 'error' })], () => false)).toBe(0)
  })
})

describe('todosFromArgs (rebuild the list from history)', () => {
  it('parses a well-formed todo_write call, including an empty list', () => {
    expect(todosFromArgs(JSON.stringify({ todos: list('completed', 'pending') }))).toEqual(list('completed', 'pending'))
    expect(todosFromArgs(JSON.stringify({ todos: [] }))).toEqual([])
  })
  it('treats unparsable arguments as "not written", never as an empty list', () => {
    expect(todosFromArgs('{"todos": [{"content": "x"')).toBeUndefined()
    expect(todosFromArgs(JSON.stringify({ plan: 'x' }))).toBeUndefined()
  })
  it('normalizes like the engine (unknown status -> pending, empty content dropped) so history matches the live list', () => {
    expect(todosFromArgs(JSON.stringify({ todos: [{ content: 'x', status: 'weird' }, { content: '', status: 'completed' }] }))).toEqual([{ content: 'x', status: 'pending' }])
  })
})

describe('recordToUi rebuilds the list from todo_write', () => {
  it('takes the last successful todo_write in the answer', async () => {
    const { recordToUi } = await import('../../tangu/store/tanguSlice')
    const call = (id: string, todos: unknown) => ({ id, type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos }) } })
    const m = recordToUi({ id: 'h', role: 'model', content: 'done', timestamp: 1,
      tool_calls: [call('c1', list('in_progress', 'pending')), call('c2', list('completed', 'completed')), call('c3', list('pending'))],
      tool_results: [{ tool_call_id: 'c1', content: 'ok' }, { tool_call_id: 'c2', content: 'ok' }, { tool_call_id: 'c3', content: 'Error: x', isError: true }] })
    expect(m.todos).toEqual(list('completed', 'completed'))
  })
})

describe('continuation rows do not start a new turn', () => {
  const machine = (id: string, content: string): UiMessage => ({ id, role: 'user', content, status: 'done', timestamp: 0 })
  it('an unfinished list keeps following through an approval-update continuation run', () => {
    const msgs = [u('u1'), a('a1', { todos: list('completed', 'in_progress') }), machine('m', '<approval_update>\nok'), a('a2', { status: 'streaming' })]
    expect(tailTodoOf(msgs, true)?.id).toBe('a1')
    expect(summarizeTask(msgs, true).todos).toHaveLength(2)
  })
  it('a finished list still stays home during a continuation run', () => {
    const msgs = [u('u1'), a('a1', { todos: list('completed', 'completed') }), machine('m', '<inquiry_update>\nx'), a('a2', { status: 'streaming' })]
    expect(tailTodoOf(msgs, true)).toBeNull()
  })
})
