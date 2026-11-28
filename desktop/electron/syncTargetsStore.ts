/**
 * 宿主自己的「同步到哪」存档 userData/sync-targets(.dev).json(智库同步统一方案第 2 步 H 包,契约 §3.4、实现期修订 H-1 第 1、2 条)。
 * - targets:每条一个网盘(凭据在这里,权限 0600;**凭据只在宿主主进程里流转**,Extend 只拿 open() 递过去的句柄);
 * - legacy:旧 remotesync 的封口状态(谁持有写权、归档到哪)。
 * 读失败 ≠ 空:没有文件 = 空;读不了 / 不是这个形状就抛(固定错误码,不带原文),调用方按「不知道」处理,也不会拿空的一份写回去盖掉凭据。
 * 不 import electron(路径由调用方给),vitest 直测。
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { LegacyHoldState } from './remotesync/legacySeal'

/** 这一版能新建 / 打开的网盘种类。 */
export type SyncTargetKind = 'folder' | 's3' | 'webdav' | 'dropbox'
export const SYNC_TARGET_KINDS: readonly SyncTargetKind[] = ['folder', 's3', 'webdav', 'dropbox']
/** 存档里认得、这一版不支持的种类(带它的版本写过一条、再降回这一版):整份照常读 —— 读失败 ≠ 空,不能因为这一条
 *  让所有去处都读不出、都停。syncTargets 只把它列出来,存 / 打开 / 测试 / 授权一律回 target-kind-unsupported,不打开、不发请求。 */
export const UNSUPPORTED_SYNC_TARGET_KINDS = ['gdrive'] as const
export type StoredSyncTargetKind = SyncTargetKind | (typeof UNSUPPORTED_SYNC_TARGET_KINDS)[number]
export const isSupportedSyncTargetKind = (k: unknown): k is SyncTargetKind => (SYNC_TARGET_KINDS as readonly unknown[]).includes(k)
const isStoredSyncTargetKind = (k: unknown): k is StoredSyncTargetKind =>
  isSupportedSyncTargetKind(k) || (UNSUPPORTED_SYNC_TARGET_KINDS as readonly unknown[]).includes(k)

export interface StoredSyncTarget {
  kind: StoredSyncTargetKind
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

/** 这个文件里有凭据:读 / 解析 / 形状出错一律换成固定的错误码往外抛(进日志、经 IPC 回渲染层)。
 *  JSON.parse 的原始报错会带一截文件原文(如 `..."cessKey":abc…`),所以原报错既不进 message 也不挂 cause。 */
export const SYNC_TARGETS_UNREADABLE = 'sync-targets-unreadable'
export const SYNC_TARGETS_UNPARSEABLE = 'sync-targets-unparseable'
export const SYNC_TARGETS_MALFORMED = 'sync-targets-malformed'

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** legacy 封口记录:整个记录缺省 = 没持有;记录在时 holder 必须在(null / 'v2'),其余字段缺的取缺省;在、但类型或取值不对 = 整个文件读不了(调用方按持有处理),
 *  不能把 holder:'v1' 之类读成 null(= 已交还)。 */
function validLegacy(l: unknown): boolean {
  if (!isObject(l)) return false
  // holder 不可缺:落盘的记录总带着它(封口 / 交还 / 归档都从读到的整份改),缺了 = 不是我们写的,不能读成「已交还」
  if (l.holder !== null && l.holder !== 'v2') return false
  if (l.archived !== undefined && typeof l.archived !== 'boolean') return false
  if (l.archivedAt !== undefined && !(typeof l.archivedAt === 'number' && Number.isFinite(l.archivedAt))) return false
  if (l.archiveDir !== undefined && typeof l.archiveDir !== 'string') return false
  if (l.targetId !== undefined && l.targetId !== null && typeof l.targetId !== 'string') return false
  return true
}

function validate(x: unknown): SyncTargetsFile {
  const f = x as SyncTargetsFile
  if (!isObject(f) || f.version !== 1 || !isObject(f.targets)) throw new Error(SYNC_TARGETS_MALFORMED)
  for (const t of Object.values(f.targets)) {
    if (!isObject(t) || !isStoredSyncTargetKind(t.kind) || !isObject(t.section) || typeof t.label !== 'string') throw new Error(SYNC_TARGETS_MALFORMED)
  }
  if (f.legacy !== undefined && !validLegacy(f.legacy)) throw new Error(SYNC_TARGETS_MALFORMED)
  return f
}

export function createSyncTargetsStore(file: () => string) {
  let queue: Promise<unknown> = Promise.resolve()

  async function read(): Promise<SyncTargetsFile> {
    let raw: string
    try { raw = await fs.readFile(file(), 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return empty()
      throw new Error(SYNC_TARGETS_UNREADABLE)
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error(SYNC_TARGETS_UNPARSEABLE) }
    return validate(parsed)
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
