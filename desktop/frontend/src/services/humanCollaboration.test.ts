import { describe, expect, it } from 'vitest'
import { humanChanges, humanLegacy } from './humanCollaboration'
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

describe('humanLegacy(这份是不是旧版本写的)', () => {
  const entry = (actor: 'agent' | 'user', rules?: number) => ({ id: `${actor}${rules ?? ''}`, scope: { kind: 'agent' as const, slug: 'a' }, summary: 's', evidence: '', at: '2026-10-01T00:00:00Z', actor, beforeVersion: 'x', afterVersion: 'y', canUndo: false, ...(rules ? { rules } : {}) })
  it('记录里全是没盖章的 Agent 写入才算', () => { expect(humanLegacy({ content: '我会先……', history: [entry('agent'), entry('agent')] })).toBe(true) })
  it('新版本写过一次(盖了章)就不算', () => { expect(humanLegacy({ content: '你先告诉我……', history: [entry('agent', 2), entry('agent')] })).toBe(false) })
  it('用户手改过(撤销也是用户的一条记录)不算', () => { expect(humanLegacy({ content: '我会先……', history: [entry('user'), entry('agent')] })).toBe(false) })
  it('没有记录的不判(别的设备同步过来的、直接放在磁盘上的);空文档也不提示', () => {
    expect(humanLegacy({ content: '我会先……', history: [] })).toBe(false)
    expect(humanLegacy({ content: '  ', history: [entry('agent')] })).toBe(false)
  })
})
