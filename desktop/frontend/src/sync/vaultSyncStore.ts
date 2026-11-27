/**
 * 智库同步的状态源(智库同步统一方案 2026-11-27 第 1 步):一份,左栏「智库」那行、同步面板、状态栏、通知、智库菜单都读它。
 *
 * 合并引擎之前三套都读:
 *   - 旧的文件夹 / 条目同步与整库镜像:window.amadeusSync —— 先 getAll()(新 Extend:全部引擎,含空闲的条目引擎),
 *     老 Extend 只有 get()(只回镜像);之后靠 onStatus 事件。注册表里有、还没见过状态的条目同步,按镜像的状态推它在不在跑。
 *   - 蓬洲云的新同步:penzor:sync:status(只读,不建会话、不扫、不踢)轮询;老 Extend 没有这个通道时,只在它确实认领了
 *     (智库菜单那份 listVaults 的 sync)才回落 penzor:sync:get —— 那个快照在新同步关着时会顺手扫一遍来源,别让常驻界面天天去扫。
 *   - 远程服务:window.remoteSync。
 * 第 2 步换成一套定时同步时,只换这里喂数据的那几段;合成(shared/vaultSync.ts composeVaultSync)和界面都不动。
 * 只在桌面有;网页 / 手机没有这几个桥,状态源是空的(云侧那行的说法另见 VaultSyncChip)。
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { composeVaultSync, type SyncFeedReport, type VaultSyncView } from '../../../shared/vaultSync'
import { ensureEntrySyncSubscribed, useEntrySync } from '../stores/entrySyncStore'
import type { AmadeusEntrySyncVault, AmadeusSyncStatus, RemoteSyncState } from '../types'
import { amadeus } from '@amadeus/api'
import { assumedEntryFeed, contentFeed, legacyFeed, legacyFeedId, remoteFeed, type ContentStatusLite } from './feeds'

type RemoteLite = Pick<RemoteSyncState, 'config' | 'running' | 'lastReport' | 'progress' | 'root' | 'rootError'>

interface VaultSyncRaw {
  /** 旧引擎最新状态,按 feed id */
  legacy: Record<string, AmadeusSyncStatus>
  entryVaults: AmadeusEntrySyncVault[]
  content: ContentStatusLite | null
  remote: RemoteLite | null
  /** 新同步与远程服务钉住的那个本机库 */
  pinnedRoot: string | null
  /** 「现在」:每 30 秒走一格,「2 分钟前」跟着变 */
  now: number
}

export const useVaultSyncRaw = create<VaultSyncRaw>(() => ({
  legacy: {}, entryVaults: [], content: null, remote: null, pinnedRoot: null, now: Date.now(),
}))

/** 原始状态 → 所有 feed(纯函数,单测直接喂)。 */
export function feedsOf(raw: Pick<VaultSyncRaw, 'legacy' | 'entryVaults' | 'content' | 'remote' | 'pinnedRoot'>): SyncFeedReport[] {
  const out: SyncFeedReport[] = []
  const statuses = Object.values(raw.legacy)
  const hasOwn = statuses.some((s) => typeof s.ownPendingDeletions === 'number')
  for (const s of statuses) {
    // 注册表里已经没有的条目同步(关掉了):它最后那条状态不再算
    if (s.binding && !raw.entryVaults.some((v) => v.vaultRoot === s.binding)) continue
    out.push(legacyFeed(s, { entryVaults: raw.entryVaults, carriesTotalDeletions: !hasOwn && legacyFeedId(s) === 'legacy:mirror' }))
  }
  const mirror = raw.legacy['legacy:mirror'] ?? null
  for (const v of raw.entryVaults) if (!raw.legacy[`legacy:entry:${v.vaultRoot}`] && v.entries.length) out.push(assumedEntryFeed(v, mirror))
  if (raw.content) out.push(contentFeed(raw.content, { pinnedRoot: raw.pinnedRoot, signedIn: raw.content.session !== false }))
  if (raw.remote) out.push(remoteFeed(raw.remote))
  return out
}

/** 所有 feed(状态栏「别处出错」、通知用)。 */
export function useSyncFeeds(): SyncFeedReport[] {
  useEffect(() => ensureVaultSyncSubscribed(), [])
  const legacy = useVaultSyncRaw((s) => s.legacy)
  const entryVaults = useVaultSyncRaw((s) => s.entryVaults)
  const content = useVaultSyncRaw((s) => s.content)
  const remote = useVaultSyncRaw((s) => s.remote)
  const pinnedRoot = useVaultSyncRaw((s) => s.pinnedRoot)
  return useMemo(() => feedsOf({ legacy, entryVaults, content, remote, pinnedRoot }), [legacy, entryVaults, content, remote, pinnedRoot])
}

/** 一个库此刻的状态(合成后)。vault.side = cloud 是账号的云端镜像那一侧。 */
export function useVaultSync(vault: { root: string | null; side: 'local' | 'cloud' }): VaultSyncView & { now: number } {
  const feeds = useSyncFeeds()
  const now = useVaultSyncRaw((s) => s.now)
  return useMemo(() => ({ ...composeVaultSync(feeds, vault, now), now }), [feeds, vault.root, vault.side, now])
}

/** 立刻再读一遍(用户刚点了立即同步 / 处理了等你定)。 */
export function refreshVaultSync(): void {
  void pullLegacy()
  void pollContent() // 重排:刚点了立即同步,马上进 1 秒一次的节奏
  void pullRemote()
}

// ── 订阅 ────────────────────────────────────────────────────────────────────────

let subscribed = false
let contentTimer: ReturnType<typeof setTimeout> | null = null
/** 老 Extend 没有 penzor:sync:status(只有「通道不存在」才记成 get,别的失败下次再试):回落时只在新同步认领了才取快照 */
let statusChannel: 'status' | 'get' | null = null
/** 轮询代号:立即同步后重排轮询,旧的那一轮回来时不再接着排 */
let pollGen = 0
let ownedByContent = false

const set = (patch: Partial<VaultSyncRaw>): void => useVaultSyncRaw.setState(patch)

function upsertLegacy(s: AmadeusSyncStatus): void {
  const id = legacyFeedId(s)
  useVaultSyncRaw.setState((st) => ({ legacy: { ...st.legacy, [id]: s } }))
}

const hasWindow = (): boolean => typeof window !== 'undefined'

async function pullLegacy(): Promise<void> {
  const api = hasWindow() ? window.amadeusSync : undefined
  if (!api?.get) return
  try {
    if (api.getAll) {
      const all = await api.getAll()
      const legacy: Record<string, AmadeusSyncStatus> = {}
      for (const s of all.engines) legacy[legacyFeedId(s)] = s
      set({ legacy })
      return
    }
    const mirror = await api.get()
    upsertLegacy(mirror)
  } catch { /* 主进程还没准备好:等事件 */ }
}

async function pullVaults(): Promise<void> {
  let rows: Awaited<ReturnType<NonNullable<typeof amadeus.listVaults>>> | null = null
  try { rows = (await amadeus?.listVaults?.()) ?? null } catch { rows = null }
  if (!rows) return
  ownedByContent = rows.some((r) => r.sync)
  const pinned = rows.find((r) => r.pinned)?.root ?? null
  if (pinned !== useVaultSyncRaw.getState().pinnedRoot) set({ pinnedRoot: pinned })
}

async function invoke<T>(channel: string): Promise<T> {
  const r = await window.tangu?.cloudInvoke?.(channel) as { ok?: boolean; value?: T; error?: string } | undefined
  if (!r?.ok) throw new Error(r?.error ?? 'content_sync_unavailable')
  return r.value as T
}

async function readContent(): Promise<ContentStatusLite | null> {
  if (!hasWindow() || typeof window.tangu?.cloudInvoke !== 'function') return null
  if (statusChannel !== 'get') {
    try {
      const v = await invoke<ContentStatusLite>('penzor:sync:status')
      statusChannel = 'status'
      return v
    } catch (e) {
      if (!/not a Forsion Extend channel/.test(String((e as Error)?.message))) return useVaultSyncRaw.getState().content // 偶发失败:留着上一份,下次再试
      statusChannel = 'get'
    }
  }
  if (statusChannel === 'get' && ownedByContent) return invoke<ContentStatusLite>('penzor:sync:get').catch(() => null)
  return null
}

async function pollContent(): Promise<void> {
  const gen = ++pollGen
  if (contentTimer) { clearTimeout(contentTimer); contentTimer = null }
  const c = await readContent().catch(() => useVaultSyncRaw.getState().content)
  if (gen !== pollGen || !hasWindow()) return // 期间又重排过:那一轮负责排下一次
  if (JSON.stringify(c) !== JSON.stringify(useVaultSyncRaw.getState().content)) set({ content: c })
  // 在跑时每秒一次(进度跟手),开着每 5 秒,没开 / 窗口不在前台放慢
  const hidden = typeof document !== 'undefined' && document.hidden
  const delay = c?.running ? 1000 : hidden ? 30_000 : (c?.enabled ?? c?.config?.enabled) ? 5000 : 20_000
  contentTimer = setTimeout(() => void pollContent(), delay)
}

async function pullRemote(): Promise<void> {
  if (!hasWindow() || typeof window.remoteSync?.get !== 'function') return
  let st: Awaited<ReturnType<NonNullable<typeof window.remoteSync>['get']>> | null = null
  try { st = await window.remoteSync.get() } catch { st = null }
  if (st) set({ remote: { config: st.config, running: st.running, lastReport: st.lastReport, progress: st.progress, root: st.root, rootError: st.rootError } })
}

/** 幂等:第一个用到状态源的组件挂载时调一次。 */
export function ensureVaultSyncSubscribed(): void {
  if (subscribed || typeof window === 'undefined') return
  subscribed = true
  ensureEntrySyncSubscribed()
  set({ entryVaults: useEntrySync.getState().vaults })
  useEntrySync.subscribe((s, prev) => {
    if (s.vaults === prev.vaults) return
    set({ entryVaults: s.vaults })
    void pullLegacy() // 新开 / 关掉的条目同步:新 Extend 的 getAll 带回它的引擎
    void pullVaults()
  })
  void pullLegacy()
  try { window.amadeusSync?.onStatus?.((s) => upsertLegacy(s)) } catch { /* 桥不全:等下次拉取 */ }
  void pullVaults().then(() => pollContent())
  void pullRemote()
  try {
    window.remoteSync?.onStatus?.((s) => {
      const prev = useVaultSyncRaw.getState().remote
      if (!prev) { void pullRemote(); return }
      set({ remote: { ...prev, running: s.running, lastReport: s.lastReport, progress: s.progress } })
    })
  } catch { /* 桥不全 */ }
  setInterval(() => set({ now: Date.now() }), 30_000)
  setInterval(() => void pullVaults(), 60_000)
  if (typeof window.addEventListener === 'function') window.addEventListener('focus', () => { void pullVaults(); void pollContent() })
}
