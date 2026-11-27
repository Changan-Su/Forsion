/**
 * 三套同步引擎 → 状态契约(desktop/shared/vaultSync.ts 的 SyncFeedReport)。纯函数,单测在 composeVaultSync.test.ts。
 *
 * 归一化表(改之前先看单测):
 *   旧的文件夹 / 条目同步与整库镜像(Forsion Extend 的在线引擎,window.amadeusSync):
 *     disabled → off;auth-required → signed-out;offline → offline;error → error;starting → starting;idle → idle;
 *     syncing → 有 round 时按它的 stage,没有(老 Extend)= transferring。
 *     skipped 里 reason 为 HELD 的不算失败(它在 held 里,是「等你定」);其余按原因码归类(TOO_LARGE = 太大,errno = 读不了,
 *     http 5xx / timeout = 失败会再试,其余 4xx = 被拒)。待确认删除:有 ownPendingDeletions 时按引擎自己的数;
 *     老 Extend 只给全引擎合计,整笔算在镜像上(一次确认放行全部引擎,accountWide)。
 *   蓬洲云的新同步(Extend contentSync,penzor:sync:status / 老 Extend 回落 penzor:sync:get):
 *     没开 / 笔记不在规则里 → 它不算任何本机库的同步(root null,错误照样进 elsewhere);paused → paused;
 *     running 时 scanning → checking、syncing → transferring;没登录 → signed-out;换了账号待复核 → error;
 *     error 是连不上 → offline;error 只是某个文件退避中的原因 → 不算整轮出错(那个文件在 failures 里);
 *     too-large / 读不了 / 名字不合规 → failures;rateLimitedUntil 是等待。
 *   远程服务(Genesis remotesync,window.remoteSync):backend off → off;running 时有 total → transferring,否则 checking;
 *     rootError → error;上次报告的 errors / skippedLarge → failures;pendingDeletions → deletes(在设置 › 同步里确认)。
 */
import type {
  SyncFailure, SyncFeedPhase, SyncFeedReport, SyncProgress, SyncReviewItem, SyncScope, SyncTarget,
} from '../../../shared/vaultSync'
import { remoteReportProblems } from '../../../shared/vaultSync'
import type { AmadeusEntrySyncVault, AmadeusSyncStatus, RemoteSyncState } from '../types'

// ── 旧的在线引擎 ────────────────────────────────────────────────────────────────

/** 本机文件读写错误码(和 Extend engine.ts LOCAL_FILE_CODES 同一张)。 */
const LOCAL_FILE_CODES = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG', 'EILSEQ', 'EINVAL', 'ELOOP', 'EBUSY', 'EFBIG', 'EIO'])

export function legacyFeedId(s: Pick<AmadeusSyncStatus, 'binding' | 'shareKey'>): string {
  return s.binding ? `legacy:entry:${s.binding}` : s.shareKey ? `legacy:share:${s.shareKey}` : 'legacy:mirror'
}

function legacyPhase(s: AmadeusSyncStatus): SyncFeedPhase {
  switch (s.state) {
    case 'disabled': return 'off'
    case 'auth-required': return 'signed-out'
    case 'offline': return 'offline'
    case 'error': return 'error'
    case 'starting': return 'starting'
    case 'syncing': return s.round?.stage === 'checking' ? 'checking' : 'transferring'
    default: return 'idle'
  }
}

/** 服务端路径 → 库内相对路径(条目同步的服务端路径带 `<云名>/` 前缀)。 */
function localPathOf(serverPath: string, cloudName: string | null): string {
  return cloudName && serverPath.startsWith(`${cloudName}/`) ? serverPath.slice(cloudName.length + 1) : serverPath
}

function legacyFailureOf(path: string, reason: string): SyncFailure {
  if (reason === 'TOO_LARGE') return { path, reason: 'too-large', code: reason }
  if (LOCAL_FILE_CODES.has(reason)) return { path, reason: 'unreadable', code: reason }
  if (/^http 5\d\d$/.test(reason) || reason === 'timeout') return { path, reason: 'failed', code: reason }
  return { path, reason: 'rejected', code: reason }
}

export interface LegacyContext {
  /** 按条目同步的注册表(范围:条目数;云名:剥服务端路径前缀) */
  entryVaults: AmadeusEntrySyncVault[]
  /** 这条状态是不是唯一知道全引擎待确认删除合计的那条(老 Extend 没有 ownPendingDeletions 时,合计只算一次) */
  carriesTotalDeletions: boolean
}

export function legacyFeed(s: AmadeusSyncStatus, ctx: LegacyContext): SyncFeedReport {
  const id = legacyFeedId(s)
  const entry = s.binding ? ctx.entryVaults.find((v) => v.vaultRoot === s.binding) ?? null : null
  const cloudName = entry?.cloudName ?? null
  const scope: SyncScope = s.binding ? { kind: 'items', count: entry?.entries.length ?? 0 } : s.shareKey ? { kind: 'items', count: 1 } : { kind: 'vault' }
  const held = (s.held ?? []).map<SyncReviewItem>((h) => {
    const at = h.remoteUpdatedAt ? Date.parse(h.remoteUpdatedAt) : NaN
    const newer = !Number.isFinite(at) || h.localMtimeMs < 0 ? null : h.localMtimeMs > at ? 'local' : 'cloud'
    return { kind: 'differs', path: h.local, newer, ref: { feed: id, binding: s.binding ?? null, shareKey: s.shareKey ?? null, serverPath: h.path } }
  })
  const ownDeletes = typeof s.ownPendingDeletions === 'number' ? s.ownPendingDeletions : ctx.carriesTotalDeletions ? s.pendingDeletions ?? 0 : 0
  const review: SyncReviewItem[] = [...held]
  if (ownDeletes > 0) review.push({ kind: 'deletes', count: ownDeletes, items: [], canRestore: false, accountWide: true, ref: { feed: id } })
  // 新 Extend 直接给归好类的 failures;老的从 skipped 推(滤掉 HELD)
  const failures = s.failures
    ? s.failures.map((f) => ({ ...f, path: localPathOf(f.path, cloudName) }))
    : s.skipped.filter((x) => x.reason !== 'HELD').map((x) => legacyFailureOf(localPathOf(x.path, cloudName), x.reason))
  const phase = legacyPhase(s)
  return {
    id,
    engine: 'legacy',
    vault: s.binding ? { root: s.binding, side: 'local' } : { root: null, side: 'cloud' },
    target: 'penzor',
    scope,
    phase,
    progress: s.round ? { ...s.round, current: s.round.current ? { ...s.round.current, path: localPathOf(s.round.current.path, cloudName) } : null } : null,
    lastSyncAt: s.lastSyncAt ?? null,
    pendingChanges: s.pending ?? 0,
    rateLimitedUntil: s.rateLimitedUntil ?? null,
    review,
    failures,
    error: phase === 'error' || phase === 'signed-out' ? s.error ?? s.state : null,
    canSyncNow: phase !== 'off',
  }
}

/** 老 Extend(没有 getAll):注册表里有、还没收到过状态事件的条目同步 —— 按镜像的状态推它开没开(条目引擎跟镜像同起同停),
 *  具体状态和上次同步时间不知道。说「同步开着」:不说「只在这台」(用户原来那句抱怨),也不冒充「已同步」。 */
export function assumedEntryFeed(v: AmadeusEntrySyncVault, mirror: AmadeusSyncStatus | null): SyncFeedReport {
  // 云同步总开关关着(镜像 disabled)时条目引擎也不起(Extend refreshEntryBindings 同一条判断)
  // 它自己的状态还没报上来:说「开着」,不说「已同步」(盘没接上之类的毛病它自己报了才知道)
  const phase: SyncFeedPhase = !mirror ? 'unknown' : mirror.state === 'disabled' ? 'off' : mirror.state === 'auth-required' ? 'signed-out' : mirror.state === 'offline' ? 'offline' : 'unknown'
  return {
    id: `legacy:entry:${v.vaultRoot}`,
    engine: 'legacy',
    vault: { root: v.vaultRoot, side: 'local' },
    target: 'penzor',
    scope: { kind: 'items', count: v.entries.length },
    phase,
    progress: null,
    lastSyncAt: null,
    pendingChanges: 0,
    rateLimitedUntil: null,
    review: [],
    failures: [],
    error: phase === 'signed-out' ? 'not-logged-in' : null,
    canSyncNow: true,
  }
}

// ── 蓬洲云的新同步 ──────────────────────────────────────────────────────────────

/** penzor:sync:status 的回复(老 Extend 回落 penzor:sync:get 的快照,也是这个子集)。 */
export interface ContentStatusLite {
  session?: boolean
  owned?: boolean
  enabled?: boolean
  config?: { enabled: boolean; rules: Array<{ source: string; target: string }> }
  paused: boolean
  running: boolean
  phase: 'idle' | 'scanning' | 'syncing' | 'paused'
  notes?: { kind: 'vault' } | { kind: 'items'; count: number } | null
  lastSyncAt?: number | null
  pending?: number
  round?: SyncProgress | null
  error?: string
  deletes?: { latched: boolean; pending: number; token: string; items: Array<{ path: string; side: 'cloud' | 'local' }> }
  skipped?: Array<{ path: string; reason: 'invalid-name' | 'unreadable' | 'too-large'; size?: number; maxBytes?: number }>
  failures?: Array<{ path: string; target: string; reason: string; code?: string; count: number; retryAt: number }>
  rateLimitedUntil?: number
  jobs?: Array<{ path: string; direction: string; state: string; done: number; size: number | null; finishedAt?: number }>
}

/** 新同步里笔记那一类的路径带 `Amadeus/` 前缀;界面给库内相对路径。 */
const notesRel = (p: string): string => (p.startsWith('Amadeus/') ? p.slice('Amadeus/'.length) : p)

/** 老快照(没有 notes 字段)按规则推笔记的范围:Amadeus 落在开着的规则里 = 整个库,只有子文件夹开着 = 选中的几项。 */
function notesScopeOf(c: ContentStatusLite): SyncScope | null {
  if (c.notes !== undefined) return c.notes
  const cfg = c.config
  if (!cfg?.enabled) return null
  let match: { source: string; target: string } | null = null
  for (const r of cfg.rules) if ((!r.source || r.source === 'Amadeus' || 'Amadeus'.startsWith(r.source + '/')) && (!match || r.source.length > match.source.length)) match = r
  if (match && match.target !== 'off') return { kind: 'vault' }
  const n = cfg.rules.filter((r) => r.source.startsWith('Amadeus/') && r.target !== 'off').length
  return n ? { kind: 'items', count: n } : null
}

const CONNECTION = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|network|offline|socket hang up/i

const isNotesPath = (p: string): boolean => p.startsWith('Amadeus/')

/** 新同步 → feed:笔记那一类算钉住的那个库;别的类(我的资料、日历这些)没传上的单列一路 content:other(不算任何库),
 *  进「别处」—— 不让一个 Plugins/ 里的大文件把同步得好好的库说成「同步出错」。 */
export function contentFeeds(c: ContentStatusLite, ctx: { pinnedRoot: string | null; signedIn: boolean }): SyncFeedReport[] {
  const main = contentFeed(c, ctx)
  const other: SyncFailure[] = [
    ...(c.failures ?? []).filter((f) => !isNotesPath(f.path)).map<SyncFailure>((f) => ({ path: f.path, reason: 'failed', code: f.code ?? f.reason, retryAt: f.retryAt })),
    ...(c.skipped ?? []).filter((x) => !isNotesPath(x.path)).map<SyncFailure>((x) => ({ path: x.path, reason: x.reason, ...(x.size !== undefined ? { size: x.size } : {}), ...(x.maxBytes !== undefined ? { maxBytes: x.maxBytes } : {}) })),
  ]
  if (main.phase === 'off' || !other.length) return [main]
  return [main, { ...main, id: 'content:other', vault: { root: null, side: 'local' }, scope: { kind: 'vault' }, phase: 'idle', progress: null, review: [], failures: other, error: null, pendingChanges: 0 }]
}

/** 老 Extend 没有只读的 penzor:sync:status、而新同步认领了这个库:说「同步开着」,不去轮询会顺手扫一遍的 penzor:sync:get。 */
export function assumedContentFeed(pinnedRoot: string | null): SyncFeedReport {
  return {
    id: 'content', engine: 'content', vault: { root: pinnedRoot, side: 'local' }, target: 'penzor', scope: { kind: 'vault' },
    phase: 'unknown', progress: null, lastSyncAt: null, pendingChanges: 0, rateLimitedUntil: null, review: [], failures: [], error: null, canSyncNow: true,
  }
}

export function contentFeed(c: ContentStatusLite, ctx: { pinnedRoot: string | null; signedIn: boolean }): SyncFeedReport {
  const enabled = c.enabled ?? c.config?.enabled ?? false
  const scope = notesScopeOf(c)
  // 只算笔记那一类的(别的类在 contentFeeds 里单列)
  const failures: SyncFailure[] = [
    ...(c.failures ?? []).filter((f) => isNotesPath(f.path)).map<SyncFailure>((f) => ({ path: notesRel(f.path), reason: 'failed', code: f.code ?? f.reason, retryAt: f.retryAt })),
    ...(c.skipped ?? []).filter((x) => isNotesPath(x.path)).map<SyncFailure>((x) => ({ path: notesRel(x.path), reason: x.reason, ...(x.size !== undefined ? { size: x.size } : {}), ...(x.maxBytes !== undefined ? { maxBytes: x.maxBytes } : {}) })),
  ]
  const fileError = !!c.error && (c.failures ?? []).some((f) => f.reason === c.error)
  let phase: SyncFeedPhase
  if (!enabled) phase = 'off'
  else if (!ctx.signedIn || c.error === 'not_signed_in') phase = 'signed-out'
  else if (c.paused) phase = 'paused'
  else if (c.running && c.phase === 'scanning') phase = 'checking'
  else if (c.running) phase = 'transferring'
  else if (c.error === 'content_account_changed_preview_required') phase = 'error'
  else if (c.error && CONNECTION.test(c.error)) phase = 'offline'
  else if (c.error && !fileError) phase = 'error'
  else phase = 'idle'
  // 老快照没有 round:正在做的那个任务当当前文件,总数不知道
  const active = c.jobs?.find((j) => j.state === 'active')
  const progress: SyncProgress | null = c.round
    ? { ...c.round, current: c.round.current ? { ...c.round.current, path: notesRel(c.round.current.path) } : null }
    : c.running ? {
      startedAt: Date.now(), stage: c.phase === 'scanning' ? 'checking' : 'transferring', files: { done: 0, total: null }, bytes: null,
      current: active ? { path: notesRel(active.path), op: active.direction === 'delete' ? 'delete' : (active.direction as 'upload'), bytesDone: active.done, bytesTotal: active.size } : null,
    } : null
  const review: SyncReviewItem[] = c.deletes && (c.deletes.pending > 0 || c.deletes.latched)
    ? [{ kind: 'deletes', count: c.deletes.pending, items: c.deletes.items.map((i) => ({ ...i, path: notesRel(i.path) })), canRestore: true, accountWide: false, ref: { feed: 'content', token: c.deletes.token } }]
    : []
  const lastDone = c.jobs?.reduce<number | null>((a, j) => (j.state === 'done' && j.finishedAt && (a === null || j.finishedAt > a) ? j.finishedAt : a), null) ?? null
  return {
    id: 'content',
    engine: 'content',
    // 笔记不在新同步的规则里:它不算任何本机库的同步(root null),出错照样进 elsewhere
    vault: { root: scope ? ctx.pinnedRoot : null, side: 'local' },
    target: 'penzor',
    scope: scope ?? { kind: 'vault' },
    phase,
    progress,
    lastSyncAt: c.lastSyncAt ?? lastDone,
    pendingChanges: c.pending ?? (c.jobs ?? []).filter((j) => j.state === 'queued' || j.state === 'failed').length,
    rateLimitedUntil: c.rateLimitedUntil ?? null,
    review,
    failures,
    error: phase === 'error' || phase === 'signed-out' ? c.error ?? null : null,
    canSyncNow: enabled && !c.paused,
  }
}

// ── 远程服务 ────────────────────────────────────────────────────────────────────

const REMOTE_TARGET: Record<string, SyncTarget> = { penzor: 'penzor', dropbox: 'dropbox', webdav: 'webdav', s3: 's3', folder: 'folder', gdrive: 'gdrive' }

export function remoteFeed(r: Pick<RemoteSyncState, 'config' | 'running' | 'lastReport' | 'progress' | 'root' | 'rootError'>): SyncFeedReport {
  const backend = r.config.backend as string
  const on = backend !== 'off'
  const report = r.lastReport
  const { failures, roundErrors } = remoteReportProblems(report)
  const roundError = r.rootError ?? (report && !report.ok ? roundErrors[0] ?? null : null)
  // 开着却还没跑完过一轮(或这一轮没交报告就退了):说「开着」,不说「两边一样」
  const phase: SyncFeedPhase = !on ? 'off' : r.running ? (r.progress?.total ? 'transferring' : 'checking') : roundError ? 'error' : report ? 'idle' : 'unknown'
  return {
    id: 'remote',
    engine: 'remote',
    vault: { root: r.root, side: 'local' },
    target: REMOTE_TARGET[backend] ?? 'other',
    scope: { kind: 'vault' },
    phase,
    progress: r.running ? {
      startedAt: report?.startedAt ?? Date.now(),
      stage: r.progress?.total ? 'transferring' : 'checking',
      files: { done: r.progress?.done ?? 0, total: r.progress?.total || null },
      bytes: null,
      current: r.progress?.key ? { path: r.progress.key, op: 'check', bytesDone: null, bytesTotal: null } : null,
    } : null,
    lastSyncAt: report?.finishedAt ?? null,
    pendingChanges: 0,
    rateLimitedUntil: null,
    review: report && report.pendingDeletions > 0 ? [{ kind: 'deletes', count: report.pendingDeletions, items: [], canRestore: false, accountWide: false, ref: { feed: 'remote' } }] : [],
    failures: r.running ? [] : failures,
    error: phase === 'error' ? roundError : null,
    canSyncNow: on && !r.running,
  }
}
