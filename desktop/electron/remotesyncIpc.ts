/**
 * remotesync 宿主接线(隔离库 electron/remotesync/ 的唯一消费者):
 * 配置持久化(userData/remotesync[.dev].json)+ 定时调度 + IPC + 同步根解析。
 *
 * 边界约定(见 remotesync/README.md):
 *  - 同步根 = Amadeus 本地库(localVault);云镜像目录一律拒绝(那是云端模式引擎的管辖);
 *  - 按条目云同步(entrySync)绑定的路径自动加入忽略 —— 双引擎不许抢管辖同一批文件;
 *  - 本地删除注入系统回收站(shell.trashItem),兜底 fs.rm。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, app, ipcMain, net, shell } from 'electron'
import { readConfig as readAmadeusConfig } from './amadeus/settings'
import { syncVaultRoot } from './amadeus/vaultList'
import { cloudVaultDir, hash8, isManagedCloudVault } from './amadeus/cloudPaths'
import { isDevMode } from './forsionHome'
import { abortableFetch } from './remotesync/abortableFetch'
import { clampMaxFile, extraBackend, extraBackendKinds } from './remotesync/backends'
import { moveAsideFromSync, runSync } from './remotesync/engine'
import {
  FORSION_DROPBOX_APP_KEY,
  createDropboxRemote,
  dropboxAuthUrl,
  dropboxCallbackServer,
  dropboxExchangeCode,
  pkcePair,
} from './remotesync/fsDropbox'
import {
  FORSION_GDRIVE_CLIENT_ID,
  FORSION_GDRIVE_CLIENT_SECRET,
  createGdriveRemote,
  gdriveAuthUrl,
  gdriveBaseSegs,
  gdriveExchangeCode,
} from './remotesync/fsGdrive'
import { createDirRemote } from './remotesync/fsLocal'
import { createS3Remote, normPrefix, type S3Config } from './remotesync/fsS3'
import { createWebdavRemote, type WebdavConfig } from './remotesync/fsWebdav'
import type { RemoteFs, SyncReport } from './remotesync/types'
import { contentSyncOwned } from './contentSyncHost'
import { currentCloudAccountId } from './amadeus/settings'
import { remoteReportProblems, SYNC_RECORD_MAX_FAILED, type SyncTarget } from '../shared/vaultSync'
import { appendSyncRecord } from './syncRecordsIpc'
import { createLegacyGate, type LegacyGate, type LegacyGateState } from './remotesync/legacySeal'
import { createSyncTargetsStore } from './syncTargetsStore'

export interface RemoteSyncConfig {
  /** penzor = Forsion 云端:实现住在 Forsion Extend(remotesync/backends.ts 注册点),这里只保留配置形状。 */
  backend: 'off' | 'folder' | 's3' | 'webdav' | 'penzor' | 'dropbox' | 'gdrive'
  /** 定时同步间隔(分钟);0 = 仅手动。 */
  intervalMin: number
  folder?: { path: string }
  s3?: S3Config
  webdav?: WebdavConfig
  penzor?: { vault?: string }
  dropbox?: { appKey: string; refreshToken?: string; accountId?: string; email?: string; baseDir?: string }
  /** clientId / clientSecret 只存用户自建的;用内置官方客户端时留空(同 dropbox.appKey)。accountId = Drive permissionId。 */
  gdrive?: { clientId: string; clientSecret?: string; refreshToken?: string; accountId?: string; email?: string; baseDir?: string }
  /** 同步方式:both=双向(默认);push=仅上传(增量备份);pull=仅下载(增量还原)。 */
  direction?: 'both' | 'push' | 'pull'
  /** 启动后自动同步一次(15s 后)。 */
  syncOnStart?: boolean
  /** 传输并发(1-16,缺省 4)。 */
  concurrency?: number
  /** 用户忽略规则(一行一条 glob)。 */
  ignore?: string[]
  /** 单文件上限(MB);0 = 不限。缺省 100。 */
  maxFileMB?: number
}

const DEFAULT_CONFIG: RemoteSyncConfig = { backend: 'off', intervalMin: 0 }
const MIN_INTERVAL_MIN = 5

let cache: RemoteSyncConfig | null = null
/** 配置文件在、却读不了 / 解析不了:界面照常给缺省值,但下一次保存先把坏文件挪到一边再写(不拿缺省值盖掉里面的凭据)。 */
let loadBroken = false
let running = false
let lastReport: SyncReport | null = null
let progress: { done: number; total: number; key: string } | null = null
let timer: NodeJS.Timeout | null = null

const configFile = (): string =>
  path.join(app.getPath('userData'), isDevMode() ? 'remotesync.dev.json' : 'remotesync.json')

async function loadConfig(): Promise<RemoteSyncConfig> {
  if (cache) return cache
  try {
    cache = { ...DEFAULT_CONFIG, ...(JSON.parse(await fs.readFile(configFile(), 'utf8')) as RemoteSyncConfig) }
  } catch (e) {
    loadBroken = (e as NodeJS.ErrnoException)?.code !== 'ENOENT'
    cache = { ...DEFAULT_CONFIG }
  }
  return cache
}

/** 严格读(接手用,契约实现期修订 H-1 第 1 条):没有文件 = null;读不了 / 不是 JSON 对象就抛 —— 读失败 ≠ 没配置。
 *  文件里有凭据:抛的是固定错误码(会进 Extend 的日志、回渲染层),JSON.parse 的原始报错带一截原文,不进 message 也不挂 cause。
 *  bytes = 读到的原样字节(归档复制用它,和改写的底是同一次读)。 */
async function readLegacyConfigStrict(): Promise<{ bytes: Buffer; raw: string; cfg: RemoteSyncConfig } | null> {
  let bytes: Buffer
  try { bytes = await fs.readFile(configFile()) } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw new Error('remotesync-config-unreadable')
  }
  const raw = bytes.toString('utf8')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('remotesync-config-unparseable') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('remotesync-config-malformed')
  return { bytes, raw, cfg: { ...DEFAULT_CONFIG, ...(parsed as RemoteSyncConfig) } }
}

/** remotesync.json 的写一条队列:设置页 / OAuth 回调的 saveConfig 与接手时的归档改写排在一起,
 *  不会出现「归档读了旧文件 → 这边存下新凭据 → 归档把改过的旧文件 rename 回去」丢掉新凭据。 */
let configQueue: Promise<unknown> = Promise.resolve()
function inConfigQueue<T>(fn: () => Promise<T>): Promise<T> {
  const work = configQueue.then(fn)
  configQueue = work.catch(() => {})
  return work
}

function saveConfig(patch: Partial<RemoteSyncConfig>): Promise<RemoteSyncConfig> {
  return inConfigQueue(async () => {
    const next = { ...(await loadConfig()), ...patch }
    await fs.mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
    if (loadBroken) {
      // 读不了的那份原样挪开留着(里面可能有凭据),再写新的。挪不开(文件已经不在除外)就不写:覆盖写会把它截掉
      try { await fs.rename(configFile(), `${configFile()}.unreadable-${Date.now()}`) } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error('remotesync-config-move-aside-failed')
      }
      loadBroken = false
    }
    // ponytail: 凭据明文落 userData(与 amadeus-config 同一惯例);要更强上 safeStorage
    await fs.writeFile(configFile(), JSON.stringify(next, null, 2), 'utf8')
    cache = next // 写成了才进缓存:写失败时界面别显示一份没存下的配置
    return next
  })
}

interface BuiltRemote { remote: RemoteFs; fingerprint: string; maxFileBytes?: number }

/** 内置五个后端的基线指纹(runNow 的基线文件 = remotesync-state/<hash8(根|指纹)>.json)。只看配置、不出网、不要凭据齐全;
 *  认不出(不是内置后端、认身份的字段缺了)= null。buildRemote 与接手归档共用这一份,别分叉。 */
function builtinFingerprint(cfg: RemoteSyncConfig): string | null {
  switch (cfg.backend) {
    case 'folder': { const p = cfg.folder?.path?.trim(); return p ? `folder:${p}` : null }
    case 's3': { const s3 = cfg.s3; return s3?.endpoint && s3.bucket ? `s3:${s3.endpoint}/${s3.bucket}/${normPrefix(s3.prefix)}` : null }
    case 'webdav': { const wd = cfg.webdav; return wd?.address ? `webdav:${wd.address}/${wd.baseDir ?? 'forsion-vault'}` : null }
    case 'dropbox': {
      const d = cfg.dropbox
      const key = dbxAppKey(d)
      // 指纹绑账号:换 Dropbox 账号 = 基线作废走首次合流,绝不带旧基线做删除判定
      return key ? `dropbox:${d?.accountId || key}|${(d?.baseDir ?? '').trim() || '/'}` : null
    }
    case 'gdrive': {
      const g = cfg.gdrive
      const client = gdriveClient(g)
      // 指纹绑「客户端 × 账号 × 目录」:drive.file 只看得到本客户端建的文件,换客户端 = 远端可见集整个变了,
      // 必须作废基线走首次合流,否则旧基线会把「看不见」当成「被删」
      return client.clientId ? `gdrive:${client.clientId}|${g?.accountId || ''}|${gdriveBaseSegs(g?.baseDir).join('/')}` : null
    }
    default: return null
  }
}

/** Dropbox / Google Drive 出网走 Chromium 网络栈(认系统代理 / PAC / SOCKS):Node 全局 fetch 不认系统代理,
 *  国内开系统代理(非 TUN)时连不上。net.fetch 读响应体途中不理 abort、默认带 cookie,由 abortableFetch 补齐。 */
const remoteFetch = abortableFetch((input, init) => net.fetch(input, init))

async function buildRemote(cfg: RemoteSyncConfig): Promise<BuiltRemote | { error: string }> {
  if (cfg.backend === 'folder') {
    const p = cfg.folder?.path?.trim()
    if (!p) return { error: 'no folder path' }
    return { remote: createDirRemote(p), fingerprint: builtinFingerprint(cfg)! }
  }
  if (cfg.backend === 's3') {
    const s3 = cfg.s3
    if (!s3?.endpoint || !s3.bucket || !s3.accessKeyID || !s3.secretAccessKey) return { error: 's3 config incomplete' }
    return { remote: createS3Remote(s3), fingerprint: builtinFingerprint(cfg)! }
  }
  if (cfg.backend === 'webdav') {
    const wd = cfg.webdav
    if (!wd?.address) return { error: 'webdav config incomplete' }
    return { remote: createWebdavRemote(wd), fingerprint: builtinFingerprint(cfg)! }
  }
  if (cfg.backend === 'dropbox') {
    const d = cfg.dropbox
    const key = dbxAppKey(d)
    if (!key || !d?.refreshToken) return { error: 'dropbox-not-connected' }
    return {
      remote: createDropboxRemote({ appKey: key, refreshToken: d.refreshToken, baseDir: d.baseDir, fetch: remoteFetch }),
      fingerprint: builtinFingerprint(cfg)!,
    }
  }
  if (cfg.backend === 'gdrive') {
    const g = cfg.gdrive
    const client = gdriveClient(g)
    if (!client.clientId || !g?.refreshToken) return { error: 'gdrive-not-connected' }
    return {
      remote: createGdriveRemote({ ...client, refreshToken: g.refreshToken, baseDir: g.baseDir, fetch: remoteFetch }),
      fingerprint: builtinFingerprint(cfg)!,
    }
  }
  if (cfg.backend === 'off') return { error: 'backend off' }
  // 外置后端(penzor 住在 Forsion Extend):没注册 = 这台机器没装 Extend / 验签失败,配置还选着它 → 报具体原因,别报 backend off
  const factory = extraBackend(cfg.backend)
  if (!factory) return { error: `${cfg.backend}-unavailable` }
  return factory((cfg as unknown as Record<string, unknown>)[cfg.backend])
}

/** realpath(存在时),否则退回 resolve —— 比较用统一口径,防符号链接绕过。 */
async function canon(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)

/** 同步根 = 钉住的同步库(没钉过 = 本地库);云镜像根拒绝(按 realpath 比较)。 */
export async function resolveLocalSyncRoot(): Promise<{ root: string } | { error: string }> {
  const am = await readAmadeusConfig()
  const root = syncVaultRoot(am) ?? am.lastVault // 切库不换同步根
  if (!root) return { error: 'no-local-vault' }
  try {
    await fs.access(root)
  } catch {
    return { error: 'vault-missing' }
  }
  const r = await canon(root)
  const cloud = await canon(cloudVaultDir())
  if (isManagedCloudVault(r) || overlaps(r, cloud)) return { error: 'cloud-vault-forbidden' }
  return { root: r }
}

/** entrySync 绑定路径 → 忽略规则(双引擎不抢管辖)。库根按物理路径比(realpath:解开符号链接、mac 上纠正大小写,
 *  同 contentSyncHost.canonRoot 的口径):经软链登记的库也认得出。条目库根解析不了时:不存在(ENOENT / ENOTDIR)= 不可能是
 *  这个(在的)根;别的错(没权限、链接打转)= 不知道,当成同一个、让开它的条目(接手据此暂停),不猜。 */
async function entrySyncIgnores(root: string): Promise<string[]> {
  const am = await readAmadeusConfig()
  const here = await canon(root)
  const out: string[] = []
  for (const v of am.entrySync ?? []) {
    let same: boolean
    try { same = (await fs.realpath(v.vaultRoot)) === here } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      same = code !== 'ENOENT' && code !== 'ENOTDIR'
    }
    if (!same) continue
    for (const e of v.entries ?? []) {
      if (e.kind === 'folder') out.push(`${e.path}/`)
      else out.push(e.path)
      if (e.kind === 'page' && e.path.endsWith('.md')) out.push(`${e.path.slice(0, -3)}.fd/`)
    }
  }
  return out
}

function sendAll(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function broadcast(): void {
  sendAll('remotesync:status', { running, lastReport, progress })
}

/** 用户单文件上限,再夹到后端硬上限之下(外置后端自报,如 penzor 的服务端 50MB:不钳住的话超限文件每轮 413 永远打不完)。 */
function effectiveMaxFileSize(cfg: RemoteSyncConfig, cap?: number): number {
  const user = cfg.maxFileMB === 0 ? 0 : (cfg.maxFileMB ?? 100) * 1024 * 1024
  return clampMaxFile(user, cap)
}

/** 删除闸确认的作用域(root|指纹):挂起后用户改了配置,旧确认不得放行新目标的删除计划。 */
let confirmScope: string | null = null

async function runNow(opts?: { dryRun?: boolean; allowMassDelete?: boolean }): Promise<SyncReport> {
  const fail = (msg: string): SyncReport => ({
    ok: false,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    pushed: 0,
    pulled: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    skippedLarge: [],
    pendingDeletions: 0,
    errors: [msg],
  })
  // 锁必须在任何 await 之前拿:定时器与手动点击并发穿过 config/root 解析会双跑同一基线
  if (running) return fail('already-running')
  // 新同步接手了这份配置、这次启动正持有写权(legacySeal.ts):定时、启动那一轮、手动、预演一律不跑。也在任何 await 之前判
  if (legacyGate().blocked()) return fail('sealed')
  running = true
  const endRound = legacyGate().begin()
  const recordAccount = currentCloudAccountId() // 这一轮记在开始时的账号名下(跑到一半换了账号,也不记到新账号里)
  progress = null
  broadcast()
  let lastProgressAt = 0
  try {
    const cfg = await loadConfig()
    if(cfg.backend==='penzor'&&contentSyncOwned(currentCloudAccountId()))return fail('content-sync-owned')
    if (cfg.backend === 'off') return fail('backend-off')
    const built = await buildRemote(cfg)
    if ('error' in built) return fail(built.error)
    const rooted = await resolveLocalSyncRoot()
    if ('error' in rooted) return fail(rooted.error)
    if (cfg.backend === 'folder' && cfg.folder?.path) {
      // folder 后端与同步根互相嵌套 = 递归自我复制,拒绝
      const target = await canon(cfg.folder.path)
      if (overlaps(target, rooted.root)) return fail('folder-overlaps-vault')
    }

    const scope = `${rooted.root}|${built.fingerprint}`
    if (opts?.allowMassDelete && confirmScope !== scope) return fail('stale-confirm')

    const report = await runSync({
      localRoot: rooted.root,
      remote: built.remote,
      statePath: path.join(app.getPath('userData'), 'remotesync-state', `${hash8(scope)}.json`),
      fingerprint: built.fingerprint,
      ignoreGlobs: [...(cfg.ignore ?? []), ...(await entrySyncIgnores(rooted.root))],
      maxFileSize: effectiveMaxFileSize(cfg, built.maxFileBytes),
      direction: cfg.direction,
      concurrency: cfg.concurrency,
      allowMassDelete: opts?.allowMassDelete,
      dryRun: opts?.dryRun,
      // 回收站失败不降级硬删:抛错 → 引擎记 errors 且保留基线,下轮重试
      deleteLocalFile: async (p) => shell.trashItem(p),
      // 进度直播(状态栏/设置页):150ms 节流,末件必发
      onProgress: (done, total, current) => {
        progress = { done, total, key: current ?? '' }
        const now = Date.now()
        if (done < total && now - lastProgressAt < 150) return
        lastProgressAt = now
        broadcast()
      },
    })
    if (!opts?.dryRun) {
      lastReport = report
      confirmScope = report.pendingDeletions > 0 ? scope : null
      recordRemoteRound(report, cfg.backend, rooted.root, recordAccount)
    }
    return report
  } finally {
    running = false
    progress = null
    endRound()
    broadcast()
  }
}

const RECORD_TARGET: Record<string, SyncTarget> = { penzor: 'penzor', dropbox: 'dropbox', webdav: 'webdav', s3: 's3', folder: 'folder', gdrive: 'gdrive' }

/** 上一行记录:连着几轮都没变化只留最新一行(和 Extend 的 RoundRecorder 同一口径,定时 5 分钟一轮不会挤掉别的记录)。 */
let lastRemoteRecord: { id: string; idle: boolean; startedAt: number; pending: number; account: string | null; scope: string } | null = null

/** 一轮跑完记一行同步记录(只观测,记不上也不影响同步)。 */
function recordRemoteRound(report: SyncReport, backend: string, root: string, account: string | null): void {
  try {
    const { failures } = remoteReportProblems(report)
    // 换了账号 / 去处 / 库:上一行不再是「同一路」,不并、删除闸也重新算
    const scope = `${backend}|${root}`
    const same = !!lastRemoteRecord && lastRemoteRecord.account === account && lastRemoteRecord.scope === scope
    // held = 这一轮新拦下等用户定的;删除闸每轮都会重报同一批,不算新的
    const held = report.pendingDeletions > 0 && !(same && lastRemoteRecord!.pending > 0) ? report.pendingDeletions : 0
    const idle = report.ok && !report.pushed && !report.pulled && !report.deletedLocal && !report.deletedRemote && !report.conflicts && !held && !failures.length
    const join = idle && same && lastRemoteRecord!.idle
    const id = join ? lastRemoteRecord!.id : `remote#${report.startedAt.toString(36)}`
    lastRemoteRecord = { id, idle, startedAt: report.startedAt, pending: report.pendingDeletions, account, scope }
    appendSyncRecord({
      id, feed: 'remote', engine: 'remote', vault: root, target: RECORD_TARGET[backend] ?? 'other',
      startedAt: report.startedAt, finishedAt: report.finishedAt, completed: report.ok,
      uploaded: report.pushed, downloaded: report.pulled, merged: 0, renamed: 0,
      deletedCloud: report.deletedRemote, deletedLocal: report.deletedLocal, held,
      failed: failures.slice(0, SYNC_RECORD_MAX_FAILED), failedCount: failures.length,
    }, account)
  } catch { /* 记录绝不影响同步 */ }
}

function resetTimer(cfg: RemoteSyncConfig): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (cfg.backend === 'off' || !cfg.intervalMin) return
  const min = Math.max(MIN_INTERVAL_MIN, cfg.intervalMin)
  timer = setInterval(() => {
    void runNow().catch(() => {})
  }, min * 60_000)
}

// ── Dropbox 链接登录:回环回调(RFC 8252 native app flow)────────────────────────
// 端口写死是硬约束:Dropbox 要求 redirect_uri 与 App Console 登记值逐字相等,不支持通配端口。
// 53682 沿用 rclone 的惯例值(照它的文档建过应用的用户已经登记过这一条)。
const DBX_PORT = 53682
const DBX_REDIRECT_URI = `http://localhost:${DBX_PORT}/`
const DBX_AUTH_TIMEOUT_MS = 5 * 60_000

/** 生效 App Key:用户自建应用优先,否则用内置的 Forsion 官方应用(空 = 两者都没有)。 */
const dbxAppKey = (d?: { appKey?: string }): string => (d?.appKey ?? '').trim() || FORSION_DROPBOX_APP_KEY

let dbxPending: { appKey: string; custom: boolean; verifier: string; redirectUri?: string } | null = null
let dbxServer: { close: () => void } | null = null
let dbxTimer: NodeJS.Timeout | null = null

function stopDbxServer(): void {
  if (dbxTimer) clearTimeout(dbxTimer)
  dbxTimer = null
  dbxServer?.close()
  dbxServer = null
}

/** 起回环回调服务器并接线到配置持久化;起不来 → false,调用方降级为手贴授权码。 */
async function startDbxLoopback(state: string): Promise<boolean> {
  stopDbxServer()
  const srv = await dropboxCallbackServer(DBX_PORT, state, (r) => {
    stopDbxServer()
    if ('error' in r) {
      dbxPending = null
      sendAll('remotesync:dropboxAuth', { ok: false, error: r.error })
    } else void finishDropboxAuth(r.code).then((out) => sendAll('remotesync:dropboxAuth', out))
  })
  if (!srv) return false
  dbxServer = srv
  dbxTimer = setTimeout(() => {
    stopDbxServer()
    dbxPending = null
    sendAll('remotesync:dropboxAuth', { ok: false, error: 'auth-timeout' })
  }, DBX_AUTH_TIMEOUT_MS)
  return true
}

/** 授权码 → refresh token,落配置(账号身份一起存,fingerprint 绑账号)。 */
async function finishDropboxAuth(code: string): Promise<{ ok: boolean; error?: string; email?: string; config?: RemoteSyncConfig }> {
  const pending = dbxPending
  if (!pending) return { ok: false, error: 'auth-not-started' }
  try {
    const r = await dropboxExchangeCode(pending.appKey, code, pending.verifier, pending.redirectUri, remoteFetch)
    dbxPending = null
    const cur = (await loadConfig()).dropbox
    const config = await saveConfig({
      // 内置官方应用的 key 不落配置:否则日后换 key,旧值会一直盖住内置值
      dropbox: { ...cur, appKey: pending.custom ? pending.appKey : '', refreshToken: r.refreshToken, accountId: r.accountId, email: r.email ?? r.name },
    })
    return { ok: true, email: r.email ?? r.name, config }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

// ── Google Drive 链接登录:回环回调,端口交系统选(Google 对桌面客户端的回环地址不校验端口)──────────
// Google 已关掉 OOB「页面显示授权码」流程,没有手贴兜底:回环起不来就报错。
/** 生效客户端:用户自建优先(ID 与 secret 成对取),否则内置 Forsion 官方客户端(空 = 两者都没有)。 */
function gdriveClient(g?: { clientId?: string; clientSecret?: string }): { clientId: string; clientSecret?: string } {
  const own = (g?.clientId ?? '').trim()
  if (own) return { clientId: own, clientSecret: (g?.clientSecret ?? '').trim() || undefined }
  return { clientId: FORSION_GDRIVE_CLIENT_ID, clientSecret: FORSION_GDRIVE_CLIENT_SECRET || undefined }
}

interface GdAttempt { clientId: string; clientSecret?: string; custom: boolean; verifier: string; redirectUri: string }
/** 当前这次授权(每次「连接」新建一个;回调与换码都只认自己那一次,旧的晚到不覆盖新的)。 */
let gdAttempt: GdAttempt | null = null
let gdServer: { close: () => void } | null = null
let gdTimer: NodeJS.Timeout | null = null

function stopGdServer(): void {
  if (gdTimer) clearTimeout(gdTimer)
  gdTimer = null
  gdServer?.close()
  gdServer = null
}

/** 授权码 → refresh token,落配置(自建客户端的 ID / secret 与 token 一起存,官方的不落)。
 *  换码期间用户又点了一次「连接」:这次的结果作废,不盖掉新的。 */
async function finishGdriveAuth(attempt: GdAttempt, code: string): Promise<{ ok: boolean; error?: string; email?: string; config?: RemoteSyncConfig }> {
  try {
    const r = await gdriveExchangeCode(attempt, code, attempt.verifier, attempt.redirectUri, remoteFetch)
    if (gdAttempt !== attempt) return { ok: false, error: 'auth-superseded' }
    gdAttempt = null
    const cur = (await loadConfig()).gdrive
    const config = await saveConfig({
      gdrive: {
        ...cur,
        clientId: attempt.custom ? attempt.clientId : '',
        clientSecret: attempt.custom ? attempt.clientSecret : '',
        refreshToken: r.refreshToken,
        accountId: r.accountId,
        email: r.email ?? r.name,
      },
    })
    return { ok: true, email: r.email ?? r.name, config }
  } catch (e) {
    if (gdAttempt === attempt) gdAttempt = null
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

async function startGdriveAuth(clientId: string, clientSecret: string): Promise<{ ok: boolean; error?: string }> {
  const custom = (clientId ?? '').trim()
  const client = custom ? { clientId: custom, clientSecret: (clientSecret ?? '').trim() || undefined } : gdriveClient()
  if (!client.clientId) return { ok: false, error: 'no-client-id' }
  stopGdServer()
  const { verifier, challenge } = pkcePair()
  const state = randomBytes(16).toString('hex')
  // 先登记这一次,再起监听:回调闭包认的是自己的 attempt,不读全局
  const attempt: GdAttempt = { ...client, custom: !!custom, verifier, redirectUri: '' }
  gdAttempt = attempt
  const srv = await dropboxCallbackServer(0, state, (r) => {
    if (gdAttempt !== attempt) return // 已被新的一次顶掉
    stopGdServer()
    if ('error' in r) {
      gdAttempt = null
      sendAll('remotesync:gdriveAuth', { ok: false, error: r.error })
    } else void finishGdriveAuth(attempt, r.code).then((out) => sendAll('remotesync:gdriveAuth', out))
  })
  if (gdAttempt !== attempt) {
    srv?.close()
    return { ok: false, error: 'auth-superseded' }
  }
  if (!srv) {
    gdAttempt = null
    return { ok: false, error: 'loopback-unavailable' }
  }
  gdServer = srv
  attempt.redirectUri = `http://127.0.0.1:${srv.port}/`
  gdTimer = setTimeout(() => {
    if (gdAttempt !== attempt) return
    stopGdServer()
    gdAttempt = null
    sendAll('remotesync:gdriveAuth', { ok: false, error: 'auth-timeout' })
  }, DBX_AUTH_TIMEOUT_MS)
  await shell.openExternal(gdriveAuthUrl(client.clientId, challenge, attempt.redirectUri, state))
  return { ok: true }
}

/** 本机笔记库多大(蓬洲云「同步」页 / 首登卡片写「412 MB · 用掉 2 GB 里的 20%」)。
 *  ponytail: 只跳过点开头的目录 / 文件,不套引擎的忽略规则 —— 估个量级;要精确再接 ignoreGlobs。 */
async function rootStats(): Promise<{ files: number; bytes: number; name: string } | { error: string }> {
  const rooted = await resolveLocalSyncRoot()
  if ('error' in rooted) return rooted
  let files = 0
  let bytes = 0
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) { files++; bytes += (await fs.stat(p).catch(() => null))?.size ?? 0 }
    }
  }
  await walk(rooted.root)
  return { files, bytes, name: path.basename(rooted.root) }
}

/** 和这台不一样、选「用云端那份」时要挪走的:只在这台的 push、两边都改的 conflict、两边都有但内容不同(或判不出)的 join。 */
export const differsFromCloud = (i: { kind: string; same?: true }): boolean => i.kind === 'push' || i.kind === 'conflict' || (i.kind === 'join' && !i.same)

/**
 * 第二台电脑选「用云端那份」(云同步开启方案 2026-10-20):先演算一遍,把这台和云端不一样的文件挪到库外的
 * 「<库名> <label> <日期>」,之后正常同步拿到的就是云端那份。label 由渲染层按界面语言给(落盘的名字跟语言走)。
 * 只挪不删:同一个上级目录里 rename;挪一个算一个,中途出错就停 —— 已挪的在备份里,没挪的在原处,都不丢。
 * 挪的时候拿同步锁、核对库和云端目标都没换;基线先清后挪(见 moveAsideFromSync),这台删掉的(pushDelete)也清,好拉回来。
 */
async function adoptRemote(label: string): Promise<{ ok: boolean; moved: number; backupDir?: string; error?: string }> {
  // 演算前后各认一次「哪个库 × 哪个云端目标」:中途在设置里换了任何一边,旧计划就不能套到新目标上
  const target = async (): Promise<{ root: string; fingerprint: string } | { error: string }> => {
    const built = await buildRemote(await loadConfig())
    if ('error' in built) return built
    const rooted = await resolveLocalSyncRoot()
    return 'error' in rooted ? rooted : { root: rooted.root, fingerprint: built.fingerprint }
  }
  if (legacyGate().blocked()) return { ok: false, moved: 0, error: 'sealed' }
  const before = await target()
  if ('error' in before) return { ok: false, moved: 0, error: before.error }
  const dry = await runNow({ dryRun: true })
  if (!dry.ok || !dry.plan) return { ok: false, moved: 0, error: dry.errors[0] ?? 'dry-run-failed' }
  const keys = dry.plan.filter(differsFromCloud).map((i) => i.key)
  const forget = dry.plan.filter((i) => i.kind === 'pushDelete').map((i) => i.key) // 这台删了、云端还在:用云端那份 = 拉回来
  if (!keys.length && !forget.length) return { ok: true, moved: 0 }
  if (running) return { ok: false, moved: 0, error: 'already-running' }
  if (legacyGate().blocked()) return { ok: false, moved: 0, error: 'sealed' }
  running = true
  const endRound = legacyGate().begin()
  try {
    const now = await target()
    if ('error' in now) return { ok: false, moved: 0, error: now.error }
    if (now.root !== before.root || now.fingerprint !== before.fingerprint) return { ok: false, moved: 0, error: 'target-changed' }
    const safe = (label || 'backup').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40) || 'backup'
    const base = path.join(path.dirname(now.root), `${path.basename(now.root)} ${safe} ${new Date().toISOString().slice(0, 10)}`)
    let dir = base
    for (let n = 2; await fs.access(dir).then(() => true, () => false); n++) dir = `${base} (${n})`
    const statePath = path.join(app.getPath('userData'), 'remotesync-state', `${hash8(`${now.root}|${now.fingerprint}`)}.json`)
    const r = await moveAsideFromSync({ localRoot: now.root, keys, forget, backupDir: dir, statePath, fingerprint: now.fingerprint })
    return { ok: !r.error, moved: r.moved, backupDir: r.moved ? dir : undefined, error: r.error }
  } finally {
    running = false
    endRound()
    broadcast()
  }
}

// ── 智库同步第 2 步(契约 §3.8 D、实现期修订 H-1 第 1、2 条):新同步接手 remotesync 的宿主那一半 ──────────────

const syncTargetsFile = (): string =>
  path.join(app.getPath('userData'), isDevMode() ? 'sync-targets.dev.json' : 'sync-targets.json')
/** 宿主的「同步到哪」存档(凭据只在主进程里)。syncTargets.ts 与这里共用一份。 */
export const syncTargetsStore = createSyncTargetsStore(syncTargetsFile)

let gate: LegacyGate | null = null
function legacyGate(): LegacyGate {
  gate ??= createLegacyGate({
    loadHold: () => syncTargetsStore.readLegacy(),
    saveHold: (h) => syncTargetsStore.writeLegacy(h),
    log: (m) => console.warn(m),
  })
  return gate
}

/** 接手归档要挪的基线:remotesync-state/ 里**这个根 × 这个指纹**那份(runNow 的文件名 = hash8(根|指纹).json)。
 *  - 后端 off:没有当前的去处,一份都不挪;
 *  - 认不出根(库不在 / 云镜像)→ 抛 legacy-root-unavailable(不记 archived:交还后从零基线跑的前提就是基线已挪走);
 *  - 内置后端:指纹只看配置(builtinFingerprint,不出网),按文件名直接认;
 *  - 外置后端(penzor 的指纹要 whoami 出网,这里不调它的工厂)或内置但认身份的字段缺了:按每个基线文件里记的指纹认 ——
 *    文件名正是 hash8(这个根|它记的指纹) 才算这个根的,再要后端前缀一致(penzor 再要库名一致;同一个根、同一个库、
 *    不同账号的也挪:宁可多挪,挪走 = 交还后首次合流、不做删除判定)。读不了 / 解析不了的基线引擎本来就当空的用,不挪。 */
async function legacyBaselines(cfg: RemoteSyncConfig, stateDir: string): Promise<string[]> {
  if (cfg.backend === 'off') return []
  const rooted = await resolveLocalSyncRoot()
  if ('error' in rooted) throw new Error('legacy-root-unavailable')
  let names: string[] = []
  try { names = (await fs.readdir(stateDir)).filter((n) => n.endsWith('.json')) } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw e
  }
  const exact = builtinFingerprint(cfg)
  if (exact) {
    const want = `${hash8(`${rooted.root}|${exact}`)}.json`
    return names.includes(want) ? [want] : []
  }
  const penzorVault = cfg.backend === 'penzor' ? (typeof cfg.penzor?.vault === 'string' ? cfg.penzor.vault : 'default').trim() || 'default' : null
  const out: string[] = []
  for (const name of names) {
    let fp: unknown
    try { fp = (JSON.parse(await fs.readFile(path.join(stateDir, name), 'utf8')) as { fingerprint?: unknown })?.fingerprint } catch { continue }
    if (typeof fp !== 'string' || `${hash8(`${rooted.root}|${fp}`)}.json` !== name) continue
    if (!fp.startsWith(`${cfg.backend}:`)) continue
    if (penzorVault !== null && !fp.endsWith(`|${penzorVault}`)) continue
    out.push(name)
  }
  return out
}

/** 封口三态给设置页(契约 §3.9):v2-holds = 这次启动新同步持有写权、旧入口拦着;imported = 接手过、现在交还着(只能手动、从零基线跑);
 *  user-off = 用户自己关着(没选后端);active = 照旧在用。 */
function legacySealView(cfg: RemoteSyncConfig): LegacyGateState & { state: 'v2-holds' | 'imported' | 'user-off' | 'active' } {
  const st = legacyGate().state()
  const state = st.blocked ? 'v2-holds' : st.archived || st.hold === 'v2' ? 'imported' : cfg.backend === 'off' ? 'user-off' : 'active'
  return { ...st, state }
}

/** 设置页要显示的目录(各后端原样):文件夹 = 路径;S3 = 前缀;WebDAV = baseDir(缺省 forsion-vault);Dropbox = baseDir(缺省根);
 *  Google Drive = baseDir(缺省 Forsion-Vault);蓬洲云 = 库名。 */
export function legacyDirOf(cfg: RemoteSyncConfig): string {
  switch (cfg.backend) {
    case 'folder': return cfg.folder?.path ?? ''
    case 's3': return normPrefix(cfg.s3?.prefix)
    case 'webdav': return (cfg.webdav?.baseDir ?? 'forsion-vault').replace(/^\/+|\/+$/g, '') || 'forsion-vault'
    case 'dropbox': return cfg.dropbox?.baseDir ?? ''
    case 'gdrive': return gdriveBaseSegs(cfg.gdrive?.baseDir).join('/')
    case 'penzor': return cfg.penzor?.vault ?? 'default'
    default: return ''
  }
}

export interface LegacyRemoteSyncView {
  config: { backend: RemoteSyncConfig['backend']; dir: string; direction: 'both' | 'push' | 'pull'; ignore: string[]; maxFileMB: number; intervalMin: number; syncOnStart: boolean; concurrency: number | null }
  root: string | null
  rootError: string | null
  running: boolean
  hold: 'none' | 'v2'
  archived: boolean
  handshake: 'pending' | 'ok' | 'released'
  /** 「让开条目绑定的路径」(契约 H-2 第 2 条):同 runNow 里的 entrySyncIgnores(root),现算。非空 = 这个根也配着条目同步。 */
  entryIgnores: string[]
}

/** 新同步(Extend)用的那几样;syncTargets.ts 包成 CloudHost.syncTargets。凭据只经 legacySection() 给宿主自己,永不进 Extend。 */
export const legacyRemoteSync = {
  /** 握手:Extend 调了 syncTargets 的任一成员。v2 持有时等在途那一轮跑完。 */
  touch: (): Promise<void> => legacyGate().touch(),
  /** 宿主装载完内置包时调。 */
  extendLoaded: (present: boolean): void => legacyGate().extendLoaded(present),
  /** 没配置(文件不在)= null;读不了就抛。 */
  async view(): Promise<LegacyRemoteSyncView | null> {
    const strict = await readLegacyConfigStrict()
    if (!strict) return null
    const cfg = strict.cfg
    const rooted = await resolveLocalSyncRoot()
    const st = legacyGate().state()
    if (st.hold === 'unknown') await syncTargetsStore.readLegacy() // 持有状态读不了:这里抛出去,别回一份「没持有」
    return {
      config: {
        backend: cfg.backend,
        dir: legacyDirOf(cfg),
        direction: cfg.direction === 'push' || cfg.direction === 'pull' ? cfg.direction : 'both',
        ignore: Array.isArray(cfg.ignore) ? cfg.ignore.filter((x): x is string => typeof x === 'string') : [],
        maxFileMB: cfg.maxFileMB ?? 100,
        intervalMin: cfg.intervalMin ?? 0,
        syncOnStart: cfg.syncOnStart === true,
        concurrency: typeof cfg.concurrency === 'number' ? cfg.concurrency : null,
      },
      root: 'root' in rooted ? rooted.root : null,
      rootError: 'error' in rooted ? rooted.error : null,
      entryIgnores: 'root' in rooted ? await entrySyncIgnores(rooted.root) : [],
      running,
      hold: st.hold === 'v2' ? 'v2' : 'none',
      archived: st.archived,
      handshake: st.handshake,
    }
  },
  /** 宿主内部用(导入 sync-targets):原样那一段后端配置,含凭据。没配置 / 读不了 / 没选后端 → 抛。 */
  async section(): Promise<{ backend: RemoteSyncConfig['backend']; section: Record<string, unknown> }> {
    const strict = await readLegacyConfigStrict()
    if (!strict) throw new Error('no-legacy-config')
    const { backend } = strict.cfg
    if (backend === 'off') throw new Error('no-legacy-backend')
    const section = (strict.cfg as unknown as Record<string, unknown>)[backend]
    return { backend, section: section && typeof section === 'object' ? structuredClone(section as Record<string, unknown>) : {} }
  },
  seal: (): Promise<void> => legacyGate().seal(),
  unseal: (): Promise<void> => legacyGate().unseal(),
  /** 只在持有时:remotesync.json 原样复制进档案,原文件只改 intervalMin=0 / syncOnStart=false,remotesync-state/ 里
   *  **这个根 × 这个指纹**的基线挪进档案(契约 H-1 第 2 条;用户以前同步过的别的根 / 去处的基线留着)。幂等。
   *  整段在封口闸的锁里跑(gate.exclusive):闸关着、没有在途的一轮,中途来的 unseal 排在后面;
   *  读 remotesync.json 和改写它在同一个写队列里(saveConfig 排在前或后,不会被改写盖掉)。锁的顺序:闸 → 配置队列,别反过来。 */
  async archive(archiveDir: string): Promise<{ copied: string[]; moved: string[] }> {
    if (typeof archiveDir !== 'string' || !path.isAbsolute(archiveDir)) throw new Error('bad-archive-dir')
    return legacyGate().exclusive(async (g) => {
      if (running) throw new Error('already-running')
      const copied: string[] = []
      const moved: string[] = []
      const stateDir = path.join(app.getPath('userData'), 'remotesync-state')
      const pick = await inConfigQueue(async () => {
        const strict = await readLegacyConfigStrict()
        if (!strict) throw new Error('no-legacy-config')
        // 先认出要挪哪份基线(认不出根就抛,什么都不动):不能一边改了原文件一边留着认不出的基线还记 archived
        const names = await legacyBaselines(strict.cfg, stateDir)
        await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 })
        const dest = path.join(archiveDir, path.basename(configFile()))
        // 只复制一次:重跑时档案里那份是改之前的原件,不能被已经关了自动同步的新内容盖掉。复制的是这次严格读到的那份字节
        try { await fs.writeFile(dest, strict.bytes, { mode: 0o600, flag: 'wx' }); copied.push(dest) } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
        }
        await fs.chmod(dest, 0o600).catch(() => {})
        if ((strict.cfg.intervalMin ?? 0) !== 0 || strict.cfg.syncOnStart) {
          const obj = JSON.parse(strict.raw) as Record<string, unknown>
          obj.intervalMin = 0
          obj.syncOnStart = false
          const file = configFile()
          const mode = (await fs.stat(file)).mode & 0o777
          const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
          await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode })
          await fs.rename(tmp, file)
          cache = { ...DEFAULT_CONFIG, ...(obj as unknown as RemoteSyncConfig) }
          loadBroken = false
          resetTimer(cache)
        }
        return names
      })
      if (pick.length) await fs.mkdir(path.join(archiveDir, 'remotesync-state'), { recursive: true, mode: 0o700 })
      for (const name of pick) {
        const from = path.join(stateDir, name)
        let to = path.join(archiveDir, 'remotesync-state', name)
        if (await fs.access(to).then(() => true, () => false)) to = `${to}.${Date.now()}`
        try { await fs.rename(from, to) } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue
          if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e
          await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL)
          await fs.unlink(from)
        }
        moved.push(to)
      }
      await g.markArchived(archiveDir)
      return { copied, moved }
    })
  },
}

/** syncTargets.ts 打开 Dropbox / Google Drive 目标时用:和 remotesync 同一套生效凭据口径、同一个走系统代理的 fetch。 */
export const remoteSyncNet = {
  fetch: remoteFetch,
  dropboxAppKey: (d?: { appKey?: string }): string => dbxAppKey(d),
  gdriveClient: (g?: { clientId?: string; clientSecret?: string }) => gdriveClient(g),
}

export function registerRemoteSync(): void {
  legacyGate() // 尽早读持有状态:启动那一轮之前就要知道拦不拦
  ipcMain.handle('remotesync:get', async () => {
    const cfg = await loadConfig()
    const rooted = await resolveLocalSyncRoot()
    return {
      config: cfg,
      running,
      lastReport,
      progress,
      root: 'root' in rooted ? rooted.root : null,
      rootError: 'error' in rooted ? rooted.error : null,
      // 有内置官方 Dropbox 应用 → UI 收起 App Key 那一栏,直接给「连接 Dropbox」
      dropboxBuiltin: FORSION_DROPBOX_APP_KEY !== '',
      // 有内置官方 Google 客户端 → UI 收起客户端 ID / secret,直接给「连接 Google Drive」
      gdriveBuiltin: FORSION_GDRIVE_CLIENT_ID !== '',
      // 外置后端(Forsion Extend 注册的 kind,如 penzor):渲染层只列这里有的选项
      backends: extraBackendKinds(),
      // 智库同步第 2 步:新同步接手了没有、这次启动谁持有写权(设置页据此显示「已交给新同步」/ 兼容模式照旧)
      seal: legacySealView(cfg),
    }
  })
  ipcMain.handle('remotesync:set', async (_e, patch: Partial<RemoteSyncConfig>) => {
    // refresh token 只对签发它的那个 Google 客户端有效:设置页改了客户端再保存,旧 token 作废(要重新连接),
    // 别把 B 客户端和 A 的 token 拼在一起存下(续期必失败)
    const cur = (await loadConfig()).gdrive
    if (patch?.gdrive && cur?.refreshToken && (patch.gdrive.clientId ?? '').trim() !== (cur.clientId ?? '').trim()) {
      patch = { ...patch, gdrive: { ...patch.gdrive, refreshToken: undefined, accountId: undefined, email: undefined } }
    }
    const next = await saveConfig(patch ?? {})
    resetTimer(next)
    return next
  })
  ipcMain.handle('remotesync:run', async (_e, opts?: { dryRun?: boolean; allowMassDelete?: boolean }) => runNow(opts))
  ipcMain.handle('remotesync:rootStats', async () => rootStats())
  ipcMain.handle('remotesync:adoptRemote', async (_e, label: string) => adoptRemote(typeof label === 'string' ? label : ''))
  ipcMain.handle('remotesync:check', async () => {
    const cfg = await loadConfig()
    const built = await buildRemote(cfg)
    if ('error' in built) return { ok: false, error: built.error }
    try {
      return await built.remote.check()
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  })

  // Dropbox OAuth PKCE:start 开浏览器授权页(verifier 主进程暂存)。回环回调服务器起得来
  // 就自动回填授权码(mode:auto,结果经 remotesync:dropboxAuth 广播);起不来退回手贴(mode:manual)。
  ipcMain.handle('remotesync:dropboxAuthStart', async (_e, appKey: string) => {
    const custom = (appKey ?? '').trim()
    const key = custom || FORSION_DROPBOX_APP_KEY
    if (!key) return { ok: false, error: 'no-app-key' }
    const { verifier, challenge } = pkcePair()
    const state = randomBytes(16).toString('hex')
    const auto = await startDbxLoopback(state)
    dbxPending = { appKey: key, custom: !!custom, verifier, redirectUri: auto ? DBX_REDIRECT_URI : undefined }
    await shell.openExternal(dropboxAuthUrl(key, challenge, auto ? { redirectUri: DBX_REDIRECT_URI, state } : {}))
    return { ok: true, mode: auto ? 'auto' : 'manual', redirectUri: DBX_REDIRECT_URI }
  })
  ipcMain.handle('remotesync:dropboxAuthFinish', async (_e, _appKey: string, code: string) =>
    finishDropboxAuth(code ?? ''),
  )

  // Google Drive OAuth PKCE:只有回环自动回填一条路(结果经 remotesync:gdriveAuth 广播)
  ipcMain.handle('remotesync:gdriveAuthStart', async (_e, clientId: string, clientSecret: string) =>
    startGdriveAuth(typeof clientId === 'string' ? clientId : '', typeof clientSecret === 'string' ? clientSecret : ''),
  )

  void loadConfig().then((cfg) => {
    resetTimer(cfg)
    // 启动后自动同步一次(remotely-save 的 run-once-on-startup;15s 避开启动高峰)
    if (cfg.syncOnStart && cfg.backend !== 'off') {
      setTimeout(() => {
        void runNow().catch(() => {})
      }, 15_000)
    }
  })
}
