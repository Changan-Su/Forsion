import { afterEach, expect, it } from 'vitest'
import { useApp } from './appStore'
import { useChildChat } from './childChatStore'
import type { AgentRunEvent } from '../types'
const initial = useApp.getState()
afterEach(() => { useApp.setState(initial, true); useChildChat.setState({ sessions: {}, selected: {} }) })
it('streams full delegated output into the child without changing the main selection or parent content', () => {
  useApp.setState({ activeId: 'main', runningBySession: { main: 'parent-run' }, messagesBySession: { main: [{ id: 'parent-answer', role: 'assistant', content: 'Parent', status: 'streaming', timestamp: 1 }] }, subChatsBySession: {} })
  let seq = 0
  const emit = (type: string, payload: Record<string, unknown>) => useApp.getState().reduceEvent('main', 'parent-run', { current: 'parent-answer' }, { seq: ++seq, type, payload } as AgentRunEvent)
  const output = 'Complete tool result. '.repeat(100) + 'END'
  emit('subchat', { id: 'delegate', sessionId: 'child', title: 'Worker' })
  emit('subagent', { subId: 'delegate', sessionId: 'child', phase: 'start', label: 'Worker' })
  emit('subagent', { subId: 'delegate', phase: 'token', delta: 'Full answer' })
  emit('subagent', { subId: 'delegate', phase: 'reasoning', delta: 'Reasoning' })
  emit('subagent', { subId: 'delegate', phase: 'tool_stream', id: 'read', name: 'read_file', delta: '{"path":' })
  expect(useApp.getState().messagesBySession.child[0].toolEvents?.[0].done).toBe(false)
  emit('subagent', { subId: 'delegate', phase: 'tool', id: 'read', name: 'read_file', args: '{"path":"evidence.md"}', preview: output })
  emit('subagent', { subId: 'delegate', phase: 'done' })
  const state = useApp.getState()
  expect(state.activeId).toBe('main')
  expect(state.messagesBySession.main[0].content).toBe('Parent')
  expect(state.messagesBySession.child[0]).toMatchObject({ content: 'Full answer', reasoning: 'Reasoning', status: 'done' })
  expect(state.messagesBySession.child[0].toolEvents).toHaveLength(1)
  expect(state.messagesBySession.child[0].toolEvents?.[0]).toMatchObject({ result: output, done: true })
  expect(state.subChatsBySession.main[0]).toMatchObject({ sessionId: 'child', streaming: false })
})
