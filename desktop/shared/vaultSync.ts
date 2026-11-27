/**
 * 智库同步的状态契约(智库同步统一方案 2026-11-27 第 1 步「状态和进度说真话」)。
 *
 * 分两层:
 *   引擎 → 状态源:每套同步引擎(今天是旧的文件夹 / 条目同步与整库镜像、蓬洲云的新同步、远程服务)由一个适配器翻成
 *     `SyncFeedReport`,每轮结束交一条 `SyncRoundRecord`。适配器只认这两个形状 —— 第 2 步换成一套定时同步(远端可换)时,
 *     只换喂数据的那一头,下面的合成与所有界面都不动。
 *   状态源 → 界面:`composeVaultSync()` 把所有 feed 合成「这个库现在怎样」(`VaultSyncView`)。左栏「智库」那行、同步面板、
 *     状态栏、通知、智库菜单都读它,文字也只从 `vaultSyncText()`(渲染层)出,不另造说法。
 *
 * 规矩(都有单测钉着,改之前先读 frontend/src/sync/composeVaultSync.test.ts):
 *   - 一个 feed 只算进它同步的那个库:旧的条目同步认 binding(本机库根);新同步与远程服务认它们钉住的库;
 *     账号的整库镜像(登录后缺省就开)只算进云侧那一行 —— 否则每个本机库都会显示「已同步」。
 *   - 不属于这个库、但在出错 / 等你定的 feed 记进 `elsewhere`:状态栏和通知照样露出,这一行的字不被它带偏。
 *   - 数不出来的段给 null(总数、字节),界面缺哪段就不画哪段,不显示 0。
 *   - 服务器限速是等待,不是出错;单个文件没传上记在 failures,不把整个 feed 打成 error。
 *   - `ref` 是不透明的句柄:界面原样交回给这个 feed 的动作(处理待定、确认删除、重试),不解读里面的字段。
 */

/** feed 来自哪套实现。第 2 步之后 legacy / content 并成一套。web = 网页 / 手机直接读写云端(没有落盘同步)。 */
export type SyncEngineKind = 'legacy' | 'content' | 'remote' | 'web'

/** 同步到哪。 */
export type SyncTarget = 'penzor' | 'dropbox' | 'webdav' | 's3' | 'folder' | 'gdrive' | 'other'

/** 同步的范围:整个库,或选中的几项(count = 选中的条目数)。 */
export type SyncScope = { kind: 'vault' } | { kind: 'items'; count: number }

/** 一个 feed 此刻在做什么。 */
export type SyncFeedPhase =
  | 'off' // 这台没开
  | 'signed-out' // 开着,但没登录 / 登录过期,没在同步
  | 'starting'
  | 'idle'
  | 'checking' // 在核对两边
  | 'transferring' // 在一个一个过文件
  | 'paused'
  | 'offline' // 连不上,不算出错
  | 'error' // 整轮跑不起来(库文件夹不见了、扫描失败……);单个文件的失败不在这里,在 failures

export type SyncOp = 'upload' | 'download' | 'merge' | 'delete' | 'rename' | 'check'

export interface SyncCurrentFile {
  /** 库内相对路径(给人看的) */
  path: string
  op: SyncOp
  bytesDone: number | null
  bytesTotal: number | null
}

/** 这一轮的进度。files.total / bytes.total 数不出来时为 null。 */
export interface SyncProgress {
  startedAt: number
  stage: 'checking' | 'transferring'
  files: { done: number; total: number | null }
  bytes: { done: number; total: number | null } | null
  current: SyncCurrentFile | null
}

/** 交回给 feed 动作的不透明句柄。feed = 产出它的 SyncFeedReport.id;其余字段只有那个适配器认。 */
export interface SyncActionRef {
  feed: string
  [key: string]: unknown
}

/** 等用户定的事。differs = 两边不一样、又没有同步记录,先放着;deletes = 删除保护拦下的一批删除。 */
export type SyncReviewItem =
  | {
      kind: 'differs'
      /** 库内相对路径 */
      path: string
      /** 引擎给的「哪边更新」只作参考;真正按时间替用户选只在用户点了以后 */
      newer: 'local' | 'cloud' | null
      ref: SyncActionRef
    }
  | {
      kind: 'deletes'
      count: number
      /** 最多列一部分;count 是总数 */
      items: Array<{ path: string; side: 'cloud' | 'local' }>
      /** 能不能「不删,恢复」(旧的文件夹同步只有确认) */
      canRestore: boolean
      /** 这批是不是这台所有云同步合起来的(旧同步的确认一次放行全部引擎) */
      accountWide: boolean
      ref: SyncActionRef
    }

export type SyncFailureReason = 'too-large' | 'invalid-name' | 'unreadable' | 'rejected' | 'failed'

/** 一个没同步成的文件。code = 引擎原样的原因码(界面按它挑说法,认不出就照原样显示)。 */
export interface SyncFailure {
  path: string
  reason: SyncFailureReason
  code?: string
  /** 下次自动再试的时刻(ms);null = 不会自己再试 */
  retryAt?: number | null
  size?: number
  maxBytes?: number
}

/** 一个 feed 的报告:适配器唯一要产出的东西。 */
export interface SyncFeedReport {
  /** 这个 feed 实例的稳定 id,例:`legacy:entry:/Users/x/Notes`、`legacy:mirror`、`content`、`remote` */
  id: string
  engine: SyncEngineKind
  /** 它同步的是哪个库。root = 本机库根;side = cloud 是账号的云端镜像(及「与我共享」),这时 root 为 null */
  vault: { root: string | null; side: 'local' | 'cloud' }
  target: SyncTarget
  scope: SyncScope
  phase: SyncFeedPhase
  progress: SyncProgress | null
  lastSyncAt: number | null
  /** 本机有、还没同步出去的改动数(离线时「3 个改动没同步」) */
  pendingChanges: number
  /** 服务器限速,等到这个时刻(ms);null = 没在等 */
  rateLimitedUntil: number | null
  review: SyncReviewItem[]
  failures: SyncFailure[]
  /** 整轮的原因码(phase 为 error / signed-out 时);语言中立,渲染层套文案 */
  error: string | null
  /** 点「立即同步」对它有没有用 */
  canSyncNow: boolean
}

/** 一轮做了什么(同步记录,一轮一行)。引擎侧合并碎轮:同一 id 再交一次 = 覆盖那一行。 */
export interface SyncRoundRecord {
  id: string
  feed: string
  engine: SyncEngineKind
  /** 本机库根;云端镜像为 null */
  vault: string | null
  target: SyncTarget
  startedAt: number
  finishedAt: number
  /** 这一轮走完了(没被断网 / 停下打断) */
  completed: boolean
  uploaded: number
  downloaded: number
  merged: number
  renamed: number
  deletedCloud: number
  deletedLocal: number
  /** 这一轮新放着、等用户定的 */
  held: number
  /** 没同步成的文件(最多 SYNC_RECORD_MAX_FAILED 条);failedCount 是总数 */
  failed: SyncFailure[]
  failedCount: number
  /** 这台第一次和云端对齐的那一轮 */
  first?: boolean
}

export const SYNC_RECORD_MAX_FAILED = 20
/** 记录留 30 天(方案:设置 › 同步的「同步记录」放 30 天)。 */
export const SYNC_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 一个账号最多留多少行(30 天内的碎轮也不会撑爆文件)。 */
export const SYNC_RECORD_MAX_ROWS = 3000

/** 合成后,一个库此刻的状态。全套说法只有这几种(方案「状态的说法」)。 */
export type VaultSyncState =
  | 'off' // 只在这台
  | 'signed-out' // 没登录，没在同步
  | 'synced' // 已同步 · 2 分钟前
  | 'checking' // 正在核对
  | 'syncing' // 正在同步 132 / 475
  | 'review' // 10 篇等你定
  | 'error' // 同步出错
  | 'offline' // 离线 · 3 个改动没同步
  | 'paused' // 已暂停

export interface VaultSyncView {
  state: VaultSyncState
  /** 同步这个库的 feed(开着的) */
  feeds: SyncFeedReport[]
  target: SyncTarget | null
  scope: SyncScope | null
  progress: SyncProgress | null
  review: SyncReviewItem[]
  failures: SyncFailure[]
  error: string | null
  lastSyncAt: number | null
  pendingChanges: number
  rateLimitedUntil: number | null
  /** 不属于这个库的 feed 里在出错 / 等你定的个数(隐藏的整库镜像、别的库);
   *  deletes = 其中「一次放行全部引擎」的那批删除(旧同步的删除保护):它只有一个确认入口,每个库的面板都要能点到 */
  elsewhere: { errors: number; review: number; deletes: Array<Extract<SyncReviewItem, { kind: 'deletes' }>> }
}

/** 记录存取(放在哪由实现决定:桌面是主进程按账号一份文件)。 */
export interface SyncRecordSource {
  list(opts?: { since?: number; vault?: string | null; limit?: number }): Promise<SyncRoundRecord[]>
  /** 有新记录时回调;返回取消订阅 */
  subscribe?(cb: () => void): () => void
}

/** 宿主给引擎的记录口子(cloudHost.syncRecords)。account = 这一轮属于哪个账号(换账号不串);不给 = 当前账号。 */
export interface SyncRecordSink {
  append(record: SyncRoundRecord, account?: string | null): void
}

export const SYNC_RECORDS_IPC = {
  list: 'sync-records:list',
  changed: 'sync-records:changed',
} as const

// ── 合成(纯函数,渲染层与单测共用)────────────────────────────────────────────

/** 比较两个本机路径(去掉末尾分隔符;mac / Windows 不分大小写)。 */
export function sameVaultRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (p: string): string => p.normalize('NFC').replace(/[\\/]+$/, '')
  const x = norm(a), y = norm(b)
  return x === y || x.toLowerCase() === y.toLowerCase()
}

/** 这个 feed 算不算进 `vault` 那一行。 */
export function feedServesVault(feed: SyncFeedReport, vault: { root: string | null; side: 'local' | 'cloud' }): boolean {
  if (feed.vault.side === 'cloud') return vault.side === 'cloud'
  return vault.side === 'local' && sameVaultRoot(feed.vault.root, vault.root)
}

const ACTIVE: ReadonlySet<SyncFeedPhase> = new Set(['starting', 'checking', 'transferring'])

const reviewCount = (items: SyncReviewItem[]): number =>
  items.reduce((n, r) => n + (r.kind === 'differs' ? 1 : r.count), 0)

/** 合并几个 feed 的进度(一般只有一个在跑)。任何一个数不出总数,合起来也是 null。 */
function mergeProgress(list: SyncProgress[]): SyncProgress | null {
  if (!list.length) return null
  if (list.length === 1) return list[0]
  const totalOf = (xs: Array<number | null>): number | null => (xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0))
  const bytesList = list.map((p) => p.bytes)
  return {
    startedAt: Math.min(...list.map((p) => p.startedAt)),
    stage: list.some((p) => p.stage === 'transferring') ? 'transferring' : 'checking',
    files: { done: list.reduce((a, p) => a + p.files.done, 0), total: totalOf(list.map((p) => p.files.total)) },
    bytes: bytesList.some((b) => b === null) ? null : {
      done: bytesList.reduce((a, b) => a + b!.done, 0),
      total: totalOf(bytesList.map((b) => b!.total)),
    },
    current: list.find((p) => p.current)?.current ?? null,
  }
}

/**
 * 把所有 feed 合成 `vault` 这一行的状态。
 * 优先级(沿用状态栏原来的顺序,方案另有说法的照方案):整轮出错 > 正在同步 / 核对 > 有文件没同步成 > 等你定 > 离线 > 已暂停 > 没登录 > 已同步;
 * 没有一个开着的 feed = 只在这台。
 */
export function composeVaultSync(feeds: SyncFeedReport[], vault: { root: string | null; side: 'local' | 'cloud' }, now = Date.now()): VaultSyncView {
  const on = feeds.filter((f) => f.phase !== 'off')
  const mine = on.filter((f) => feedServesVault(f, vault))
  const others = on.filter((f) => !feedServesVault(f, vault))
  const elsewhere = {
    errors: others.filter((f) => f.phase === 'error' || f.failures.length > 0).length,
    review: others.reduce((n, f) => n + reviewCount(f.review), 0),
    deletes: others.flatMap((f) => f.review).filter((r): r is Extract<SyncReviewItem, { kind: 'deletes' }> => r.kind === 'deletes' && r.accountWide),
  }
  const review = mine.flatMap((f) => f.review)
  const failures = mine.flatMap((f) => f.failures)
  const active = mine.filter((f) => ACTIVE.has(f.phase))
  const progress = mergeProgress(active.map((f) => f.progress).filter((p): p is SyncProgress => !!p))
  const lastSyncAt = mine.reduce<number | null>((a, f) => (f.lastSyncAt !== null && (a === null || f.lastSyncAt > a) ? f.lastSyncAt : a), null)
  const limited = active.reduce<number | null>((a, f) => (f.rateLimitedUntil && f.rateLimitedUntil > now && (a === null || f.rateLimitedUntil > a) ? f.rateLimitedUntil : a), null)
  const engineError = mine.find((f) => f.phase === 'error')
  let state: VaultSyncState
  if (!mine.length) state = 'off'
  else if (engineError) state = 'error'
  else if (active.length) state = active.some((f) => f.phase === 'transferring' || (f.progress?.stage === 'transferring')) ? 'syncing' : 'checking'
  else if (failures.length) state = 'error'
  else if (review.length) state = 'review'
  else if (mine.some((f) => f.phase === 'offline')) state = 'offline'
  else if (mine.every((f) => f.phase === 'paused' || f.phase === 'signed-out') && mine.some((f) => f.phase === 'paused')) state = 'paused'
  else if (mine.every((f) => f.phase === 'signed-out')) state = 'signed-out'
  else state = 'synced'
  const first = mine[0]
  return {
    state,
    feeds: mine,
    target: first?.target ?? null,
    scope: mine.length === 1 ? first.scope : mine.length ? mergeScope(mine.map((f) => f.scope)) : null,
    progress: state === 'syncing' || state === 'checking' ? progress : null,
    review,
    failures,
    error: engineError?.error ?? mine.find((f) => f.phase === 'signed-out')?.error ?? null,
    lastSyncAt,
    pendingChanges: mine.reduce((a, f) => a + f.pendingChanges, 0),
    rateLimitedUntil: limited,
    elsewhere,
  }
}

function mergeScope(list: SyncScope[]): SyncScope {
  if (list.some((s) => s.kind === 'vault')) return { kind: 'vault' }
  return { kind: 'items', count: list.reduce((a, s) => a + (s.kind === 'items' ? s.count : 0), 0) }
}

/** 等你定的总条数(differs 一篇算一条,deletes 按拦下的删除数)。 */
export function vaultReviewCount(view: Pick<VaultSyncView, 'review'>): number {
  return reviewCount(view.review)
}
