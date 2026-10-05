import { describe, expect, it } from 'vitest'
import { harnessChanges, harnessChangeState } from './harnessUpdates'
import type { ToolEvent } from '../types'
const change = { rev: 'f579dfd5-ff45-4d89-8a73-2c2b6b4db1cd', at: '2026-10-04T00:00:00Z', agent: 'xyra', entryId: 'h-x3k9', action: 'create', kind: 'note', title: 'Quote first', body: 'Quote the line, then conclude.', evidence: 'Corrected on 10-04', version: 1 }
const event: ToolEvent = { id: 'call-1', name: 'manage_harness', done: true, result: JSON.stringify({ kind: 'harness_update', change, message: 'Applied' }) }
const withChange = (patch: Record<string, unknown>): ToolEvent => ({ ...event, result: JSON.stringify({ kind: 'harness_update', change: { ...change, ...patch } }) })
describe('working-note update receipts', () => {
  it('restores persisted receipts and deduplicates replayed events', () => { expect(harnessChanges([event, event])).toEqual([change]) })
  it('ignores list/propose/error/incomplete and foreign tool results', () => {
    expect(harnessChanges([{ ...event, name: 'manage_human' }, { ...event, done: false }, { ...event, isError: true }, { ...event, result: '(evolution record is empty)' },
      { ...event, result: JSON.stringify({ kind: 'human_update', change }) }, { ...event, result: JSON.stringify({ kind: 'harness_update', change: null }) }])).toEqual([])
  })
  it('carries the shelved names of an equip entry and rejects a malformed list', () => {
    expect(harnessChanges([withChange({ kind: 'equip', tools: ['sketch'], skills: ['local:pptx'] })])[0]).toMatchObject({ kind: 'equip', tools: ['sketch'], skills: ['local:pptx'] })
    expect(harnessChanges([withChange({ kind: 'equip', tools: 'sketch' }), withChange({ kind: 'equip', skills: [1] })])).toEqual([])
  })
  it('rejects malformed identities and unknown actions', () => {
    expect(harnessChanges([withChange({ agent: '../other' }), withChange({ entryId: 'a/b' }), withChange({ rev: 'x' }), withChange({ action: 'wipe' }), withChange({ version: '1' })])).toEqual([])
  })
})
describe('card state from the edit journal', () => {
  const line = (rev: string, action = 'upsert', entryId = 'h-x3k9') => ({ rev, action, entryId })
  it('is undoable only while it is the last change to its entry', () => {
    expect(harnessChangeState([line('other', 'upsert', 'h-zzzz'), line(change.rev), line('later', 'upsert', 'h-zzzz')], change as any)).toBe('current')
    expect(harnessChangeState([line(change.rev), line('later')], change as any)).toBe('superseded')
  })
  it('reads one trailing restore as undone, and anything after that as superseded', () => {
    expect(harnessChangeState([line(change.rev), line('u', 'rollback')], change as any)).toBe('undone')
    expect(harnessChangeState([line(change.rev), line('u', 'rollback'), line('r', 'rollback')], change as any)).toBe('superseded')
  })
  it('never offers undo when the journal does not know this change (another device, truncated history, older engine)', () => {
    expect(harnessChangeState([], change as any)).toBe('superseded')
    expect(harnessChangeState([{ action: 'upsert', entryId: 'h-x3k9' }], change as any)).toBe('superseded')
  })
})
