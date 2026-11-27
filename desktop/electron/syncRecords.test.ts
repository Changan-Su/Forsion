import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYNC_RECORD_RETENTION_MS } from '../shared/vaultSync'
import { cleanRecord, createSyncRecordStore } from './syncRecords'

const T0 = Date.UTC(2026, 10, 27, 8, 0, 0)
const rec = (id: string, finishedAt: number, extra: Record<string, unknown> = {}) => ({
  id, feed: 'content', engine: 'content', vault: '/v/Notes', target: 'penzor',
  startedAt: finishedAt - 1000, finishedAt, completed: true,
  uploaded: 1, downloaded: 0, merged: 0, renamed: 0, deletedCloud: 0, deletedLocal: 0, held: 0,
  failed: [], failedCount: 0, ...extra,
})

describe('sync records store', () => {
  it('keeps one file per account, upserts by id, lists newest first', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-records-'))
    let changed = 0
    const store = createSyncRecordStore(dir, { now: () => T0, writeDelayMs: 5, onChanged: () => { changed++ } })
    store.append(rec('a', T0 - 3000), 'acct-1')
    store.append(rec('b', T0 - 2000), 'acct-1')
    store.append(rec('a', T0 - 1000, { uploaded: 7 }), 'acct-1') // 碎轮并进同一行
    store.append(rec('c', T0 - 1000), 'acct-2')
    await new Promise((r) => setTimeout(r, 20))
    await store.flush()
    const one = await store.list('acct-1')
    expect(one.map((r) => [r.id, r.uploaded])).toEqual([['a', 7], ['b', 1]])
    expect((await store.list('acct-2')).map((r) => r.id)).toEqual(['c'])
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(2)
    expect(changed).toBeGreaterThan(0)
    // 重新打开:从盘上读回来
    const again = createSyncRecordStore(dir, { now: () => T0 })
    expect((await again.list('acct-1', { limit: 1 })).map((r) => r.id)).toEqual(['a'])
  })

  it('drops records older than 30 days and rejects malformed ones', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-records-'))
    const store = createSyncRecordStore(dir, { now: () => T0, writeDelayMs: 1 })
    store.append(rec('old', T0 - SYNC_RECORD_RETENTION_MS - 1), 'acct')
    store.append(rec('new', T0 - 10), 'acct')
    store.append({ id: 'bad', engine: 'nope' }, 'acct')
    await new Promise((r) => setTimeout(r, 10))
    await store.flush()
    expect((await store.list('acct')).map((r) => r.id)).toEqual(['new'])
    expect(cleanRecord({ ...rec('x', T0), failed: [{ path: 'a.md', reason: 'too-large', maxBytes: 5 }, { path: 1, reason: 'failed' }] })?.failed)
      .toEqual([{ path: 'a.md', reason: 'too-large', maxBytes: 5 }])
  })

  it('a corrupt file is set aside, never overwritten with an empty list', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-records-'))
    const store = createSyncRecordStore(dir, { now: () => T0, writeDelayMs: 1 })
    store.append(rec('a', T0 - 10), 'acct')
    await new Promise((r) => setTimeout(r, 10))
    await store.flush()
    const file = readdirSync(dir).find((f) => f.endsWith('.json'))!
    writeFileSync(path.join(dir, file), '{"version":1,"records":[') // 半截
    const reopened = createSyncRecordStore(dir, { now: () => T0, writeDelayMs: 1 })
    expect(await reopened.list('acct')).toEqual([])
    const aside = readdirSync(dir).find((f) => f.includes('.corrupt-'))
    expect(aside).toBeTruthy()
    expect(readFileSync(path.join(dir, aside!), 'utf8')).toBe('{"version":1,"records":[')
  })

  it('an unreadable file (not ENOENT) is left alone and nothing is written', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-records-'))
    const store = createSyncRecordStore(dir, { now: () => T0, writeDelayMs: 1 })
    store.append(rec('a', T0 - 10), 'acct')
    await new Promise((r) => setTimeout(r, 10))
    await store.flush()
    const file = readdirSync(dir).find((f) => f.endsWith('.json'))!
    const before = readFileSync(path.join(dir, file), 'utf8')
    // 把文件换成同名目录:readFile 报 EISDIR(读不了 ≠ 没有)
    const { rmSync } = await import('node:fs')
    rmSync(path.join(dir, file)); mkdirSync(path.join(dir, file))
    const other = createSyncRecordStore(dir, { now: () => T0, writeDelayMs: 1 })
    other.append(rec('b', T0 - 5), 'acct')
    await new Promise((r) => setTimeout(r, 10))
    await other.flush()
    expect(readdirSync(path.join(dir, file))).toEqual([]) // 没被写成文件
    expect(before.length).toBeGreaterThan(0)
  })
})
