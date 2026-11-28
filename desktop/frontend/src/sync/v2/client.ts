/**
 * `vaultsync:*` 通道的唯一客户端(智库同步第 2 步 U 包)。界面一律经它调,别自己拆 cloudInvoke 的回复。
 *
 * 回复有两层(契约实现期修订 E-2 第 9 条、#884):
 *   外层:Extend 的 host.handle 一律回 `{ok:true, value}` / `{ok:false, error}`;通道没注册时 cloudInvoke 直接 reject(`not a Forsion Extend channel`)。
 *   内层:apply / setScope / setTarget / rename:answer 把「要先 preview」「代次过期」「不支持」放在 value 里回 `{error}`;
 *         resolve 在 value 里再套一层 `{ok:false, error}`;第 4 步的 downloadCheck / download / create / unbind 同 resolve
 *         (失败另带 root / bindingId / libraryId / bytes / freeBytes / pending / held / failures,归进 detail);
 *         libraries 读不出回 `{error}`(读失败 ≠ 空清单)。
 * 这里把两层归一成 `{ok:true, value}` / `{ok:false, error}`。⚠️ 判失败只看 ok,别用 `'error' in r`(resolveName 的 value 本身就可能带 error 字段)。
 */
import {
  VAULT_SYNC_CHANNELS as CH,
  type BindingScope, type BindingView, type Cadence, type HeldAction, type HeldRef, type RecoveryEventView, type ResolveNameResult,
  type RemoteDirHolder, type VaultSyncApplyArgs, type VaultSyncGet, type VaultSyncPreview, type VaultSyncPreviewArgs, type VaultSyncResolveAllResult, type VaultSyncStatus,
  type CreateOk, type DownloadCheckOk, type DownloadOk, type LibrariesValue, type UnbindOk,
} from './types'

/** 第 4 步失败时引擎另带的字段(逐个核类型,不对就丢):
 *  already_local → root(这台那份)/ bindingId;insufficient_space → bytes / freeBytes;name_exists → libraryId;
 *  already_bound → bindingId;unbind 的 pending → pending / held / failures。 */
export interface VsFailDetail { root?: string; bindingId?: string; libraryId?: string; bytes?: number; freeBytes?: number; pending?: number; held?: number; failures?: number }
/** inUseBy:remote_dir_in_use 时引擎带上的「谁占着这个远端目录」(契约 E-17),界面要写出库名。 */
export type VsResult<T> = { ok: true; value: T } | { ok: false; error: string; inUseBy?: RemoteDirHolder; uncovered?: string[] | 'all'; detail?: VsFailDetail }

/** cloudInvoke 不在(Extend 没装载 / 停用,或网页 / 手机):所有调用回它。 */
export const EXTEND_UNAVAILABLE = 'extend_unavailable'
/** 通道没注册(老 Extend,或 U-1 里 E 还没补的通道)。 */
export const CHANNEL_MISSING = 'channel_missing'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

function invoker(): Invoke | null {
  const fn = typeof window !== 'undefined' ? window.tangu?.cloudInvoke : undefined
  return typeof fn === 'function' ? fn : null
}

/** value 里还藏着失败的通道(内层)。 */
const SOFT_FAIL = new Set<string>([CH.resolveAll, CH.preview, CH.recoveryRestore, CH.deletesConfirm, CH.deletesAbandon, CH.apply, CH.setScope, CH.setTarget, CH.renameAnswer, CH.resolve, CH.setEnabled, CH.choose, CH.takeoverRevert, CH.dismissCard,
  CH.libraries, CH.downloadCheck, CH.download, CH.create, CH.unbind])

const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined)
const bytesOf = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined)
const countOf = (x: unknown): number | undefined => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : undefined)
/** 失败里带的第 4 步字段(见 VsFailDetail);一个都没有 = undefined(老通道的失败形状不变)。 */
function detailOf(x: unknown): VsFailDetail | undefined {
  if (!x || typeof x !== 'object') return undefined
  const o = x as Record<string, unknown>
  const d: VsFailDetail = {}
  const root = str(o.root), bindingId = str(o.bindingId), libraryId = str(o.libraryId)
  const bytes = bytesOf(o.bytes), freeBytes = bytesOf(o.freeBytes), pending = countOf(o.pending), held = countOf(o.held), failures = countOf(o.failures)
  if (root !== undefined) d.root = root
  if (bindingId !== undefined) d.bindingId = bindingId
  if (libraryId !== undefined) d.libraryId = libraryId
  if (bytes !== undefined) d.bytes = bytes
  if (freeBytes !== undefined) d.freeBytes = freeBytes
  if (pending !== undefined) d.pending = pending
  if (held !== undefined) d.held = held
  if (failures !== undefined) d.failures = failures
  return Object.keys(d).length ? d : undefined
}

/** 占着远端目录的是谁(E-17 / E-19):name 必须是字符串;bindingId 不是字符串就是 null(原来的网盘同步占着时本来就是 null)。 */
function holderOf(x: unknown): RemoteDirHolder | undefined {
  const u = (x as { inUseBy?: unknown } | null | undefined)?.inUseBy as { bindingId?: unknown; name?: unknown; source?: unknown } | undefined
  if (!u || typeof u !== 'object' || typeof u.name !== 'string') return undefined
  return { bindingId: typeof u.bindingId === 'string' ? u.bindingId : null, name: u.name, ...(u.source === 'remotesync' ? { source: 'remotesync' as const } : {}) }
}

/** legacy_remote_same_root(E-21):新范围里旧网盘同步没忽略的那几项;'all' = 整个都没盖住(读不出时也是)。形状不对就不带。 */
function uncoveredOf(x: unknown): string[] | 'all' | undefined {
  const u = (x as { uncovered?: unknown } | null | undefined)?.uncovered
  if (u === 'all') return 'all'
  return Array.isArray(u) && u.every((s) => typeof s === 'string') ? (u as string[]) : undefined
}

/** 归一两层回复(纯函数,单测直接喂)。 */
export function normalizeReply<T>(channel: string, reply: unknown): VsResult<T> {
  const r = reply as { ok?: unknown; value?: unknown; error?: unknown } | null | undefined
  if (!r || typeof r !== 'object') return { ok: false, error: 'invalid_reply' }
  if (r.ok !== true) {
    // 宿主把失败放在外层回时也可能带着 inUseBy(Codex 第四轮 P1-4)
    const inUseBy = holderOf(r), uncovered = uncoveredOf(r), detail = detailOf(r)
    return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : 'failed', ...(inUseBy ? { inUseBy } : {}), ...(uncovered ? { uncovered } : {}), ...(detail ? { detail } : {}) }
  }
  const v = r.value as { ok?: unknown; error?: unknown } | null | undefined
  if (SOFT_FAIL.has(channel) && v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.ok === false) {
      // remote_dir_in_use 带着占着那个目录的库(E-17):留下来,别只剩一个码
      const inUseBy = holderOf(v), uncovered = uncoveredOf(v), detail = detailOf(v)
      return { ok: false, error: typeof v.error === 'string' && v.error ? v.error : 'failed', ...(inUseBy ? { inUseBy } : {}), ...(uncovered ? { uncovered } : {}), ...(detail ? { detail } : {}) }
    }
    // apply 成功回 BindingView(没有 error 字段);失败回 {error:'stale'} 这样只有 error 的对象
    if (v.ok === undefined && typeof v.error === 'string' && v.error) return { ok: false, error: v.error }
  }
  return { ok: true, value: r.value as T }
}

export async function call<T>(channel: string, ...args: unknown[]): Promise<VsResult<T>> {
  const inv = invoker()
  if (!inv) return { ok: false, error: EXTEND_UNAVAILABLE }
  let reply: unknown
  try {
    reply = await inv(channel, ...args)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    return { ok: false, error: /not a Forsion Extend channel/.test(msg) ? CHANNEL_MISSING : msg || 'failed' }
  }
  return normalizeReply<T>(channel, reply)
}

export const vaultSync = {
  get: (locale?: 'zh' | 'en') => call<VaultSyncGet>(CH.get, locale),
  status: () => call<VaultSyncStatus>(CH.status),
  resolveName: (root: string) => call<ResolveNameResult>(CH.resolveName, { root }),
  preview: (args: VaultSyncPreviewArgs) => call<VaultSyncPreview>(CH.preview, args),
  apply: (args: VaultSyncApplyArgs) => call<BindingView | { bindingId: string }>(CH.apply, args),
  setEnabled: (bindingId: string, enabled: boolean) => call<void>(CH.setEnabled, { bindingId, enabled }),
  /** 只收缩范围直接改;有新加的部分回 preview_required(走汇总卡)。 */
  setScope: (bindingId: string, scope: BindingScope) => call<void>(CH.setScope, { bindingId, scope }),
  run: (bindingId?: string, reason?: 'focus') => call<void>(CH.run, { ...(bindingId ? { bindingId } : {}), ...(reason ? { reason } : {}) }),
  resolve: (ref: HeldRef, action: HeldAction) => call<{ ok: true; recoveryEventId?: string }>(CH.resolve, { ref, action }),
  resolveAll: (bindingId: string, action: HeldAction, token: string) => call<VaultSyncResolveAllResult>(CH.resolveAll, { bindingId, action, token }),
  deletesConfirm: (bindingId: string, token: string) => call<void>(CH.deletesConfirm, { bindingId, token }),
  deletesAbandon: (bindingId: string, token: string) => call<void>(CH.deletesAbandon, { bindingId, token }),
  /** newVault 回 { next: 'preview' }:界面接着用 { kind: 'create' } 预演、出汇总卡(apply 时才建新库)。 */
  renameAnswer: (bindingId: string, choice: 'renameCloud' | 'newVault' | 'pause') => call<{ next?: 'preview' } | void>(CH.renameAnswer, { bindingId, choice }),
  choose: (bindingId: string, choice: 'primary' | 'backup' | 'off') => call<void>(CH.choose, { bindingId, choice }),
  setCadence: (c: Cadence) => call<void>(CH.setCadence, c),
  recoveryList: (since?: number) => call<RecoveryEventView[]>(CH.recoveryList, since ? { since } : {}),
  recoveryRestore: (eventId: string) => call<{ path: string }>(CH.recoveryRestore, { eventId }),
  takeoverRevert: (root: string, source: string) => call<void>(CH.takeoverRevert, { root, source }),
  dismissCard: (bindingId: string) => call<void>(CH.dismissCard, { bindingId }),
  /** 云端库清单;refresh = 现取(缺省给主进程那份缓存,便宜)。读不出回失败,别当空清单。 */
  libraries: (refresh?: boolean) => call<LibrariesValue>(CH.libraries, refresh ? { refresh: true } : {}),
  /** 落盘对话框打开 / 换位置时调,只读。 */
  downloadCheck: (libraryId: string, parent: string) => call<DownloadCheckOk>(CH.downloadCheck, { libraryId, parent }),
  /** root 由宿主 vaultCreate 建好、登记好;非空回 { next:'preview', preview }(交汇总卡)。 */
  download: (libraryId: string, root: string) => call<DownloadOk>(CH.download, { libraryId, root }),
  create: (root: string) => call<CreateOk>(CH.create, { root }),
  /** syncFirst = 「先同步再停」:Extend 自己先跑一轮、跑完还有剩回 pending(什么都没停)。 */
  unbind: (bindingId: string, syncFirst?: boolean) => call<UnbindOk>(CH.unbind, { bindingId, ...(syncFirst ? { syncFirst: true } : {}) }),
}

/** Extend 的设备名(已有通道 `penzor:device`,回 `{ok, name}`,不是 value 包着的那种)。 */
export async function deviceName(): Promise<string | null> {
  const inv = invoker()
  if (!inv) return null
  try {
    const r = await inv('penzor:device') as { ok?: boolean; name?: unknown } | null
    return r?.ok && typeof r.name === 'string' && r.name ? r.name : null
  } catch { return null }
}
