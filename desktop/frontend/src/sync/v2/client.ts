/**
 * `vaultsync:*` 通道的唯一客户端(智库同步第 2 步 U 包)。界面一律经它调,别自己拆 cloudInvoke 的回复。
 *
 * 回复有两层(契约实现期修订 E-2 第 9 条、#884):
 *   外层:Extend 的 host.handle 一律回 `{ok:true, value}` / `{ok:false, error}`;通道没注册时 cloudInvoke 直接 reject(`not a Forsion Extend channel`)。
 *   内层:apply / setScope / setTarget / rename:answer 把「要先 preview」「代次过期」「不支持」放在 value 里回 `{error}`;
 *         resolve 在 value 里再套一层 `{ok:false, error}`。
 * 这里把两层归一成 `{ok:true, value}` / `{ok:false, error}`。⚠️ 判失败只看 ok,别用 `'error' in r`(resolveName 的 value 本身就可能带 error 字段)。
 */
import {
  VAULT_SYNC_CHANNELS as CH,
  type BindingScope, type BindingView, type Cadence, type HeldAction, type HeldRef, type RecoveryEventView, type ResolveNameResult,
  type RemoteDirHolder, type VaultSyncApplyArgs, type VaultSyncGet, type VaultSyncPreview, type VaultSyncPreviewArgs, type VaultSyncResolveAllResult, type VaultSyncStatus,
} from './types'

/** inUseBy:remote_dir_in_use 时引擎带上的「谁占着这个远端目录」(契约 E-17),界面要写出库名。 */
export type VsResult<T> = { ok: true; value: T } | { ok: false; error: string; inUseBy?: RemoteDirHolder; uncovered?: string[] | 'all' }

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
const SOFT_FAIL = new Set<string>([CH.resolveAll, CH.preview, CH.recoveryRestore, CH.deletesConfirm, CH.deletesAbandon, CH.apply, CH.setScope, CH.setTarget, CH.renameAnswer, CH.resolve, CH.setEnabled, CH.choose, CH.takeoverRevert, CH.dismissCard])

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
    const inUseBy = holderOf(r), uncovered = uncoveredOf(r)
    return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : 'failed', ...(inUseBy ? { inUseBy } : {}), ...(uncovered ? { uncovered } : {}) }
  }
  const v = r.value as { ok?: unknown; error?: unknown } | null | undefined
  if (SOFT_FAIL.has(channel) && v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.ok === false) {
      // remote_dir_in_use 带着占着那个目录的库(E-17):留下来,别只剩一个码
      const inUseBy = holderOf(v), uncovered = uncoveredOf(v)
      return { ok: false, error: typeof v.error === 'string' && v.error ? v.error : 'failed', ...(inUseBy ? { inUseBy } : {}), ...(uncovered ? { uncovered } : {}) }
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
