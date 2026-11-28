/**
 * 「同步到哪」的宿主接缝 CloudHost.syncTargets(智库同步统一方案第 2 步 H 包;契约 §3.4、§3.8 D、实现期修订 H-1)。
 * 新同步的引擎在 Forsion Extend 里;网盘的凭据、OAuth、五个后端的实现留在宿主,Extend 只拿 open() 递过去的句柄。
 *
 * - list / open:宿主存档 sync-targets(.dev).json 里的网盘(syncTargetsStore.ts);open 回 RemoteFs + 如实的 caps + 单文件 stat(remotesync/targetFs.ts);
 * - legacyRemoteSync / importLegacyRemoteSync / seal / archive / unseal:接手旧 remotesync 的那一半(真活在 remotesyncIpc.ts 的 legacyRemoteSync);
 * - vaults:本机库清单(realpath + 文件夹名;目录身份由 Extend 自己算,修订第 3 条)。
 * 每个成员先「握手」(legacyRemoteSync.touch):这次启动 Extend 在用新接缝,旧 remotesync 在 v2 持有时继续拦着。
 * 渲染层(设置 › 同步,U 包)经 window.remoteSync.targets 列 / 存 / 删 / 测网盘(registerSyncTargetsIpc)。
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { readConfig as readAmadeusConfig } from './amadeus/settings'
import { vaultList } from './amadeus/vaultList'
import { cloudVaultDir, isManagedCloudVault } from './amadeus/cloudPaths'
import { legacyRemoteSync, remoteSyncNet, syncTargetsStore, type LegacyRemoteSyncView } from './remotesyncIpc'
import { openTargetFs, type TargetFs, type TargetSpec } from './remotesync/targetFs'
import { normPrefix } from './remotesync/fsS3'
import { gdriveBaseSegs } from './remotesync/fsGdrive'
import { SYNC_TARGET_KINDS, type StoredSyncTarget, type SyncTargetKind } from './syncTargetsStore'

export interface SyncTargetSummary { id: string; kind: SyncTargetKind; label: string; dirDefault: string; source: 'remotesync' | 'user' }

export interface SyncTargetsSeam {
  list(): Promise<SyncTargetSummary[]>
  open(id: string, dir?: string): Promise<TargetFs>
  legacyRemoteSync(): Promise<(LegacyRemoteSyncView & { targetId: string | null }) | null>
  importLegacyRemoteSync(): Promise<{ targetId: string }>
  sealLegacyRemoteSync(): Promise<void>
  archiveLegacyRemoteSync(archiveDir: string): Promise<{ copied: string[]; moved: string[] }>
  unsealLegacyRemoteSync(): Promise<void>
  vaults(): Promise<Array<{ root: string; name: string }>>
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 网盘的「位置」,不含凭据:同一个位置只导入一条;open 的文件夹重叠检查也用它。 */
export function targetLocation(kind: SyncTargetKind, s: Record<string, unknown>): string {
  switch (kind) {
    case 'folder': return `folder:${path.resolve(str(s.path))}`
    case 's3': return `s3:${str(s.endpoint)}/${str(s.bucket)}/${normPrefix(str(s.prefix))}`
    case 'webdav': return `webdav:${str(s.address)}/${str(s.baseDir) || 'forsion-vault'}`
    case 'dropbox': return `dropbox:${str(s.accountId) || remoteSyncNet.dropboxAppKey(s as { appKey?: string })}|${str(s.baseDir) || '/'}`
    case 'gdrive': return `gdrive:${remoteSyncNet.gdriveClient(s as { clientId?: string }).clientId}|${str(s.accountId)}|${gdriveBaseSegs(str(s.baseDir)).join('/')}`
  }
}

export function dirDefaultOf(kind: SyncTargetKind, s: Record<string, unknown>): string {
  switch (kind) {
    case 'folder': return str(s.path)
    case 's3': return normPrefix(str(s.prefix))
    case 'webdav': return str(s.baseDir).replace(/^\/+|\/+$/g, '') || 'forsion-vault'
    case 'dropbox': return str(s.baseDir)
    case 'gdrive': return gdriveBaseSegs(str(s.baseDir)).join('/')
  }
}

function labelOf(kind: SyncTargetKind, s: Record<string, unknown>): string {
  switch (kind) {
    case 'folder': return path.basename(str(s.path)) || str(s.path)
    case 's3': return str(s.bucket) || 'S3'
    case 'webdav': { try { return new URL(str(s.address)).host || 'WebDAV' } catch { return 'WebDAV' } }
    case 'dropbox': return str(s.email) || 'Dropbox'
    case 'gdrive': return str(s.email) || 'Google Drive'
  }
}

/** 这段配置够不够打开(和 remotesync 的 buildRemote 同一个口径);不够回原因。 */
export function incompleteReason(kind: SyncTargetKind, s: Record<string, unknown>): string | null {
  switch (kind) {
    case 'folder': return str(s.path) && path.isAbsolute(str(s.path)) ? null : 'no folder path'
    case 's3': return str(s.endpoint) && str(s.bucket) && str(s.accessKeyID) && str(s.secretAccessKey) ? null : 's3 config incomplete'
    case 'webdav': return str(s.address) ? null : 'webdav config incomplete'
    case 'dropbox': return remoteSyncNet.dropboxAppKey(s as { appKey?: string }) && str(s.refreshToken) ? null : 'dropbox-not-connected'
    case 'gdrive': return remoteSyncNet.gdriveClient(s as { clientId?: string }).clientId && str(s.refreshToken) ? null : 'gdrive-not-connected'
  }
}

function specOf(t: StoredSyncTarget): TargetSpec {
  const s = t.section
  switch (t.kind) {
    case 'folder': return { kind: 'folder', folder: { path: str(s.path) } }
    case 's3': return { kind: 's3', s3: s as unknown as NonNullable<TargetSpec['s3']> }
    case 'webdav': return { kind: 'webdav', webdav: s as unknown as NonNullable<TargetSpec['webdav']> }
    case 'dropbox': return { kind: 'dropbox', dropbox: { appKey: remoteSyncNet.dropboxAppKey(s as { appKey?: string }), refreshToken: str(s.refreshToken), baseDir: typeof s.baseDir === 'string' ? s.baseDir : undefined, fetch: remoteSyncNet.fetch } }
    case 'gdrive': return { kind: 'gdrive', gdrive: { ...remoteSyncNet.gdriveClient(s as { clientId?: string; clientSecret?: string }), refreshToken: str(s.refreshToken), baseDir: typeof s.baseDir === 'string' ? s.baseDir : undefined, fetch: remoteSyncNet.fetch } }
  }
}

async function canon(p: string): Promise<string> {
  try { return await fs.realpath(p) } catch { return path.resolve(p) }
}
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)

/** 本机库清单(realpath,只列在的、不是托管云镜像的)。 */
async function localVaults(): Promise<Array<{ root: string; name: string }>> {
  const cfg = await readAmadeusConfig()
  const out: Array<{ root: string; name: string }> = []
  for (const v of vaultList(cfg)) {
    if (isManagedCloudVault(v.root)) continue
    let root: string
    try { root = await fs.realpath(v.root); if (!(await fs.stat(root)).isDirectory()) continue } catch { continue }
    if (!out.some((o) => o.root === root)) out.push({ root, name: path.basename(root) })
  }
  return out
}

/** 文件夹后端的目标目录不能和任何本机库根、托管云镜像嵌套(契约 §3.2 物理根重叠第二、三条;同 remotesyncIpc 的 folder-overlaps-vault)。 */
async function assertFolderTargetClear(target: string): Promise<void> {
  const t = await canon(target)
  if (overlaps(t, await canon(cloudVaultDir()))) throw new Error('folder-overlaps-vault')
  for (const v of await localVaults()) if (overlaps(t, v.root)) throw new Error('folder-overlaps-vault')
}

function validDir(dir: string): string[] {
  if (dir === '') return []
  if (path.isAbsolute(dir) || dir.includes('\\')) throw new Error('bad-target-dir')
  const segs = dir.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new Error('bad-target-dir')
  return segs
}

/** 打开一条网盘(不握手:渲染层「测试连接」也走这里,那不算 Extend 在用新接缝)。 */
async function openTarget(id: string, dir: string): Promise<TargetFs> {
  const segs = validDir(typeof dir === 'string' ? dir : '')
  const t = (await syncTargetsStore.read()).targets[id]
  if (!t) throw new Error('no-such-target')
  const why = incompleteReason(t.kind, t.section)
  if (why) throw new Error(why)
  if (t.kind === 'folder') await assertFolderTargetClear(path.join(str(t.section.path), ...segs))
  return openTargetFs(specOf(t), segs.join('/'))
}

export function createSyncTargets(): SyncTargetsSeam {
  const touch = (): Promise<void> => legacyRemoteSync.touch()
  return {
    async list() {
      await touch()
      const f = await syncTargetsStore.read()
      return Object.entries(f.targets).map(([id, t]) => ({ id, kind: t.kind, label: t.label, dirDefault: dirDefaultOf(t.kind, t.section), source: t.source.startsWith('remotesync:') ? 'remotesync' as const : 'user' as const }))
    },
    async open(id, dir = '') {
      await touch()
      return openTarget(id, dir)
    },
    async legacyRemoteSync() {
      await touch()
      const view = await legacyRemoteSync.view()
      if (!view) return null
      return { ...view, targetId: (await syncTargetsStore.read()).legacy?.targetId ?? null }
    },
    async importLegacyRemoteSync() {
      await touch()
      const { backend, section } = await legacyRemoteSync.section()
      if (backend === 'penzor') throw new Error('penzor-not-importable')
      if (!(SYNC_TARGET_KINDS as readonly string[]).includes(backend)) throw new Error('no-legacy-backend')
      const kind = backend as SyncTargetKind
      const why = incompleteReason(kind, section)
      if (why) throw new Error(why)
      const source = `remotesync:${createHash('sha256').update(targetLocation(kind, section)).digest('hex').slice(0, 16)}`
      const id = await syncTargetsStore.update((cur) => {
        // 同一份来源只建一条;已有的不改(之后在新设置页里重新授权过的凭据,不能被 remotesync.json 里那份旧的盖回去)
        const found = Object.entries(cur.targets).find(([, t]) => t.source === source)?.[0]
        const targetId = found ?? randomUUID()
        if (!found) {
          const now = Date.now()
          cur.targets[targetId] = { kind, label: labelOf(kind, section), section, source, createdAt: now, updatedAt: now }
        }
        cur.legacy = { holder: cur.legacy?.holder ?? null, archived: cur.legacy?.archived ?? false, ...cur.legacy, targetId }
        return targetId
      })
      if (id === false) throw new Error('import-failed')
      return { targetId: id }
    },
    async sealLegacyRemoteSync() { await touch(); await legacyRemoteSync.seal() },
    async archiveLegacyRemoteSync(archiveDir) { await touch(); return legacyRemoteSync.archive(archiveDir) },
    async unsealLegacyRemoteSync() { await touch(); await legacyRemoteSync.unseal() },
    async vaults() { await touch(); return localVaults() },
  }
}

// ── 渲染层(设置 › 同步,U 包):列 / 存 / 删 / 测网盘。凭据进主进程后只落 sync-targets 文件,list 永不回凭据 ──

export interface SaveTargetInput { id?: string; kind: SyncTargetKind; label?: string; section: Record<string, unknown> }

export async function saveSyncTarget(input: SaveTargetInput): Promise<SyncTargetSummary> {
  if (!input || !(SYNC_TARGET_KINDS as readonly string[]).includes(input.kind) || !input.section || typeof input.section !== 'object' || Array.isArray(input.section)) throw new Error('invalid-target')
  const section = structuredClone(input.section)
  const why = incompleteReason(input.kind, section)
  if (why) throw new Error(why)
  if (input.kind === 'folder') await assertFolderTargetClear(str(section.path))
  const out = await syncTargetsStore.update((cur) => {
    const now = Date.now()
    const id = input.id && cur.targets[input.id] ? input.id : randomUUID()
    const prev = cur.targets[id]
    if (prev && prev.kind !== input.kind) throw new Error('target-kind-changed')
    cur.targets[id] = { kind: input.kind, label: (input.label ?? '').trim() || labelOf(input.kind, section), section, source: prev?.source ?? 'user', createdAt: prev?.createdAt ?? now, updatedAt: now }
    const t = cur.targets[id]
    return { id, kind: t.kind, label: t.label, dirDefault: dirDefaultOf(t.kind, t.section), source: t.source.startsWith('remotesync:') ? 'remotesync' as const : 'user' as const }
  })
  if (out === false) throw new Error('save-failed')
  return out
}

export function registerSyncTargetsIpc(): void {
  ipcMain.handle('remotesync:targets:list', async () => {
    const f = await syncTargetsStore.read()
    return Object.entries(f.targets).map(([id, t]) => ({ id, kind: t.kind, label: t.label, dirDefault: dirDefaultOf(t.kind, t.section), source: t.source.startsWith('remotesync:') ? 'remotesync' : 'user' }))
  })
  ipcMain.handle('remotesync:targets:save', async (_e, input: SaveTargetInput) => saveSyncTarget(input))
  ipcMain.handle('remotesync:targets:remove', async (_e, id: string) => {
    await syncTargetsStore.update((cur) => { if (typeof id !== 'string' || !cur.targets[id]) return false; delete cur.targets[id]; return true })
    return { ok: true }
  })
  ipcMain.handle('remotesync:targets:check', async (_e, id: string) => {
    try {
      const fsT = await openTarget(typeof id === 'string' ? id : '', '')
      return await fsT.check()
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  })
}
