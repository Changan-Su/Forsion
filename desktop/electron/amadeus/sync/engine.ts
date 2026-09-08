/**
 * Amadeus 云同步引擎(桌面主进程)。
 *
 * 形态:云 vault = 本地 vault 内的一个同步子树(默认 'Cloud/'),逻辑双 vault、物理单树。
 * 协议零新增 —— 全部使用现有服务端 API:tree(+P1 entries)/file CAS/binary/asset/changes/SSE。
 *
 * 关键机制:
 * - 单串行 job 队列:所有拉/推/对账依次执行,天然免路径级并发竞态;
 * - 引擎自己的写盘不走 VaultManager(绕开自写台账)→ watcher 照常发外部变更事件 →
 *   渲染端刷新/索引更新全部白拿;回推环由「reconcile 按 hash 幂等」消解(拉完 shadow 已更新,
 *   watcher 触发的 reconcile 发现 hash 一致 → no-op);
 * - 回声抑制:推送带 X-Amadeus-Client=deviceId,SSE 里自己的事件只推游标不应用;
 * - 冲突 = LWW + 冲突副本(见 reconcile.ts);
 * - 断线/长离线:SSE 断 → 退避重连;追赶窗口不够(reset / changes 有缺口)→ 全量对账,
 *   shadow 即墓碑知识源,服务端无需软删。
 */

import { createHash } from 'node:crypto'
import { promises as fs, existsSync, renameSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { defaultWorkspaceDir, forsionHomeDir } from '../../forsionHome'
import { cloudAccountNamespace, currentCloudAccountId, readConfig, writeConfig } from '../settings'
import { conflictCopyPath, decide, mergeText3, shouldTripMassDelete } from './reconcile'
import {
  isIgnoredName,
  isTextKind,
  kindForServerPath,
  normalizeServerPath,
  toServerPath,
  toVaultRel,
} from './syncPaths'
import { createCloudClient, CloudHttpError, type CloudChange, type CloudClient, type CloudTreeEntry } from './cloudClient'
import { startSse, type SseHandle } from './sseClient'
import { createShadowSaver, loadShadow, type SyncShadow } from './shadow'

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 与服务端 MAX_TEXT_BYTES 一致;二进制同限(P1 服务端补齐)
const RETRY_MS = 30_000
const SCAN_DEBOUNCE_MS = 2_500
const MERGE_MAX_BYTES = 1024 * 1024 // markdown 机会性三方合并的单侧上限(超限直接走冲突副本)
// 删除保护:全量对账计划级(绝对 200 条 / 已跟踪文件的半数且 ≥5)+ 增量 60s 滑窗(防 watcher 风暴级联清空)。
const MASS_DELETE_ABS = 200
const DELETE_STORM_WINDOW_MS = 60_000
const DELETE_STORM_MAX = 50
/** 远端删除落到本地时的软删目录(<root>/.sync-trash/<日期>/<路径>);两个方向都被 isIgnoredName 忽略。 */
const SYNC_TRASH_DIR = '.sync-trash'

/** 云 vault 的本地镜像目录:固定、应用管理,与用户自选 vault 无关(胶囊滑块的 Cloud 侧)。
 *  放在隐藏应用数据目录(~/.forsion),彻底不出现在任何工作区文件夹里——本地 vault 若选在
 *  工作区(如 ~/Forsion)也不会把云端内容混进本地模式的笔记树。 */
export function cloudVaultDir(accountId = currentCloudAccountId()): string {
  return path.join(forsionHomeDir(), 'Amadeus Accounts', cloudAccountNamespace(accountId), 'Cloud')
}
/** Previous unscoped mirror is retained for recovery; it is never a new account's upload source. */
export function unscopedCloudVaultDir(): string {
  return path.join(forsionHomeDir(), 'Amadeus Cloud')
}
export function isManagedCloudVault(root: string): boolean {
  const canonical = (value: string): string => {
    try { return realpathSync.native(value) } catch { return path.resolve(value) }
  }
  const roots = [unscopedCloudVaultDir(), legacyCloudVaultDir(), path.join(forsionHomeDir(), 'Amadeus Accounts')]
  return roots.some((base) => {
    const relative = path.relative(canonical(base), canonical(root))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}
/** 旧位置(工作区内可见目录)。已迁至隐藏目录;仅迁移与 restoreVault 兼容判定用。 */
export function legacyCloudVaultDir(): string {
  return path.join(defaultWorkspaceDir(), 'Amadeus Cloud')
}
/**
 * 一次性迁移:旧可见镜像目录 → 新隐藏目录。整目录 rename(含 与我共享/ 子绑定),
 * shadow 存的是 vault 相对路径,随目录移动仍对得上,不会被当成本地删除推给服务端。
 * ponytail: 两路径同在 $HOME 下(同卷),renameSync 原子且不会 EXDEV;失败仅记录不阻塞。
 */
export function migrateCloudMirrorDir(log: (m: string) => void = console.log): void {
  const oldDir = legacyCloudVaultDir()
  const newDir = unscopedCloudVaultDir()
  if (oldDir === newDir || !existsSync(oldDir) || existsSync(newDir)) return
  try {
    renameSync(oldDir, newDir)
    log(`[amadeus-sync] 云镜像已迁移到隐藏目录 ${oldDir} → ${newDir}`)
  } catch (e) {
    log(`[amadeus-sync] ⚠️ 云镜像迁移失败(保持旧位置,不阻塞): ${e instanceof Error ? e.message : String(e)}`)
  }
}

export type SyncState = 'disabled' | 'starting' | 'idle' | 'syncing' | 'offline' | 'auth-required' | 'error'

export interface SyncStatus {
  enabled: boolean
  state: SyncState
  lastSyncAt: number | null
  pending: number
  conflicts: number
  skipped: Array<{ path: string; reason: string }>
  error: string | null
  /** 被删除保护拦下、等用户确认的删除条数(0 = 无)。confirmMassDeletions 放行。 */
  pendingDeletions: number
}

interface EngineDeps {
  loadCreds: () => { cloudUrl?: string; token?: string }
  onStatus: (s: SyncStatus) => void
  /** P2 presence(可选):本引擎 SSE 收到的在线态(vaultId 由绑定决定)。 */
  onPresence?: (vaultId: string, data: unknown) => void
  onPresenceRoster?: (vaultId: string, data: unknown) => void
  /** 远端结构事件已应用到本地后的回调(move/rename-folder/move-folder/delete*)。
   *  按条目同步用它跟进注册表路径,否则远端改名后 scope 失配静默停同步。 */
  onRemoteApplied?: (ev: CloudChange) => void
}

/** 绑定配置:一个引擎实例同步「一个本地目录 ↔ 一个云 vault 的一个范围」。 */
export interface EngineBinding {
  /** Owner fixed for this instance. Account changes create new instances. */
  accountId?: string | null
  /** 本地根目录(绝对路径)。own=cloudVaultDir();共享=cloudVaultDir()/与我共享/<slug>。 */
  localRoot: string
  /** shadow 文件名(userData 下,每绑定一份)。 */
  shadowName: string
  /** 云 vault:own='first'(列表取第一个);共享=固定 id。 */
  vaultId: 'first' | string
  /** 服务端路径前缀(共享页所在目录;own='')。本地 rel ↔ serverDir/rel。 */
  serverDir: string
  /** 范围过滤(共享=页+子页面+资产;own=undefined 全量)。推拉双向:拉侧 3 处消费,
   *  推侧经 toServer 单咽喉——不加推侧过滤,localRoot=整个本地 vault 的按条目绑定会
   *  (a)整库误上传 (b)缩小 scope 时 decide=deleteLocal 删掉用户本地文件(过滤后=dropShadow 干净解绑)。 */
  inScope?: (serverPath: string, kind: string) => boolean
  /** 本地排除前缀(own 引擎排除「与我共享/」,交给各共享绑定)。 */
  excludePrefixes?: string[]
  /** 附加到 X-Amadeus-Client 的后缀(deviceId#suffix)。按条目绑定与 own 引擎同挂一个云 vault,
   *  不区分 clientId 时 own 引擎会把条目绑定的推送当自回声只推游标 → 镜像永不物化。 */
  clientIdSuffix?: string
  /** localRoot 必须已存在(按条目绑定指向用户 vault,可能在外置盘上)。
   *  不设时 restart 会 mkdir——对拔掉的挂载点会凭空造空根 → pushDelete 级联清空云端。 */
  requireRootExists?: boolean
  /** 目录名黑名单(如 .git/node_modules/.trash):遍历不下钻、事件不入队。
   *  防止同步一个代码文件夹时 node_modules 洪水上传;own 镜像不设,行为不变。 */
  ignoreNames?: string[]
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

export function createSyncEngine(deps: EngineDeps, binding: EngineBinding = {
  localRoot: cloudVaultDir(),
  shadowName: `amadeus-sync-${cloudAccountNamespace()}`,
  vaultId: 'first',
  serverDir: '',
  excludePrefixes: ['与我共享/'],
}) {
  /** 本地相对路径(POSIX 化)↔ 服务端路径 的绑定映射。
   *  推侧过滤单咽喉:walkLocal/watcher/notifyLocal/notifyLocalMove 全经此处,scope 外一律 null。 */
  const toServer = (rel: string): string | null => {
    const sp = toServerPath(rel, '')
    if (!sp) return null
    for (const ex of binding.excludePrefixes ?? []) if (sp === ex.replace(/\/$/, '') || sp.startsWith(ex)) return null
    if (binding.ignoreNames?.length && sp.split('/').some((seg) => binding.ignoreNames!.includes(seg))) return null
    const full = binding.serverDir ? `${binding.serverDir}/${sp}` : sp
    if (binding.inScope && !binding.inScope(full, kindForServerPath(full))) return null
    return full
  }
  const fromServer = (serverPath: string): string | null => {
    let rel: string
    if (!binding.serverDir) {
      for (const ex of binding.excludePrefixes ?? []) if (serverPath.startsWith(ex)) return null
      rel = serverPath
    } else {
      if (!serverPath.startsWith(`${binding.serverDir}/`)) return null
      rel = serverPath.slice(binding.serverDir.length + 1)
    }
    // 绑定内相对路径任一段是忽略名(.sync-trash / 临时文件 / 系统杂物 / 绑定的 ignoreNames)→ 不参与同步。
    // 否则会拉进本地忽略目录,下轮扫描看不见它 → 判「本地已删」→ 反把云端那份删掉(Codex 终审 P1/P0)。
    // 只看剥掉 serverDir 之后的相对段:云名本身叫 `.sync-trash` 之类不该让整个绑定失明。
    if (rel.split('/').some((seg) => isIgnoredName(seg) || !!binding.ignoreNames?.includes(seg))) return null
    return rel
  }
  const scoped = (serverPath: string, kind: string): boolean => !binding.inScope || binding.inScope(serverPath, kind)

  const accountId = binding.accountId ?? currentCloudAccountId()
  let accepting = false
  let generation = 0
  let lifecycle: Promise<void> = Promise.resolve()
  const pumpWaiters = new Set<() => void>()

  let state: SyncState = 'disabled'
  let error: string | null = null
  let shadow: SyncShadow | null = null
  let client: CloudClient | null = null
  let sse: SseHandle | null = null
  let sessionCreds: { cloudUrl: string; token: string } | null = null
  let boundRoot: string | null = null
  let conflicts = 0
  const skipped = new Map<string, string>()
  const saver = createShadowSaver(binding.shadowName)
  /** 删除保护:待确认的删除(serverPath → 哪一侧将被删)。shadow 保留 → 确认后 fullReconcile 重新推导执行。 */
  const pendingDeletions = new Map<string, 'local' | 'remote'>()
  let allowMassDeleteOnce = false
  /** 删除风暴闩:一旦触发(60s/50 条限流 或 计划级阈值),此后**每一条**删除都进待确认,直到用户确认
   *  (confirmMassDeletions)或待确认名单自己清空(文件被放回来)。以前只是限流:窗口一过又放 50 条,
   *  一台镜像目录被清空的设备就这样分批把云端删光(2026-09-06 实翻);Codex 终审再钉:待确认必须粘性,
   *  不能因为下一轮低于阈值就放行。 */
  let stormLatched = false
  const recentDeleteStamps: number[] = []
  /** 待确认名单落盘(shadow.pending):restart/stop 只清内存,重启后按它恢复名单与闩。 */
  const persistPending = (): void => {
    if (!shadow) return
    shadow.pending = pendingDeletions.size ? Object.fromEntries(pendingDeletions) : undefined
    saver.save(shadow)
  }
  /** 闩解除 = 风暴过去:同时清限流窗口,否则 60s 内下一次正常单删又因旧时间戳立刻重新落闩。 */
  const releaseLatch = (): void => {
    stormLatched = false
    recentDeleteStamps.length = 0
  }
  const deleteStorm = (): boolean => {
    if (stormLatched) return true
    const now = Date.now()
    while (recentDeleteStamps.length && now - recentDeleteStamps[0] > DELETE_STORM_WINDOW_MS) recentDeleteStamps.shift()
    if (recentDeleteStamps.length >= DELETE_STORM_MAX) {
      stormLatched = true
      return true
    }
    return false
  }

  // ── job 队列(严格串行)────────────────────────────────────────────────────
  interface Job {
    key?: string // reconcile 类 job 的去重键(server path)
    run: () => Promise<void>
  }
  const jobs: Job[] = []
  const queuedKeys = new Set<string>()
  let pumping = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let scanTimer: ReturnType<typeof setTimeout> | null = null
  let statusTimer: ReturnType<typeof setTimeout> | null = null

  const emitStatus = (): void => {
    if (!accepting || statusTimer) return
    statusTimer = setTimeout(() => {
      statusTimer = null
      deps.onStatus(getStatus())
    }, 200)
  }

  const setState = (s: SyncState, err?: string | null): void => {
    state = s
    if (err !== undefined) error = err
    emitStatus()
  }

  const enqueue = (job: Job, front = false): void => {
    if (!accepting) return
    if (job.key) {
      if (queuedKeys.has(job.key)) return
      queuedKeys.add(job.key)
    }
    if (front) jobs.unshift(job)
    else jobs.push(job)
    void pump()
  }

  const isNetworkErr = (e: unknown): boolean =>
    !(e instanceof CloudHttpError) || e.status >= 500 || e.status === 0

  const isAuthErr = (e: unknown): boolean => e instanceof CloudHttpError && (e.status === 401 || e.status === 403)

  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    try {
      while (jobs.length) {
        if (state === 'idle' || state === 'starting') setState('syncing')
        const job = jobs.shift()!
        if (job.key) queuedKeys.delete(job.key)
        try {
          await job.run()
        } catch (e) {
          if (!accepting) return
          if (isAuthErr(e)) {
            jobs.length = 0
            queuedKeys.clear()
            stopSse()
            setState('auth-required', '登录已失效,请重新登录 Forsion 账号')
            return
          }
          if (isNetworkErr(e)) {
            // 网络故障:该 job 重新排队,进入离线态,定时重试(SSE 重连成功也会拉活)。
            enqueue(job, true)
            stopSse()
            setState('offline', (e as Error)?.message || 'network error')
            scheduleRetry()
            return
          }
          // 业务错(4xx):记 skipped,不无限循环。
          const p = job.key ?? '(op)'
          skipped.set(p, (e as CloudHttpError)?.body?.code || `http ${(e as CloudHttpError)?.status}`)
          emitStatus()
        }
      }
      if (accepting && state === 'syncing') {
        if (shadow) {
          shadow.lastSyncAt = Date.now()
          saver.save(shadow)
        }
        setState('idle', null)
      }
    } finally {
      pumping = false
      for (const resolve of pumpWaiters) resolve()
      pumpWaiters.clear()
    }
  }

  const scheduleRetry = (): void => {
    if (!accepting || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void restart()
    }, RETRY_MS)
  }

  // ── 本地 IO 助手 ───────────────────────────────────────────────────────────
  const localAbs = (serverPath: string): string => {
    if (!boundRoot || !shadow) throw new Error('engine not bound')
    const rel = fromServer(serverPath)
    if (rel === null) throw new Error('path outside binding: ' + serverPath)
    const abs = path.resolve(boundRoot, toVaultRel(rel, shadow.folder))
    const back = path.relative(boundRoot, abs)
    if (back.startsWith('..') || path.isAbsolute(back)) throw new Error('path escapes vault: ' + serverPath)
    return abs
  }

  let tmpCounter = 0
  const atomicWrite = async (abs: string, data: string | Buffer): Promise<void> => {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    // 后缀模式对齐 vaultManager.atomicWrite —— watcher 的 ignored 规则会滤掉这些临时文件。
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${tmpCounter++}`
    await fs.writeFile(tmp, data as any)
    await fs.rename(tmp, abs)
  }

  const statOf = async (abs: string): Promise<{ size: number; mtimeMs: number } | null> => {
    try {
      const st = await fs.stat(abs)
      return st.isFile() ? { size: st.size, mtimeMs: Math.floor(st.mtimeMs) } : null
    } catch {
      return null
    }
  }

  /** 自底向上只删**空**目录(rmdir 非递归,构造上安全);非空/失败即保留。 */
  const removeEmptyDirs = async (abs: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return // 不存在:已清
    }
    for (const e of entries) {
      if (e.isDirectory()) await removeEmptyDirs(path.join(abs, e.name))
    }
    try {
      await fs.rmdir(abs)
    } catch {
      /* 非空(有幸存文件)→ 保留 */
    }
  }

  /** 读本地文件内容 hash;不存在返回 null。文本按 utf8 字符串哈希(与服务端 sha256(content) 对齐)。 */
  const localHashOf = async (serverPath: string): Promise<{ hash: string; size: number; mtimeMs: number; buf: Buffer } | null> => {
    const abs = localAbs(serverPath)
    let buf: Buffer
    try {
      buf = await fs.readFile(abs)
    } catch {
      return null
    }
    const st = await statOf(abs)
    const hash = isTextKind(kindForServerPath(serverPath)) ? sha256(buf.toString('utf8')) : sha256(buf)
    return { hash, size: st?.size ?? buf.length, mtimeMs: st?.mtimeMs ?? 0, buf }
  }

  const setShadowEntry = async (serverPath: string, seq: number, hash: string): Promise<void> => {
    if (!shadow) return
    const st = await statOf(localAbs(serverPath))
    shadow.files[serverPath] = { seq, hash, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 }
    saver.save(shadow)
  }

  const dropShadowEntry = (serverPath: string): void => {
    if (!shadow) return
    if (serverPath in shadow.files) {
      delete shadow.files[serverPath]
      saver.save(shadow)
    }
  }

  // ── 拉(服务端 → 本地)─────────────────────────────────────────────────────
  /** 把服务端当前内容落到本地;带脏检测(本地未同步的改动先另存冲突副本)。 */
  const pullPath = async (serverPath: string, knownSeq: number | null): Promise<void> => {
    if (!client || !shadow) return
    const kind = kindForServerPath(serverPath)
    let content: string | Buffer
    let seq: number
    let hash: string
    if (isTextKind(kind)) {
      let f: { content: string; seq: number; hash: string | null }
      try {
        f = await client.getFile(shadow.vaultId, serverPath)
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 404) {
          await applyRemoteDelete(serverPath)
          return
        }
        throw e
      }
      content = f.content
      seq = f.seq
      hash = f.hash ?? sha256(f.content)
    } else {
      let bytes: Buffer
      try {
        bytes = await client.getAsset(shadow.vaultId, serverPath)
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 404) {
          // asset 404 ≠ 权威删除:服务端把「无记录/无读权限/OSS 字节缺失」混在同一个 404 里,
          // 按删除处理会毁掉本地唯一幸存副本。记 skipped 留待下次对账;真删除走 change op=delete。
          skipped.set(serverPath, 'ASSET_404')
          emitStatus()
          return
        }
        throw e
      }
      content = bytes
      seq = knownSeq ?? 0
      hash = sha256(bytes)
    }

    const local = await localHashOf(serverPath)
    if (local && local.hash === hash) {
      await setShadowEntry(serverPath, seq, hash) // 内容已一致,只记账
      return
    }
    const entry = shadow.files[serverPath]
    if (local && (!entry || local.hash !== entry.hash)) {
      // 本地有未同步改动。markdown 先试机会性三方合并(base 按 shadow 基线从服务端版本快照找);
      // 干净合并 → 本地落合并稿、shadow 记服务端态、排队推回(竞态由 PUT 409 兜);否则冲突副本。
      if (entry && kind === 'page' && typeof content === 'string' && (await tryMergeText(serverPath, entry, local, content, seq, hash))) {
        return
      }
      await materializeConflictCopy(serverPath)
    }
    await atomicWrite(localAbs(serverPath), content)
    await setShadowEntry(serverPath, seq, hash)
  }

  /** markdown 冲突的机会性合并:base = 服务端版本快照里 seq === shadow.seq 且 hash 对得上的那份。
   *  找不到 base / 超限 / 合并有冲突块 / 任何网络错 → false,回落冲突副本(保守优先,绝不冒险)。 */
  const tryMergeText = async (
    serverPath: string,
    entry: { seq: number; hash: string },
    local: { buf: Buffer; hash: string },
    serverContent: string,
    serverSeq: number,
    serverHash: string,
  ): Promise<boolean> => {
    try {
      if (!client || !shadow) return false
      if (local.buf.length > MERGE_MAX_BYTES || serverContent.length > MERGE_MAX_BYTES) return false
      const versions = await client.listVersions(shadow.vaultId, serverPath)
      const v = versions.find((x) => x.seq === entry.seq)
      if (!v) return false
      const base = await client.getVersion(shadow.vaultId, v.id)
      if (sha256(base) !== entry.hash) return false // 快照对不上基线(5min 合并窗跳过等)→ 不赌
      const merged = mergeText3(local.buf.toString('utf8'), base, serverContent)
      if (merged === null) return false
      await atomicWrite(localAbs(serverPath), merged)
      await setShadowEntry(serverPath, serverSeq, serverHash) // shadow=服务端态 → 下面这单对账把合并稿推回
      enqueue({ key: serverPath, run: () => reconcileLocal(serverPath) })
      return true
    } catch {
      return false
    }
  }

  /** 本地当前内容 → 冲突副本文件;副本随后走正常推送(pushCreate)。
   *  同分钟重复冲突不互相覆盖(-2/-3… 递增);副本没保住(非 ENOENT)必须抛错中止,
   *  让调用方(pullPath)放弃覆盖原文件——宁可这单同步卡住重试,不吃掉用户改动。 */
  const materializeConflictCopy = async (serverPath: string): Promise<void> => {
    const first = normalizeServerPath(conflictCopyPath(serverPath, new Date()))
    if (!first) return
    const dot = first.lastIndexOf('.')
    const hasExt = dot > first.lastIndexOf('/')
    const stem = hasExt ? first.slice(0, dot) : first
    const ext = hasExt ? first.slice(dot) : ''
    let copyServerPath = first
    for (let n = 2; existsSync(localAbs(copyServerPath)); n++) copyServerPath = `${stem}-${n}${ext}`
    try {
      await fs.rename(localAbs(serverPath), localAbs(copyServerPath))
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return // 本地文件已不在:没有可保的
      throw e
    }
    conflicts++
    enqueue({ key: copyServerPath, run: () => reconcileLocal(copyServerPath) })
    emitStatus()
  }

  /** 远端删除落到本地 = 挪进 <root>/.sync-trash/<日期>/<相对路径>,不再 fs.rm。
   *  2026-09-06 实翻:另一台设备的镜像目录被清空,它推了 50 条删除,本机照单把用户本地库里的真文件
   *  (MOC-Tisy.md 及其子笔记)硬删了。软删后至少还能从这里捞回来;跨卷等挪不动时才退回硬删。 */
  const trashLocal = async (serverPath: string): Promise<void> => {
    if (!boundRoot) return
    const abs = localAbs(serverPath)
    const rel = fromServer(serverPath) ?? serverPath
    const base = path.join(boundRoot, SYNC_TRASH_DIR, new Date().toISOString().slice(0, 10), ...rel.split('/'))
    const dst = existsSync(base) ? `${base}.${Date.now()}` : base
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.rename(abs, dst)
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return // 本地已不在
      // 归档失败(ENOSPC/EACCES/目的地被占)绝不退化成硬删:抛错让本轮 job 失败、shadow 与源文件都留着,
      // 下轮重试。同一根内的 rename 本不该失败;真失败时最后一份本地内容比对账进度重要。
      throw new Error(`软删失败,保留本地文件 ${abs}: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  const applyRemoteDelete = async (serverPath: string): Promise<void> => {
    if (!shadow) return
    const local = await localHashOf(serverPath)
    const entry = shadow.files[serverPath] ?? null
    const d = decide(local?.hash ?? null, entry, null)
    if (d.kind === 'deleteLocal') {
      if (!allowMassDeleteOnce && deleteStorm()) {
        // 远端删除风暴:保住本地与 shadow,记待确认;确认后 fullReconcile 重新推导收敛。
        pendingDeletions.set(serverPath, 'local')
        persistPending()
        emitStatus()
        return
      }
      recentDeleteStamps.push(Date.now())
      await trashLocal(serverPath)
      dropShadowEntry(serverPath)
    } else if (d.kind === 'pushCreate') {
      dropShadowEntry(serverPath) // 编辑胜删除:洗掉旧基线,按新文件重推
      enqueue({ key: serverPath, run: () => reconcileLocal(serverPath) })
    } else {
      dropShadowEntry(serverPath)
    }
  }

  const migrateShadowPrefix = (fromPrefix: string, toPrefix: string): void => {
    if (!shadow) return
    for (const key of Object.keys(shadow.files)) {
      if (key === fromPrefix || key.startsWith(`${fromPrefix}/`)) {
        const next = toPrefix + key.slice(fromPrefix.length)
        shadow.files[next] = shadow.files[key]
        delete shadow.files[key]
      }
    }
    saver.save(shadow)
  }

  /** 应用一条远端变更事件(SSE / changes 追赶)。 */
  const applyRemoteChange = async (ev: CloudChange): Promise<void> => {
    if (!client || !shadow) return
    if (ev.seq <= shadow.cursor) return // 已应用过
    // 根目录不见了(挪走/拔盘):入站写会经 atomicWrite 的 mkdir 凭空造出只有一个文件的空根,
    // 下一轮对账把其余已跟踪文件全判成本地已删。不推游标,恢复后 fullReconcile 补课。
    if (!(await rootAlive())) return
    if (ev.origin.client && client.clientId === ev.origin.client) {
      shadow.cursor = ev.seq // 自己的回声:只推游标
      saver.save(shadow)
      return
    }
    const evKind = ev.type === 'structure' ? 'folder' : ev.type
    const inBinding = (pp: string): boolean => fromServer(pp) !== null && scoped(pp, evKind)
    if (!inBinding(ev.path) && !(ev.newPath && inBinding(ev.newPath))) {
      shadow.cursor = ev.seq // 绑定外(如 own 引擎的与我共享前缀/共享范围外):只推游标
      saver.save(shadow)
      return
    }
    const p = ev.path
    switch (ev.op) {
      case 'write':
        await pullPath(p, ev.fileSeq)
        break
      case 'delete':
        await applyRemoteDelete(p)
        break
      case 'move': {
        const to = ev.newPath
        if (!to) break
        const entry = shadow.files[p]
        const local = await localHashOf(p)
        if (local && entry) {
          try {
            await fs.mkdir(path.dirname(localAbs(to)), { recursive: true })
            await fs.rename(localAbs(p), localAbs(to))
            shadow.files[to] = { ...entry, seq: ev.fileSeq ?? entry.seq }
            delete shadow.files[p]
            saver.save(shadow)
          } catch {
            await pullPath(to, ev.fileSeq)
          }
        } else {
          dropShadowEntry(p)
          await pullPath(to, ev.fileSeq)
        }
        break
      }
      case 'mkdir':
        await fs.mkdir(localAbs(p), { recursive: true })
        break
      case 'rename-folder':
      case 'move-folder': {
        const to = ev.newPath
        if (!to) break
        try {
          await fs.mkdir(path.dirname(localAbs(to)), { recursive: true })
          await fs.rename(localAbs(p), localAbs(to))
        } catch {
          /* 本地没有该目录:靠后续文件事件/对账兜底 */
        }
        migrateShadowPrefix(p, to)
        break
      }
      case 'delete-folder': {
        const prefix = `${p}/`
        for (const key of Object.keys(shadow.files)) {
          if (key === p || key.startsWith(prefix)) await applyRemoteDelete(key)
        }
        // 绝不递归 rm:整目录强删会误杀「编辑胜删除」幸存者、风暴闸保住的文件、从未上云的本地文件
        // (含待推送的冲突副本)。逐文件删除已由上面的 applyRemoteDelete 完成,这里只做空目录清扫。
        await removeEmptyDirs(localAbs(p))
        break
      }
    }
    shadow.cursor = ev.seq
    saver.save(shadow)
    if (ev.op === 'move' || ev.op === 'rename-folder' || ev.op === 'move-folder' || ev.op === 'delete' || ev.op === 'delete-folder') {
      try {
        deps.onRemoteApplied?.(ev)
      } catch {
        /* 回调故障不阻断同步 */
      }
    }
  }

  // ── 推(本地 → 服务端)─────────────────────────────────────────────────────
  const handlePut409 = async (serverPath: string, body: any, localHash: string): Promise<void> => {
    const srvSeq = Number(body?.seq ?? 0)
    const srvContent: string | null = body?.content ?? null
    if (srvContent !== null && sha256(srvContent) === localHash) {
      await setShadowEntry(serverPath, srvSeq, localHash) // 两端各自写了相同内容
      return
    }
    if (srvContent === null && srvSeq === 0) {
      // CONFLICT + 服务端已无此文件(基线期间被删):编辑胜删除 → 重建。
      // 已无基线还 409(路径撞服务端文件夹等)→ 记 skipped,防「drop→重推→再 409」死循环。
      if (!shadow?.files[serverPath]) {
        skipped.set(serverPath, body?.code || 'EXISTS')
        emitStatus()
        return
      }
      dropShadowEntry(serverPath)
      enqueue({ key: serverPath, run: () => reconcileLocal(serverPath) })
      return
    }
    // 真冲突:服务端赢原路径,本地另存副本(pullPath 内的脏检测完成搬运)。
    await pullPath(serverPath, srvSeq)
  }

  const pushText = async (serverPath: string, baseSeq: number): Promise<void> => {
    if (!client || !shadow) return
    const local = await localHashOf(serverPath)
    if (!local) {
      enqueue({ key: serverPath, run: () => reconcileLocal(serverPath) })
      return
    }
    if (local.size > MAX_FILE_BYTES) {
      skipped.set(serverPath, 'TOO_LARGE')
      emitStatus()
      return
    }
    const content = local.buf.toString('utf8')
    try {
      const r = await client.putFile(shadow.vaultId, serverPath, content, baseSeq)
      skipped.delete(serverPath)
      await setShadowEntry(serverPath, r.seq, r.hash ?? local.hash)
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 409) {
        await handlePut409(serverPath, e.body, local.hash)
        return
      }
      throw e
    }
  }

  const pushBinary = async (serverPath: string, baseSeq: number): Promise<void> => {
    if (!client || !shadow) return
    const local = await localHashOf(serverPath)
    if (!local) {
      enqueue({ key: serverPath, run: () => reconcileLocal(serverPath) })
      return
    }
    if (local.size > MAX_FILE_BYTES) {
      skipped.set(serverPath, 'TOO_LARGE')
      emitStatus()
      return
    }
    try {
      const r = await client.putBinary(shadow.vaultId, serverPath, local.buf, { baseSeq })
      skipped.delete(serverPath)
      await setShadowEntry(serverPath, r.seq, local.hash)
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 409) {
        const srvSeq = Number(e.body?.seq ?? 0)
        const srvHash: string | null = e.body?.hash ?? null
        if (srvHash !== null && srvHash === local.hash) {
          await setShadowEntry(serverPath, srvSeq, local.hash) // 两端写了相同字节
          return
        }
        if (srvSeq === 0) {
          // 服务端已无此文件(或路径撞了文件夹/文本)。有基线 → 编辑胜删除按新文件重推;
          // 已无基线还 409 → 记 skipped 防死循环。
          if (!shadow.files[serverPath]) {
            skipped.set(serverPath, e.body?.code || 'EXISTS')
            emitStatus()
            return
          }
          dropShadowEntry(serverPath)
          enqueue({ key: serverPath, run: () => reconcileLocal(serverPath) })
          return
        }
        await pullPath(serverPath, srvSeq) // 真冲突:服务端赢原路径,本地进冲突副本
        return
      }
      throw e
    }
  }

  const pushDelete = async (serverPath: string): Promise<void> => {
    if (!client || !shadow) return
    const entry = shadow.files[serverPath]
    if (!entry) return
    if (isTextKind(kindForServerPath(serverPath))) {
      // 旧服务端兜底探测(新服务端下与 baseSeq 条件删双保险;GET→DELETE 窗口由 409 堵上)。
      try {
        const f = await client.getFile(shadow.vaultId, serverPath)
        if (f.seq !== entry.seq) {
          await pullPath(serverPath, f.seq)
          return
        }
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 404) {
          dropShadowEntry(serverPath)
          return
        }
        throw e
      }
    }
    try {
      await client.deleteFile(shadow.vaultId, serverPath, entry.seq) // 条件删:基线后被写过 → 409
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 409) {
        await pullPath(serverPath, Number(e.body?.seq ?? 0) || null) // 编辑胜删除:拉回
        return
      }
      throw e
    }
    dropShadowEntry(serverPath)
  }

  /** requireRootExists 绑定的防线:根目录不在(外置盘拔了)时禁止一切推断——
   *  否则空目录会被解读成「本地全删」→ pushDelete 级联清空云端。 */
  const rootAlive = async (): Promise<boolean> => {
    if (!boundRoot) return false
    const alive = await fs.stat(boundRoot).then((s) => s.isDirectory()).catch(() => false)
    if (alive) return true
    // 镜像根(own 引擎)不要求预先存在;但 shadow 已跟踪过文件时根却不见了 = 目录被人挪走/清空,
    // 绝不能解读成「本地全删」推给服务端(2026-09-06 另一台设备就是这样把云端删掉 50 个文件的)。
    if (!binding.requireRootExists && !Object.keys(shadow?.files ?? {}).length) return true
    setState('error', `vault 目录不存在: ${boundRoot}`)
    scheduleRetry()
    return false
  }

  /** 本地触发的单路径对账(远端视角用 shadow 基线近似;真变更由 PUT 409 兜住)。 */
  const reconcileLocal = async (serverPath: string): Promise<void> => {
    if (!shadow) return
    // scope 缩小(按条目同步剔除子页面/关闭条目)后 shadow 里还留着旧路径,而 scanJob 会按 shadow
    // 键补队到这里 —— 不复查范围的话:本地改过=push 把已排除内容推上云,本地删了=pushDelete 抹掉
    // 云端副本。范围外一律只丢基线(与 fullReconcile 对同一情形的 dropShadow 同结论)。
    if (!scoped(serverPath, kindForServerPath(serverPath))) {
      dropShadowEntry(serverPath)
      return
    }
    if (!(await rootAlive())) return
    const local = await localHashOf(serverPath)
    const entry = shadow.files[serverPath] ?? null
    const d = decide(local?.hash ?? null, entry, entry ? { seq: entry.seq, hash: entry.hash } : null)
    switch (d.kind) {
      case 'push':
        if (isTextKind(kindForServerPath(serverPath))) await pushText(serverPath, d.baseSeq)
        else await pushBinary(serverPath, d.baseSeq)
        break
      case 'pushCreate':
        if (isTextKind(kindForServerPath(serverPath))) await pushText(serverPath, 0)
        else await pushBinary(serverPath, 0)
        break
      case 'pushDelete':
        if (!allowMassDeleteOnce && (pendingDeletions.has(serverPath) || deleteStorm())) {
          // 本地删除风暴(误删镜像目录/watcher 级联)或已在待确认名单:暂不删云端,等确认。
          pendingDeletions.set(serverPath, 'remote')
          persistPending()
          emitStatus()
          break
        }
        recentDeleteStamps.push(Date.now())
        await pushDelete(serverPath)
        break
      case 'dropShadow':
        dropShadowEntry(serverPath)
        break
      default:
        break // none/adopt:无事
    }
  }

  // ── 扫描与全量对账 ─────────────────────────────────────────────────────────
  /** 遍历本地子树(含点目录如 .amadeus 资产;跳过忽略名)。返回 serverPath → stat。
   *  任何一层 readdir 失败 → 返回 null,调用方本轮放弃推断:读不到的目录若按「空」处理,里面每个
   *  已跟踪文件都会被判成本地删除 → pushDelete 级联清空云端(小子树还不够触发计划级删除保护)。 */
  const walkLocal = async (): Promise<Map<string, { size: number; mtimeMs: number }> | null> => {
    const out = new Map<string, { size: number; mtimeMs: number }>()
    if (!boundRoot || !shadow) return out
    const rootAbs = boundRoot
    let failed: string | null = null
    const walk = async (dir: string): Promise<void> => {
      if (failed) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        failed = `${dir}: ${(e as Error)?.message ?? String(e)}`
        return
      }
      for (const e of entries) {
        if (isIgnoredName(e.name)) continue
        if (e.isDirectory() && binding.ignoreNames?.includes(e.name)) continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) {
          await walk(abs)
        } else if (e.isFile()) {
          const rel = path.relative(rootAbs, abs).split(path.sep).join('/')
          const sp = toServer(rel)
          if (!sp) continue
          try {
            const s = await fs.stat(abs)
            if (!s.isFile()) continue
            out.set(sp, { size: s.size, mtimeMs: Math.floor(s.mtimeMs) })
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue // readdir 与 stat 之间被删:真的不在了
            failed = `${abs}: ${(err as Error)?.message ?? String(err)}` // EIO/EACCES ≠ 不存在:本轮不推断删除
            return
          }
        }
      }
    }
    await walk(rootAbs)
    if (failed) {
      setState('error', `本地目录读取失败,本轮不推断删除: ${failed}`)
      scheduleRetry()
      return null
    }
    return out
  }

  /** 轻量扫描:stat 与 shadow 不符的路径入队对账(推方向兜底)。 */
  const scanJob = async (): Promise<void> => {
    if (!shadow) return
    if (!(await rootAlive())) return
    const seen = await walkLocal()
    if (!seen) return
    // 待确认里已无破坏性动作可做的条目撤销:本地删除(remote)而文件已被放回来;远端删除(local)而本地
    // 文件自己也没了。名单清空 = 风暴过去,闩解除(远端恢复了文件的情况由 fullReconcile 重新推导)。
    let pendingChanged = false
    for (const [sp, side] of [...pendingDeletions]) {
      if ((side === 'remote' && seen.has(sp)) || (side === 'local' && !seen.has(sp))) { pendingDeletions.delete(sp); pendingChanged = true }
    }
    if (!pendingDeletions.size) releaseLatch()
    for (const [sp, st] of seen) {
      const entry = shadow.files[sp]
      if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) continue
      enqueue({ key: sp, run: () => reconcileLocal(sp) })
    }
    const tracked = Object.keys(shadow.files)
    const missing = tracked.filter((sp) => !seen.has(sp))
    // 增量路径同样要过计划级删除保护:60s/50 条的风暴闸只是限流,每次 SSE 重连/目录事件再扫一遍就
    // 再放行一批 —— 一台镜像目录被清空的设备就这样分批把云端删光(2026-09-06 实翻,恰好 50 条)。
    // 过阈值(或闩已落下)→ 全部记待确认(状态条「确认删除」放行后 fullReconcile 按真实三方重推),一个都不推。
    // 粘性:已在名单里的路径不因下一轮低于阈值放行(10 个缺 5 个 → 放回 1 个 → 剩 4 个照样等确认)。
    if (missing.length && !allowMassDeleteOnce && (stormLatched || shouldTripMassDelete(missing.length, tracked.length, MASS_DELETE_ABS))) {
      stormLatched = true
      for (const sp of missing) pendingDeletions.set(sp, 'remote')
      persistPending()
      emitStatus()
      return
    }
    if (pendingChanged) { persistPending(); emitStatus() }
    for (const sp of missing) if (!pendingDeletions.has(sp)) enqueue({ key: sp, run: () => reconcileLocal(sp) })
  }

  /** 全量三方对账(首次启用 / reset / 追赶缺口 / 手动 syncNow)。 */
  const fullReconcile = async (): Promise<void> => {
    if (!client || !shadow || !boundRoot) return
    if (!(await rootAlive())) return
    const tree = await client.tree(shadow.vaultId)
    const remote = new Map<string, CloudTreeEntry>()
    for (const e of tree.entries) {
      if (fromServer(e.path) === null || !scoped(e.path, e.kind)) continue // 绑定外/范围外不参与对账
      remote.set(e.path, e)
    }

    const localStats = await walkLocal()
    if (!localStats) return
    const paths = new Set<string>([...remote.keys(), ...localStats.keys(), ...Object.keys(shadow.files)])

    // 先出全量计划(纯判定),过删除保护阈值,再执行——否则级联删除(空根/坏 tree/误删镜像)
    // 一路执行到底,发现时已清空。tracked 用对账前的 shadow 条数。
    const tracked = Object.keys(shadow.files).length
    const plan: Array<{ sp: string; d: ReturnType<typeof decide>; rSeq: number | null; localHash: string | null }> = []
    for (const sp of paths) {
      const entry = shadow.files[sp] ?? null
      const r = remote.get(sp) ?? null
      const st = localStats.get(sp) ?? null
      // 本地 hash:stat 与 shadow 一致 → 直接用基线 hash,免读文件。
      let localHash: string | null = null
      if (st) {
        if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) localHash = entry.hash
        else localHash = (await localHashOf(sp))?.hash ?? null
      }
      plan.push({ sp, d: decide(localHash, entry, r ? { seq: r.seq, hash: r.hash } : null), rSeq: r?.seq ?? null, localHash })
    }
    const delCount = plan.filter((p) => p.d.kind === 'deleteLocal' || p.d.kind === 'pushDelete').length
    const tripped = !allowMassDeleteOnce && (stormLatched || shouldTripMassDelete(delCount, tracked, MASS_DELETE_ABS))
    if (tripped && delCount) stormLatched = true
    pendingDeletions.clear()

    for (const { sp, d, rSeq, localHash } of plan) {
      if (tripped && (d.kind === 'deleteLocal' || d.kind === 'pushDelete')) {
        pendingDeletions.set(sp, d.kind === 'deleteLocal' ? 'local' : 'remote')
        continue
      }
      if (d.kind === 'deleteLocal' || d.kind === 'pushDelete') {
        // 计划是老照片:出计划到执行之间用户可能改了/重建了该文件。破坏性动作前重验本地现状,
        // 不符 → 弃用旧决策,重新入队单路径对账。
        const cur = (await localHashOf(sp))?.hash ?? null
        if (cur !== localHash) {
          enqueue({ key: sp, run: () => reconcileLocal(sp) })
          continue
        }
      }
      switch (d.kind) {
        case 'adopt':
          await setShadowEntry(sp, rSeq!, localHash!)
          break
        case 'pull':
          await pullPath(sp, rSeq)
          break
        case 'push':
          if (isTextKind(kindForServerPath(sp))) await pushText(sp, d.baseSeq)
          else await pushBinary(sp, d.baseSeq)
          break
        case 'pushCreate':
          if (isTextKind(kindForServerPath(sp))) await pushText(sp, 0)
          else await pushBinary(sp, 0)
          break
        case 'pushDelete':
          await pushDelete(sp)
          break
        case 'deleteLocal':
          await trashLocal(sp)
          dropShadowEntry(sp)
          break
        case 'conflict':
          await pullPath(sp, rSeq) // pullPath 内脏检测会先试合并、再物化冲突副本
          break
        case 'dropShadow':
          dropShadowEntry(sp)
          break
        case 'none':
          break
      }
    }
    if (allowMassDeleteOnce) {
      allowMassDeleteOnce = false // 一次性放行已消费
      recentDeleteStamps.length = 0
    }
    if (!pendingDeletions.size) releaseLatch() // 计划里已无删除(文件放回来了)→ 闩解除
    persistPending()
    if (tripped) emitStatus()

    // 服务端文件夹 → 本地补目录(空文件夹也可见);本地空目录刻意不上推。
    for (const f of tree.folders) {
      if (fromServer(f) === null || !scoped(f, 'folder')) continue
      try {
        await fs.mkdir(localAbs(f), { recursive: true })
      } catch {
        /* 与同名文件撞了等:忽略 */
      }
    }

    shadow.cursor = tree.seq
    shadow.lastSyncAt = Date.now()
    saver.save(shadow)
  }

  /** 变更流追赶;窗口被剪(有缺口)→ 全量对账。 */
  const catchUp = async (): Promise<void> => {
    if (!client || !shadow) return
    const since = shadow.cursor
    const r = await client.changes(shadow.vaultId, since)
    const gap =
      (r.changes.length === 0 && r.seq > since) ||
      (r.changes.length > 0 && r.changes[0].seq !== since + 1)
    if (gap) {
      await fullReconcile()
      return
    }
    for (const ev of r.changes) await applyRemoteChange(ev)
  }

  // ── 镜像目录自带 watcher(引擎独立于活动 vault,外部改动/非活动期改动全靠它)────
  let watcher: FSWatcher | null = null

  const watcherClosures: Promise<unknown>[] = []
  const stopWatcher = (): void => {
    if (watcher) watcherClosures.push(watcher.close())
    watcher = null
  }

  const startWatcher = (): void => {
    if (!accepting || watcher || !boundRoot) return
    // 与 VaultWatcher 不同:点目录(.amadeus 资产)必须纳入;只滤原子写临时文件与系统杂物。
    watcher = chokidar.watch(boundRoot, {
      ignoreInitial: true,
      depth: 12,
      ignored: (p: string) => {
        const base = path.basename(p)
        return isIgnoredName(base) || !!binding.ignoreNames?.includes(base)
      },
    })
    const onPath = (abs: string): void => {
      if (!boundRoot) return
      const rel = path.relative(boundRoot, abs)
      if (!rel || rel.startsWith('..')) return
      const sp = toServer(rel)
      if (!sp) return
      enqueue({ key: sp, run: () => reconcileLocal(sp) })
    }
    watcher.on('change', onPath)
    watcher.on('add', onPath)
    // 文件删除不逐条对账:逐条 = 每个 unlink 各自 pushDelete,只受 50/分钟限流,整目录被清空时恰好
    // 放掉 50 条(2026-09-06 事故主路径,Codex 终审钉出)。改走防抖扫描,让缺失集整体过计划级阈值。
    watcher.on('unlink', () => scanLater())
    watcher.on('unlinkDir', () => scanLater()) // 目录整删:前缀内容靠扫描对账
  }

  // ── SSE 生命周期 ───────────────────────────────────────────────────────────
  const stopSse = (): void => {
    sse?.stop()
    sse = null
  }

  const startSseLoop = (): void => {
    if (!accepting || !client || !shadow || sse) return
    const creds = sessionCreds
    if (!creds) return
    sse = startSse(
      { baseUrl: creds.cloudUrl, vaultId: shadow.vaultId, token: creds.token },
      {
        getSince: () => shadow?.cursor ?? 0,
        onHello: (seq) => {
          if (shadow && seq > shadow.cursor) enqueue({ run: catchUp })
        },
        onChange: (data) => {
          enqueue({ run: () => applyRemoteChange(data as CloudChange) })
        },
        onReset: () => {
          enqueue({ run: fullReconcile })
        },
        onOpen: () => {
          if (state === 'offline' || state === 'starting') setState('idle', null)
          enqueue({ run: scanJob }) // 断线期间本地改动补推
        },
        onDown: () => {
          if (state === 'idle' || state === 'syncing') setState('offline')
        },
        onPresence: (d) => deps.onPresence?.(shadow?.vaultId ?? '', d),
        onPresenceRoster: (d) => deps.onPresenceRoster?.(shadow?.vaultId ?? '', d),
      },
    )
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────────
  const ensureDeviceId = async (): Promise<string> => {
    const cfg = await readConfig(accountId)
    if (cfg.cloudSync?.deviceId) return cfg.cloudSync.deviceId
    const id = `desk-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
    await writeConfig({ cloudSync: { ...(cfg.cloudSync ?? {}), deviceId: id } }, accountId)
    return id
  }

  /** 依据 config + 登录态决定启动/停止。镜像目录固定,与用户自选 vault 无关。幂等。 */
  const initialize = async (gen: number): Promise<void> => {
    stopSse()
    stopWatcher()
    jobs.length = 0
    queuedKeys.clear()
    pendingDeletions.clear()
    allowMassDeleteOnce = false
    stormLatched = false
    recentDeleteStamps.length = 0
    const cfg = await readConfig(accountId)
    if (gen !== generation) return
    const cs = cfg.cloudSync
    if (cs?.enabled === false) {
      // 仅显式停用才下线;缺省 = 登录即同步(云 vault 的存在意义就是同步)。
      boundRoot = null
      client = null
      setState('disabled', null)
      return
    }
    if (!accountId || accountId !== currentCloudAccountId()) {
      setState('auth-required', '未登录 Forsion 账号')
      return
    }
    boundRoot = binding.localRoot
    if (binding.requireRootExists) {
      // 指向用户 vault 的绑定:根不在(外置盘拔了/目录被移走)绝不 mkdir——
      // 空根会被当成「本地全删」推给服务端。停在 error 态定时重试。
      const alive = await fs.stat(boundRoot).then((s) => s.isDirectory()).catch(() => false)
      if (gen !== generation) return
      if (!alive) {
        setState('error', `vault 目录不存在: ${boundRoot}`)
        scheduleRetry()
        return
      }
    }
    // own 镜像根的 mkdir 挪到 shadow 装载之后:shadow 已跟踪文件而根不见了 = 目录被挪走/清空,
    // 凭空造空根会让全量对账把「本地全没了」当成删除(小 shadow 够不到阈值就真删云端)。
    if (gen !== generation) return
    const creds = deps.loadCreds()
    if (!creds.cloudUrl || !creds.token) {
      client = null // 丢弃旧账号的 client:登出后绝不能拿旧 token 继续同步
      setState('auth-required', '未登录 Forsion 账号')
      return
    }
    setState('starting', null)
    const deviceId = cs?.deviceId ?? (await ensureDeviceId())
    if (gen !== generation) return
    // 按条目绑定带后缀:与 own 镜像引擎同挂一个云 vault,同 clientId 会被互相当自回声。
    const clientId = binding.clientIdSuffix ? `${deviceId}#${binding.clientIdSuffix}` : deviceId
    sessionCreds = { cloudUrl: creds.cloudUrl, token: creds.token }
    client = createCloudClient({ baseUrl: creds.cloudUrl, token: creds.token, clientId })

    try {
      let vaultId = binding.vaultId === 'first' ? cs?.vaultId : binding.vaultId
      if (!vaultId) {
        const vaults = await client.listVaults()
        if (gen !== generation) return
        if (!vaults.length) throw new Error('云端无可用 vault')
        vaultId = vaults[0].id
        await writeConfig({ cloudSync: { ...(cs ?? {}), vaultId } }, accountId)
      }
      if (gen !== generation) return
      const prev = await loadShadow(binding.shadowName)
      if (gen !== generation) return
      shadow =
        prev && prev.vaultRoot === boundRoot && prev.vaultId === vaultId && prev.folder === ''
          ? prev
          : {
              vaultRoot: boundRoot,
              folder: '', // 镜像模式:镜像根 = 云 vault 根,无子树前缀
              vaultId,
              cursor: 0,
              lastSyncAt: null,
              files: {},
            }
      if (gen !== generation) return
      // 上次没确认完的待确认名单:恢复名单并落闩 —— 不然重启就是绕过确认的后门。
      for (const [sp, side] of Object.entries(shadow.pending ?? {})) pendingDeletions.set(sp, side)
      if (pendingDeletions.size) stormLatched = true
      if (!binding.requireRootExists) {
        const alive = await fs.stat(boundRoot).then((s) => s.isDirectory()).catch(() => false)
        if (gen !== generation) return
        if (!alive) {
          if (Object.keys(shadow.files).length) {
            setState('error', `镜像目录不存在(已跟踪 ${Object.keys(shadow.files).length} 个文件,不造空根): ${boundRoot}`)
            scheduleRetry()
            return
          }
          await fs.mkdir(boundRoot, { recursive: true })
          if (gen !== generation) return
        }
      }
      startWatcher()
      enqueue({ run: fullReconcile })
      enqueue({
        run: async () => {
          startSseLoop()
        },
      })
    } catch (e) {
      if (gen !== generation) return
      if (isAuthErr(e)) setState('auth-required', '登录已失效,请重新登录 Forsion 账号')
      else {
        setState('offline', (e as Error)?.message || String(e))
        scheduleRetry()
      }
    }
  }

  // Stop invalidates startup immediately, then drains the one active job before
  // credentials or roots may change. Queued jobs and delayed callbacks cannot
  // resurrect the retired engine. This also serializes overlapping restarts.
  const pause = (): void => {
    accepting = false
    stopSse()
    stopWatcher()
    jobs.length = 0
    queuedKeys.clear()
    for (const timer of [retryTimer, scanTimer, statusTimer]) if (timer) clearTimeout(timer)
    retryTimer = scanTimer = statusTimer = null
  }
  const drain = async (): Promise<void> => {
    if (pumping) await new Promise<void>((resolve) => pumpWaiters.add(resolve))
    await Promise.all(watcherClosures.splice(0))
    await saver.flush()
    shadow = null
    client = null
    sessionCreds = null
    boundRoot = null
    conflicts = 0
    skipped.clear()
    pendingDeletions.clear()
    allowMassDeleteOnce = false
    stormLatched = false
    recentDeleteStamps.length = 0
    state = 'disabled'
    error = null
  }
  const onQuit = (): void => { void stop() }
  const restart = (): Promise<void> => {
    app.removeListener('before-quit', onQuit)
    app.once('before-quit', onQuit)
    const gen = ++generation
    pause()
    const next = lifecycle.catch(() => {}).then(async () => {
      await drain()
      if (gen !== generation) return
      accepting = true
      await initialize(gen)
    })
    lifecycle = next
    return next
  }
  const stop = (): Promise<void> => {
    app.removeListener('before-quit', onQuit)
    ++generation
    pause()
    const next = lifecycle.catch(() => {}).then(drain)
    lifecycle = next
    return next
  }

  // ── 对外 API ───────────────────────────────────────────────────────────────
  const getStatus = (): SyncStatus => ({
    enabled: state !== 'disabled',
    state,
    lastSyncAt: shadow?.lastSyncAt ?? null,
    pending: jobs.length,
    conflicts,
    skipped: [...skipped].map(([p, reason]) => ({ path: p, reason })),
    error,
    pendingDeletions: pendingDeletions.size,
  })

  return {
    getStatus,

    /** 应用启动时调用一次;登录态变化后可再调(幂等)。 */
    start(): void {
      void restart()
    },

    /** 本地变更通知(VaultManager 写钩子 + watcher 外部变更)。vaultRel 允许 OS 分隔符。 */
    notifyLocal(vaultRel: string, kind: 'write' | 'remove', dstVaultRel?: string): void {
      if (!shadow || state === 'disabled' || state === 'auth-required') return
      const src = toServer(vaultRel)
      const dst = dstVaultRel ? toServer(dstVaultRel) : null
      if (kind === 'write' && src) {
        if (!isIgnoredName(src.split('/').pop() || '')) enqueue({ key: src, run: () => reconcileLocal(src) })
        return
      }
      if (kind === 'remove') {
        // remove 可能是文件也可能是整个目录:shadow 里所有该前缀条目都对账一遍。
        if (!src) return
        const prefix = `${src}/`
        let hit = false
        for (const key of Object.keys(shadow.files)) {
          if (key === src || key.startsWith(prefix)) {
            hit = true
            enqueue({ key, run: () => reconcileLocal(key) })
          }
        }
        if (!hit && src) enqueue({ key: src, run: () => reconcileLocal(src) })
        void dst
      }
    },

    /** 本地移动(moveEntry 钩子)。跨子树边界 = 一侧删一侧建;目录移动逐条目处理。 */
    notifyLocalMove(fromVaultRel: string, toVaultRel: string): void {
      if (!shadow || state === 'disabled' || state === 'auth-required') return
      const from = toServer(fromVaultRel)
      const to = toServer(toVaultRel)
      if (!from && !to) return
      if (from && to && client) {
        // 双端都在子树内:优先精确 move(保服务端文件 id/版本链);目录 move 走文件夹 API。
        const vaultId = shadow.vaultId
        enqueue({
          run: async () => {
            if (!client || !shadow) return
            const st = await statOf(localAbs(to))
            const isDir = st === null && (await fs.stat(localAbs(to)).then((s) => s.isDirectory()).catch(() => false))
            try {
              if (isDir) {
                const fromDir = from.slice(0, from.lastIndexOf('/'))
                const toDir = to.slice(0, to.lastIndexOf('/'))
                const fromName = from.split('/').pop()!
                const toName = to.split('/').pop()!
                if (fromDir === toDir && fromName !== toName) await client.renameFolder(vaultId, from, toName)
                else await client.moveFolder(vaultId, from, toDir)
                migrateShadowPrefix(from, to)
              } else if (shadow.files[from]) {
                const r = await client.move(vaultId, from, to)
                const entry = shadow.files[from]
                delete shadow.files[from]
                shadow.files[to] = { ...entry, seq: Number((r as any)?.seq ?? entry.seq) }
                saver.save(shadow)
                // move 后本地 stat 变了,刷新记账
                await setShadowEntry(to, shadow.files[to].seq, shadow.files[to].hash)
              } else {
                enqueue({ key: to, run: () => reconcileLocal(to) })
              }
            } catch {
              // 精确 move 失败(如服务端没有源):退化为两端各自对账。
              enqueue({ key: from, run: () => reconcileLocal(from) })
              enqueue({ key: to, run: () => reconcileLocal(to) })
              const prefix = `${from}/`
              for (const key of Object.keys(shadow?.files ?? {})) {
                if (key.startsWith(prefix)) enqueue({ key, run: () => reconcileLocal(key) })
              }
              void scanLater()
            }
          },
        })
        return
      }
      // 单侧在子树内:入界 = 新增,出界 = 删除。目录用前缀对账 + 扫描兜底。
      if (from) this.notifyLocal(fromVaultRel, 'remove')
      if (to) {
        enqueue({ key: to, run: () => reconcileLocal(to) })
        void scanLater()
      }
    },

    async setEnabled(on: boolean): Promise<SyncStatus> {
      const cfg = await readConfig(accountId)
      await writeConfig({ cloudSync: { ...(cfg.cloudSync ?? {}), enabled: on } }, accountId)
      await restart()
      return getStatus()
    },

    /** 凭据/账号变更的传播入口:换代硬重启(重读 auth.json、重建云端 client)。
     *  syncNow 只在停摆(auth-required/无 client)时才 restart——运行中换账号/登出必须走这里,
     *  否则引擎拿旧账号的 client 继续同步。 */
    async restart(): Promise<SyncStatus> {
      await restart()
      return getStatus()
    },

    async syncNow(): Promise<SyncStatus> {
      skipped.clear()
      if (state === 'disabled' || state === 'auth-required' || !client) {
        await restart()
      } else {
        enqueue({ run: fullReconcile })
      }
      return getStatus()
    },

    /** 放行一轮被删除保护拦下的批量删除:下一次全量对账按真实三方重新推导并执行。 */
    confirmMassDeletions(): SyncStatus {
      if (!pendingDeletions.size) return getStatus()
      allowMassDeleteOnce = true
      stormLatched = false
      pendingDeletions.clear()
      recentDeleteStamps.length = 0
      persistPending()
      enqueue({ run: fullReconcile })
      return getStatus()
    },

    stop,
  }

  function scanLater(): void {
    if (!accepting) return
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      scanTimer = null
      enqueue({ run: scanJob })
    }, SCAN_DEBOUNCE_MS)
  }
}
