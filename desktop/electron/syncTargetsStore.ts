/**
 * 宿主自己的「同步到哪」存档 userData/sync-targets(.dev).json(智库同步统一方案第 2 步 H 包,契约 §3.4、实现期修订 H-1 第 1、2 条)。
 * - targets:每条一个网盘(凭据在这里,权限 0600;**凭据只在宿主主进程里流转**,Extend 只拿 open() 递过去的句柄);
 * - legacy:旧 remotesync 的封口状态(谁持有写权、归档到哪)。
 * 读失败 ≠ 空:没有文件 = 空;读不了 / 不是这个形状就抛,调用方按「不知道」处理,也不会拿空的一份写回去盖掉凭据。
 * 不 import electron(路径由调用方给),vitest 直测。
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { LegacyHoldState } from './remotesync/legacySeal'

export type SyncTargetKind = 'folder' | 's3' | 'webdav' | 'dropbox' | 'gdrive'
export const SYNC_TARGET_KINDS: readonly SyncTargetKind[] = ['folder', 's3', 'webdav', 'dropbox', 'gdrive']

export interface StoredSyncTarget {
  kind: SyncTargetKind
  label: string
  /** 这个后端那一段配置,形状同 remotesync.json 里的 cfg[kind](含凭据)。 */
  section: Record<string, unknown>
  /** 从哪来:'remotesync:<来源指纹>' = 从旧 remotesync 导入(同一份来源只建一条);'user' = 设置页里新建。 */
  source: string
  createdAt: number
  updatedAt: number
}

export interface SyncTargetsFile {
  version: 1
  targets: Record<string, StoredSyncTarget>
  legacy?: LegacyHoldState & { targetId?: string | null }
}

const empty = (): SyncTargetsFile => ({ version: 1, targets: {} })

function validate(x: unknown): SyncTargetsFile {
  const f = x as SyncTargetsFile
  if (!f || typeof f !== 'object' || Array.isArray(f) || f.version !== 1 || !f.targets || typeof f.targets !== 'object' || Array.isArray(f.targets)) {
    throw new Error('sync-targets file is malformed')
  }
  for (const [id, t] of Object.entries(f.targets)) {
    if (!t || typeof t !== 'object' || !SYNC_TARGET_KINDS.includes(t.kind) || !t.section || typeof t.section !== 'object' || typeof t.label !== 'string') {
      throw new Error(`sync-targets entry ${JSON.stringify(id)} is malformed`)
    }
  }
  if (f.legacy !== undefined && (typeof f.legacy !== 'object' || f.legacy === null)) throw new Error('sync-targets legacy state is malformed')
  return f
}

export function createSyncTargetsStore(file: () => string) {
  let queue: Promise<unknown> = Promise.resolve()

  async function read(): Promise<SyncTargetsFile> {
    let raw: string
    try { raw = await fs.readFile(file(), 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return empty()
      throw e
    }
    return validate(JSON.parse(raw))
  }

  async function write(next: SyncTargetsFile): Promise<void> {
    const f = file()
    await fs.mkdir(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp-${process.pid}-${randomUUID()}`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.chmod(tmp, 0o600).catch(() => {}) // umask 不吃掉 0600 之外的位,但已有文件被替换时以新文件为准
    await fs.rename(tmp, f)
  }

  /** 读-改-写一条队列:改函数返回 false = 不写。读不了直接抛,不写。 */
  function update<T>(fn: (cur: SyncTargetsFile) => T | false | Promise<T | false>): Promise<T | false> {
    const work = queue.then(async () => {
      const cur = await read()
      const out = await fn(cur)
      if (out !== false) await write(cur)
      return out
    })
    queue = work.catch(() => {})
    return work
  }

  return {
    read: async (): Promise<SyncTargetsFile> => { await queue; return read() },
    update,
    async readLegacy(): Promise<LegacyHoldState> {
      const l = (await this.read()).legacy
      return { holder: l?.holder === 'v2' ? 'v2' : null, archived: l?.archived === true, ...(l?.archivedAt ? { archivedAt: l.archivedAt } : {}), ...(l?.archiveDir ? { archiveDir: l.archiveDir } : {}) }
    },
    async writeLegacy(next: LegacyHoldState): Promise<void> {
      await update((cur) => { cur.legacy = { ...cur.legacy, ...next }; return true })
    },
  }
}

export type SyncTargetsStore = ReturnType<typeof createSyncTargetsStore>
