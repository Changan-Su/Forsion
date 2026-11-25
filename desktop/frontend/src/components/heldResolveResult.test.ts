/**
 * resolveHeld 回复的失败判别(界面接线在 Electron 台架 check:cloudheld 里看):
 *   - 成功回的同步状态恒带 error 字段(平时 null),不能当失败
 *   - 引擎状态里 error 非空(引擎级错误)也不是这次处理失败
 *   - 只有不是同步状态的错误回复(找不到绑定)才算失败
 */
import { describe, expect, it } from 'vitest'
import { isResolveHeldFailure } from './heldResolveResult'
import type { AmadeusSyncStatus } from '../types'

// 和 Forsion Extend 的 SyncStatus 同形(resolveHeld 对按条目同步的库再补上 binding)
const status = (over: Partial<AmadeusSyncStatus> = {}): AmadeusSyncStatus => ({
  enabled: true, state: 'idle', lastSyncAt: 1_764_000_000_000, pending: 0, conflicts: 0,
  skipped: [{ path: 'Notes/a.md', reason: 'HELD' }], error: null, pendingDeletions: 0, maxFileBytes: null,
  held: [{
    path: 'Notes/a.md', local: 'a.md', localHash: 'l'.padEnd(64, '0'), localSize: 12, localMtimeMs: 1_764_000_000_000,
    remoteSeq: 1, remoteHash: 'r'.padEnd(64, '0'), remoteUpdatedAt: '2026-11-13T05:37:00.000Z', since: 1_764_000_000_000,
  }],
  binding: '/vault',
  ...over,
})

describe('isResolveHeldFailure', () => {
  it('成功回的同步状态(带 error: null)不算失败', () => {
    const r = { ...status(), heldCount: 1 }
    expect('error' in r).toBe(true)
    expect(isResolveHeldFailure(r)).toBe(false)
  })

  it('找不到绑定的错误回复算失败', () => {
    expect(isResolveHeldFailure({ error: 'binding-not-found' })).toBe(true)
  })

  it('error 非空但带 state 的同步状态不算这次处理失败', () => {
    expect(isResolveHeldFailure(status({ state: 'error', error: 'network down' }))).toBe(false)
    expect(isResolveHeldFailure(status({ state: 'offline', error: 'fetch failed' }))).toBe(false)
  })

  it('没回东西不算失败', () => {
    expect(isResolveHeldFailure(null)).toBe(false)
    expect(isResolveHeldFailure(undefined)).toBe(false)
  })
})
