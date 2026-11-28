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
import { promises as fs, realpath as realpathCb } from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { readConfig as readAmadeusConfig } from './amadeus/settings'
import { normalizeLocal, vaultList } from './amadeus/vaultList'
import { cloudVaultDir, isManagedCloudVault } from './amadeus/cloudPaths'
import { cancelTargetAuth, finishTargetAuth, legacyRemoteSync, remoteSyncNet, startTargetAuth, syncTargetsStore, takeTargetAuthTicket, type LegacyRemoteSyncView, type TargetAuthOutcome } from './remotesyncIpc'
import { openTargetFs, type TargetFs, type TargetSpec } from './remotesync/targetFs'
import { normPrefix } from './remotesync/fsS3'
import { dropboxAccountId, normBaseDir } from './remotesync/fsDropbox'
import { webdavBaseDir } from './remotesync/fsWebdav'
import { SYNC_TARGET_KINDS, UNSUPPORTED_SYNC_TARGET_KINDS, isSupportedSyncTargetKind, type StoredSyncTarget, type StoredSyncTargetKind, type SyncTargetKind } from './syncTargetsStore'

/** kind 可能是存档里认得、这一版不支持的种类(syncTargetsStore 的 UNSUPPORTED_SYNC_TARGET_KINDS):照常列出,dirDefault 为空。 */
export interface SyncTargetSummary { id: string; kind: StoredSyncTargetKind; label: string; dirDefault: string; source: 'remotesync' | 'user' }

export interface SyncTargetsSeam {
  list(): Promise<SyncTargetSummary[]>
  open(id: string, dir?: string): Promise<TargetFs>
  /** targetId = 上一次导入的那条(store 里记的);currentTargetId = 和旧同步**当前**配置同一位置、现在导入会复用的那条
   *  (同 importLegacyRemoteSync 的来源键;后端 off / penzor / 不支持 / 配置不全 / 没导入过 = null)。不写盘、不复制凭据(契约 step34「H3 追加 2」)。 */
  legacyRemoteSync(): Promise<(LegacyRemoteSyncView & { targetId: string | null; currentTargetId: string | null }) | null>
  importLegacyRemoteSync(): Promise<{ targetId: string }>
  sealLegacyRemoteSync(): Promise<void>
  /** opts.expectKey = 接手时 legacyRemoteSync() 给的 legacyKey:现在的配置对不上就抛 legacy-config-changed、什么都不动。 */
  archiveLegacyRemoteSync(archiveDir: string, opts?: { expectKey?: string }): Promise<{ copied: string[]; moved: string[] }>
  /** opts.restoreAutoSync:已归档的先把旧自动同步两项从档案原件写回(契约 H-8,接手失败到头 / 退回时用)。
   *  opts.expectKey(契约 H-13):宿主在配置写队列里核「根 × 去处」,对不上(含配置没了)抛 legacy-config-changed、根认不出抛
   *  legacy-root-unavailable、读不了配置照抛,封口和配置都不动;对得上才交还。不带 = 照旧不核(老 Extend)。 */
  unsealLegacyRemoteSync(opts?: { restoreAutoSync?: boolean; expectKey?: string }): Promise<void>
  vaults(): Promise<Array<{ root: string; name: string }>>
  /** 去处 × 子目录的物理位置身份(契约 step34「H3 追加」「H3 接口定稿」第 3 节)。不透明串,同一物理位置同一个串;分隔符一律 '/',
   *  不以 '/' 结尾,没有空段 / '.' / '..';以「后端 + 权威部分」开头,A 是 B 的祖先目录 ⇔ B 以 A + '/' 开头。不含任何凭据。
   *  抛固定码:target-not-found(没有这个 id)、target-identity-unavailable(别的一切:解析不了、Dropbox 取不到账号、
   *  不支持的种类、dir 不合法、存档读不了、超时 10 秒)。绝不回空串。 */
  identity(targetId: string, dir: string): Promise<string>
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

/** 本机库清单(realpath,只列在的、不是托管云镜像的)。和菜单的 listVaults 同一口径:只有 lastVault 的老配置经 normalizeLocal 补进来。 */
async function localVaults(): Promise<Array<{ root: string; name: string }>> {
  const cfg = normalizeLocal(await readAmadeusConfig(), isManagedCloudVault)
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

/** 导入旧同步那一段时的来源键:同一个位置只建一条(importLegacyRemoteSync 与 currentTargetId 共用,别分叉)。 */
function legacySourceOf(kind: SyncTargetKind, section: Record<string, unknown>): string {
  return `remotesync:${createHash('sha256').update(targetLocation(kind, section)).digest('hex').slice(0, 16)}`
}

/** 旧同步当前配置现在导入会复用的那条(只认来源键,同 importLegacyRemoteSync);导入不了的(off / penzor / 不支持 / 不全)= null。 */
function currentTargetOf(targets: Record<string, StoredSyncTarget>, backend: string, section: Record<string, unknown>): string | null {
  if (!(SYNC_TARGET_KINDS as readonly string[]).includes(backend)) return null
  const kind = backend as SyncTargetKind
  if (incompleteReason(kind, section)) return null
  const source = legacySourceOf(kind, section)
  return Object.entries(targets).find(([, t]) => t.source === source && t.kind === kind)?.[0] ?? null
}

// ── 目录身份(syncTargets.identity)──────────────────────────────────────────────────────────────

export const TARGET_IDENTITY_TIMEOUT_MS = 10_000
const ID_UNAVAILABLE = 'target-identity-unavailable'

/** 段规整:去掉空段和 '.','..' 退一层;退出根之外 = null(认不准)。 */
export function cleanSegments(parts: readonly string[]): string[] | null {
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') { if (!out.length) return null; out.pop(); continue }
    out.push(p)
  }
  return out
}

/** 权威部分 + 段 → 身份串:每段前面一个 '/',根就是权威部分本身(不带尾斜杠)。段里不许有 '/'(调用方先转义)。 */
export function joinIdentity(head: string, segs: readonly string[]): string {
  return head + segs.map((x) => `/${x}`).join('')
}

/** 本机路径(已经是绝对路径)→ 盘符 / UNC 头 + 段。纯字符串;win = 按 Windows 规则('\' 和 '/' 都是分隔符)。
 *  posix:头为空,'/' 是根;Windows:`C:`(根 = `C:`),UNC `\\server\share\…` → 头 `UNC`、段从 server 起。认不出 → null。 */
export function nativeSegments(p: string, win: boolean): { head: string; segs: string[] } | null {
  if (!win) {
    if (!p.startsWith('/')) return null
    const segs = cleanSegments(p.split('/'))
    return segs ? { head: '', segs } : { head: '', segs: [] } // '/..' 就是根
  }
  const q = p.replace(/\\/g, '/')
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(q)
  if (drive) return { head: drive[1], segs: cleanSegments((drive[2] ?? '').split('/')) ?? [] }
  if (q.startsWith('//')) {
    const segs = cleanSegments(q.slice(2).split('/'))
    return segs && segs.length >= 2 ? { head: 'UNC', segs } : null
  }
  return null
}

/** 文件夹的身份串。fold[i] = 第 i 段所在的卷不分大小写(那一段折成小写);头(盘符 / UNC)一律折。纯字符串。 */
export function folderIdentityOf(head: string, segs: readonly string[], fold: readonly boolean[]): string {
  const f = (x: string, on: boolean): string => (on ? x.normalize('NFC').toLowerCase() : x.normalize('NFC'))
  return joinIdentity(`folder:${f(head, true)}`, segs.map((x, i) => f(x, fold[i] ?? true)))
}

/** fs.realpath.native(系统 realpath:mac / Windows 上纠正成盘上的大小写);promises 版没有 native。 */
const realpathNative = (p: string): Promise<string> => new Promise((resolve, reject) => realpathCb.native(p, (e, r) => (e ? reject(e) : resolve(r))))

const flipAscii = (x: string): string => x.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))

/** dir 这个目录项所在的卷分不分大小写:换一下 ASCII 大小写再 lstat,是同一个 inode = 不分。没有 ASCII 字母 / 别的错 = 当不分
 *  (多折 = 多认重叠 = 偏安全)。返回 true = 折。 */
async function foldsAt(parent: string, name: string): Promise<boolean> {
  const flipped = flipAscii(name)
  if (flipped === name) return true
  try {
    const [a, b] = await Promise.all([fs.lstat(path.join(parent, name)), fs.lstat(path.join(parent, flipped))])
    return a.dev === b.dev && a.ino === b.ino
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return !(code === 'ENOENT' || code === 'ENOTDIR')
  }
}

/** 目录里面(新建的子目录会落在这个卷上)分不分大小写:找一个带 ASCII 字母的子项试;找不到 = 折。 */
async function foldsInside(dir: string): Promise<boolean> {
  let d: import('node:fs').Dir | null = null
  try {
    d = await fs.opendir(dir)
    for (let i = 0; i < 64; i++) {
      const ent = await d.read()
      if (!ent) break
      if (flipAscii(ent.name) !== ent.name) return foldsAt(dir, ent.name)
    }
  } catch { /* 不是目录 / 读不了 */ } finally { await d?.close().catch(() => {}) }
  return true
}

async function folderIdentity(base: string, segs: readonly string[]): Promise<string> {
  const win = process.platform === 'win32'
  // realpath.native 到已存在的最深一层(解开符号链接、纠正大小写),余下几段原样接上
  let cur = path.resolve(base, ...segs)
  const rest: string[] = []
  let real: string
  for (;;) {
    try { real = await realpathNative(cur); break } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new Error(ID_UNAVAILABLE) // 没权限、链接打转:认不准
      const up = path.dirname(cur)
      if (up === cur) throw new Error(ID_UNAVAILABLE)
      rest.unshift(path.basename(cur))
      cur = up
    }
  }
  const parsed = nativeSegments(real, win)
  if (!parsed) throw new Error(ID_UNAVAILABLE)
  const rootOf = win ? (parsed.head === 'UNC' ? `\\\\${parsed.segs[0]}\\${parsed.segs[1]}\\` : `${parsed.head}\\`) : '/'
  const fold: boolean[] = []
  let dirAt = rootOf
  for (let i = 0; i < parsed.segs.length; i++) {
    const name = parsed.segs[i]
    // UNC 的 server / share 和盘符一样一律折
    fold.push(win && parsed.head === 'UNC' && i < 2 ? true : await foldsAt(dirAt, name))
    dirAt = path.join(dirAt, name)
  }
  if (rest.length) {
    const inside = await foldsInside(real)
    for (let i = 0; i < rest.length; i++) fold.push(inside)
  }
  const all = cleanSegments([...parsed.segs, ...rest])
  if (!all) throw new Error(ID_UNAVAILABLE)
  return folderIdentityOf(parsed.head, all, fold)
}

const encSeg = (x: string): string => x.replace(/%/g, '%25').replace(/\//g, '%2F')
const sha32 = (x: string): string => createHash('sha256').update(x).digest('hex').slice(0, 32)

/** S3:规整后的 endpoint(同 createS3Remote 补 https://;URL 规整小写主机、去缺省端口;不要 userinfo / 查询)+ bucket + prefix。 */
export function s3IdentityOf(section: Record<string, unknown>, segs: readonly string[]): string {
  let ep = str(section.endpoint)
  const bucket = str(section.bucket)
  if (!ep || !bucket) throw new Error(ID_UNAVAILABLE)
  if (!/^https?:\/\//i.test(ep)) ep = `https://${ep}`
  let u: URL
  try { u = new URL(ep) } catch { throw new Error(ID_UNAVAILABLE) }
  const endpoint = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  const all = cleanSegments([...normPrefix(str(section.prefix)).split('/'), ...segs])
  if (!all) throw new Error(ID_UNAVAILABLE)
  return joinIdentity(`s3:${encodeURIComponent(endpoint)}/${encodeURIComponent(bucket)}`, all.map((x) => encSeg(x.normalize('NFC'))))
}

/** WebDAV:origin(不带 userinfo)+ 地址里的路径(逐段解码)+ baseDir + dir。段里的 '%' 和 '/' 再转义,解码前后同一个串。 */
export function webdavIdentityOf(section: Record<string, unknown>, segs: readonly string[]): string {
  const addr = str(section.address)
  if (!addr) throw new Error(ID_UNAVAILABLE)
  let u: URL
  try { u = new URL(addr.includes('%') ? addr : encodeURI(addr)) } catch { throw new Error(ID_UNAVAILABLE) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(ID_UNAVAILABLE)
  let addrSegs: string[]
  try { addrSegs = u.pathname.split('/').map((x) => decodeURIComponent(x)) } catch { throw new Error(ID_UNAVAILABLE) }
  const all = cleanSegments([...addrSegs, ...webdavBaseDir(typeof section.baseDir === 'string' ? section.baseDir : undefined).split('/'), ...segs])
  if (!all) throw new Error(ID_UNAVAILABLE)
  return joinIdentity(`webdav:${encodeURIComponent(u.origin)}`, all.map((x) => encSeg(x.normalize('NFC'))))
}

/** Dropbox:账号(只放 hash)+ 应用 + 小写路径(Dropbox 不分大小写)。 */
export function dropboxIdentityOf(accountId: string, app: string, section: Record<string, unknown>, segs: readonly string[]): string {
  if (!accountId || !app) throw new Error(ID_UNAVAILABLE)
  const all = cleanSegments([...normBaseDir(typeof section.baseDir === 'string' ? section.baseDir : undefined).split('/'), ...segs])
  if (!all) throw new Error(ID_UNAVAILABLE)
  return joinIdentity(`dropbox:${sha32(accountId)}:${encodeURIComponent(app)}`, all.map((x) => encSeg(x.normalize('NFC').toLowerCase())))
}

async function computeIdentity(id: string, dir: string, signal: AbortSignal): Promise<string> {
  let f: Awaited<ReturnType<typeof syncTargetsStore.read>>
  try { f = await syncTargetsStore.read() } catch { throw new Error(ID_UNAVAILABLE) }
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(f.targets, id)) throw new Error('target-not-found')
  const t = f.targets[id]
  if (!supported(t)) throw new Error(ID_UNAVAILABLE) // 认得、这一版不支持(Drive)
  let segs: string[]
  try { segs = validDir(typeof dir === 'string' ? dir : '') } catch { throw new Error(ID_UNAVAILABLE) }
  const s = t.section
  switch (t.kind) {
    case 'folder': {
      const base = str(s.path)
      if (!base || !path.isAbsolute(base)) throw new Error(ID_UNAVAILABLE)
      return folderIdentity(base, segs)
    }
    case 's3': return s3IdentityOf(s, segs)
    case 'webdav': return webdavIdentityOf(s, segs)
    case 'dropbox': {
      const app = remoteSyncNet.dropboxAppKey(s as { appKey?: string })
      let account = str(s.accountId) // 授权时和 refresh token 一起存下的;没有才去问 Dropbox
      if (!account) {
        const refreshToken = str(s.refreshToken)
        if (!app || !refreshToken || signal.aborted) throw new Error(ID_UNAVAILABLE) // 已经超时了就别再发请求
        account = await dropboxAccountId({ appKey: app, refreshToken }, signal)
      }
      return dropboxIdentityOf(account, app, s, segs)
    }
  }
}

/** 只回两个码:target-not-found 照传,别的(可能带原文)一律 target-identity-unavailable。10 秒没出结果也算。 */
async function targetIdentity(id: string, dir: string): Promise<string> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error(ID_UNAVAILABLE)) }, TARGET_IDENTITY_TIMEOUT_MS) })
  try {
    const out = await Promise.race([computeIdentity(id, dir, ctl.signal), timeout])
    if (typeof out !== 'string' || !out) throw new Error(ID_UNAVAILABLE)
    return out
  } catch (e) {
    throw new Error((e as Error)?.message === 'target-not-found' ? 'target-not-found' : ID_UNAVAILABLE)
  } finally { clearTimeout(timer) }
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
      const cur = await legacyRemoteSync.viewWithSection() // 视图和比位置用的那段来自同一次严格读
      if (!cur) return null
      const f = await syncTargetsStore.read()
      return { ...cur.view, targetId: f.legacy?.targetId ?? null, currentTargetId: currentTargetOf(f.targets, cur.backend, cur.section) }
    },
    async importLegacyRemoteSync() {
      await touch()
      const { backend, section } = await legacyRemoteSync.section()
      if (backend === 'penzor') throw new Error('penzor-not-importable')
      if (!(SYNC_TARGET_KINDS as readonly string[]).includes(backend)) throw new Error('no-legacy-backend')
      const kind = backend as SyncTargetKind
      const why = incompleteReason(kind, section)
      if (why) throw new Error(why)
      const source = legacySourceOf(kind, section)
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
    async identity(targetId, dir) { await touch(); return targetIdentity(targetId, dir) },
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
