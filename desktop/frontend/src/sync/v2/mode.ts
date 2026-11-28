/**
 * 这台现在用哪套同步界面(智库同步第 2 步,契约 §3.9 / §3.10):所有入口读同一份 ——
 * 设置 › 同步那一页、右键「同步这个文件夹…」、顶栏云按钮、树顶分区、开启弹窗、首登卡片、面板里的「同步设置…」。
 *
 *   full       Extend 注册了 vaultsync:* 且回 mode:'full'(宿主带齐 H 的接缝)→ 新的设置 › 同步,入口改道。
 *   legacy     通道不在(老 Extend)或回 mode:'compat'(宿主缺接缝 / 这个账号开着旧新同步)→ 今天的界面原样。
 *   unreadable compat 的原因是 state-unreadable:v2 的状态文件读不出来 → 设置页说读不出来,**不**退回能把老同步打开的旧界面(§3.2)。
 *   off        cloudInvoke 不在 = Forsion Extend 没装载(插件页停用 / 验签没过)→ 设置页写明并给启用按钮,开关不可点(§7 第 1 条)。
 *   unknown    还没问过 / 问的时候出错 → 入口按 legacy 走(不会把 v2 管着的根交给旧弹窗:H 的遮罩挡着,而且 unknown 只在启动头几秒)。
 * mode 按账号(content-sync-active 是账号级的),所以换账号、窗口切回前台时重问。
 */
import { create } from 'zustand'
import { CHANNEL_MISSING, EXTEND_UNAVAILABLE, vaultSync } from './client'
import type { VaultSyncCompatReason, VaultSyncGet, VaultSyncStatus } from './types'

export type SyncUiMode = 'unknown' | 'full' | 'legacy' | 'unreadable' | 'off'

interface SyncModeState {
  mode: SyncUiMode
  compatReason?: VaultSyncCompatReason | 'old-extend'
  /** 上一次问出错的原因(只给设置页显示;入口照 unknown 走) */
  error?: string
}

export const useSyncMode = create<SyncModeState>(() => ({ mode: 'unknown' }))

/** 由 get / status 的回复推出模式(纯函数)。 */
export function modeFrom(r: { ok: true; value: Pick<VaultSyncGet, 'mode' | 'compatReason'> | Pick<VaultSyncStatus, 'mode'> } | { ok: false; error: string }): SyncModeState {
  if (!r.ok) {
    if (r.error === EXTEND_UNAVAILABLE) return { mode: 'off' }
    if (r.error === CHANNEL_MISSING) return { mode: 'legacy', compatReason: 'old-extend' }
    return { mode: 'unknown', error: r.error }
  }
  const v = r.value as { mode?: string; compatReason?: VaultSyncCompatReason } | null | undefined
  if (!v || typeof v !== 'object') return { mode: 'unknown', error: 'invalid_reply' }
  if (v.mode === 'full') return { mode: 'full' }
  if (v.compatReason === 'state-unreadable') return { mode: 'unreadable', compatReason: v.compatReason }
  return { mode: 'legacy', ...(v.compatReason ? { compatReason: v.compatReason } : {}) }
}

export function setSyncMode(next: SyncModeState): void {
  const cur = useSyncMode.getState()
  // 问出错(unknown + error)不盖掉已经问出来的模式:偶发失败别让入口在 full / legacy 之间来回跳
  if (next.mode === 'unknown' && cur.mode !== 'unknown') { if (cur.error !== next.error) useSyncMode.setState({ error: next.error }); return }
  if (cur.mode !== next.mode || cur.compatReason !== next.compatReason || cur.error !== next.error) useSyncMode.setState({ mode: next.mode, compatReason: next.compatReason, error: next.error })
}

/**
 * vaultsync:status 的回复 → 模式。E 的 status 在兼容模式下不带 compatReason(只有 get 带):这时问一次 get 补上原因(30 秒内复用),
 * 否则「同步记录读不出」会被当成普通兼容、把旧写入口放出来(台架 probe-states 的 unreadable 实测出来的)。get 也问不出 = 不知道(unknown)。
 * 已请 E 在 status 里带 compatReason(契约 U-4)。
 */
let reasonCache: { at: number; reason: VaultSyncCompatReason | undefined } | null = null
export async function modeFromStatus(r: VsStatusReply): Promise<SyncModeState> {
  if (!r.ok || !r.value || r.value.mode !== 'compat' || (r.value as { compatReason?: unknown }).compatReason) return modeFrom(r)
  if (!reasonCache || Date.now() - reasonCache.at > 30_000) {
    const g = await vaultSync.get().catch(() => null)
    if (!g?.ok || !g.value) return { mode: 'unknown', error: g && !g.ok ? g.error : 'compat_reason_unknown' }
    reasonCache = { at: Date.now(), reason: g.value.mode === 'compat' ? g.value.compatReason : undefined }
  }
  return modeFrom({ ok: true, value: { mode: 'compat', ...(reasonCache.reason ? { compatReason: reasonCache.reason } : {}) } })
}
type VsStatusReply = { ok: true; value: Pick<VaultSyncStatus, 'mode'> } | { ok: false; error: string }

/** 现在问一次(只读、便宜的 vaultsync:status)。 */
export async function refreshSyncMode(): Promise<SyncUiMode> {
  const r = await vaultSync.status()
  setSyncMode(await modeFromStatus(r))
  return useSyncMode.getState().mode
}

export const syncModeNow = (): SyncUiMode => useSyncMode.getState().mode
export const isFullSync = (): boolean => useSyncMode.getState().mode === 'full'
/** 旧流程照旧的几种:compat / 老 Extend(legacy),和这台根本没有 v2(off:网页、手机、没装或停用 Extend 的桌面 ——
 *  这些宿主上旧流程一直是唯一的那套)。只有「还没问出来(unknown)」「读不出(unreadable)」不给旧写入口(Codex P1-7):
 *  这两种是 v2 可能在管、只是这一下不知道。 */
export const isLegacySync = (): boolean => { const m = useSyncMode.getState().mode; return m === 'legacy' || m === 'off' }
/** 同上的 hook 版(组件里订阅)。 */
export const useLegacySync = (): boolean => useSyncMode((s) => s.mode === 'legacy' || s.mode === 'off')
/** 桌面上 Extend 停用 / 没装(这台本该有设置 › 同步这一页,却问不到 v2):入口去设置页看说明,别按残留的就绪标记送进不存在的蓬洲云(Codex P2-6)。
 *  网页 / 手机没有这一页,照旧去蓬洲云。 */
export const isDesktopExtendOff = (): boolean =>
  useSyncMode.getState().mode === 'off' && typeof window !== 'undefined' && !!window.tangu?.backendStatus && !!window.amadeus && !!window.remoteSync
