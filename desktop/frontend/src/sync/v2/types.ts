/**
 * 智库同步 v2 的渲染层契约(智库同步统一方案第 2 步,契约 step2-contract.md §3.10 与实现期修订 E-2 / U-1)。
 * 真身在 Forsion Extend `src/core/vaultSync.ts`;Genesis 不能 import Extend 的源码,这里照抄要用的那几样,改那边时同改。
 * 通道由 Extend 主进程半身注册,渲染层经 `window.tangu.cloudInvoke` 调(sync/v2/client.ts)。只加字段,不改语义。
 */

export const VAULT_SYNC_CHANNELS = {
  get: 'vaultsync:get',
  status: 'vaultsync:status',
  resolveName: 'vaultsync:resolveName',
  preview: 'vaultsync:preview',
  apply: 'vaultsync:apply',
  setEnabled: 'vaultsync:setEnabled',
  setScope: 'vaultsync:setScope',
  setTarget: 'vaultsync:setTarget',
  run: 'vaultsync:run',
  resolve: 'vaultsync:resolve',
  /** E-11:「全部…」{ bindingId, action, token };token = status 的 review.differsToken,对不上回 stale、一条不动。老 Extend 没有这个通道。 */
  resolveAll: 'vaultsync:resolveAll',
  deletesConfirm: 'vaultsync:deletes:confirm',
  deletesAbandon: 'vaultsync:deletes:abandon',
  renameAnswer: 'vaultsync:rename:answer',
  choose: 'vaultsync:choose',
  setCadence: 'vaultsync:setCadence',
  recoveryList: 'vaultsync:recovery:list',
  recoveryRestore: 'vaultsync:recovery:restore',
  takeoverRevert: 'vaultsync:takeover:revert',
  /** 契约 U-1 第 2 条:E 还没注册时回 channel_missing,界面不画「知道了」。 */
  dismissCard: 'vaultsync:dismissCard',
} as const

export type VaultSyncMode = 'full' | 'compat'
export type VaultSyncCompatReason =
  | 'host-missing-ownership' | 'host-missing-sync-targets' | 'host-missing-sync-records' | 'state-unreadable' | 'content-sync-active'
export type Cadence = { kind: 'interval'; minutes: 5 | 10 | 30 } | { kind: 'manual' }

export type ScopeItemKind = 'folder' | 'file' | 'page'
export interface ScopeItem { path: string; kind: ScopeItemKind }
export type BindingScope = { mode: 'all' } | { mode: 'some'; items: ScopeItem[]; exclude?: string[] }
export type BindingPlacement = 'own' | 'legacy-entry' | 'legacy-root'
export type BindingState = 'active' | 'takeover' | 'needs-card' | 'needs-rename-answer' | 'needs-choice'
export type BindingRole = 'primary' | 'backup'
export type SyncDirection = 'both' | 'push' | 'pull'
export type BindingReason =
  | 'non_default_vault' | 'no_backing_identity' | 'too_large_for_new_sync' | 'cross_namespace_rules' | 'double_engine'
  | 'root_missing' | 'root_renamed' | 'server_unsupported' | 'state_unreadable' | 'takeover_failed' | 'remote_same_root'
  | 'remote_dir_in_use' | 'move_in_progress'

/** 占着这个远端目录的那条绑定(契约 E-17):name = 库文件夹名;可能是停着的那条(停着也占着,只有停止同步才释放)。 */
export interface RemoteDirHolder { bindingId: string; name: string }

export type BindingTargetView =
  | { kind: 'penzor'; vaultId: string; vaultName: string | null; placement: BindingPlacement; prefix: string }
  | { kind: 'remote'; targetId: string; backend: string; label: string; dir: string; direction: SyncDirection; conditionalWrites: boolean }

export interface BindingStatusView {
  phase: 'idle' | 'checking' | 'transferring' | 'paused' | 'error'
  lastSyncAt: number | null
  pendingChanges: number
  held: number
  deletesPending: number
  failures: number
  error?: string
  notice?: 'takeover' | 'needs-choice' | 'needs-card' | 'refused'
  reason?: BindingReason
  /** reason = remote_dir_in_use 时:谁占着这个远端目录(E-17) */
  inUseBy?: RemoteDirHolder
}

export interface BindingView {
  id: string
  root: string
  name: string
  target: BindingTargetView
  scope: BindingScope
  enabled: boolean
  paused: boolean
  state: BindingState
  role: BindingRole
  status: BindingStatusView
  takeoverCard?: { adopted: number; filled: number; held: number; revived: number }
  /** state = needs-rename-answer 时:改名前的文件夹名(「你把 X 改成了 Y」)。 */
  renamedFrom?: string
}

export interface TakeoverView { root: string; source: 'entry' | 'content-active' | 'content-off' | 'remotesync'; phase: string; lastError?: string; reason?: BindingReason }

export interface CloudVaultView {
  id: string
  name: string
  kind: 'own' | 'legacy' | 'default'
  devices: number
  /** 契约 U-1 第 3 条(E 还没给时缺省) */
  deviceNames?: string[]
  files?: number | null
}

export interface VaultSyncGet {
  version: 2
  mode: VaultSyncMode
  /** 这台电脑(E-6 第 2 条):id = 设备登记里的那个,name = 心跳用的名字;兼容模式不给。 */
  device?: { id: string; name: string }
  compatReason?: VaultSyncCompatReason
  cadence: Cadence
  bindings: BindingView[]
  localVaults: Array<{ root: string; name: string; bindingId?: string }>
  cloudVaults: CloudVaultView[] | null
  serverCaps: { vaults: boolean; realMove: boolean }
  sealed: { agents: true; plugins: true }
  takeover: TakeoverView[]
  recoveryCount: number
}

export type ResolveCandidate = { kind: 'own'; vaultId: string; name: string } | { kind: 'legacy'; vaultId: string; prefix: string; name?: string }
export interface ResolveNameResult { candidates: ResolveCandidate[]; error?: 'reserved' | 'server_unsupported' | 'invalid_name' }

/** 按文件夹名新建一个蓬洲云库(名字 = 库文件夹名;apply 时才建,撞名回 stale,重新 preview 回 name_exists)。契约 U-1 第 1 条,E 已做。 */
/** 按文件夹名新建(契约 U-1 第 1 条;E 3164e7c 起认 `{kind:'new'}`,name 不给 = 文件夹名,给了须同一个名字键否则 name_mismatch)。 */
export type CreateCandidate = { kind: 'new'; name?: string }
export const CREATE_CANDIDATE: CreateCandidate = { kind: 'new' }
/** candidate 缺 = 沿用已有绑定的去处(改范围)。 */
export type PreviewTarget =
  | { kind: 'penzor'; candidate?: ResolveCandidate | CreateCandidate }
  | { kind: 'remote'; targetId: string; dir?: string; direction?: SyncDirection }
export interface VaultSyncPreviewArgs { root: string; target: PreviewTarget; scope: BindingScope; bindingId?: string }
export interface VaultSyncPreview {
  token: string
  generation: string
  expiresAt: number
  match: 'none' | 'own' | 'legacy'
  same: number
  onlyLocal: number
  onlyRemote: number
  differ: Array<{ path: string; newer: 'local' | 'remote' | null }>
  tooLarge: Array<{ path: string; size: number; maxBytes: number }>
}
export interface VaultSyncApplyArgs { token: string; generation: string; onDiffer: 'newer' | 'hold' }

export interface HeldRef { bindingId: string; path: string; generation: string }
export type HeldAction = 'local' | 'cloud' | 'both' | 'newer'
/** E-11 第 3 条:newer 判不出的照旧放着,算进 cannotDecide。 */
export interface VaultSyncResolveAllResult { resolved: number; cannotDecide: number; stale: number; failed: number; recoveryEventIds: string[] }

export interface RecoveryEventView {
  eventId: string
  bindingId: string
  target: string
  path: string
  side: 'cloud' | 'local'
  hash: string
  size: number
  at: number
  reason: 'held-resolve' | 'pair-newer' | 'local-delete'
}

/** 只读状态(vaultsync:status):一个绑定一条。 */
export interface VaultSyncStatus {
  mode: VaultSyncMode
  bindings: Array<Pick<BindingView, 'id' | 'root' | 'name' | 'target' | 'scope' | 'state' | 'status'> & { enabled?: boolean; paused?: boolean; role?: BindingRole }>
}
