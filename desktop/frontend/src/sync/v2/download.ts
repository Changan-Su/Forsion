import type { VaultCreateArgs, VaultCreated } from '@amadeus-shared/vaultCreate'
/**
 * 智库同步第 4 步 U4 ⑧「落盘到这台…」对话框背后的逻辑(契约 step34 §4.1、实现期修订 E4-1/2/7/15/17;方案图第 2 页 ⑧)。
 * 没有 JSX、不出文案:状态一律回码,界面按码说。
 *
 * 顺序:downloadCheck(只读)→ 用户点主按钮 → 宿主 vaultCreate(建 `<上级>/<库名>`、登记进清单、不切过去)→ download。
 *   - check 没过(含 already_local、默认库)不调 vaultCreate,什么都不建;
 *   - 传给 download 的 root 用宿主回的那个(自己拼的只拿来显示);
 *   - download 在 vaultCreate 之后失败:本次新建、仍为空、没有绑定的文件夹撤掉(createdFolder.ts),否则留着并回报;
 *   - 非空(同一个库)回 { next:'preview' }:交给设置 › 同步的汇总卡(downloadPreviewHandoff / downloadPreviewFocus)。
 */
import type { VsFailDetail, VsResult } from './client'
import { discardCreatedFolder, type CreatedFolderHost, type DiscardOutcome } from './createdFolder'
import type { BindingView, DownloadCheckOk, DownloadError, DownloadOk, LastRoundView, PreviewTarget, ResolveCandidate, VaultSyncPreviewArgs, BindingScope } from './types'

/** 云端那个库在对话框里要的样子(取自库清单 LibraryInfo / get().cloudVaults)。 */
export interface DownloadLibrary { id: string; kind: 'default' | 'own' | 'legacy'; name: string; files?: number | null; bytes?: number }

/** 文件夹名固定 = 库名(库按文件夹名认);默认库的名字跟界面语言,由调用方给(translate('amadeus.default.cloudNotes') 一类)。 */
export function downloadFolderName(lib: Pick<DownloadLibrary, 'kind' | 'name'>, defaultFolderName: string): string {
  return lib.kind === 'default' ? defaultFolderName : lib.name
}

/** `<上级>/<库名>`,只用来显示(真去落盘的 root 用 downloadCheck / 宿主回的)。分隔符跟着上级那条路径走(Windows 上是 `\`)。 */
export function downloadTargetPath(parent: string, folderName: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  const p = parent.length > 1 ? parent.replace(/[\\/]+$/, '') : parent
  return p.endsWith(sep) ? p + folderName : p + sep + folderName
}

/** 四个入口画不画、能不能点:默认库这一版落不了盘(E4-2),四个入口都灰。 */
export type DownloadEntry = { enabled: true } | { enabled: false; reason: 'default_unsupported' | 'not_full' | 'no_library_id' }
export function downloadEntry(lib: { kind: DownloadLibrary['kind']; libraryId?: string | null } | null | undefined, fullMode: boolean): DownloadEntry {
  if (!fullMode) return { enabled: false, reason: 'not_full' }
  if (lib?.kind === 'default') return { enabled: false, reason: 'default_unsupported' }
  if (!lib?.libraryId) return { enabled: false, reason: 'no_library_id' }
  return { enabled: true }
}

// ── 对话框状态 ──

/** 挡住的几类(同一类同一种挡法,原因各写各的;码见 DownloadError + 外层码)。 */
export type DownloadBlockGroup =
  /** 空间不够(insufficient_space):剩余那格变黄,能换位置 */
  | 'space'
  /** 物理根重叠(root_nested / primary_exists / mirror_root / folder_target_nested):换位置 */
  | 'nested'
  /** 那个位置还在旧的同步里(entry_sync_active;legacy_remote_same_root = 原来的网盘同步):给「去设置 › 同步」,也能换位置 */
  | 'legacy_sync'
  /** 位置本身不行(name_mismatch / parent_missing / not_a_directory / root_unreadable / root_missing):换位置 */
  | 'location'
  /** 默认库这一版落不了盘 */
  | 'default'
  /** 这台的智库清单里还读不出来(vault_list_unreadable):不知道撞没撞,不落 */
  | 'list_unreadable'
  /** 根本落不了(没登录 / 老服务器 / 离线 / 库没了 / 同步状态读不出 / 兼容模式 / Extend 不在 / 通道缺位 / 换了账号…):不能换位置 */
  | 'unavailable'

export const DOWNLOAD_BLOCK_GROUP: Readonly<Record<DownloadError, DownloadBlockGroup | 'already_local'>> = {
  insufficient_space: 'space',
  root_nested: 'nested', primary_exists: 'nested', mirror_root: 'nested', folder_target_nested: 'nested',
  entry_sync_active: 'legacy_sync', legacy_remote_same_root: 'legacy_sync',
  name_mismatch: 'location', parent_missing: 'location', not_a_directory: 'location', root_unreadable: 'location', root_missing: 'location',
  default_unsupported: 'default',
  vault_list_unreadable: 'list_unreadable',
  already_local: 'already_local',
  library_not_found: 'unavailable', server_unsupported: 'unavailable', offline: 'unavailable', not_signed_in: 'unavailable',
}

/** 主按钮做什么:落盘 / 比对两边…(汇总卡)/ 同步它…(设置 › 同步那一行)/ 去设置 / 没有(灰着)。 */
export type DownloadPrimary = 'download' | 'compare' | 'sync_existing' | 'open_settings' | 'none'

export type DownloadCheckState =
  /** 正在算(对话框刚开 / 换了位置):主按钮灰着,数字那格写「正在算…」 */
  | { kind: 'checking' }
  /** 能落:new = 文件夹还没有(宿主会建),empty = 有个空的同名文件夹 */
  | { kind: 'ready'; state: 'new' | 'empty'; root: string; name: string; files: number; bytes: number; freeBytes: number | null; primary: 'download'; canChangeLocation: true }
  /** 那个位置已有同名、非空的文件夹 = 同一个库:先比对两边(汇总卡) */
  | { kind: 'compare'; root: string; name: string; files: number; bytes: number; freeBytes: number | null; primary: 'compare'; canChangeLocation: true }
  /** 这台已经有这个库:不另下一份,主按钮「同步它…」→ 设置 › 同步定位到 root 那一行;位置那一行不出 */
  | { kind: 'already_local'; root?: string; bindingId?: string; primary: 'sync_existing'; canChangeLocation: false }
  /** 挡住:code = 原码(界面按它写原因),bytes / freeBytes 只在 space 时有 */
  | { kind: 'blocked'; group: DownloadBlockGroup; code: string; bytes?: number; freeBytes?: number; primary: 'open_settings' | 'none'; canChangeLocation: boolean }

const CHANGEABLE = new Set<DownloadBlockGroup>(['space', 'nested', 'legacy_sync', 'location'])

/** 码(含外层的 stale / state_unreadable / compat_mode / channel_missing / extend_unavailable 和带前缀的错误串)→ 挡法。 */
export function downloadBlock(error: string, detail?: VsFailDetail): DownloadCheckState {
  const code = /([a-z][a-z0-9_-]+)\s*$/.exec(error)?.[1] ?? error
  const g = (DOWNLOAD_BLOCK_GROUP as Record<string, DownloadBlockGroup | 'already_local' | undefined>)[code]
  if (g === 'already_local') return { kind: 'already_local', ...(detail?.root ? { root: detail.root } : {}), ...(detail?.bindingId ? { bindingId: detail.bindingId } : {}), primary: 'sync_existing', canChangeLocation: false }
  const group: DownloadBlockGroup = g ?? 'unavailable'
  return {
    kind: 'blocked', group, code,
    ...(group === 'space' && detail?.bytes !== undefined ? { bytes: detail.bytes } : {}),
    ...(group === 'space' && detail?.freeBytes !== undefined ? { freeBytes: detail.freeBytes } : {}),
    primary: group === 'legacy_sync' ? 'open_settings' : 'none',
    canChangeLocation: CHANGEABLE.has(group),
  }
}

/** downloadCheck 的回复 → 对话框状态。 */
export function classifyDownloadCheck(r: VsResult<DownloadCheckOk>): DownloadCheckState {
  if (!r.ok) return downloadBlock(r.error, r.detail)
  const v = r.value
  if (!v || typeof v !== 'object' || v.ok !== true || typeof v.root !== 'string' || !v.root) return downloadBlock('invalid_reply')
  if (v.kind === 'default') return downloadBlock('default_unsupported')
  const base = { root: v.root, name: v.name, files: v.files, bytes: v.bytes, freeBytes: v.freeBytes ?? null }
  // Extend 已经按「非空的不按整库大小挡」判过 insufficient_space;这里只是不信任一个自相矛盾的回包
  if (v.state === 'nonempty') return { kind: 'compare', ...base, primary: 'compare', canChangeLocation: true }
  if (v.state === 'new' || v.state === 'empty') {
    if (base.freeBytes !== null && base.bytes > base.freeBytes) return downloadBlock('insufficient_space', { bytes: base.bytes, freeBytes: base.freeBytes })
    return { kind: 'ready', state: v.state, ...base, primary: 'download', canChangeLocation: true }
  }
  return downloadBlock('invalid_reply')
}

/** 对话框刚开 / 换了位置:先 checking,回来再换成 classifyDownloadCheck 的结果。lib 是默认库时不调通道。 */
export async function checkDownload(deps: { downloadCheck(libraryId: string, parent: string): Promise<VsResult<DownloadCheckOk>> }, lib: DownloadLibrary, parent: string): Promise<DownloadCheckState> {
  if (lib.kind === 'default') return downloadBlock('default_unsupported')
  return classifyDownloadCheck(await deps.downloadCheck(lib.id, parent))
}

// ── 点了主按钮 ──

/** 宿主 vaultCreate(H 评,electron/amadeus/vaultCreate.ts):在 parent 下建 name 这一层(parent 必须已存在),登记进智库清单,不切过去。
 *  existing:'reuse' = 文件夹已在就只登记(created:false);'refuse' = 已在就抛 EEXIST。名字不合宿主规矩抛 invalid-name。 */
export type VaultCreateFn = (args: VaultCreateArgs) => Promise<VaultCreated>

/** 宿主建文件夹失败的几种(消息带 IPC 前缀,按包含判)。 */
export type HostCreateError = 'invalid_name' | 'exists' | 'parent_missing' | 'failed'
export function hostCreateError(e: unknown): HostCreateError {
  const msg = String((e as Error)?.message ?? e)
  if (msg.includes('invalid-name')) return 'invalid_name'
  if (msg.includes('EEXIST')) return 'exists'
  if (msg.includes('parent-missing') || msg.includes('ENOENT')) return 'parent_missing'
  return 'failed'
}

export interface DownloadDeps {
  download(libraryId: string, root: string): Promise<VsResult<DownloadOk>>
  vaultCreate: VaultCreateFn
  folder: CreatedFolderHost
}

/** 汇总卡要的那几样(和 SyncSettings 的 Pending 同形;对话框和汇总卡在同一个窗口时直接交给 runPreview)。 */
export interface DownloadPreviewHandoff {
  root: string
  name: string
  kind: 'cloud'
  target: PreviewTarget
  scope: BindingScope
  added: []
  downloadCompare: true
  preview: null
}

export type DownloadRun =
  /** 空的:绑定建好了,首轮开始下(进度走第 1 步的状态源) */
  | { kind: 'started'; root: string; bindingId: string; created: boolean }
  /** 非空 = 同一个库:出汇总卡(handoff 给同窗的 runPreview;跨窗口用 downloadPreviewFocus 经 openSyncSettings 带过去) */
  | { kind: 'needs_preview'; root: string; created: boolean; preview: VaultSyncPreviewArgs; handoff: DownloadPreviewHandoff }
  /** 宿主没建成文件夹:什么都没写 */
  | { kind: 'host_failed'; code: HostCreateError }
  /** 宿主回的 vaultCreate 形状不对:不知道建没建,留着、不 download */
  | { kind: 'host_invalid' }
  /** download 挡回来了;cleanup = 本次新建的空文件夹撤没撤(没建就是 null) */
  | { kind: 'blocked'; state: Exclude<DownloadCheckState, { kind: 'checking' | 'ready' | 'compare' }>; root: string; created: boolean; cleanup: DiscardOutcome | null }
  /** 对话框状态不是能落的那两种:什么都不做 */
  | { kind: 'not_ready' }

/** 汇总卡的交接:download 回的 preview 原样给(candidate 是库清单里认定的那个,不按名字重找 —— 那条会在 0 个时新建、多个时让人重挑)。 */
export function downloadPreviewHandoff(preview: VaultSyncPreviewArgs, name: string): DownloadPreviewHandoff {
  return { root: preview.root, name, kind: 'cloud', target: preview.target, scope: preview.scope, added: [], downloadCompare: true, preview: null }
}

/** 点了「落盘」/「比对两边…」:vaultCreate → download。check 必须是 ready / compare。 */
export async function runDownload(deps: DownloadDeps, lib: DownloadLibrary, check: DownloadCheckState, opts: { parent: string; folderName: string }): Promise<DownloadRun> {
  if (check.kind !== 'ready' && check.kind !== 'compare') return { kind: 'not_ready' }
  if (lib.kind === 'default') return { kind: 'blocked', state: downloadBlock('default_unsupported') as DownloadBlockedState, root: check.root, created: false, cleanup: null }
  let made: VaultCreated
  try {
    made = await deps.vaultCreate({ parent: opts.parent, name: opts.folderName, existing: 'reuse' })
  } catch (e) {
    return { kind: 'host_failed', code: hostCreateError(e) }
  }
  if (!made || typeof made.root !== 'string' || !made.root || typeof made.created !== 'boolean' || typeof made.registered !== 'boolean' || !made.operationId) return { kind: 'host_invalid' }
  const r = await deps.download(lib.id, made.root)
  if (r.ok) {
    const v = r.value
    if (v && 'next' in v && v.next === 'preview') {
      const preview = parseDownloadPreview(v.preview)
      if (preview?.root === made.root) return { kind: 'needs_preview', root: made.root, created: made.created, preview, handoff: downloadPreviewHandoff(preview, opts.folderName) }
    }
    if (v && 'bindingId' in v && typeof v.bindingId === 'string' && v.bindingId) return { kind: 'started', root: made.root, bindingId: v.bindingId, created: made.created }
    // 成功却认不出形状:不知道建没建绑定,当失败,不撤文件夹(下一条 cleanup 会先看有没有绑定指着它)
  }
  const state = downloadBlock(r.ok ? 'invalid_reply' : r.error, r.ok ? undefined : r.detail) as DownloadBlockedState
  const cleanup = made.created || made.registered ? await discardCreatedFolder(deps.folder, made) : null
  return { kind: 'blocked', state, root: made.root, created: made.created, cleanup }
}
type DownloadBlockedState = Exclude<DownloadCheckState, { kind: 'checking' | 'ready' | 'compare' }>

// ── 跨窗口交给汇总卡(对话框在主窗、汇总卡在设置浮窗):只传可序列化的数据 ──

function isCandidate(c: unknown): c is ResolveCandidate {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  if (o.kind === 'own') return typeof o.vaultId === 'string' && !!o.vaultId && typeof o.name === 'string' && !!o.name
  if (o.kind === 'legacy') return typeof o.vaultId === 'string' && !!o.vaultId && typeof o.prefix === 'string' && !!o.prefix && (o.name === undefined || typeof o.name === 'string')
  return false
}
function isScope(s: unknown): s is BindingScope {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  if (o.mode === 'all') return true
  if (o.mode !== 'some' || !Array.isArray(o.items)) return false
  const okItem = (it: unknown): boolean => !!it && typeof it === 'object' && typeof (it as { path?: unknown }).path === 'string' && ['folder', 'file', 'page'].includes(String((it as { kind?: unknown }).kind))
  return o.items.every(okItem) && (o.exclude === undefined || (Array.isArray(o.exclude) && o.exclude.every((x) => typeof x === 'string')))
}

/** 别的窗口带来的落盘预演参数:只认 download 会回的那种(蓬洲云去处 + 认定的 own / legacy 候选),逐字段核;不对 = undefined。 */
export function parseDownloadPreview(v: unknown): VaultSyncPreviewArgs | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o.root !== 'string' || !o.root) return undefined
  const t = o.target as Record<string, unknown> | undefined
  if (!t || t.kind !== 'penzor' || !isCandidate(t.candidate)) return undefined
  if (!isScope(o.scope)) return undefined
  const c = t.candidate as ResolveCandidate
  const candidate: ResolveCandidate = c.kind === 'own' ? { kind: 'own', vaultId: c.vaultId, name: c.name } : { kind: 'legacy', vaultId: c.vaultId, prefix: c.prefix, ...(typeof c.name === 'string' ? { name: c.name } : {}) }
  return { root: o.root, target: { kind: 'penzor', candidate }, scope: o.scope as BindingScope }
}

// ── 下完了没有(§3.6 切到本机那份的前半;核哈希、封口在第 3 批)──

export type DownloadSettle =
  /** 首轮整轮跑完、这一轮在封口之后开始、完整、没有失败 / 扫不到 / 等你定 */
  | 'settled'
  /** 首轮还没跑完(firstRound 还在) */
  | 'first_round'
  /** 这次启动以来还没跑完过一轮 */
  | 'no_round'
  /** 最近那一轮是封口之前开始的:再等一轮 */
  | 'round_before_seal'
  | 'incomplete'
  | 'failures'
  | 'skipped'
  /** 有等你定的,或读不出(held = -1) */
  | 'held'

/** E4-7 / E4-15 的判法:startedAt 晚于封口时刻、completed、failures / skipped / held 都是 0;held = -1 当有。字段不在(老 Extend)= no_round。 */
export function downloadSettled(b: Pick<BindingView, 'firstRound' | 'lastRound'>, sealedAt: number): DownloadSettle {
  if (b.firstRound) return 'first_round'
  const r: LastRoundView | null | undefined = b.lastRound
  if (!r || typeof r.startedAt !== 'number') return 'no_round'
  if (!(r.startedAt > sealedAt)) return 'round_before_seal'
  if (r.completed !== true) return 'incomplete'
  if (r.failures !== 0) return 'failures'
  if (r.skipped !== 0) return 'skipped'
  if (r.held !== 0) return 'held'
  return 'settled'
}
