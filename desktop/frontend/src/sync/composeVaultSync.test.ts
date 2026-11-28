/**
 * 智库同步的状态源(智库同步统一方案 2026-11-27 第 1 步):三套引擎的原始状态 → feed → 一个库此刻的状态与说法。
 * 用户原来那句抱怨:开着旧同步的机器,界面却显示「未开」。这里每种组合都钉住。
 */
import { describe, expect, it } from 'vitest'
import { composeVaultSync, type SyncFeedReport } from '../../../shared/vaultSync'
import type { AmadeusEntrySyncVault, AmadeusSyncStatus } from '../types'
import { feedsOf } from './vaultSyncStore'
import { failureText, vaultSyncWords } from './vaultSyncText'
import type { ContentStatusLite } from './feeds'

const ROOT = '/Users/me/Documents/Notes'
const LOCAL = { root: ROOT, side: 'local' as const }
const CLOUD = { root: null, side: 'cloud' as const }
const t = (k: string, v?: Record<string, string | number>): string => (v ? `${k}${JSON.stringify(v)}` : k)

const status = (over: Partial<AmadeusSyncStatus> = {}): AmadeusSyncStatus => ({
  enabled: true, state: 'idle', lastSyncAt: 1_000, pending: 0, conflicts: 0, skipped: [], error: null, pendingDeletions: 0, held: [], ...over,
})
/** 4 个页面条目 + 2 个资源条目 */
const entryVault: AmadeusEntrySyncVault = {
  vaultRoot: ROOT, cloudName: 'Notes',
  entries: [
    { path: 'A.md', kind: 'page' }, { path: 'B.md', kind: 'page' }, { path: 'C.md', kind: 'page' }, { path: 'D.md', kind: 'page' },
    { path: 'attachments', kind: 'asset' }, { path: 'img.png', kind: 'asset' },
  ],
}
const contentOff: ContentStatusLite = { session: true, owned: false, enabled: false, paused: false, running: false, phase: 'idle', notes: null, lastSyncAt: null, pending: 0, round: null }
const contentOn = (over: Partial<ContentStatusLite> = {}): ContentStatusLite => ({
  session: true, owned: true, enabled: true, paused: false, running: false, phase: 'idle', notes: { kind: 'vault' }, lastSyncAt: 5_000, pending: 0, round: null, ...over,
})
const raw = (over: Partial<Parameters<typeof feedsOf>[0]> = {}): Parameters<typeof feedsOf>[0] => ({
  legacy: {}, entryVaults: [], content: null, remote: null, pinnedRoot: ROOT, ...over,
})
const view = (feeds: SyncFeedReport[], vault: { root: string | null; side: 'local' | 'cloud' } = LOCAL, now = 10_000) => composeVaultSync(feeds, vault, now)

describe('only the old folder / entry sync is on (the reported machine)', () => {
  const legacy = {
    'legacy:mirror': status(),
    [`legacy:entry:${ROOT}`]: status({
      binding: ROOT, state: 'syncing', ownPendingDeletions: 0,
      round: { startedAt: 9_000, stage: 'transferring', files: { done: 2, total: 6 }, bytes: { done: 2048, total: 8192 }, current: { path: 'Notes/C.md', op: 'upload', bytesDone: 100, bytesTotal: 400 } },
    }),
  }
  it('shows syncing with its scope (6 selected items), not "off"', () => {
    const v = view(feedsOf(raw({ legacy, entryVaults: [entryVault], content: contentOff })))
    expect(v.state).toBe('syncing')
    expect(v.scope).toEqual({ kind: 'items', count: 6 })
    expect(v.progress).toMatchObject({ files: { done: 2, total: 6 }, bytes: { done: 2048, total: 8192 } })
    expect(v.progress?.current).toMatchObject({ path: 'C.md', op: 'upload' }) // 服务端路径的「<云名>/」剥掉
    expect(vaultSyncWords(v, 10_000, t).text).toBe('vsync.syncingCount{"done":2,"total":6}')
    expect(vaultSyncWords(v, 10_000, t).short).toEqual({ kind: 'ring', pct: 33 })
  })
  it('idle afterwards reads "synced · n min ago"', () => {
    const idle = { ...legacy, [`legacy:entry:${ROOT}`]: status({ binding: ROOT, lastSyncAt: 10_000 - 120_000 }) }
    const v = view(feedsOf(raw({ legacy: idle, entryVaults: [entryVault], content: contentOff })))
    expect(v.state).toBe('synced')
    expect(vaultSyncWords(v, 10_000, t).text).toBe('vsync.synced{"ago":"vsync.ago.min{\\"n\\":2}"}')
  })
  it('old Extend: an entry sync we have no status for yet counts as on — not "this computer only", not "synced" either', () => {
    const v = view(feedsOf(raw({ legacy: { 'legacy:mirror': status() }, entryVaults: [entryVault], content: contentOff })))
    expect(v.state).toBe('on')
    expect(vaultSyncWords(v, 10_000, t).text).toBe('vsync.on')
    expect(v.scope).toEqual({ kind: 'items', count: 6 })
    const signedOut = view(feedsOf(raw({ legacy: { 'legacy:mirror': status({ state: 'auth-required', error: 'not-logged-in' }) }, entryVaults: [entryVault] })))
    expect(signedOut.state).toBe('signed-out')
    const masterOff = view(feedsOf(raw({ legacy: { 'legacy:mirror': status({ enabled: false, state: 'disabled' }) }, entryVaults: [entryVault] })))
    expect(masterOff.state).toBe('off')
  })
})

describe('only the new content sync is on', () => {
  it('serves the pinned vault: synced, whole vault', () => {
    const v = view(feedsOf(raw({ legacy: { 'legacy:mirror': status() }, content: contentOn() })))
    expect(v.state).toBe('synced')
    expect(v.scope).toEqual({ kind: 'vault' })
    expect(v.lastSyncAt).toBe(5_000)
    expect(v.feeds.map((f) => f.id)).toEqual(['content'])
  })
  it('does not serve a vault it is not pinned to', () => {
    expect(view(feedsOf(raw({ content: contentOn(), pinnedRoot: '/elsewhere' }))).state).toBe('off')
  })
  it('notes not in its rules: it serves no vault, but its errors still surface elsewhere', () => {
    const v = view(feedsOf(raw({ content: contentOn({ notes: null, error: 'boom' }) })))
    expect(v.state).toBe('off')
    expect(v.elsewhere.errors).toBe(1)
  })
  it('a round in progress: checking, then a total with the current file and its bytes', () => {
    const checking = view(feedsOf(raw({ content: contentOn({ running: true, phase: 'scanning', round: { startedAt: 1, stage: 'checking', files: { done: 0, total: null }, bytes: null, current: null } }) })))
    expect(checking.state).toBe('checking')
    expect(vaultSyncWords(checking, 10_000, t)).toMatchObject({ text: 'vsync.checking', short: { kind: 'ring', pct: null } })
    const running = view(feedsOf(raw({ content: contentOn({
      running: true, phase: 'syncing',
      round: { startedAt: 1, stage: 'transferring', files: { done: 132, total: 475 }, bytes: { done: 86 << 20, total: null }, current: { path: 'Amadeus/Course A/L07.md', op: 'upload', bytesDone: 10, bytesTotal: 20 } },
    }) })))
    expect(running.state).toBe('syncing')
    expect(running.progress?.files).toEqual({ done: 132, total: 475 })
    expect(running.progress?.bytes).toEqual({ done: 86 << 20, total: null }) // 总字节数不出来:null,界面不画那一段
    expect(running.progress?.current?.path).toBe('Course A/L07.md')
    expect(vaultSyncWords(running, 10_000, t).text).toBe('vsync.syncingCount{"done":132,"total":475}')
  })
  it('old Extend snapshot (no round): the active job is the current file, total unknown', () => {
    const v = view(feedsOf(raw({ content: { ...contentOn(), notes: undefined, config: { enabled: true, rules: [{ source: '', target: 'default' }] }, round: undefined, running: true, phase: 'syncing',
      jobs: [{ path: 'Amadeus/x.md', direction: 'download', state: 'active', done: 5, size: 9 }] } })))
    expect(v.state).toBe('syncing')
    expect(v.progress).toMatchObject({ files: { done: 0, total: null }, current: { path: 'x.md', op: 'download', bytesDone: 5, bytesTotal: 9 } })
    expect(vaultSyncWords(v, 10_000, t).text).toBe('vsync.syncing')
  })
  it('a server rate limit is a wait, not an error', () => {
    const v = view(feedsOf(raw({ content: contentOn({ running: true, phase: 'syncing', rateLimitedUntil: 28_000,
      round: { startedAt: 1, stage: 'transferring', files: { done: 1, total: 4 }, bytes: null, current: null } }) })), LOCAL, 10_000)
    expect(v.state).toBe('syncing')
    expect(v.rateLimitedUntil).toBe(28_000)
  })
})

describe('neither is on', () => {
  it('a local vault reads "this computer only" even though the account mirror runs (it is on by default)', () => {
    const feeds = feedsOf(raw({ legacy: { 'legacy:mirror': status() }, content: contentOff }))
    expect(view(feeds).state).toBe('off')
    expect(vaultSyncWords(view(feeds), 10_000, t).text).toBe('vsync.off')
    expect(view(feeds, CLOUD).state).toBe('synced') // 云侧那一行才认镜像
  })
  it('no feeds at all (web / mobile, or before anything loaded)', () => {
    expect(view([]).state).toBe('off')
  })
})

describe('to review', () => {
  it('new sync: blocked deletions are listed with their token and can be restored', () => {
    const v = view(feedsOf(raw({ content: contentOn({ deletes: { latched: true, pending: 12, token: 'tok', items: [{ path: 'Amadeus/a.md', side: 'cloud' }] } }) })))
    expect(v.state).toBe('review')
    expect(v.review).toEqual([expect.objectContaining({ kind: 'deletes', count: 12, canRestore: true, accountWide: false, items: [{ path: 'a.md', side: 'cloud' }], ref: { feed: 'content', token: 'tok' } })])
    expect(vaultSyncWords(v, 10_000, t)).toMatchObject({ text: 'vsync.reviewItems{"n":12}', short: { kind: 'dot', n: 12 }, tone: 'warning' })
  })
  it('old sync: held files are "differs" with the binding handed back; HELD is not a failure', () => {
    const held = [{ path: 'Notes/L07.md', local: 'L07.md', localHash: 'a', localSize: 1, localMtimeMs: 9_000, remoteSeq: 1, remoteHash: 'b', remoteUpdatedAt: new Date(1_000).toISOString(), since: 1 }]
    const legacy = { [`legacy:entry:${ROOT}`]: status({ binding: ROOT, held, skipped: [{ path: 'Notes/L07.md', reason: 'HELD' }] }) }
    const v = view(feedsOf(raw({ legacy, entryVaults: [entryVault] })))
    expect(v.state).toBe('review')
    expect(v.failures).toEqual([])
    expect(v.review[0]).toMatchObject({ kind: 'differs', path: 'L07.md', newer: 'local', ref: { binding: ROOT, serverPath: 'Notes/L07.md' } })
    expect(vaultSyncWords(v, 10_000, t).text).toBe('vsync.review{"n":1}')
  })
  it('old sync deletions: attributed to the engine that holds them; old Extend counts the total once, on the mirror', () => {
    const own = feedsOf(raw({ legacy: {
      'legacy:mirror': status({ pendingDeletions: 7, ownPendingDeletions: 0 }),
      [`legacy:entry:${ROOT}`]: status({ binding: ROOT, pendingDeletions: 7, ownPendingDeletions: 7 }),
    }, entryVaults: [entryVault] }))
    expect(view(own).review).toEqual([expect.objectContaining({ kind: 'deletes', count: 7, accountWide: true })])
    const old = feedsOf(raw({ legacy: {
      'legacy:mirror': status({ pendingDeletions: 7 }),
      [`legacy:entry:${ROOT}`]: status({ binding: ROOT, pendingDeletions: 7 }),
    }, entryVaults: [entryVault] }))
    const v = view(old)
    expect(v.state).toBe('synced') // 不知道是谁的:这一行不被它带偏
    expect(v.elsewhere.deletes).toEqual([expect.objectContaining({ count: 7, accountWide: true })]) // 面板里照样能点「确认」
    expect(view(old, CLOUD).review).toEqual([expect.objectContaining({ kind: 'deletes', count: 7 })])
  })
})

describe('a single file failed', () => {
  it('old sync: names the file and the reason; the vault reads "sync error"', () => {
    const legacy = { [`legacy:entry:${ROOT}`]: status({ binding: ROOT, failures: [{ path: 'Notes/attachments/rec.mp4', reason: 'too-large', code: 'TOO_LARGE', maxBytes: 5 << 20 }] }) }
    const v = view(feedsOf(raw({ legacy, entryVaults: [entryVault] })))
    expect(v.state).toBe('error')
    expect(v.failures).toEqual([expect.objectContaining({ path: 'attachments/rec.mp4', reason: 'too-large' })])
    expect(failureText(v.failures[0], v.target, t)).toBe('vsync.reason.tooLarge{"mb":5,"target":"vsync.target.penzor"}')
    expect(vaultSyncWords(v, 10_000, t)).toMatchObject({ text: 'vsync.error', short: { kind: 'error' }, tone: 'danger' })
  })
  it('old Extend: classified from skipped codes', () => {
    const legacy = { [`legacy:entry:${ROOT}`]: status({ binding: ROOT, skipped: [{ path: 'Notes/a.md', reason: 'EACCES' }, { path: 'Notes/b.bin', reason: 'http 503' }, { path: 'Notes/c', reason: 'PATH_INVALID' }] }) }
    const v = view(feedsOf(raw({ legacy, entryVaults: [entryVault] })))
    expect(v.failures.map((f) => [f.path, f.reason])).toEqual([['a.md', 'unreadable'], ['b.bin', 'failed'], ['c', 'rejected']])
  })
  it('new sync: a file in backoff is not an engine error, but the vault still reads "sync error"', () => {
    const c = contentOn({ error: 'HTTP 500', failures: [{ path: 'Amadeus/x.md', target: 'default', reason: 'HTTP 500', count: 2, retryAt: 70_000 }] })
    const feeds = feedsOf(raw({ content: c }))
    expect(feeds[0].phase).toBe('idle')
    const v = view(feeds)
    expect(v.state).toBe('error')
    expect(v.error).toBeNull()
    expect(v.failures[0]).toMatchObject({ path: 'x.md', reason: 'failed', retryAt: 70_000 })
  })
  it('new sync: a lost connection is offline, not an error', () => {
    const v = view(feedsOf(raw({ content: contentOn({ error: 'fetch failed', pending: 3 }) })))
    expect(v.state).toBe('offline')
    expect(vaultSyncWords(v, 10_000, t).text).toBe('vsync.offline{"n":3}')
  })
})

describe('precedence and elsewhere', () => {
  it('an error in the hidden mirror does not flip a local vault row, but is counted elsewhere', () => {
    const legacy = {
      'legacy:mirror': status({ state: 'error', error: 'scan-failed: x' }),
      [`legacy:entry:${ROOT}`]: status({ binding: ROOT }),
    }
    const v = view(feedsOf(raw({ legacy, entryVaults: [entryVault] })))
    expect(v.state).toBe('synced')
    expect(v.elsewhere.errors).toBe(1)
    expect(view(feedsOf(raw({ legacy, entryVaults: [entryVault] })), CLOUD).state).toBe('error')
  })
  it('paused and signed-out', () => {
    expect(view(feedsOf(raw({ content: contentOn({ paused: true }) }))).state).toBe('paused')
    expect(view(feedsOf(raw({ content: contentOn({ error: 'not_signed_in' }) }))).state).toBe('signed-out')
  })
  it('remote service: running with a total is syncing; its root decides the vault', () => {
    const remote = { config: { backend: 'dropbox', intervalMin: 5 } as never, running: true, lastReport: null, progress: { done: 3, total: 10, key: 'a.md' }, root: ROOT, rootError: null }
    const v = view(feedsOf(raw({ remote })))
    expect(v.state).toBe('syncing')
    expect(v.target).toBe('dropbox')
    expect(v.progress?.files).toEqual({ done: 3, total: 10 })
  })
})

describe('review fixes (Codex, 11-27)', () => {
  it('old Extend + new sync claimed: "on", without polling the snapshot that scans', () => {
    const v = view(feedsOf({ ...raw(), contentAssumed: true }))
    expect(v.state).toBe('on')
    expect(v.feeds.map((f) => f.id)).toEqual(['content'])
  })

  it('a failure outside the notes category goes elsewhere, not onto the notes vault', () => {
    const c = contentOn({ skipped: [{ path: 'human/big.bin', reason: 'too-large', maxBytes: 5 }], failures: [{ path: 'Amadeus/a.md', target: 'Amadeus', reason: 'http_500', count: 1, retryAt: 0 }] })
    const v = view(feedsOf(raw({ content: c })))
    expect(v.failures.map((f) => f.path)).toEqual(['a.md'])
    expect(v.elsewhere.errors).toBe(1)
    const clean = view(feedsOf(raw({ content: contentOn({ skipped: [{ path: 'human/big.bin', reason: 'too-large' }] }) })))
    expect(clean.state).toBe('synced')
    expect(clean.elsewhere.errors).toBe(1)
  })

  it('remote service on but no round reported yet: "on", not "both sides match"', () => {
    const remote = { config: { backend: 'webdav' } as never, running: false, lastReport: null, progress: null, root: ROOT, rootError: null }
    expect(view(feedsOf(raw({ remote }))).state).toBe('on')
    const done = { ...remote, lastReport: { ok: true, startedAt: 1, finishedAt: 2, pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skippedLarge: [], pendingDeletions: 0, errors: [] } }
    expect(view(feedsOf(raw({ remote: done }))).state).toBe('synced')
  })
})
