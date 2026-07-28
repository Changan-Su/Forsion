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
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { readConfig as readAmadeusConfig } from './amadeus/settings'
import { cloudVaultDir } from './amadeus/sync/engine'
import { hash8 } from './amadeus/sync/entryRegistry'
import { forsionWhoami, loadTanguCreds } from './forsionAuth'
import { isDevMode } from './forsionHome'
import { runSync } from './remotesync/engine'
import {
  FORSION_DROPBOX_APP_KEY,
  createDropboxRemote,
  dropboxAuthUrl,
  dropboxCallbackServer,
  dropboxExchangeCode,
  pkcePair,
} from './remotesync/fsDropbox'
import { createDirRemote } from './remotesync/fsLocal'
import { createPenzorRemote } from './remotesync/fsPenzor'
import { createS3Remote, normPrefix, type S3Config } from './remotesync/fsS3'
import { createWebdavRemote, type WebdavConfig } from './remotesync/fsWebdav'
import type { RemoteFs, SyncReport } from './remotesync/types'

export interface RemoteSyncConfig {
  backend: 'off' | 'folder' | 's3' | 'webdav' | 'penzor' | 'dropbox'
  /** 定时同步间隔(分钟);0 = 仅手动。 */
  intervalMin: number
  folder?: { path: string }
  s3?: S3Config
  webdav?: WebdavConfig
  penzor?: { vault?: string }
  dropbox?: { appKey: string; refreshToken?: string; accountId?: string; email?: string; baseDir?: string }
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
  } catch {
    cache = { ...DEFAULT_CONFIG }
  }
  return cache
}

async function saveConfig(patch: Partial<RemoteSyncConfig>): Promise<RemoteSyncConfig> {
  const next = { ...(await loadConfig()), ...patch }
  cache = next
  await fs.mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
  // ponytail: 凭据明文落 userData(与 amadeus-config 同一惯例);要更强上 safeStorage
  await fs.writeFile(configFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** whoami 身份缓存(token → username):Penzor 基线指纹要绑账号,换号绝不带旧基线对新库做删除判定。 */
const whoamiMemo = new Map<string, string>()
async function penzorIdentity(cloudUrl: string, token: string): Promise<{ id: string } | { error: string }> {
  const hit = whoamiMemo.get(token)
  if (hit) return { id: hit }
  const w = await forsionWhoami(cloudUrl, token)
  if (w.status === 'offline') return { error: 'penzor-offline' }
  if (w.status !== 'ok') return { error: 'penzor-not-logged-in' }
  const name = w.user?.username?.trim()
  if (!name) return { error: 'penzor-auth-unverified' }
  whoamiMemo.set(token, name)
  return { id: name }
}

async function buildRemote(cfg: RemoteSyncConfig): Promise<{ remote: RemoteFs; fingerprint: string } | { error: string }> {
  if (cfg.backend === 'folder') {
    const p = cfg.folder?.path?.trim()
    if (!p) return { error: 'no folder path' }
    return { remote: createDirRemote(p), fingerprint: `folder:${p}` }
  }
  if (cfg.backend === 's3') {
    const s3 = cfg.s3
    if (!s3?.endpoint || !s3.bucket || !s3.accessKeyID || !s3.secretAccessKey) return { error: 's3 config incomplete' }
    return { remote: createS3Remote(s3), fingerprint: `s3:${s3.endpoint}/${s3.bucket}/${normPrefix(s3.prefix)}` }
  }
  if (cfg.backend === 'webdav') {
    const wd = cfg.webdav
    if (!wd?.address) return { error: 'webdav config incomplete' }
    return { remote: createWebdavRemote(wd), fingerprint: `webdav:${wd.address}/${wd.baseDir ?? 'forsion-vault'}` }
  }
  if (cfg.backend === 'dropbox') {
    const d = cfg.dropbox
    const key = dbxAppKey(d)
    if (!key || !d?.refreshToken) return { error: 'dropbox-not-connected' }
    return {
      remote: createDropboxRemote({ appKey: key, refreshToken: d.refreshToken, baseDir: d.baseDir }),
      // 指纹绑账号:换 Dropbox 账号 = 基线作废走首次合流,绝不带旧基线做删除判定
      fingerprint: `dropbox:${d.accountId || key}|${(d.baseDir ?? '').trim() || '/'}`,
    }
  }
  if (cfg.backend === 'penzor') {
    const creds = loadTanguCreds()
    if (!creds.token || !creds.cloudUrl) return { error: 'penzor-not-logged-in' }
    const vault = (cfg.penzor?.vault ?? 'default').trim() || 'default'
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(vault)) return { error: 'penzor-bad-vault' }
    const ident = await penzorIdentity(creds.cloudUrl, creds.token)
    if ('error' in ident) return ident
    // token 冻结整轮:getToken 若每次重读 auth.json,同步中途换号会拿 A 的基线对 B 的库做增删
    const frozenToken = creds.token
    return {
      remote: createPenzorRemote({ baseUrl: creds.cloudUrl, vault, getToken: () => frozenToken }),
      fingerprint: `penzor:${creds.cloudUrl.replace(/\/+$/, '')}|u:${ident.id}|${vault}`,
    }
  }
  return { error: 'backend off' }
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

/** 同步根 = 本地库;云镜像根拒绝(按 realpath 比较)。 */
async function resolveRoot(): Promise<{ root: string } | { error: string }> {
  const am = await readAmadeusConfig()
  const root = am.localVault ?? am.lastVault
  if (!root) return { error: 'no-local-vault' }
  try {
    await fs.access(root)
  } catch {
    return { error: 'vault-missing' }
  }
  const r = await canon(root)
  const cloud = await canon(cloudVaultDir())
  if (overlaps(r, cloud)) return { error: 'cloud-vault-forbidden' }
  return { root: r }
}

/** entrySync 绑定路径 → 忽略规则(双引擎不抢管辖)。 */
async function entrySyncIgnores(root: string): Promise<string[]> {
  const am = await readAmadeusConfig()
  const out: string[] = []
  for (const v of am.entrySync ?? []) {
    if (path.resolve(v.vaultRoot) !== path.resolve(root)) continue
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

/** Penzor 服务端单文件上限(与 server REMOTESYNC_MAX_FILE_BYTES 对齐):客户端钳住,
 *  否则超限文件每轮推送每轮 413,永远打不完。 */
const PENZOR_MAX_FILE = 50 * 1024 * 1024
function effectiveMaxFileSize(cfg: RemoteSyncConfig): number {
  const user = cfg.maxFileMB === 0 ? 0 : (cfg.maxFileMB ?? 100) * 1024 * 1024
  if (cfg.backend !== 'penzor') return user
  return user === 0 ? PENZOR_MAX_FILE : Math.min(user, PENZOR_MAX_FILE)
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
  running = true
  progress = null
  broadcast()
  let lastProgressAt = 0
  try {
    const cfg = await loadConfig()
    if (cfg.backend === 'off') return fail('backend-off')
    const built = await buildRemote(cfg)
    if ('error' in built) return fail(built.error)
    const rooted = await resolveRoot()
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
      maxFileSize: effectiveMaxFileSize(cfg),
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
    }
    return report
  } finally {
    running = false
    progress = null
    broadcast()
  }
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
    const r = await dropboxExchangeCode(pending.appKey, code, pending.verifier, pending.redirectUri)
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

export function registerRemoteSync(): void {
  ipcMain.handle('remotesync:get', async () => {
    const cfg = await loadConfig()
    const rooted = await resolveRoot()
    return {
      config: cfg,
      running,
      lastReport,
      progress,
      root: 'root' in rooted ? rooted.root : null,
      rootError: 'error' in rooted ? rooted.error : null,
      // 有内置官方 Dropbox 应用 → UI 收起 App Key 那一栏,直接给「连接 Dropbox」
      dropboxBuiltin: FORSION_DROPBOX_APP_KEY !== '',
    }
  })
  ipcMain.handle('remotesync:set', async (_e, patch: Partial<RemoteSyncConfig>) => {
    const next = await saveConfig(patch ?? {})
    resetTimer(next)
    return next
  })
  ipcMain.handle('remotesync:run', async (_e, opts?: { dryRun?: boolean; allowMassDelete?: boolean }) => runNow(opts))
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
