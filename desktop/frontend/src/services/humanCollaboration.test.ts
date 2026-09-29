import { describe, expect, it } from 'vitest'
import { humanChanges } from './humanCollaboration'
import type { ToolEvent } from '../types'
const change = { id: 'f579dfd5-ff45-4d89-8a73-2c2b6b4db1cd', scope: { kind: 'agent', slug: 'xyra' }, summary: 'Use sketches', evidence: 'User feedback', at: '2026-09-29T00:00:00Z', actor: 'agent', beforeVersion: 'a'.repeat(64), afterVersion: 'b'.repeat(64) }
const event: ToolEvent = { id: 'call-1', name: 'manage_human', done: true, result: JSON.stringify({ kind: 'human_update', change }) }
describe('collaboration update receipts', () => {
  it('restores persisted receipts and deduplicates replayed events', () => { expect(humanChanges([event, event])).toEqual([change]) })
  it('ignores read/no-op/error/incomplete and foreign tool results', () => {
    expect(humanChanges([{ ...event, name: 'read_file' }, { ...event, done: false }, { ...event, isError: true }, { ...event, result: '{' }, { ...event, result: JSON.stringify({ kind: 'human_update', change: null }) }, { ...event, result: JSON.stringify({ content: '# HUMAN' }) }])).toEqual([])
  })
  it('rejects malformed or path-traversing Agent identities', () => {
    expect(humanChanges([{ ...event, result: JSON.stringify({ kind: 'human_update', change: { ...change, scope: { kind: 'agent', slug: '../other' } } }) }])).toEqual([])
  })
})
