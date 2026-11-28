/**
 * 智库同步 v2 → 第 1 步的状态契约(契约 §3.11):一个绑定一个 feed,`id = vault:<bindingId>`,`engine:'content'`。
 * 数据来自只读的 `vaultsync:status`(不建会话、不扫盘)。纯函数,单测在 v2.test.ts。
 *
 * 归一化:
 *   没启用 → off;接手中(state takeover)→ checking;要汇总卡 / 要选 / 要回答改名 → paused(带 notice);
 *   phase checking / transferring / paused 原样;error 是连不上 → offline,没登录 → signed-out,其余 → error。
 *   清单(等你定、进度、出错的文件)要 E 补上 U-2 的字段才有;没有时只报计数:
 *     等你定 → 一条不带路径的 differs(`ref.placeholder`),界面认它只写「N 篇等你定」,不画逐篇按钮。
 */
import type { SyncFailure, SyncFeedPhase, SyncFeedReport, SyncProgress, SyncReviewItem, SyncTarget } from '../../../../shared/vaultSync'
import type { BindingTargetView, HeldRef, VaultSyncStatus } from './types'

type StatusBinding = VaultSyncStatus['bindings'][number]

/** 契约 U-2:E 补上以后 status 上会多出来的字段(都是可选,缺 = 老 E)。 */
export interface StatusBindingExtras {
  enabled?: boolean
  paused?: boolean
  progress?: SyncProgress | null
  review?: {
    differs?: Array<{ path: string; newer: 'local' | 'remote' | null; ref: HeldRef }>
    differsTotal?: number
    deletes?: { count: number; token: string; items: Array<{ path: string; side: 'cloud' | 'local' }> } | null
  }
  failures?: Array<{ path: string; reason: SyncFailure['reason']; code?: string; retryAt?: number | null; size?: number; maxBytes?: number }>
  rateLimitedUntil?: number | null
}

const CONNECTION = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|network|offline|socket hang up/i

export const v2FeedId = (bindingId: string): string => `vault:${bindingId}`

const REMOTE_TARGET: Record<string, SyncTarget> = { dropbox: 'dropbox', webdav: 'webdav', s3: 's3', folder: 'folder', gdrive: 'gdrive' }
export function v2Target(t: BindingTargetView): SyncTarget {
  return t.kind === 'penzor' ? 'penzor' : REMOTE_TARGET[t.backend] ?? 'other'
}

export function v2Feed(b: StatusBinding & StatusBindingExtras): SyncFeedReport {
  const id = v2FeedId(b.id)
  const st = b.status
  const err = st.error ?? null
  let phase: SyncFeedPhase
  if (b.enabled === false) phase = 'off'
  else if (b.state === 'takeover') phase = 'checking'
  else if (b.state === 'needs-card' || b.state === 'needs-choice' || b.state === 'needs-rename-answer') phase = 'paused'
  else if (st.phase === 'checking' || st.phase === 'transferring' || st.phase === 'paused' || st.phase === 'idle') phase = st.phase
  else if (err === 'not_signed_in') phase = 'signed-out'
  else if (err && CONNECTION.test(err)) phase = 'offline'
  else phase = 'error'
  const review: SyncReviewItem[] = []
  const differs = b.review?.differs
  if (differs) {
    for (const d of differs) review.push({ kind: 'differs', path: d.path, newer: d.newer === 'remote' ? 'cloud' : d.newer, ref: { feed: id, bindingId: b.id, held: d.ref } })
    // 列出来的少于总数:剩下的算一条不带路径的(界面写「还有 N 篇」)
    const rest = (b.review?.differsTotal ?? differs.length) - differs.length
    for (let i = 0; i < rest; i++) review.push({ kind: 'differs', path: '', newer: null, ref: { feed: id, bindingId: b.id, placeholder: true } })
  } else {
    for (let i = 0; i < st.held; i++) review.push({ kind: 'differs', path: '', newer: null, ref: { feed: id, bindingId: b.id, placeholder: true } })
  }
  const dels = b.review?.deletes
  if (dels && dels.count > 0) review.push({ kind: 'deletes', count: dels.count, items: dels.items, canRestore: true, accountWide: false, ref: { feed: id, bindingId: b.id, token: dels.token } })
  else if (!dels && st.deletesPending > 0) review.push({ kind: 'deletes', count: st.deletesPending, items: [], canRestore: true, accountWide: false, ref: { feed: id, bindingId: b.id } })
  const failures: SyncFailure[] = b.failures
    ? b.failures.map((f) => ({ path: f.path, reason: f.reason, ...(f.code ? { code: f.code } : {}), ...(f.retryAt !== undefined ? { retryAt: f.retryAt } : {}), ...(f.size !== undefined ? { size: f.size } : {}), ...(f.maxBytes !== undefined ? { maxBytes: f.maxBytes } : {}) }))
    : []
  return {
    id,
    engine: 'content',
    vault: { root: b.root, side: 'local' },
    target: v2Target(b.target),
    scope: b.scope.mode === 'all' ? { kind: 'vault' } : { kind: 'items', count: b.scope.items.length },
    phase,
    progress: b.progress ?? null,
    lastSyncAt: st.lastSyncAt,
    pendingChanges: st.pendingChanges,
    rateLimitedUntil: b.rateLimitedUntil ?? null,
    review,
    failures,
    error: phase === 'error' || phase === 'signed-out' ? err ?? st.reason ?? 'error' : null,
    canSyncNow: phase !== 'off' && phase !== 'paused' && b.state === 'active',
    ...(st.notice ? { notice: st.notice } : {}),
  }
}

/** 一条 differs 是不是 U-2 之前的占位(没有路径,处理不了)。 */
export const isPlaceholderReview = (r: SyncReviewItem): boolean => r.kind === 'differs' && !!(r.ref as { placeholder?: boolean }).placeholder

/** status → feeds。compat / 读不到 → 空(兼容模式下状态由第 1 步的老几路报)。 */
export function v2Feeds(s: VaultSyncStatus | null): SyncFeedReport[] {
  if (!s || s.mode !== 'full') return []
  return s.bindings.map((b) => v2Feed(b as StatusBinding & StatusBindingExtras))
}

/** v2 接管着的本机库根(启用的、主绑定):旧条目同步那一路的 feed 对这些根不再算(接手后旧引擎不为它起来,注册表里可能还留着)。 */
export function v2Roots(s: VaultSyncStatus | null): Set<string> {
  const out = new Set<string>()
  if (!s || s.mode !== 'full') return out
  for (const b of s.bindings as Array<StatusBinding & StatusBindingExtras>) if (b.enabled !== false && (b.role ?? 'primary') === 'primary') out.add(b.root)
  return out
}
