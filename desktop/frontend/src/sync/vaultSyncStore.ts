/**
 * 智库同步的状态源(智库同步统一方案 2026-11-27 第 1 步):一份,左栏「智库」那行、同步面板、状态栏、通知、智库菜单都读它。
 *
 * 合并引擎之前三套都读:
 *   - 旧的文件夹 / 条目同步与整库镜像:window.amadeusSync —— 先 getAll()(新 Extend:全部引擎,含空闲的条目引擎),
 *     老 Extend 只有 get()(只回镜像);之后靠 onStatus 事件。注册表里有、还没见过状态的条目同步,按镜像的状态推它在不在跑。
 *   - 蓬洲云的新同步:penzor:sync:status(只读,不建会话、不扫、不踢)轮询;老 Extend 没有这个通道时**不回落** penzor:sync:get
 *     (那个快照会建会话、恢复回收站、扫来源,常驻界面去轮询它就改了同步什么时候干活),新同步认领了(listVaults 的 sync)只说「同步开着」。
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
import { assumedContentFeed, assumedEntryFeed, contentFeeds, legacyFeed, legacyFeedId, remoteFeed, type ContentStatusLite } from './feeds'
import { v2Feeds, v2Roots } from './v2/feed'
import { CHANNEL_MISSING, EXTEND_UNAVAILABLE, vaultSync } from './v2/client'
import { modeFrom, setSyncMode } from './v2/mode'
import type { VaultSyncStatus } from './v2/types'

type RemoteLite = Pick<RemoteSyncState, 'config' | 'running' | 'lastReport' | 'progress' | 'root' | 'rootError'>

interface VaultSyncRaw {
  /** 旧引擎最新状态,按 feed id */
  legacy: Record<string, AmadeusSyncStatus>
  entryVaults: AmadeusEntrySyncVault[]
  content: ContentStatusLite | null
  remote: RemoteLite | null
  /** 新同步与远程服务钉住的那个本机库 */
  pinnedRoot: string | null
  /** 老 Extend(没有只读的 penzor:sync:status)且新同步认领了这个库:状态说不出,只说开着 */
  contentAssumed: boolean
  /** 智库同步 v2(第 2 步)的只读状态 vaultsync:status;compat / 没有这个通道 = null */
  v2: VaultSyncStatus | null
  /** 「现在」:每 30 秒走一格,「2 分钟前」跟着变 */
  now: number
}

export const useVaultSyncRaw = create<VaultSyncRaw>(() => ({
  legacy: {}, entryVaults: [], content: null, remote: null, pinnedRoot: null, contentAssumed: false, v2: null, now: Date.now(),
}))

/** 原始状态 → 所有 feed(纯函数,单测直接喂)。 */
export function feedsOf(raw: Pick<VaultSyncRaw, 'legacy' | 'entryVaults' | 'content' | 'remote' | 'pinnedRoot'> & { contentAssumed?: boolean; v2?: VaultSyncStatus | null }): SyncFeedReport[] {
  const out: SyncFeedReport[] = []
  const statuses = Object.values(raw.legacy)
  const hasOwn = statuses.some((s) => typeof s.ownPendingDeletions === 'number')
  // v2 接手了的根:旧条目同步不再为它起来(契约 §3.8 A0),注册表里留着的那条不再算 —— 否则它的「同步开着」会盖过 v2 的「已同步」
  const taken = v2Roots(raw.v2 ?? null)
  for (const s of statuses) {
    // 注册表里已经没有的条目同步(关掉了):它最后那条状态不再算
    if (s.binding && !raw.entryVaults.some((v) => v.vaultRoot === s.binding)) continue
    if (s.binding && taken.has(s.binding)) continue
    out.push(legacyFeed(s, { entryVaults: raw.entryVaults, carriesTotalDeletions: !hasOwn && legacyFeedId(s) === 'legacy:mirror' }))
  }
  const mirror = raw.legacy['legacy:mirror'] ?? null
  for (const v of raw.entryVaults) if (!raw.legacy[`legacy:entry:${v.vaultRoot}`] && v.entries.length && !taken.has(v.vaultRoot)) out.push(assumedEntryFeed(v, mirror))
  out.push(...v2Feeds(raw.v2 ?? null))
  if (raw.content) out.push(...contentFeeds(raw.content, { pinnedRoot: raw.pinnedRoot, signedIn: raw.content.session !== false }))
  else if (raw.contentAssumed) out.push(assumedContentFeed(raw.pinnedRoot))
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
  const contentAssumed = useVaultSyncRaw((s) => s.contentAssumed)
  const v2 = useVaultSyncRaw((s) => s.v2)
  return useMemo(() => feedsOf({ legacy, entryVaults, content, remote, pinnedRoot, contentAssumed, v2 }), [legacy, entryVaults, content, remote, pinnedRoot, contentAssumed, v2])
}

/** 一个库此刻的状态(合成后)。vault.side = cloud 是账号的云端镜像那一侧。 */
export function useVaultSync(vault: { root: string | null; side: 'local' | 'cloud' }): VaultSyncView & { now: number } {
  const feeds = useSyncFeeds()
  const now = useVaultSyncRaw((s) => s.now)
  return useMemo(() => ({ ...composeVaultSync(feeds, vault, now), now }), [feeds, vault.root, vault.side, now])
}

/** 立刻再读一遍(用户刚点了立即同步 / 处理了等你定)。 */
export function refreshVaultSync(): void {
  v2MetaDirty = true // 刚做过写操作(开关 / 应用 / 改范围):开没开、主绑定还是备份可能变了
  void pullLegacy()
  void pollContent() // 重排:刚点了立即同步,马上进 1 秒一次的节奏
  void pullRemote()
}

// ── 订阅 ────────────────────────────────────────────────────────────────────────

let subscribed = false
let contentTimer: ReturnType<typeof setTimeout> | null = null
/** 老 Extend 没有 penzor:sync:status(只有「通道不存在」才记成 missing,别的失败下次再试) */
let statusChannel: 'status' | 'missing' | null = null
/** 轮询代号:立即同步后重排轮询,旧的那一轮回来时不再接着排 */
let pollGen = 0
let ownedByContent = false
/** vaultsync:status 那一路:missing = 老 Extend(粘住,不再问);off = cloudInvoke 不在 */
let v2Channel: 'ok' | 'missing' | 'off' | null = null

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
  const assumed = statusChannel === 'missing' && ownedByContent
  if (assumed !== useVaultSyncRaw.getState().contentAssumed) set({ contentAssumed: assumed })
}

async function invoke<T>(channel: string): Promise<T> {
  const r = await window.tangu?.cloudInvoke?.(channel) as { ok?: boolean; value?: T; error?: string } | undefined
  if (!r?.ok) throw new Error(r?.error ?? 'content_sync_unavailable')
  return r.value as T
}

async function readContent(): Promise<ContentStatusLite | null> {
  if (!hasWindow() || typeof window.tangu?.cloudInvoke !== 'function') return null
  if (statusChannel === 'missing') return null
  try {
    const v = await invoke<ContentStatusLite>('penzor:sync:status')
    statusChannel = 'status'
    return v
  } catch (e) {
    if (!/not a Forsion Extend channel/.test(String((e as Error)?.message))) return useVaultSyncRaw.getState().content // 偶发失败:留着上一份,下次再试
    statusChannel = 'missing'
    if (ownedByContent && !useVaultSyncRaw.getState().contentAssumed) set({ contentAssumed: true })
    return null
  }
}

/** 智库同步 v2 的只读状态;顺手定这台用哪套界面(sync/v2/mode.ts)。 */
async function readV2(): Promise<VaultSyncStatus | null> {
  if (!hasWindow() || v2Channel === 'missing') return null
  const r = await vaultSync.status()
  setSyncMode(modeFrom(r))
  if (!r.ok) {
    if (r.error === CHANNEL_MISSING) v2Channel = 'missing'
    else if (r.error === EXTEND_UNAVAILABLE) v2Channel = 'off'
    else return useVaultSyncRaw.getState().v2 // 偶发失败:留着上一份
    return null
  }
  v2Channel = 'ok'
  return r.value.mode === 'full' ? withBindingMeta(r.value) : null
}

/**
 * vaultsync:status 目前不带 enabled / paused / role(只有 get 带;已回报 E,契约 U-4)。缺了不能当「开着的主绑定」:
 * 右键会对停用的 / 备份绑定改范围、旧条目同步那条会被盖掉(Codex P2-3)。缺的时候用 get 补,绑定集合变了 / 刚写过 / 30 秒一次重问;
 * get 也读不出就照旧缺着 —— 入口那边缺了就不当主绑定(entries.ts primaryOf)。E 把字段补进 status 以后这里不再发 get。
 */
let v2Meta: { at: number; ids: string; map: Map<string, { enabled: boolean; paused: boolean; role: 'primary' | 'backup' }> } | null = null
let v2MetaDirty = true
async function withBindingMeta(st: VaultSyncStatus): Promise<VaultSyncStatus> {
  if (!st.bindings.some((b) => b.enabled === undefined || b.role === undefined)) return st
  const ids = st.bindings.map((b) => b.id).sort().join(',')
  if (!v2Meta || v2Meta.ids !== ids || v2MetaDirty || Date.now() - v2Meta.at > 30_000) {
    v2MetaDirty = false
    const g = await vaultSync.get().catch(() => null)
    if (g?.ok && Array.isArray(g.value?.bindings)) v2Meta = { at: Date.now(), ids, map: new Map(g.value.bindings.map((b) => [b.id, { enabled: b.enabled, paused: b.paused, role: b.role }])) }
  }
  const meta = v2Meta
  if (!meta) return st
  return { ...st, bindings: st.bindings.map((b) => { const m = meta.map.get(b.id); return m ? { ...m, ...b } : b }) }
}

async function pollContent(): Promise<void> {
  const gen = ++pollGen
  if (contentTimer) { clearTimeout(contentTimer); contentTimer = null }
  const [c, v2] = await Promise.all([
    readContent().catch(() => useVaultSyncRaw.getState().content),
    readV2().catch(() => useVaultSyncRaw.getState().v2),
  ])
  if (gen !== pollGen || !hasWindow()) return // 期间又重排过:那一轮负责排下一次
  if (JSON.stringify(c) !== JSON.stringify(useVaultSyncRaw.getState().content)) set({ content: c })
  if (JSON.stringify(v2) !== JSON.stringify(useVaultSyncRaw.getState().v2)) set({ v2 })
  // 在跑时每秒一次(进度跟手),开着每 5 秒,没开 / 窗口不在前台放慢
  const hidden = typeof document !== 'undefined' && document.hidden
  const v2Busy = !!v2?.bindings.some((b) => b.status.phase === 'checking' || b.status.phase === 'transferring')
  const v2On = !!v2?.bindings.length
  const delay = c?.running || v2Busy ? 1000 : hidden ? 30_000 : (c?.enabled ?? c?.config?.enabled) || v2On ? 5000 : 20_000
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
      // 事件不带配置和库根:一轮跑完再取一次整份,换过去处 / 换过库时面板上说的去处跟着变
      if (prev.running && !s.running) void pullRemote()
    })
  } catch { /* 桥不全 */ }
  setInterval(() => set({ now: Date.now() }), 30_000)
  setInterval(() => { void pullVaults(); void pullRemote() }, 60_000)
  if (typeof window.addEventListener === 'function') window.addEventListener('focus', () => { void pullVaults(); void pollContent(); void pullRemote() })
}
