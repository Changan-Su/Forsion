/**
 * 同步总开关(2026-10-20 云同步开启方案 A + B 的卡片,docs/ToBeImproved/云同步开启方案_2026-10-20):
 * 三样东西各有各的引擎,这里把开关和状态收成一份,给首登卡片(SyncSetupCard)、引导「连接」那步,
 * 以及经 ctx.app.sync 给 Forsion Extend 的蓬洲云「同步」页用。
 *  - 笔记库 = 本地库远程同步(window.remoteSync)。开 = penzor 后端、库名 default、每 5 分钟 + 开机一次、双向;
 *    云端已经有这个库、这台又有和云端不一样的文件 → 先不开,挂「等你决定」(合并两边 / 用云端那份 / 这台先不同步)。
 *  - Agents 与记忆 = 引擎的账号级总闸(PUT /agent/sync/default),顺手写旧的 forsionSyncEnabled,设置页那条老路径一致。
 *  - 插件数据 = 本机所有插件一起关的 localStorage 键(PLUGIN_SYNC_ALL_OFF_KEY)。
 * 「点过了」按账号记在本机(decided):登录了但没点过的,主窗弹一次卡片;点「稍后」也算点过,左栏挂点不再弹。
 */
import { request } from './backendService'
import { homeTarget } from './engine/targets'
import { PLUGIN_SYNC_ALL_OFF_KEY } from '../amadeus/plugins/pluginDataSync'
import { usePluginStore, pluginWanted } from '../amadeus/plugins/pluginStore'
import type { AuthStatusInfo, RemoteSyncConfig, RemoteSyncReport } from '../types'
import { registerMessages } from '../i18n'
import { windowKind } from '../windowKind'

registerMessages({
  // 第二台电脑「用云端那份」时,这台不一样的文件挪去的库外文件夹:「<库名> 同步前备份 <日期>」
  'sync.backupFolder': { zh: '同步前备份', en: 'backup before sync' },
})

export type SyncKind = 'notes' | 'agents' | 'plugins'
export type NotesChoice = 'merge' | 'cloud' | 'skip'
export interface NotesPending { cloudFiles: number; cloudBytes: number; cloudDevice: string | null; localOnly: number; conflicts: number }
export interface SyncSnapshot {
  /** Informational unified quota; never gates sync choices. */
  storage?: { usedBytes: number | null; limitBytes: number; complete: boolean; asOf: string; enforcement?: boolean } | null
  signedIn: boolean
  decided: boolean
  notes: {
    on: boolean
    backend: RemoteSyncConfig['backend']
    vault: string | null
    rootName: string | null
    pending: NotesPending | null
    running: boolean
    progress: { done: number; total: number } | null
    last: { at: number; ok: boolean; pushed: number; pulled: number; conflicts: number; skippedLarge: number; errors: string[] } | null
    intervalMin: number
    syncOnStart: boolean
    direction: 'both' | 'push' | 'pull'
    localBytes: number | null
    /** 既有设备同步限制，T2 保留；统一额度在 storage，拿不到 = null。 */
    maxBytes: number | null
    /** 这台装了带 penzor 后端的 Forsion Extend(没有就开不了笔记库同步)。 */
    available: boolean
  }
  agents: { on: boolean; count: number }
  plugins: { on: boolean; count: number }
}
export interface SyncResult { ok: boolean; error?: string }

/** 笔记库「开」的样子(方案页第六节:每 5 分钟 + 开机一次,双向,库名 default 不出现在界面上)。 */
/** 蓬洲云 Space(Forsion Extend)与宿主的约定:Extend 在主窗口注册好 Space 后写 READY;宿主写 FOCUS(要看哪个库 / 哪一页),
 *  主窗口的 Extend 收 storage 事件切过去。两个键与 Extend src/renderer/penzor/state.ts 同步改。 */
export const PENZOR_SPACE_ID = 'forsion-penzor'
export const PENZOR_FOCUS = 'forsion-extend.penzor.focus'
export const penzorSyncReady = (): boolean => ls.get('forsion-extend.penzor.ready') === '1'
/** 打开蓬洲云「同步」页。storage 事件只发给别的窗口:主窗自己调(提醒里的「查看」、底部进度)时就地派一个,
 *  Extend 用同一个监听接住;设置窗调时走主窗动作把主窗切过去。 */
export function openPenzorSync(): void {
  const v = JSON.stringify({ page: 'sync', at: Date.now() })
  ls.set(PENZOR_FOCUS, v)
  if (windowKind() === 'main') window.dispatchEvent(new StorageEvent('storage', { key: PENZOR_FOCUS, newValue: v }))
  else window.tangu?.requestMainAction?.('open-space', PENZOR_SPACE_ID)
}

export const NOTES_ON: Partial<RemoteSyncConfig> = { backend: 'penzor', intervalMin: 5, syncOnStart: true, direction: 'both' }
const DEFAULT_VAULT = 'default'
const decidedKey = (acct: string) => `forsion.sync.decided.${acct}`
const pendingKey = (acct: string) => `forsion.sync.pending.${acct}`

let snap: SyncSnapshot | null = null
let account: string | null = null
let started = false
let loading: Promise<void> | null = null
let storageCache: { account: string; at: number; value: SyncSnapshot['storage'] } | null = null
async function readStorage(acct: string | null): Promise<SyncSnapshot['storage']> {
  if (!acct) { storageCache = null; return null }
  if (storageCache?.account === acct && Date.now() - storageCache.at < 60_000) return storageCache.value
  const r = await window.tangu?.cloudFetch?.({ path: '/storage/ledger' }).catch(() => null)
  const l = r?.status === 200 && r.json?.schemaVersion === 1 ? r.json : null
  const value = l ? { usedBytes: l.complete ? l.usage.usedBytes : null, limitBytes: l.quota.limitBytes, complete: l.complete, asOf: l.asOf, enforcement: l.enforcement === true } : null
  storageCache = { account: acct, at: Date.now(), value }
  return value
}
const listeners = new Set<() => void>()
const emit = (): void => { for (const cb of listeners) { try { cb() } catch { /* 一个订阅方坏了不拖别人 */ } } }

const ls = {
  get: (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null): void => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* 隐私模式:这次会话里记不住,最坏再弹一次卡片 */ } },
}

const toLast = (r: RemoteSyncReport | null): SyncSnapshot['notes']['last'] => r
  ? { at: r.finishedAt, ok: r.ok, pushed: r.pushed, pulled: r.pulled, conflicts: r.conflicts, skippedLarge: r.skippedLarge?.length ?? 0, errors: r.errors ?? [] }
  : null

async function readAgents(): Promise<SyncSnapshot['agents']> {
  try {
    const r = await request<{ enabled: boolean | null; agents: number }>(homeTarget(), '/agent/sync/default')
    return { on: r.enabled === true, count: r.agents ?? 0 }
  } catch { return { on: false, count: 0 } } // 老引擎没有这条路由 / 引擎没起:当关着
}

function readPlugins(): SyncSnapshot['plugins'] {
  const st = usePluginStore.getState()
  return { on: ls.get(PLUGIN_SYNC_ALL_OFF_KEY) !== '1', count: st.plugins.filter((p) => p.syncData && pluginWanted(p, st.disabledIds)).length }
}

async function load(): Promise<void> {
  const rs = window.remoteSync
  const auth: AuthStatusInfo | null = await window.tangu?.authStatus?.().catch(() => null) ?? null
  const signedIn = !!auth?.loggedIn
  account = signedIn ? (auth?.accountId ?? auth?.username ?? 'default') : null
  const [state, stats, agents, quota, storage] = await Promise.all([
    rs?.get().catch(() => null) ?? null,
    rs?.rootStats?.().catch(() => null) ?? null,
    signedIn ? readAgents() : Promise.resolve({ on: false, count: 0 }),
    signedIn ? window.tangu?.cloudFetch?.({ path: '/remotesync/vaults' }).catch(() => null) ?? null : null,
    readStorage(account),
  ])
  const cfg = state?.config
  let pending: NotesPending | null = null
  try { pending = account ? JSON.parse(ls.get(pendingKey(account)) || 'null') : null } catch { pending = null }
  snap = {
    storage,
    signedIn,
    decided: !!account && ls.get(decidedKey(account)) === '1',
    notes: {
      on: !!cfg && cfg.backend !== 'off',
      backend: cfg?.backend ?? 'off',
      // 关着 / 等你决定时也给「会用的那个」:同步页据此列出已经在往这个库同步的设备
      vault: cfg && (cfg.backend === 'penzor' || cfg.backend === 'off') ? (cfg.penzor?.vault || DEFAULT_VAULT) : null,
      rootName: stats && 'name' in stats ? stats.name : null,
      pending,
      running: !!state?.running,
      progress: state?.progress ? { done: state.progress.done, total: state.progress.total } : null,
      last: toLast(state?.lastReport ?? null),
      intervalMin: cfg?.intervalMin ?? 0,
      syncOnStart: !!cfg?.syncOnStart,
      direction: cfg?.direction ?? 'both',
      localBytes: stats && 'bytes' in stats ? stats.bytes : null,
      maxBytes: typeof quota?.json?.maxBytes === 'number' ? quota.json.maxBytes : null,
      available: !!state?.backends?.includes('penzor'),
    },
    agents,
    plugins: readPlugins(),
  }
  emit()
}

/** 重新读一遍;并发的调用合成一次。 */
export function refreshSync(): Promise<void> {
  loading ??= load().finally(() => { loading = null })
  return loading
}

/** 主窗口启动时调一次:订阅同步进度 / 登录变化;登录着且 Agents 开着就先同步一次记忆(旧提示说「打开应用时自动同步」,一直没接上)。 */
export function startSyncSetup(): void {
  if (started) return
  started = true
  window.remoteSync?.onStatus((st) => {
    if (!snap) return
    snap = { ...snap, notes: { ...snap.notes, running: st.running, progress: st.progress ? { done: st.progress.done, total: st.progress.total } : null, last: toLast(st.lastReport) ?? snap.notes.last } }
    emit()
  })
  window.tangu?.onAuthChanged?.(() => { void refreshSync() })
  usePluginStore.subscribe((s, prev) => { if (snap && (s.plugins !== prev.plugins || s.disabledIds !== prev.disabledIds)) { snap = { ...snap, plugins: readPlugins() }; emit() } })
  // 分离窗 / 浮窗里也有插件实例会来拿状态,只有主窗口(没有 ?window=)替用户发这一次同步
  const isMain = (() => { try { return !new URLSearchParams(location.search).get('window') } catch { return false } })()
  void refreshSync().then(() => {
    if (isMain && snap?.signedIn && snap.agents.on) void request(homeTarget(), '/agent/sync', { method: 'POST' }).catch(() => {})
  })
}

export const getSync = (): SyncSnapshot | null => snap
export function subscribeSync(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb) } }

function setPending(p: NotesPending | null): void {
  if (account) ls.set(pendingKey(account), p ? JSON.stringify(p) : null)
}

/** 云端设备同步里这个库的情况(Extend 主进程盖令牌;没有 cloudFetch = 没装 Extend,当云端没有)。 */
/** 云端这个库的概况;没有 / 空库 → null;查不到(断网、5xx)→ 抛错:不知道云端有没有,就不能当第一台电脑直接开。 */
async function cloudVault(vault: string): Promise<{ files: number; bytes: number; device: string | null } | null> {
  const r = await window.tangu?.cloudFetch?.({ path: '/remotesync/vaults' }).catch(() => null)
  if (!r || r.status !== 200) throw new Error('cloud-unreachable')
  const v = (r?.json?.vaults as Array<{ vault: string; files?: number; bytes?: number; device?: string | null }> | undefined)?.find((x) => x.vault === vault)
  return v && (v.files ?? 0) > 0 ? { files: v.files ?? 0, bytes: v.bytes ?? 0, device: v.device ?? null } : null
}

/** 这一串操作开始时的账号还是不是当前账号(who 不传 = 不查;引导 / 卡片那一串才传)。 */
async function sameAccount(who: string | null | undefined): Promise<boolean> {
  if (who === undefined) return true
  const a = await window.tangu?.authStatus?.().catch(() => null)
  return (a?.loggedIn ? (a.accountId ?? a.username ?? 'default') : null) === who
}

async function notesOn(who?: string | null): Promise<SyncResult> {
  const rs = window.remoteSync
  if (!rs) return { ok: false, error: 'unavailable' }
  const st = await rs.get()
  const cur = st.config
  if (cur.backend !== 'off') return { ok: true }
  if (!st.backends?.includes('penzor')) return { ok: false, error: 'penzor-unavailable' } // 没装 Forsion Extend
  const vault = cur.penzor?.vault || DEFAULT_VAULT
  // 先只配后端不排定时(intervalMin 0、不开机同步),演算一遍:云端有这个库、这台又有和它不一样的文件 → 先关回去、等用户定
  await rs.set({ backend: 'penzor', penzor: { vault }, intervalMin: 0, syncOnStart: false, direction: 'both' })
  try {
    const cloud = await cloudVault(vault)
    if (cloud) {
      const dry = await rs.run({ dryRun: true })
      const localOnly = dry.plan?.filter((i) => i.kind === 'push').length ?? 0
      // 两边都有:conflict,或新电脑上的 join(内容一样的 same 不算;后端没给 hash 判不出 → 当不一样,宁可多问一次)
      const conflicts = dry.plan?.filter((i) => i.kind === 'conflict' || (i.kind === 'join' && !i.same)).length ?? 0
      if (!dry.ok) { await rs.set({ backend: 'off' }); return { ok: false, error: dry.errors[0] } }
      if (!(await sameAccount(who))) { await rs.set({ backend: 'off' }); return { ok: false, error: 'account-changed' } }
      if (localOnly + conflicts > 0) {
        await rs.set({ backend: 'off' })
        setPending({ cloudFiles: cloud.files, cloudBytes: cloud.bytes, cloudDevice: cloud.device, localOnly, conflicts })
        return { ok: true }
      }
    }
  } catch (e) {
    await rs.set({ backend: 'off' })
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  // 等云端列表 / 演算时换了号:别用新账号的凭据把这台的智库传上去
  if (!(await sameAccount(who))) { await rs.set({ backend: 'off' }); return { ok: false, error: 'account-changed' } }
  await rs.set(NOTES_ON)
  void rs.run().catch(() => {})
  return { ok: true }
}

/** 第二台电脑那张卡上的三个按钮。backupLabel = 「同步前备份」按界面语言(落盘的文件夹名跟语言走)。 */
export async function resolveNotes(choice: NotesChoice, backupLabel: string): Promise<SyncResult> {
  const rs = window.remoteSync
  if (!rs) return { ok: false, error: 'unavailable' }
  try {
    if (choice === 'skip') { setPending(null); return { ok: true } }
    const vault = (await rs.get()).config.penzor?.vault || DEFAULT_VAULT
    await rs.set({ backend: 'penzor', penzor: { vault }, intervalMin: 0, syncOnStart: false, direction: 'both' })
    if (choice === 'cloud') {
      if (!rs.adoptRemote) { await rs.set({ backend: 'off' }); return { ok: false, error: 'unavailable' } }
      const r = await rs.adoptRemote(backupLabel)
      if (!r.ok) { await rs.set({ backend: 'off' }); return { ok: false, error: r.error } }
    }
    setPending(null)
    await rs.set(NOTES_ON)
    void rs.run().catch(() => {})
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e as Error)?.message || e) } }
  finally { await refreshSync() }
}

export async function setSync(kind: SyncKind, on: boolean, who?: string | null): Promise<SyncResult> {
  try {
    if (kind === 'plugins') { ls.set(PLUGIN_SYNC_ALL_OFF_KEY, on ? null : '1'); return { ok: true } }
    if (kind === 'agents') {
      await request(homeTarget(), '/agent/sync/default', { method: 'PUT', body: JSON.stringify({ enabled: on }) })
      const stored = await window.tangu?.getConfig?.().catch(() => null)
      await window.tangu?.setConfig?.({ forsionSyncEnabled: on, ...(stored?.forsionSyncAccountId ? { forsionSyncAccountId: stored.forsionSyncAccountId } : {}) }).catch(() => {})
      return { ok: true }
    }
    if (on) return await notesOn(who)
    setPending(null)
    await window.remoteSync?.set({ backend: 'off' })
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e as Error)?.message || e) } }
  finally { await refreshSync() }
}

/** 首登卡片 / 引导那一步:勾着的开、没勾的关(智库只关蓬洲云这一种,自己配的 WebDAV 等不动);不管成没成都记「点过了」。
 *  中途换了账号就停:剩下的步骤会落到另一个账号上。 */
export async function applySyncChoices(choices: Record<SyncKind, boolean>): Promise<SyncResult[]> {
  if (!snap) await refreshSync() // 引导收尾时可能还没读过:不读就不知道是哪个账号,「点过了」记不上
  const who = account
  const out: SyncResult[] = []
  for (const kind of ['agents', 'plugins', 'notes'] as const) {
    if (account !== who) { out.push({ ok: false, error: 'account-changed' }); return out }
    if (kind === 'notes' && !choices.notes && snap?.notes.backend !== 'penzor') continue
    out.push(await setSync(kind, choices[kind], who))
  }
  if (account === who) markSyncDecided()
  return out
}

/** 首登卡片要不要弹:登录着、没点过、这台能开智库同步、引导走完了;三样本来就都开着的不弹(调用方直接记成点过)。 */
export function wantsSyncCard(s: SyncSnapshot | null, onboardingDone: boolean): boolean {
  if (!s || !s.signedIn || s.decided || !s.notes.available || !onboardingDone) return false
  return !(s.notes.on && s.agents.on && s.plugins.on)
}

export function markSyncDecided(): void {
  if (account) ls.set(decidedKey(account), '1')
  if (snap) { snap = { ...snap, decided: true }; emit() }
}

export async function runSyncNow(): Promise<void> {
  if (snap?.notes.on) await window.remoteSync?.run().catch(() => null)
  if (snap?.agents.on) await request(homeTarget(), '/agent/sync', { method: 'POST' }).catch(() => null)
  await refreshSync()
}
