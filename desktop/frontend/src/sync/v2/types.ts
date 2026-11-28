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
  /** 第 3 步 E3(契约 step34 §3.1):云端库清单 { refresh? } → LibrariesResult(读失败回 { error },不是空清单)。只读。 */
  libraries: 'vaultsync:libraries',
  /** 第 4 步(契约 step34「实现期修订 · E4」):落盘对话框打开时调,只读。{ libraryId, parent } → DownloadCheckResult。 */
  downloadCheck: 'vaultsync:downloadCheck',
  /** 落盘:{ libraryId, root }(root 由宿主 vaultCreate 建好、登记进清单)→ DownloadResult;非空回 next:'preview'。 */
  download: 'vaultsync:download',
  /** 新建的库直接上云:{ root } → CreateResult;任何失败都不建绑定,本机的库照样在。 */
  create: 'vaultsync:create',
  /** 停止落盘(只留云端):{ bindingId, syncFirst? } → UnbindResult;本机文件夹原样留着。 */
  unbind: 'vaultsync:unbind',
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
  | 'remote_dir_in_use' | 'move_in_progress' | 'cloud_deleted'

/** 云端这个库被删了(Extend #146,读到 410):这一条停着、本机文件都在。autoResume = 在蓬洲云回收站里恢复后自己接着跑(自己的库、没清理、不是分库撤销)。 */
export interface CloudDeletedView { at: string; purgeAt: string | null; purging: boolean; purged: boolean; reverted: boolean; autoResume: boolean }

/** 占着这个远端目录的那条绑定(契约 E-17):name = 库文件夹名;可能是停着的那条(停着也占着,只有停止同步才释放)。 */
/** 谁占着这个远端目录(E-17)。bindingId = null、source = 'remotesync':被原来的网盘同步占着(E-19),name 是它本机库的文件夹名,读不出时为空串。 */
export interface RemoteDirHolder { bindingId: string | null; name: string; source?: 'remotesync' }

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
  /** 这条网盘绑定和原来的网盘同步用着同一个去处、旧同步没交给 v2(E-19):照跑,reason 不变,只是一句提示 */
  overlapsLegacy?: { name: string; targetId: string }
  /** reason = cloud_deleted 时的细节(Extend #146) */
  cloudDeleted?: CloudDeletedView
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
  /** 首轮(新建绑定 / 落盘 / 新加范围 / 接手)还没整轮跑完就一直在;落盘下完 = 它没了(契约 step34 E4-7)。 */
  firstRound?: 'pair' | 'scope' | 'takeover'
  /** 最近跑完的那一轮(这次启动以来;没跑过 = null)。§3.6 的切换条件照它判(E4-7、E4-15)。 */
  lastRound?: LastRoundView | null
}
/** failures = 单文件出错的;skipped = 扫不到的和太大被拒的;held = 等你定的(-1 = 读不出,当有)。三个都是 0 才算这一轮干净(E4-15)。 */
export interface LastRoundView { startedAt: number; endedAt: number; completed: boolean; failures: number; skipped: number; held: number }

/** 接手 D(旧网盘同步)撞上占用、封着不交还时(H 的 fix/sync-takeover-d-hold):reason 是三种之一,inUseBy = 占着的那条(remote_dir_nested 可能没有);
 *  接手收尾(done / reverted / refused)以后不再带这两项。 */
export type TakeoverHoldReason = 'remote_dir_in_use' | 'remote_dir_nested' | 'primary_exists'
export interface TakeoverView { root: string; source: 'entry' | 'content-active' | 'content-off' | 'remotesync'; phase: string; lastError?: string; reason?: BindingReason | TakeoverHoldReason; inUseBy?: RemoteDirHolder }

export interface CloudVaultView {
  id: string
  name: string
  kind: 'own' | 'legacy' | 'default'
  devices: number
  /** 契约 U-1 第 3 条(E 还没给时缺省) */
  deviceNames?: string[]
  files?: number | null
  /** 第 3 步(契约 step34 §3.1):库清单那一项的 id(own / default = vaultId;legacy = `${vaultId}:${prefix}`);老 Extend 不给。 */
  libraryId?: string
  /** legacy 的 content 前缀 `Amadeus/<名字>/` */
  prefix?: string
}

/** 镜像退役(E 第 6–9 件的 PR 承诺,还没合):字段不在 = 不退役,界面照旧;只在 phase === 'done' 时动两行 / 胶囊 / 镜像开关。 */
export interface MirrorRetireView {
  phase: 'detected' | 'clean' | 'sealed' | 'archived' | 'done' | 'blocked'
  reason?: string
  pending?: number
  unconfirmedBytes?: number
  dirRetiredInPlace?: boolean
}

export interface VaultSyncGet {
  version: 2
  mode: VaultSyncMode
  /** 这台电脑(E-6 第 2 条):id = 设备登记里的那个,name = 心跳用的名字;兼容模式不给。 */
  device?: { id: string; name: string }
  compatReason?: VaultSyncCompatReason
  cadence: Cadence
  bindings: BindingView[]
  /** libraryId(E 已承诺、还没合):Extend 拿服务端 nameKey 对本机文件夹名算出来的那个云端库;不在 = 不知道,null = 清单里没有同名的。
   *  Genesis 不自己按名字配(不抄第三份 vaultNameKey)。 */
  localVaults: Array<{ root: string; name: string; bindingId?: string; libraryId?: string | null }>
  cloudVaults: CloudVaultView[] | null
  serverCaps: { vaults: boolean; realMove: boolean }
  sealed: { agents: true; plugins: true }
  takeover: TakeoverView[]
  recoveryCount: number
  /** 能不能在线打开(E 已承诺、还没合):不为 true = 不画成能点的「在线打开」;不在 = 不知道,照今天。 */
  onlineCapable?: boolean
  /** 镜像退役那本账(E 已承诺、还没合),见 MirrorRetireView。 */
  mirrorRetire?: MirrorRetireView
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
  bindings: Array<Pick<BindingView, 'id' | 'root' | 'name' | 'target' | 'scope' | 'state' | 'status' | 'firstRound' | 'lastRound'> & { enabled?: boolean; paused?: boolean; role?: BindingRole }>
}

// ── 第 3 步 E3:云端库清单(契约 step34 §3.1;Extend core/vaultSync.ts LibraryInfo 起照抄)──
export interface LibraryInfo {
  /** own / default = vaultId;legacy = `${vaultId}:${prefix}` */
  id: string
  kind: 'default' | 'own' | 'legacy'
  vaultId: string
  /** content 前缀:'Amadeus/' 或原位置库的 `Amadeus/<名字>/` */
  prefix: string
  /** 默认库回 'My Vault'(界面显示「云端笔记 / Cloud notes」) */
  name: string
  /** 服务端算的名字键;默认库 null */
  nameKey: string | null
  files: number
  bytes: number
  updatedAt: string | null
  devices: Array<{ deviceId: string; name: string; scope: 'all' | 'some'; lastSyncAt: string | null; caps: string[]; clientVersion: string | null }>
  markerDevices?: Array<{ id: string; name: string; since?: string; superseded?: boolean }> | null
  protectedRoot?: boolean
  deleted?: { at: string; purgeAt: string; purging?: true }
  splitFrom?: { splitId: string; vaultId: string; prefix: string; at: string; deleteBlocked?: Array<{ code: string; detail: string; items?: unknown[] }> }
}
export interface LibraryList { generatedAt: string; libraries: LibraryInfo[] }
/** 读失败 ≠ 空:libraries_cache_unreadable / not_fetched / server_unsupported / not_signed_in(client 把它们归成失败)。 */
export type LibrariesError = 'libraries_cache_unreadable' | 'not_fetched' | 'server_unsupported' | 'not_signed_in'
/** stale = 最近一次取失败了,回的是之前那份(离线 / 冷启动只有盘上那份)。 */
export interface LibrariesValue { list: LibraryList; fetchedAt: number; stale: boolean }

// ── 第 4 步(契约 step34「实现期修订 · E4」;Extend core/vaultSync.ts 照抄)──
export type DownloadError =
  | 'library_not_found' | 'server_unsupported' | 'offline' | 'not_signed_in' | 'name_mismatch' | 'already_local' | 'not_a_directory' | 'root_unreadable'
  | 'parent_missing' | 'root_missing' | 'insufficient_space' | 'root_nested' | 'primary_exists' | 'mirror_root' | 'folder_target_nested' | 'entry_sync_active'
  | 'vault_list_unreadable' | 'default_unsupported' | 'legacy_remote_same_root'
/** already_local 带这台那份的 root(在同步的话还有 bindingId);insufficient_space 带 bytes / freeBytes。 */
export type DownloadFailure = { ok: false; error: DownloadError; root?: string; bindingId?: string; bytes?: number; freeBytes?: number }
export interface DownloadCheckArgs { libraryId: string; parent: string }
/** state:root 不存在(宿主要建)/ 空的 / 非空(同一个库,下载会先出汇总卡)。freeBytes 读不出 = null(不挡)。 */
export type DownloadCheckOk = { ok: true; root: string; name: string; kind: 'own' | 'legacy' | 'default'; files: number; bytes: number; freeBytes: number | null; state: 'new' | 'empty' | 'nonempty' }
export type DownloadCheckResult = DownloadCheckOk | DownloadFailure
export interface DownloadArgs { libraryId: string; root: string }
export type DownloadOk = { ok: true; bindingId: string } | { ok: true; next: 'preview'; preview: VaultSyncPreviewArgs }
export type DownloadResult = DownloadOk | DownloadFailure
export interface CreateArgs { root: string }
export type CreateError =
  | 'name_exists' | 'already_bound' | 'reserved' | 'invalid_name' | 'server_unsupported' | 'offline' | 'not_signed_in' | 'root_missing' | 'not_a_directory'
  | 'root_nested' | 'primary_exists' | 'mirror_root' | 'folder_target_nested' | 'entry_sync_active' | 'already_local' | 'legacy_remote_same_root'
export type CreateOk = { ok: true; bindingId: string }
export type CreateResult = CreateOk
  | { ok: false; error: 'name_exists'; libraryId?: string } | { ok: false; error: 'already_bound'; bindingId: string }
  | { ok: false; error: Exclude<CreateError, 'name_exists' | 'already_bound'> }
export interface UnbindArgs { bindingId: string; syncFirst?: boolean }
export type UnbindError = 'pending' | 'takeover_in_progress' | 'binding_not_found' | 'binding_not_running' | 'local_pending' | 'move_in_progress'
export type UnbindOk = { ok: true; root: string }
/** pending(只在 syncFirst 时):跑完一轮还有剩的,什么都没停;local_pending:绑定已停用、意图留着,下次启动接着做完。 */
export type UnbindResult = UnbindOk
  | { ok: false; error: 'pending'; pending: number; held: number; failures: number }
  | { ok: false; error: Exclude<UnbindError, 'pending'> }
