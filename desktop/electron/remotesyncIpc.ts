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
import { syncVaultRoot } from './amadeus/vaultList'
import { cloudVaultDir, hash8, isManagedCloudVault } from './amadeus/cloudPaths'
import { isDevMode } from './forsionHome'
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
import { createDirRemote } from './remotesync/fsLocal'
import { createS3Remote, normPrefix, type S3Config } from './remotesync/fsS3'
import { createWebdavRemote, type WebdavConfig } from './remotesync/fsWebdav'
import type { RemoteFs, SyncReport } from './remotesync/types'
import { contentSyncOwned } from './contentSyncHost'
import { currentCloudAccountId } from './amadeus/settings'

export interface RemoteSyncConfig {
  /** penzor = Forsion 云端:实现住在 Forsion Extend(remotesync/backends.ts 注册点),这里只保留配置形状。 */
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

interface BuiltRemote { remote: RemoteFs; fingerprint: string; maxFileBytes?: number }

async function buildRemote(cfg: RemoteSyncConfig): Promise<BuiltRemote | { error: string }> {
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
  running = true
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
  const before = await target()
  if ('error' in before) return { ok: false, moved: 0, error: before.error }
  const dry = await runNow({ dryRun: true })
  if (!dry.ok || !dry.plan) return { ok: false, moved: 0, error: dry.errors[0] ?? 'dry-run-failed' }
  const keys = dry.plan.filter(differsFromCloud).map((i) => i.key)
  const forget = dry.plan.filter((i) => i.kind === 'pushDelete').map((i) => i.key) // 这台删了、云端还在:用云端那份 = 拉回来
  if (!keys.length && !forget.length) return { ok: true, moved: 0 }
  if (running) return { ok: false, moved: 0, error: 'already-running' }
  running = true
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
    broadcast()
  }
}

export function registerRemoteSync(): void {
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
      // 外置后端(Forsion Extend 注册的 kind,如 penzor):渲染层只列这里有的选项
      backends: extraBackendKinds(),
    }
  })
  ipcMain.handle('remotesync:set', async (_e, patch: Partial<RemoteSyncConfig>) => {
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
