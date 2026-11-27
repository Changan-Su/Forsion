/**
 * 同步记录(智库同步统一方案 2026-11-27 第 1 步):一轮一行,按账号一份文件,留 30 天,存在本机,换账号不带走。
 *
 * 谁来记:Forsion Extend 的两套引擎经 cloudHost.syncRecords.append 交(记录的形状 = shared/vaultSync.ts 的 SyncRoundRecord,
 * 碎轮在引擎那头已经并好:同一 id 再交一次 = 覆盖那一行);远程服务每跑完一轮在 remotesyncIpc 里记。
 * 谁来读:渲染层经 sync-records:list(同步面板的最近几轮、全部记录);有新记录时广播 sync-records:changed。
 * 存取只管追加 / 覆盖和 30 天清理,不懂「一轮」是什么 —— 第 2 步换成定时同步时它不用改。
 *
 * 读失败 ≠ 空:文件在、读不出来(半截、坏了)时把原件改名留着(`.corrupt-<时刻>`),再从空开始记,绝不拿空列表盖掉它。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  SYNC_RECORD_MAX_FAILED, SYNC_RECORD_MAX_ROWS, SYNC_RECORD_RETENTION_MS, sameVaultRoot,
  type SyncFailure, type SyncRoundRecord,
} from '../shared/vaultSync'

const ENGINES = new Set(['legacy', 'content', 'remote', 'web'])
const TARGETS = new Set(['penzor', 'dropbox', 'webdav', 's3', 'folder', 'gdrive', 'other'])
const REASONS = new Set(['too-large', 'invalid-name', 'unreadable', 'rejected', 'failed'])
const str = (v: unknown, max = 1024): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

function cleanFailure(raw: unknown): SyncFailure | null {
  const f = raw as Partial<SyncFailure> | null
  const p = str(f?.path, 2048)
  if (p === null || !REASONS.has(String(f?.reason))) return null
  return {
    path: p,
    reason: f!.reason as SyncFailure['reason'],
    ...(str(f!.code, 200) !== null ? { code: f!.code } : {}),
    ...(typeof f!.retryAt === 'number' ? { retryAt: f!.retryAt } : {}),
    ...(typeof f!.size === 'number' ? { size: num(f!.size) } : {}),
    ...(typeof f!.maxBytes === 'number' ? { maxBytes: num(f!.maxBytes) } : {}),
  }
}

/** 收进来的记录先过一遍:形状不对 = 不收(来自 Extend,是数据)。 */
export function cleanRecord(raw: unknown): SyncRoundRecord | null {
  const r = raw as Partial<SyncRoundRecord> | null
  const id = str(r?.id, 300), feed = str(r?.feed, 2048)
  if (!r || id === null || feed === null || !ENGINES.has(String(r.engine)) || !TARGETS.has(String(r.target))) return null
  if (typeof r.startedAt !== 'number' || typeof r.finishedAt !== 'number' || !Number.isFinite(r.startedAt) || !Number.isFinite(r.finishedAt)) return null
  const failed = (Array.isArray(r.failed) ? r.failed : []).map(cleanFailure).filter((f): f is SyncFailure => !!f).slice(0, SYNC_RECORD_MAX_FAILED)
  return {
    id, feed,
    engine: r.engine as SyncRoundRecord['engine'],
    vault: str(r.vault, 4096),
    target: r.target as SyncRoundRecord['target'],
    startedAt: r.startedAt, finishedAt: r.finishedAt,
    completed: r.completed === true,
    uploaded: num(r.uploaded), downloaded: num(r.downloaded), merged: num(r.merged), renamed: num(r.renamed),
    deletedCloud: num(r.deletedCloud), deletedLocal: num(r.deletedLocal), held: num(r.held),
    failed, failedCount: Math.max(failed.length, num(r.failedCount)),
    ...(r.first === true ? { first: true } : {}),
  }
}

/** 留下的那些:30 天内、最多 SYNC_RECORD_MAX_ROWS 行,按结束时刻排。 */
export function prune(records: SyncRoundRecord[], now = Date.now()): SyncRoundRecord[] {
  const kept = records.filter((r) => r.finishedAt >= now - SYNC_RECORD_RETENTION_MS).sort((a, b) => a.finishedAt - b.finishedAt)
  return kept.length > SYNC_RECORD_MAX_ROWS ? kept.slice(kept.length - SYNC_RECORD_MAX_ROWS) : kept
}

interface FileShape { version: 1; records: SyncRoundRecord[] }

export interface SyncRecordStore {
  append(record: unknown, account: string | null): void
  /** feeds = 只要这几个 feed 的;vault = 只要这个库的(记录没带库 = 算它那个 feed 的,不排除)。先筛后截 limit。 */
  list(account: string | null, opts?: { since?: number; feeds?: string[]; vault?: string | null; limit?: number }): Promise<SyncRoundRecord[]>
  /** 等还没落盘的写完(退出前 / 测试) */
  flush(): Promise<void>
}

/** dir = userData/sync-records。onChanged:有新记录(合并后约 300ms 一次)。 */
export function createSyncRecordStore(dir: string, opts: { onChanged?: () => void; now?: () => number; writeDelayMs?: number } = {}): SyncRecordStore {
  const now = opts.now ?? Date.now
  const delay = opts.writeDelayMs ?? 300
  const cache = new Map<string, Promise<SyncRoundRecord[]>>()
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()

  const keyOf = (account: string | null): string => createHash('sha256').update(`forsion-sync-records\0${account ?? 'signed-out'}`).digest('hex').slice(0, 24)
  const fileOf = (key: string): string => path.join(dir, `${key}.json`)

  const load = (key: string): Promise<SyncRoundRecord[]> => {
    let p = cache.get(key)
    if (!p) {
      p = (async () => {
        const file = fileOf(key)
        let text: string
        try { text = await fs.readFile(file, 'utf8') } catch (e) {
          if ((e as { code?: string }).code === 'ENOENT') return []
          throw e // 读不了(权限、IO):不知道,别当空
        }
        try {
          const parsed = JSON.parse(text) as FileShape
          if (parsed?.version !== 1 || !Array.isArray(parsed.records)) throw new Error('bad shape')
          return prune(parsed.records.map(cleanRecord).filter((r): r is SyncRoundRecord => !!r), now())
        } catch {
          await fs.rename(file, `${file}.corrupt-${now()}`).catch(() => {}) // 原件留着,不盖
          return []
        }
      })()
      cache.set(key, p)
      p.catch(() => { if (cache.get(key) === p) cache.delete(key) }) // 读失败:下次再试,这次不写
    }
    return p
  }

  const writeOut = async (): Promise<void> => {
    timer = null
    const keys = [...dirty]
    dirty.clear()
    for (const key of keys) {
      const records = await load(key).catch(() => null)
      if (!records) continue
      const file = fileOf(key)
      const tmp = `${file}.${process.pid}.tmp`
      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmp, JSON.stringify({ version: 1, records } satisfies FileShape))
        await fs.rename(tmp, file)
      } catch { await fs.rm(tmp, { force: true }).catch(() => {}) }
    }
    opts.onChanged?.()
  }
  const schedule = (key: string): void => {
    dirty.add(key)
    if (!timer) timer = setTimeout(() => { writing = writing.then(writeOut, writeOut) }, delay)
  }

  return {
    append(raw, account) {
      const record = cleanRecord(raw)
      if (!record) return
      const key = keyOf(account)
      void load(key).then((records) => {
        const i = records.findIndex((r) => r.id === record.id)
        if (i >= 0) records[i] = record
        else records.push(record)
        const kept = prune(records, now())
        records.length = 0
        records.push(...kept)
        schedule(key)
      }, () => { /* 读不了:这一条不记,也不盖文件 */ })
    },
    async list(account, o = {}) {
      const records = await load(keyOf(account)).catch(() => [] as SyncRoundRecord[])
      let out = prune(records, now())
      if (o.since !== undefined) out = out.filter((r) => r.finishedAt >= o.since!)
      if (o.feeds) { const want = new Set(o.feeds); out = out.filter((r) => want.has(r.feed)) }
      if (o.vault) out = out.filter((r) => r.vault === null || sameVaultRoot(r.vault, o.vault!))
      out = out.slice().sort((a, b) => b.finishedAt - a.finishedAt)
      return o.limit ? out.slice(0, o.limit) : out
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; writing = writing.then(writeOut, writeOut) }
      await writing
    },
  }
}
