/**
 * 「同步到哪」的宿主接缝 CloudHost.syncTargets(智库同步统一方案第 2 步 H 包;契约 §3.4、§3.8 D、实现期修订 H-1)。
 * 新同步的引擎在 Forsion Extend 里;网盘的凭据、OAuth、四个后端的实现留在宿主,Extend 只拿 open() 递过去的句柄。
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
import { cancelTargetAuth, finishTargetAuth, legacyRemoteSync, remoteSyncNet, startTargetAuth, syncTargetsStore, takeTargetAuthTicket, type LegacyRemoteSyncView, type TargetAuthOutcome } from './remotesyncIpc'
import { openTargetFs, type TargetFs, type TargetSpec } from './remotesync/targetFs'
import { normPrefix } from './remotesync/fsS3'
import { SYNC_TARGET_KINDS, UNSUPPORTED_SYNC_TARGET_KINDS, isSupportedSyncTargetKind, type StoredSyncTarget, type StoredSyncTargetKind, type SyncTargetKind } from './syncTargetsStore'

/** kind 可能是存档里认得、这一版不支持的种类(syncTargetsStore 的 UNSUPPORTED_SYNC_TARGET_KINDS):照常列出,dirDefault 为空。 */
export interface SyncTargetSummary { id: string; kind: StoredSyncTargetKind; label: string; dirDefault: string; source: 'remotesync' | 'user' }

export interface SyncTargetsSeam {
  list(): Promise<SyncTargetSummary[]>
  open(id: string, dir?: string): Promise<TargetFs>
  legacyRemoteSync(): Promise<(LegacyRemoteSyncView & { targetId: string | null }) | null>
  importLegacyRemoteSync(): Promise<{ targetId: string }>
  sealLegacyRemoteSync(): Promise<void>
  /** opts.expectKey = 接手时 legacyRemoteSync() 给的 legacyKey:现在的配置对不上就抛 legacy-config-changed、什么都不动。 */
  archiveLegacyRemoteSync(archiveDir: string, opts?: { expectKey?: string }): Promise<{ copied: string[]; moved: string[] }>
  /** opts.restoreAutoSync:已归档的先把旧自动同步两项从档案原件写回(契约 H-8,接手失败到头 / 退回时用)。 */
  unsealLegacyRemoteSync(opts?: { restoreAutoSync?: boolean }): Promise<void>
  vaults(): Promise<Array<{ root: string; name: string }>>
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 这一版能打开的那条;不支持的种类(存档里认得)= false。 */
const supported = (t: StoredSyncTarget): t is StoredSyncTarget & { kind: SyncTargetKind } => isSupportedSyncTargetKind(t.kind)
const UNSUPPORTED = 'target-kind-unsupported'

/** 网盘的「位置」,不含凭据:同一个位置只导入一条;open 的文件夹重叠检查也用它。 */
export function targetLocation(kind: SyncTargetKind, s: Record<string, unknown>): string {
  switch (kind) {
    case 'folder': return `folder:${path.resolve(str(s.path))}`
    case 's3': return `s3:${str(s.endpoint)}/${str(s.bucket)}/${normPrefix(str(s.prefix))}`
    case 'webdav': return `webdav:${str(s.address)}/${str(s.baseDir) || 'forsion-vault'}`
    case 'dropbox': return `dropbox:${str(s.accountId) || remoteSyncNet.dropboxAppKey(s as { appKey?: string })}|${str(s.baseDir) || '/'}`
  }
}

/** 网盘的「账号」(位置里没编进去的那部分身份):WebDAV 的用户名(同一个地址换个用户 = 别人的那棵树)。
 *  S3 的 accessKeyID 不算(换钥匙 = 同一个桶的凭据轮换);Dropbox 的账号已经在 targetLocation 里;文件夹没有账号。 */
/** 打开时原样传下去的位置字段(specOf:S3 / WebDAV 整段 section,Dropbox 的 baseDir)的原文,不去空格、不归一:
 *  `v` 改成 `v ` 在 targetLocation 里看不出来,打开的却是另一个目录。文件夹打开时也 trim,targetLocation 已经够。 */
const RAW_LOCATION_KEYS: Record<SyncTargetKind, readonly string[]> = {
  folder: [], s3: ['endpoint', 'bucket', 'prefix'], webdav: ['address', 'baseDir', 'username'], dropbox: ['baseDir'],
}
function rawLocation(kind: SyncTargetKind, s: Record<string, unknown>): string {
  return JSON.stringify(RAW_LOCATION_KEYS[kind].map((k) => (s[k] === undefined ? null : s[k])))
}

function targetAccount(kind: SyncTargetKind, s: Record<string, unknown>): string {
  return kind === 'webdav' ? str(s.username) : ''
}

export function dirDefaultOf(kind: StoredSyncTargetKind, s: Record<string, unknown>): string {
  if (!isSupportedSyncTargetKind(kind)) return '' // 不支持的种类:不知道它的缺省目录
  switch (kind) {
    case 'folder': return str(s.path)
    case 's3': return normPrefix(str(s.prefix))
    case 'webdav': return str(s.baseDir).replace(/^\/+|\/+$/g, '') || 'forsion-vault'
    case 'dropbox': return str(s.baseDir)
  }
}

function labelOf(kind: SyncTargetKind, s: Record<string, unknown>): string {
  switch (kind) {
    case 'folder': return path.basename(str(s.path)) || str(s.path)
    case 's3': return str(s.bucket) || 'S3'
    case 'webdav': { try { return new URL(str(s.address)).host || 'WebDAV' } catch { return 'WebDAV' } }
    case 'dropbox': return str(s.email) || 'Dropbox'
  }
}

/** 这段配置够不够打开(和 remotesync 的 buildRemote 同一个口径);不够回原因。 */
export function incompleteReason(kind: SyncTargetKind, s: Record<string, unknown>): string | null {
  switch (kind) {
    case 'folder': return str(s.path) && path.isAbsolute(str(s.path)) ? null : 'no folder path'
    case 's3': return str(s.endpoint) && str(s.bucket) && str(s.accessKeyID) && str(s.secretAccessKey) ? null : 's3 config incomplete'
    case 'webdav': return str(s.address) ? null : 'webdav config incomplete'
    case 'dropbox': return remoteSyncNet.dropboxAppKey(s as { appKey?: string }) && str(s.refreshToken) ? null : 'dropbox-not-connected'
  }
}

function specOf(t: StoredSyncTarget & { kind: SyncTargetKind }): TargetSpec {
  const s = t.section
  switch (t.kind) {
    case 'folder': return { kind: 'folder', folder: { path: str(s.path) } }
    case 's3': return { kind: 's3', s3: s as unknown as NonNullable<TargetSpec['s3']> }
    case 'webdav': return { kind: 'webdav', webdav: s as unknown as NonNullable<TargetSpec['webdav']> }
    case 'dropbox': return { kind: 'dropbox', dropbox: { appKey: remoteSyncNet.dropboxAppKey(s as { appKey?: string }), refreshToken: str(s.refreshToken), baseDir: typeof s.baseDir === 'string' ? s.baseDir : undefined } }
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
  if (!supported(t)) throw new Error(UNSUPPORTED) // 认得、这一版不支持:不打开、不发请求
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
    async archiveLegacyRemoteSync(archiveDir, opts) { await touch(); return legacyRemoteSync.archive(archiveDir, opts) },
    async unsealLegacyRemoteSync(opts) { await touch(); await legacyRemoteSync.unseal(opts) },
    async vaults() { await touch(); return localVaults() },
  }
}

// ── 渲染层(设置 › 同步,U 包):列 / 存 / 删 / 测网盘。凭据进主进程后只落 sync-targets 文件,list 永不回凭据 ──

export interface SaveTargetInput { id?: string; kind: SyncTargetKind; label?: string; section: Record<string, unknown> }

/** 网盘去处用的哪个应用(生效值:内置的留空也算内置那个)。换了 = 另一个可见集(Dropbox 的 App Folder)。 */
function appOf(kind: SyncTargetKind, s: Record<string, unknown>): string {
  if (kind === 'dropbox') return remoteSyncNet.dropboxAppKey(s as { appKey?: string })
  return ''
}

/** `mergeExisting`(宿主内部,网盘重新授权用):`input.section` 是新凭据,在写事务里叠到那条现有的 section 上;
 *  那条不在了(别的窗口刚删)回 target-not-found,不新建;应用换了回 target-location-changed。 */
export async function saveSyncTarget(input: SaveTargetInput, opts: { mergeExisting?: boolean } = {}): Promise<SyncTargetSummary> {
  if (input && (UNSUPPORTED_SYNC_TARGET_KINDS as readonly unknown[]).includes(input.kind)) throw new Error(UNSUPPORTED) // 认得、这一版不能新建 / 改
  if (!input || !(SYNC_TARGET_KINDS as readonly string[]).includes(input.kind) || !input.section || typeof input.section !== 'object' || Array.isArray(input.section)) throw new Error('invalid-target')
  const patch = structuredClone(input.section)
  if (!opts.mergeExisting) {
    const why = incompleteReason(input.kind, patch)
    if (why) throw new Error(why)
    if (input.kind === 'folder') await assertFolderTargetClear(str(patch.path))
  } else if (input.kind === 'folder') throw new Error('invalid-target')
  const out = await syncTargetsStore.update((cur) => {
    const now = Date.now()
    if (opts.mergeExisting && !(input.id && cur.targets[input.id])) throw new Error('target-not-found')
    const id = input.id && cur.targets[input.id] ? input.id : randomUUID()
    const prev = cur.targets[id]
    if (prev && !supported(prev)) throw new Error(UNSUPPORTED) // 认得、这一版不支持的那条:原样留着,不改
    if (prev && prev.kind !== input.kind) throw new Error('target-kind-changed')
    const section = opts.mergeExisting && prev ? { ...prev.section, ...patch } : patch
    if (opts.mergeExisting) {
      const why = incompleteReason(input.kind, section)
      if (why) throw new Error(why)
      if (prev && appOf(prev.kind, prev.section) !== appOf(input.kind, section)) throw new Error('target-location-changed')
    }
    // 同一个 id 只能更新凭据:换了位置(桶 / 前缀 / 地址 / 目录 / 文件夹)或账号 = 另一棵远端树,
    // 绑定会拿旧基线去对它做删除判定。要换就在设置页新建一条(新 id、新基线)
    if (prev && (targetLocation(prev.kind, prev.section) !== targetLocation(input.kind, section) || targetAccount(prev.kind, prev.section) !== targetAccount(input.kind, section) || rawLocation(prev.kind, prev.section) !== rawLocation(input.kind, section))) {
      throw new Error('target-location-changed')
    }
    const label = (input.label ?? '').trim() || (opts.mergeExisting && prev ? prev.label : labelOf(input.kind, section))
    cur.targets[id] = { kind: input.kind, label, section, source: prev?.source ?? 'user', createdAt: prev?.createdAt ?? now, updatedAt: now }
    const t = cur.targets[id]
    return { id, kind: t.kind, label: t.label, dirDefault: dirDefaultOf(t.kind, t.section), source: t.source.startsWith('remotesync:') ? 'remotesync' as const : 'user' as const }
  })
  if (out === false) throw new Error('save-failed')
  return out
}

/** 报给渲染层的固定码:本身就是码的照传,别的(可能带原文)一律 save-failed。 */
const fixedCode = (e: unknown): string => {
  const m = (e as Error)?.message
  return typeof m === 'string' && /^[a-z][a-z0-9-]{2,63}$/.test(m) ? m : 'save-failed'
}

export interface TargetAuthStartOpts { id?: string; label?: string; baseDir?: string; appKey?: string }
export type TargetAuthEvent = { attempt: string; ok: true; target: SyncTargetSummary; account: string } | { attempt: string; ok: false; error: string }

/** 授权完的凭据存进 sync-targets(契约 H-9)。给了 id = 给已有那条重新授权:位置(baseDir / 自建应用)沿用那条,账号得是同一个
 *  (saveSyncTarget 核,换了回 target-location-changed);没给 = 新建一条。凭据只在主进程里过一手,回去的只有摘要。 */
export async function saveAuthorizedTarget(kind: 'dropbox', opts: TargetAuthStartOpts, r: TargetAuthOutcome): Promise<{ ok: true; target: SyncTargetSummary; account: string } | { ok: false; error: string }> {
  if (!r.ok) return r
  try {
    // 重新授权:在写事务里叠到那条上(位置沿用那条;那条没了 / 换了账号或应用 = 拒,原凭据不动)
    const target = opts.id
      ? await saveSyncTarget({ id: opts.id, kind, label: opts.label, section: r.creds.section }, { mergeExisting: true })
      : await saveSyncTarget({ kind, label: opts.label, section: { ...r.creds.section, ...(typeof opts.baseDir === 'string' && opts.baseDir.trim() ? { baseDir: opts.baseDir.trim() } : {}) } })
    return { ok: true, target, account: r.creds.account }
  } catch (e) {
    return { ok: false, error: fixedCode(e) }
  }
}

export function registerSyncTargetsIpc(): void {
  // 新建 / 重新授权网盘去处(契约 H-9):开系统浏览器,结果经 remotesync:targets:auth 发回发起的那个窗口
  ipcMain.handle('remotesync:targets:authStart', async (e, kind: unknown, rawOpts: unknown) => {
    if (kind !== 'dropbox') return { ok: false, error: 'bad-target-kind' } // 先判种类再领票:被拒的这次不顶掉别人
    const ticket = takeTargetAuthTicket() // 进门就领票:下面查 sync-targets 慢了,也不会去顶掉比它晚开始的那一次
    const o = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {}) as Record<string, unknown>
    const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
    const opts: TargetAuthStartOpts = { id: str('id'), label: str('label'), baseDir: str('baseDir'), appKey: str('appKey') }
    let prevSection: Record<string, unknown> | undefined
    if (opts.id) {
      let prev
      try { prev = (await syncTargetsStore.read()).targets[opts.id] } catch (err) { return { ok: false, error: fixedCode(err) } }
      if (!prev) return { ok: false, error: 'target-not-found' }
      if (!supported(prev)) return { ok: false, error: UNSUPPORTED } // 先于换种类:不开浏览器、不起回调口
      if (prev.kind !== kind) return { ok: false, error: 'target-kind-changed' }
      prevSection = prev.section
    }
    // 重新授权:应用只认那条存着的(这次传的不认):换了 = 另一个可见集,旧基线会把「看不见」当成「被删」
    const pick = (k: 'appKey'): string | undefined =>
      prevSection ? (typeof prevSection[k] === 'string' ? prevSection[k] as string : undefined) : opts[k]
    const sender = e.sender
    const send = (ev: TargetAuthEvent): void => { if (!sender.isDestroyed()) sender.send('remotesync:targets:auth', ev) }
    return startTargetAuth(kind, { appKey: pick('appKey') }, (attempt, r) => {
      void saveAuthorizedTarget(kind, opts, r).then((out) => send({ attempt, ...out } as TargetAuthEvent))
    }, ticket)
  })
  ipcMain.handle('remotesync:targets:authFinish', async (_e, attempt: unknown, code: unknown) =>
    finishTargetAuth(typeof attempt === 'string' ? attempt : '', typeof code === 'string' ? code : ''))
  ipcMain.handle('remotesync:targets:authCancel', async (_e, attempt: unknown) => { cancelTargetAuth(typeof attempt === 'string' ? attempt : ''); return { ok: true } })

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
