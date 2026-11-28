/**
 * 同步面板上的动作:只接现成的通道,不加新的同步行为(第 1 步只读状态、展示状态)。
 *   立即同步 / 重试:旧引擎 amadeusSync.syncNow;新同步 penzor:sync:run / penzor:sync:retry;远程服务 remoteSync.run。
 *   等你定 · 两边不一样:面板里展开现成的 HeldSyncNotice(它自己调 resolveHeld)。
 *   等你定 · 拦下的删除:去现成的确认处(蓬洲云同步页 / 设置 › 同步),面板不另造删除按钮
 *     (旧引擎的 confirmDeletions 一次放行全部引擎,放在一个库的面板里会误导)。
 * 「跳过这个」引擎没有这个动作,这一步不做(第 2 步)。
 */
import type { SyncFeedReport, SyncReviewItem } from '../../../shared/vaultSync'
import { openPenzorSync, penzorSyncReady } from '../services/syncSetup'
import { useApp } from '../stores/appStore'
import { refreshVaultSync } from './vaultSyncStore'
import { vaultSync } from './v2/client'
import { isDesktopExtendOff, isFullSync, isLegacySync } from './v2/mode'
import { openSyncSettings as openV2Settings } from './v2/openSyncSettings'

/** v2 的 feed(`vault:<bindingId>`):立即同步 / 重试走 vaultsync:run,别撞已退场的 penzor:sync:*。 */
const v2Binding = (f: SyncFeedReport): string | null => (f.id.startsWith('vault:') ? f.id.slice(6) : null)

async function contentCall(channel: string, ...args: unknown[]): Promise<void> {
  const r = await window.tangu?.cloudInvoke?.(channel, ...args) as { ok?: boolean; error?: string } | undefined
  if (!r?.ok) throw new Error(r?.error ?? 'content_sync_unavailable')
}

/** 立即同步:这个库的每个 feed 各踢一次(互不阻塞)。 */
export async function syncNow(feeds: SyncFeedReport[]): Promise<void> {
  const jobs: Array<Promise<unknown>> = []
  if (feeds.some((f) => f.engine === 'legacy' && f.canSyncNow)) jobs.push(window.amadeusSync?.syncNow?.() ?? Promise.resolve())
  for (const f of feeds) { const id = v2Binding(f); if (id && f.canSyncNow) jobs.push(vaultSync.run(id)) }
  if (feeds.some((f) => f.engine === 'content' && !v2Binding(f) && f.canSyncNow)) jobs.push(contentCall('penzor:sync:run'))
  if (feeds.some((f) => f.engine === 'remote' && f.canSyncNow)) jobs.push(window.remoteSync?.run?.() ?? Promise.resolve())
  setTimeout(refreshVaultSync, 300) // 踢完马上读一次:面板别停在「已同步」上等一整轮
  await Promise.allSettled(jobs)
  refreshVaultSync()
}

/** 出错的文件再试一次。 */
export async function retryFailed(feeds: SyncFeedReport[]): Promise<void> {
  const jobs: Array<Promise<unknown>> = []
  if (feeds.some((f) => f.engine === 'legacy' && f.failures.length)) jobs.push(window.amadeusSync?.syncNow?.() ?? Promise.resolve())
  for (const f of feeds) { const id = v2Binding(f); if (id && f.failures.length) jobs.push(vaultSync.run(id)) }
  if (feeds.some((f) => f.engine === 'content' && !v2Binding(f) && f.failures.length)) jobs.push(contentCall('penzor:sync:retry'))
  if (feeds.some((f) => f.engine === 'remote' && f.failures.length)) jobs.push(window.remoteSync?.run?.() ?? Promise.resolve())
  await Promise.allSettled(jobs)
  refreshVaultSync()
}

type SettingsTab = Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0]

/** 拦下的删除去哪确认(都是已有的确认处,面板里不另造删除按钮):
 *  新同步 → 蓬洲云的同步页;旧的在线同步 → 设置 › Forsion 云端 › 笔记同步(「放行删除」在那一行);远程服务 → 设置 › 同步。 */
export function openDeletesReview(item: Extract<SyncReviewItem, { kind: 'deletes' }>, root?: string | null): void {
  // 第 2 步完整模式:v2 绑定拦下的删除在设置 › 同步那个库那一行确认(契约 §3.10);
  // 旧引擎(镜像 / 网盘)那几条还在它们原来的确认处,按条目来源走,别一律送进 v2 的库行(Codex P1-6)
  if (item.ref.feed.startsWith('vault:')) { openV2Settings(root ? { root } : undefined); return }
  if (item.ref.feed === 'content' && penzorSyncReady()) openPenzorSync()
  else if (item.ref.feed.startsWith('legacy:')) useApp.getState().openSettings('forsion/f-sync' as SettingsTab)
  else useApp.getState().openSettings('sync')
}

/** 「同步设置…」:完整模式 → 设置 › 同步(带上库根就定位到那一行);其余照第 1 步:蓬洲云的同步页,没装 Extend 的去设置 › 同步。 */
export function openSyncSettings(root?: string | null): void {
  if (isFullSync()) { openV2Settings(root ? { root } : undefined); return }
  if (isLegacySync() && !isDesktopExtendOff() && penzorSyncReady()) openPenzorSync()
  else useApp.getState().openSettings('sync')
}
