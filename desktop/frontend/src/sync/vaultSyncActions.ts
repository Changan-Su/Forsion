/**
 * 同步面板上的动作:只接现成的通道,不加新的同步行为(第 1 步只读状态、展示状态)。
 *   立即同步 / 重试:旧引擎 amadeusSync.syncNow;新同步 penzor:sync:run / penzor:sync:retry;远程服务 remoteSync.run。
 *   等你定 · 两边不一样:旧引擎 amadeusSync.resolveHeld(binding / shareKey 原样从 ref 带回)。
 *   等你定 · 拦下的删除:旧引擎 amadeusSync.confirmDeletions(一次放行全部引擎);新同步 penzor:sync:confirmDeletes / abandonDeletes(带名单指纹);
 *     远程服务的在设置 › 同步里确认(这里只开那一页)。
 * 「跳过这个」引擎没有这个动作,这一步不做(第 2 步)。
 */
import type { AmadeusHeldChoice } from '../types'
import type { SyncActionRef, SyncFeedReport, SyncReviewItem } from '../../../shared/vaultSync'
import { isResolveHeldFailure } from '../components/heldResolveResult'
import { useApp } from '../stores/appStore'
import { refreshVaultSync } from './vaultSyncStore'

async function contentCall(channel: string, ...args: unknown[]): Promise<void> {
  const r = await window.tangu?.cloudInvoke?.(channel, ...args) as { ok?: boolean; error?: string } | undefined
  if (!r?.ok) throw new Error(r?.error ?? 'content_sync_unavailable')
}

/** 立即同步:这个库的每个 feed 各踢一次(互不阻塞)。 */
export async function syncNow(feeds: SyncFeedReport[]): Promise<void> {
  const jobs: Array<Promise<unknown>> = []
  if (feeds.some((f) => f.engine === 'legacy' && f.canSyncNow)) jobs.push(window.amadeusSync?.syncNow?.() ?? Promise.resolve())
  if (feeds.some((f) => f.engine === 'content' && f.canSyncNow)) jobs.push(contentCall('penzor:sync:run'))
  if (feeds.some((f) => f.engine === 'remote' && f.canSyncNow)) jobs.push(window.remoteSync?.run?.() ?? Promise.resolve())
  await Promise.allSettled(jobs)
  refreshVaultSync()
}

/** 出错的文件再试一次。 */
export async function retryFailed(feeds: SyncFeedReport[]): Promise<void> {
  const jobs: Array<Promise<unknown>> = []
  if (feeds.some((f) => f.engine === 'legacy' && f.failures.length)) jobs.push(window.amadeusSync?.syncNow?.() ?? Promise.resolve())
  if (feeds.some((f) => f.engine === 'content' && f.failures.length)) jobs.push(contentCall('penzor:sync:retry'))
  if (feeds.some((f) => f.engine === 'remote' && f.failures.length)) jobs.push(window.remoteSync?.run?.() ?? Promise.resolve())
  await Promise.allSettled(jobs)
  refreshVaultSync()
}

export const canResolveHeld = (): boolean => !!window.amadeusSync?.resolveHeld

/** 处理几篇「两边不一样」(同一个 feed 的;不同 feed 的分开调)。返回是否成功。 */
export async function resolveDiffers(items: Array<Extract<SyncReviewItem, { kind: 'differs' }>>, choice: AmadeusHeldChoice): Promise<boolean> {
  const resolve = window.amadeusSync?.resolveHeld
  if (!resolve || !items.length) return false
  const byFeed = new Map<string, typeof items>()
  for (const it of items) byFeed.set(it.ref.feed, [...(byFeed.get(it.ref.feed) ?? []), it])
  let ok = true
  for (const group of byFeed.values()) {
    const ref = group[0].ref as SyncActionRef & { binding?: string | null; shareKey?: string | null }
    try {
      const r = await resolve({ binding: ref.binding ?? null, ...(ref.shareKey ? { shareKey: ref.shareKey } : {}), paths: group.map((g) => String(g.ref.serverPath)), choice })
      if (isResolveHeldFailure(r)) ok = false
    } catch { ok = false }
  }
  refreshVaultSync()
  return ok
}

/** 确认拦下的删除。返回是否成功。 */
export async function confirmDeletes(item: Extract<SyncReviewItem, { kind: 'deletes' }>): Promise<boolean> {
  try {
    if (item.ref.feed === 'content') await contentCall('penzor:sync:confirmDeletes', String(item.ref.token ?? ''))
    else if (item.ref.feed === 'remote') { useApp.getState().openSettings('sync'); return true }
    else { if (!window.amadeusSync?.confirmDeletions) return false; await window.amadeusSync.confirmDeletions() }
    return true
  } catch { return false } finally { refreshVaultSync() }
}

/** 不删,恢复(只有新同步有)。 */
export async function restoreDeletes(item: Extract<SyncReviewItem, { kind: 'deletes' }>): Promise<boolean> {
  if (item.ref.feed !== 'content') return false
  try { await contentCall('penzor:sync:abandonDeletes', String(item.ref.token ?? '')); return true } catch { return false } finally { refreshVaultSync() }
}
