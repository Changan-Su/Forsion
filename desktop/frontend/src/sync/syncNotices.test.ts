/** 同步通知只在转移时弹、首次读到不弹;同步记录那句话;远程服务报告里的问题怎么分。 */
import { describe, expect, it } from 'vitest'
import { remoteReportProblems, type SyncFeedReport, type SyncRoundRecord } from '../../../shared/vaultSync'
import { takeSyncNotices } from './syncNotices'
import { recordFeedLabel, recordSummary } from './vaultSyncText'

const t = (k: string, v?: Record<string, string | number>): string => (v ? `${k}${JSON.stringify(v)}` : k)
const feed = (over: Partial<SyncFeedReport> = {}): SyncFeedReport => ({
  id: 'content', engine: 'content', vault: { root: '/v/Notes', side: 'local' }, target: 'penzor', scope: { kind: 'vault' },
  phase: 'idle', progress: null, lastSyncAt: 1, pendingChanges: 0, rateLimitedUntil: null, review: [], failures: [], error: null, canSyncNow: true,
  ...over,
})

describe('sync notices', () => {
  it('first sighting is silent, even with errors and failures already there', () => {
    const { notices } = takeSyncNotices(null, [feed({ phase: 'error', error: 'x', failures: [{ path: 'a.md', reason: 'failed' }] })])
    expect(notices).toEqual([])
  })

  it('failures that appear during a round are told once, when the round ends, naming the file', () => {
    let { memo } = takeSyncNotices(null, [feed()])
    const mid = takeSyncNotices(memo, [feed({ phase: 'transferring', failures: [{ path: 'big.mp4', reason: 'too-large', maxBytes: 5 << 20 }] })])
    expect(mid.notices).toEqual([])
    const end = takeSyncNotices(mid.memo, [feed({ phase: 'idle', failures: [{ path: 'big.mp4', reason: 'too-large', maxBytes: 5 << 20 }] })])
    expect(end.notices.map((n) => n.kind)).toEqual(['failed', 'done'])
    expect(end.notices[0]).toMatchObject({ failures: [{ path: 'big.mp4' }] })
    memo = end.memo
    // 下一轮同一个文件还是没传上:不再弹
    const again = takeSyncNotices(memo, [feed({ phase: 'idle', failures: [{ path: 'big.mp4', reason: 'too-large' }] })])
    expect(again.notices).toEqual([])
  })

  it('entering error and getting review items are told once; the remote feed is left to its own report', () => {
    const { memo } = takeSyncNotices(null, [feed(), feed({ id: 'remote', engine: 'remote' })])
    const r = takeSyncNotices(memo, [
      feed({ phase: 'error', error: 'boom', review: [{ kind: 'differs', path: 'a.md', newer: 'local', ref: { feed: 'content' } }] }),
      feed({ id: 'remote', engine: 'remote', phase: 'error', error: 'x' }),
    ])
    expect(r.notices.map((n) => n.kind)).toEqual(['error', 'review'])
    expect(takeSyncNotices(r.memo, [feed({ phase: 'error', error: 'boom', review: [{ kind: 'differs', path: 'a.md', newer: 'local', ref: { feed: 'content' } }] })]).notices).toEqual([])
  })
})

const rec = (over: Partial<SyncRoundRecord> = {}): SyncRoundRecord => ({
  id: 'r', feed: 'content', engine: 'content', vault: '/v/Notes', target: 'penzor', startedAt: 0, finishedAt: 66_000, completed: true,
  uploaded: 0, downloaded: 0, merged: 0, renamed: 0, deletedCloud: 0, deletedLocal: 0, held: 0, failed: [], failedCount: 0, ...over,
})

describe('record summary', () => {
  it('one line per round, in the order the proposal shows', () => {
    expect(recordSummary(rec({ uploaded: 3, downloaded: 1 }), t)).toBe('vsync.rec.uploaded{"n":3} · vsync.rec.downloaded{"n":1}')
    expect(recordSummary(rec(), t)).toBe('vsync.rec.idle')
    expect(recordSummary(rec({ uploaded: 12, failedCount: 1 }), t)).toBe('vsync.rec.uploaded{"n":12} · vsync.rec.failed{"n":1}')
    expect(recordSummary(rec({ first: true, uploaded: 471 }), t)).toBe('vsync.rec.first · vsync.rec.uploaded{"n":471} · vsync.rec.took{"d":"vsync.rec.minSec{\\"m\\":1,\\"s\\":\\"06\\"}"}')
    expect(recordSummary(rec({ completed: false, uploaded: 2 }), t)).toBe('vsync.rec.uploaded{"n":2} · vsync.rec.stopped')
  })
  it('labels which feed a row belongs to', () => {
    expect(recordFeedLabel(rec(), t)).toBe('vsync.rec.feed{"name":"Notes","target":"vsync.target.penzor"}')
    expect(recordFeedLabel(rec({ feed: 'legacy:mirror', vault: null }), t)).toBe('vsync.rec.feed{"name":"vsync.rec.mirror","target":"vsync.target.penzor"}')
  })
})

describe('remote report problems', () => {
  it('per-file errors name the file; round-level errors are not dressed up as files', () => {
    const r = remoteReportProblems({
      skippedLarge: ['video/a.mov'],
      errors: ['push Course A/L1.md: HTTP 500', 'unsafe remote key skipped: "../x"', 'setup: ENOTFOUND', 'save state: EACCES'],
    })
    expect(r.failures).toEqual([
      { path: 'video/a.mov', reason: 'too-large' },
      { path: 'Course A/L1.md', reason: 'failed', code: 'HTTP 500' },
      { path: '../x', reason: 'invalid-name' },
    ])
    expect(r.roundErrors).toEqual(['setup: ENOTFOUND', 'save state: EACCES'])
  })
})
