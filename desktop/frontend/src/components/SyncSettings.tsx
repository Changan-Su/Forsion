/**
 * 设置 › 同步(智库同步统一方案第 2 步 U 包;契约 §3.10,方案 V7 / V9b / 2B)。
 *   门控:`vaultsync:get` 回 full → 这一页;compat / 老 Extend(通道缺位)→ 今天的 UI 整页(调用方给的 legacy);
 *        Extend 停用 / 没加载 → 说明 + 启用按钮(用户 11-28 定:停用 Extend 同步也停),下面照旧画今天的 UI。
 *   完整模式:这台电脑 · 立即同步 → 智库(每库一行:同步到 / 范围 / 状态 / 开关,下面挂提示与等你定)→ 只在云端 →
 *            多久同步一次 → 再备份一份 → 同步记录 → 被换掉的那份 → 同步到网盘(原来的方式)→ Agents 与插件锁卡;
 *            打开同步 / 扩大范围时页底出汇总卡(3B 内容 + 2B 主按钮「开始同步，不一样的留较新的」)。
 * 数据与动作一律经 sync/v2/client.ts(两层回复:外层 {ok,value|error},内层软失败 {error})。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Cloud, Folder, Lock, RefreshCw } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { amadeus } from '@amadeus/api'
import type { LocalVaultRow } from '@amadeus-shared/ipc'
import { useI18n } from '../i18n'
import { ipcErrorText } from '../ipcError'
import { SettingsPage, type HostSettingsGroup } from './SettingsPage'
import { SettingsSwitch } from './SettingsPrimitives'
import { Mark } from '../sync/VaultSyncChip'
import { ensureVaultSyncSubscribed, refreshVaultSync, useVaultSync, useVaultSyncRaw } from '../sync/vaultSyncStore'
import { vaultSyncWords } from '../sync/vaultSyncText'
import { SyncRecordsDialogHost } from '../sync/SyncRecordList'
import { CHANNEL_MISSING, EXTEND_UNAVAILABLE, deviceName, vaultSync } from '../sync/v2/client'
import { modeFrom, setSyncMode } from '../sync/v2/mode'
import { K4_CODES, syncErrorText } from '../sync/v2/errors'
import { formatDate } from '../format/time'
import { addedItems, closureItems, isExcluded, mergeScope, rebaseScope, removeItem, scopeCovers, topLevelEntries } from '../sync/v2/scope'
import type { SyncFocus } from '../sync/v2/openSyncSettings'
import type { StatusBindingExtras } from '../sync/v2/feed'
import { PENZOR_SPACE_ID } from '../services/syncSetup'
import { CREATE_CANDIDATE, type RemoteDirHolder, type TakeoverHoldReason, type TakeoverView } from '../sync/v2/types'
import { useApp } from '../stores/appStore'
import { addFolderTarget, canAuth, cancelAuth, currentTargetKey, finishAuth, hasTargets, listTargets, onAuth, isUnsupportedKind, previewTargetOf, startAuth, targetErrorKey, targetIdentity, type AuthEvent, type AuthKind } from '../sync/v2/targets'
import type { SyncTargetSummary } from '../types'
import type {
  BindingScope, BindingView, Cadence, PreviewTarget, ResolveCandidate, ResolveNameResult, ScopeItem, VaultSyncCompatReason,
  VaultSyncGet, VaultSyncPreview,
} from '../sync/v2/types'
import { ExtendOffNotice, HandoverCard, HeldReview, RecordsBlock, RecoveryList, SummaryCard } from './SyncSettingsParts'
import './syncSettingsMessages'
import './syncSettings.css'

const folderName = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root
const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')
const lastSeg = (prefix: string): string => prefix.split('/').filter(Boolean).pop() ?? prefix
type TFn = (key: string, vars?: Record<string, unknown>) => string

/** 行上的原因(E 的 BindingReason)。网盘那一行有两条意思不同:server_unsupported = 宿主没有网盘后端,remote_same_root = 同一个库在同步到蓬洲云、这条先不跑(E-8);
 *  认不得的码不把键名露出来。 */
function reasonText(b: BindingView, t: TFn, data: VaultSyncGet): string {
  const code = b.status.reason!
  // 远端目录被别的库占着(E-17):写出是哪个库;停着的那条也占着
  // 云端这个库被删了(Extend #146):停着、本机文件都在;按能不能恢复、会不会自己接着跑分开说
  if (code === 'cloud_deleted') {
    const cd = b.status.cloudDeleted
    const k = !cd ? 'plain' : cd.purged ? 'purged' : cd.purging ? 'purging' : cd.reverted ? 'reverted' : cd.autoResume ? 'auto' : 'manual'
    const until = (k === 'auto' || k === 'manual') && cd?.purgeAt && Number.isFinite(Date.parse(cd.purgeAt))
      ? t('ssync.reason.cloud_deleted.until', { date: formatDate(cd.purgeAt) }) : ''
    return t(`ssync.reason.cloud_deleted.${k}`) + until
  }
  if (code === 'remote_dir_in_use') {
    const u = withHolder(data, b.status.inUseBy)
    if (u?.source === 'remotesync') return t('ssync.reason.remote_dir_in_use_legacy')
    if (u?.name && u.takeover) return t('ssync.reason.remote_dir_in_use_takeover', { name: u.name })
    return u?.name ? t('ssync.reason.remote_dir_in_use', { name: u.name }) : t('ssync.reason.remote_dir_in_use_anon')
  }
  const remote = b.target.kind === 'remote' && (code === 'server_unsupported' || code === 'remote_same_root')
  const key = remote ? `ssync.reason.remote.${code}` : `ssync.reason.${code}`
  const text = t(key)
  return text === key ? t('ssync.reason.unknown', { code }) : text
}

/** 占着的那条是不是接手旧同步时建的(state takeover):refused / reverted 留下的那条用户停不掉(点了回 takeover_in_progress,E-19 第 4 件),
 *  提示里不叫人去停它、也不给跳过去的按钮。 */
type HolderInfo = RemoteDirHolder & { takeover?: boolean; uncovered?: string[] | 'all' }
function withHolder(data: VaultSyncGet, u?: RemoteDirHolder, uncovered?: string[] | 'all'): HolderInfo | undefined {
  if (!u) return uncovered ? { bindingId: null, name: '', uncovered } : undefined
  return { ...u, takeover: !!u.bindingId && data.bindings.some((x) => x.id === u.bindingId && x.state === 'takeover'), ...(uncovered ? { uncovered } : {}) }
}
/** 「去『X』」只给用户在那一行能停掉的(不是原来的网盘同步、也不是接手建的那条)。 */
function canGoto(data: VaultSyncGet, u?: RemoteDirHolder): u is RemoteDirHolder & { bindingId: string } {
  return !!u?.bindingId && data.bindings.some((x) => x.id === u.bindingId && x.state !== 'takeover')
}

/** 接手旧网盘同步(D)撞上占用、旧同步封着不交还的那几种(H 的 fix/sync-takeover-d-hold)。 */
const D_HOLD = new Set(['remote_dir_in_use', 'remote_dir_nested', 'primary_exists'])
/** 接手账里已经归档(或绑定已建、被运行时挡住):改旧同步的配置没用,出口只有让占着的那条停止同步。 */
const D_ARCHIVED = new Set(['archived', 'sealed', 'round-running'])
function dHoldOf(data: VaultSyncGet, root: string): TakeoverView | undefined {
  return data.takeover.find((x) => x.root === root && x.source === 'remotesync' && !!x.reason && D_HOLD.has(x.reason))
}
function dHoldText(take: TakeoverView, archived: boolean, t: TFn, data: VaultSyncGet): string {
  const kind = take.reason === 'remote_dir_in_use' ? 'InUse' : take.reason === 'primary_exists' ? 'Primary' : 'Nested'
  const holder = take.inUseBy?.bindingId ? data.bindings.find((x) => x.id === take.inUseBy!.bindingId) : undefined
  const stage = archived ? 'archived' : 'held'
  // 占着的是接手旧同步时建的那条:停不掉,不叫人去停它(E-19 第 4 件)
  if (holder?.state === 'takeover' && kind !== 'Nested') return t(`ssync.dhold.${stage}${kind}Takeover`, { name: take.inUseBy?.name ?? '' })
  // primary_exists 的 inUseBy.name 是库名、不是去处(Codex 第四轮 P2-2):写那条绑定同步到哪,找不到那条就不带名字
  const name = kind === 'Primary' ? (holder ? targetNameOf(holder, t) : '') : take.inUseBy?.name
  return t(`ssync.dhold.${stage}${kind}${kind !== 'Nested' && !name ? 'Anon' : ''}`, { name: name ?? '' })
}
function targetNameOf(b: BindingView, t: TFn): string {
  return b.target.kind === 'remote' ? b.target.label || t('vsync.target.other') : t('ssync.target.penzor')
}

/** 跳到占着远端目录的那一行(E-17 的出口:要用这个目录,得先让那个库停止同步)。 */
function gotoBinding(data: VaultSyncGet, id: string | null): void {
  const root = data.bindings.find((x) => x.id === id)?.root
  const el = root ? document.querySelector<HTMLElement>(`[data-ssync-root="${CSS.escape(root)}"]`) : null
  el?.scrollIntoView({ block: 'center' })
  el?.querySelector<HTMLElement>('.ssync-target-btn, button')?.focus({ preventScroll: true })
}

/** 汇总卡上写明「本机这个库 → 云端哪一处」:标题是通用的,库名和去处要看得见(Codex P1-4)。 */
function destOf(p: Pending, data: VaultSyncGet, t: TFn): string {
  if (p.target.kind === 'remote') {
    const cur = p.bindingId ? data.bindings.find((x) => x.id === p.bindingId)?.target : undefined
    const same = cur?.kind === 'remote' && cur.targetId === p.target.targetId ? cur : undefined
    const label = p.targetLabel || same?.label || t('vsync.target.other')
    // 远端目录缺省 = 库文件夹名(引擎 pair.ts);写出来,两个同名库撞同一个目录时一眼看得见(E-17)
    const dir = p.target.dir ?? same?.dir ?? folderName(p.root)
    return dir ? t('ssync.dest.remote', { label, dir }) : label
  }
  const c = p.target.kind === 'penzor' ? p.target.candidate : undefined
  if (c?.kind === 'new') return t('ssync.dest.new', { name: p.name })
  if (c?.kind === 'own') return t('ssync.dest.own', { name: c.name })
  if (c?.kind === 'legacy') return t('ssync.dest.legacy', { name: c.name ?? lastSeg(c.prefix) })
  const tg = p.bindingId ? data.bindings.find((x) => x.id === p.bindingId)?.target : undefined
  if (tg?.kind === 'penzor') return tg.placement === 'own' ? t('ssync.dest.own', { name: tg.vaultName || p.name }) : t('ssync.dest.legacy', { name: lastSeg(tg.prefix) })
  if (tg?.kind === 'remote') return tg.label || t('vsync.target.other')
  return t('ssync.target.penzor')
}

type Gate =
  | { kind: 'loading' }
  | { kind: 'full'; data: VaultSyncGet }
  | { kind: 'compat'; reason?: VaultSyncCompatReason }
  | { kind: 'off' }
  | { kind: 'error'; error: string }

/** 门控:哪一种都不比今天少东西(compat / 老 Extend 原样给今天的 UI)。 */
/** legacy = 今天的整页(compat / 老 Extend / Extend 停用时画);drive = 完整模式下「同步到网盘（原来的方式）」卡里的那份。 */
export function SyncSettings({ focus, legacy, drive }: { focus?: SyncFocus; legacy: ReactNode; drive?: ReactNode }) {
  const { t, locale } = useI18n()
  const [gate, setGate] = useState<Gate>({ kind: 'loading' })
  const load = useCallback(async (): Promise<void> => {
    const r = await vaultSync.get(locale === 'zh' ? 'zh' : 'en')
    setSyncMode(modeFrom(r))
    if (r.ok && r.value) setGate(r.value.mode === 'full' ? { kind: 'full', data: r.value } : { kind: 'compat', reason: r.value.compatReason })
    else if (!r.ok && r.error === EXTEND_UNAVAILABLE) setGate({ kind: 'off' })
    else if (!r.ok && r.error === CHANNEL_MISSING) setGate({ kind: 'compat' })
    else setGate((g) => (g.kind === 'full' ? g : { kind: 'error', error: r.ok ? 'empty' : r.error }))
  }, [locale])
  useEffect(() => {
    void load()
    const onFocus = (): void => { void load() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  if (gate.kind === 'loading') return <SettingsPage host schema={{ state: { kind: 'loading', title: t('ssync.loading') } }} />
  if (gate.kind === 'error') {
    return <SettingsPage host schema={{ state: { kind: 'error', title: t('ssync.loadFailed'), desc: ipcErrorText(gate.error), action: { label: t('ssync.retry'), onClick: () => load() } } }} />
  }
  // Extend 停用 = 同步到蓬洲云的停了(11-28 用户定);下面原来方式的网盘同步是宿主自己的引擎(Extend 不握手时 H 会交还给它),
  // 停用时照样在跑,这里得能管它 —— 不做成只读
  // 用不带「开关在蓬洲云 › 同步」那句的那份(drive):Extend 停用时蓬洲云不在,那个按钮是死路(台架 probe-states off 截图看出来的)
  if (gate.kind === 'off') return <div className="ssync-page" data-ssync-mode="off"><ExtendOffNotice />{drive ?? legacy}</div>
  // 同步记录读不出来:引擎已经停下;这时不给旧界面的写入口(读失败 ≠ 空,Codex P1-7),只说清楚 + 重试
  if (gate.kind === 'compat' && gate.reason === 'state-unreadable') {
    return (
      <div className="ssync-page" data-ssync-mode="compat" data-compat-reason="state-unreadable">
        <div className="ssync-off" role="status">
          <b>{t('ssync.unreadable.title')}</b><p>{t('ssync.unreadable.desc')}</p>
          <div><button type="button" className="btn sm" onClick={() => void load()}>{t('ssync.retry')}</button></div>
        </div>
      </div>
    )
  }
  if (gate.kind === 'compat') {
    return <div className="ssync-page" data-ssync-mode="compat" data-compat-reason={gate.reason ?? 'channel-missing'}>{legacy}</div>
  }
  return <SyncSettingsFull data={gate.data} reload={load} focus={focus} legacy={drive ?? legacy} />
}

interface Pending {
  root: string
  name: string
  kind: 'cloud' | 'new' | 'scope' | 'target'
  bindingId?: string
  target: PreviewTarget
  /** 换到网盘 / 本地文件夹去处时,那个去处的名字(汇总卡写「→ X」) */
  targetLabel?: string
  scope: BindingScope
  added: ScopeItem[]
  preview: VaultSyncPreview | null
  candidates?: ResolveCandidate[]
  note?: string
  /** 预演那一刻引擎里这个绑定的范围与去处:过期重来时把「这次改了什么」套到引擎此刻的范围上(scope.ts rebaseScope) */
  base?: BindingScope
  baseTarget?: string
}

/** 跨种类换去处(蓬洲云 ↔ 网盘 / 文件夹,Extend #140、契约 E-16 附):卡上带着原来的去处身份,新去处的种类和它不同。 */
const isCrossKind = (p: Pick<Pending, 'bindingId' | 'baseTarget' | 'target'>): boolean =>
  !!p.bindingId && !!p.baseTarget && !p.baseTarget.startsWith(p.target.kind === 'remote' ? 'remote:' : 'penzor:')
/** 预演 / 换去处出错的人话。从蓬洲云那一行换走时没登录:apply 回 not_signed_in;预演回 binding_not_found(账号那本账看不到)——
 *  后者只在宿主确知没登录时才按「要先登录」说,绑定在别处停掉了 / 读失败不冒充成登录问题(Codex P1)。 */
const signedOut = (): boolean => useApp.getState().authInfo?.loggedIn === false
function crossKindError(p: Pick<Pending, 'bindingId' | 'baseTarget' | 'target' | 'name'>, err: string, t: TFn, inUseBy?: HolderInfo): string {
  const fromPenzor = isCrossKind(p) && p.baseTarget!.startsWith('penzor:')
  if (fromPenzor && (/not_signed_in\s*$/.test(err) || (/binding_not_found\s*$/.test(err) && signedOut()))) return t('ssync.err.moveSignIn')
  return syncErrorText(err, t, p.name, inUseBy)
}
/** 卡上记的那条绑定此刻对不上了:读失败照实说;没了 / 去处换了(别处刚换过)各说各的,不叫人新建网盘(Codex P2)。 */
function staleCardText(p: Pending, g: { ok: true; value: VaultSyncGet } | { ok: false; error: string }, fresh: BindingView | undefined, t: TFn): string {
  if (!g.ok) return syncErrorText(g.error, t, p.name)
  return fresh ? t('ssync.err.targetMoved') : crossKindError(p, 'binding_not_found', t)
}

/** 落点只认一次:设置层拿着同一个 focus 对象,子页切走再回来(组件重挂)不再重放一遍预演(Codex P2-4)。 */
const consumedFocus = new WeakSet<object>()

function SyncSettingsFull({ data, reload, focus, legacy }: { data: VaultSyncGet; reload: () => Promise<void>; focus?: SyncFocus; legacy: ReactNode }) {
  const { t } = useI18n()
  const [vaults, setVaults] = useState<LocalVaultRow[] | null>(null)
  const [device, setDevice] = useState<string | null>(null)
  const [names, setNames] = useState<Record<string, ResolveNameResult | { error: string }>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  // 范围清单按库根记:切库后旧库的清单不拿来用;读失败 = 不知道(failed),范围不许写(Codex P1-3)
  const [entries, setEntries] = useState<{ root: string; items: ScopeItem[] | null; failed?: boolean } | null>(null)
  const [driveOpen, setDriveOpen] = useState(false)
  const openDrive = useCallback((): void => {
    setDriveOpen(true)
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.ssync-drive')?.scrollIntoView({ block: 'start' })))
  }, [])
  const [recKey, setRecKey] = useState(0)
  const v2 = useVaultSyncRaw((s) => s.v2)
  // 网盘 / 本地文件夹去处(宿主 sync-targets);null = 列不出(旧主进程)
  const [targets, setTargets] = useState<SyncTargetSummary[] | null>(null)
  // 在途的网盘授权(H-9):只认这个 attempt 的结果事件
  const [auth, setAuth] = useState<AuthState | null>(null)
  const authRef = useRef<AuthState | null>(null)
  authRef.current = auth
  const sumRef = useRef<HTMLDivElement>(null)
  const reqRef = useRef(0) // 预演请求号:晚回来的旧回包不再替换当前的卡(Codex P1-4)
  // 回包到了再按此刻的绑定判占着的那条能不能停(useCallback 的闭包里那份 data 可能是旧的,Codex 第五轮 P1)
  const dataRef = useRef(data)
  dataRef.current = data

  useEffect(() => { ensureVaultSyncSubscribed(); if (!data.device?.name) void deviceName().then(setDevice) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const deviceLabel = data.device?.name || device
  useEffect(() => {
    let alive = true
    void (amadeus?.listVaults?.() ?? Promise.resolve(null)).then((rows: LocalVaultRow[] | null) => { if (alive) setVaults(rows ?? []) }).catch(() => { if (alive) setVaults([]) })
    return () => { alive = false }
  }, [data])

  const bindingOf = useCallback((root: string): BindingView | undefined =>
    data.bindings.find((b) => b.root === root && b.role === 'primary') ?? data.bindings.find((b) => b.root === root), [data])
  // 页面上的智库行:本机库清单(带 display / current)∪ 引擎认得的库;按引擎的 localVaults 排序
  const rows = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ root: string; name: string; display: string; current: boolean; exists: boolean }> = []
    for (const v of data.localVaults) {
      const row = vaults?.find((x) => x.root === v.root)
      seen.add(v.root)
      out.push({ root: v.root, name: v.name || folderName(v.root), display: row?.display ?? v.root, current: !!row?.current, exists: row ? row.exists : true })
    }
    for (const v of vaults ?? []) if (!seen.has(v.root)) { seen.add(v.root); out.push({ root: v.root, name: v.name, display: v.display, current: v.current, exists: v.exists }) }
    for (const b of data.bindings) if (!seen.has(b.root)) { seen.add(b.root); out.push({ root: b.root, name: b.name || folderName(b.root), display: b.root, current: false, exists: true }) }
    return out
  }, [data, vaults])

  // 没绑定的库先问一次云端同名(开关能不能开、汇总卡标题,都要它)
  useEffect(() => {
    for (const r of rows) {
      if (bindingOf(r.root) || names[r.root]) continue
      void vaultSync.resolveName(r.root).then((res) => setNames((m) => ({ ...m, [r.root]: res.ok && res.value ? res.value : { error: res.ok ? 'empty' : res.error } })))
    }
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // 当前库的顶层项(范围清单)
  const current = rows.find((r) => r.current)?.root ?? null
  useEffect(() => {
    if (!expanded || expanded !== current || !amadeus) return
    let alive = true
    const root = current
    setEntries((e) => (e?.root === root ? e : null))
    void Promise.all([amadeus.listPages(), amadeus.listFiles()])
      .then(([pages, files]) => { if (alive) setEntries({ root, items: topLevelEntries(pages, files) }) })
      .catch(() => { if (alive) setEntries({ root, items: null, failed: true }) })
    return () => { alive = false }
  }, [expanded, current])

  useEffect(() => {
    if (pending?.bindingId && !data.bindings.some((b) => b.id === pending.bindingId)) { ++reqRef.current; setPending(null) }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const say = (root: string, text: string | null): void => setMsg((m) => { const n = { ...m }; if (text) n[root] = text; else delete n[root]; return n })
  const loadTargets = useCallback(async (): Promise<void> => { setTargets(await listTargets()) }, [])
  useEffect(() => { void loadTargets() }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const runPreview = useCallback(async (p: Pending): Promise<boolean> => {
    const my = ++reqRef.current
    setPending({ ...p, preview: null, candidates: undefined })
    const r = await vaultSync.preview({ root: p.root, target: p.target, scope: p.scope, ...(p.bindingId ? { bindingId: p.bindingId } : {}) })
    if (my !== reqRef.current) return false // 期间又开了别的卡 / 取消了
    if (r.ok && r.value) { setPending({ ...p, preview: r.value, candidates: undefined }); return true }
    const err = r.ok ? 'empty' : r.error
    // 新建库时云端刚冒出同名的(别的设备刚建了 / 改名后当新库撞了名):重新按名字找候选,让人挑(E 不替人绑,契约 E-4 第 1 条);
    // 改名那条带着 bindingId,挑了候选 = 这个绑定换到那个同名库(Codex P2-5)
    if (p.kind === 'new' && /name_exists/.test(err)) {
      const res = await vaultSync.resolveName(p.root)
      if (my !== reqRef.current) return false
      if (res.ok && res.value?.candidates.length) {
        setNames((m) => ({ ...m, [p.root]: res.value! }))
        setPending({ ...p, kind: 'cloud', target: { kind: 'penzor' }, candidates: res.value.candidates, preview: null })
        return false
      }
    }
    setPending(null)
    say(p.root, crossKindError(p, err, t, r.ok ? undefined : withHolder(dataRef.current, r.inUseBy, r.uncovered)))
    return false
  }, [t])

  /** 打开同步(没有绑定的库):按名字找云端 → 一个候选直接比 / 几个候选让人挑 / 没有就新建(U-1 第 1 条)。 */
  const startOpen = useCallback(async (root: string, name: string, scope: BindingScope, added: ScopeItem[]): Promise<void> => {
    say(root, null)
    const my = ++reqRef.current // 同名查询也算一次请求:查询途中又开了别的卡,这次的结果不再顶掉它(Codex)
    let res = names[root]
    if (!res || 'error' in res && !('candidates' in res)) {
      const r = await vaultSync.resolveName(root)
      if (my !== reqRef.current) return
      res = r.ok && r.value ? r.value : { error: r.ok ? 'empty' : r.error }
      setNames((m) => ({ ...m, [root]: res! }))
    }
    if (!('candidates' in res)) { say(root, syncErrorText(res.error, t, name)); return }
    if (res.error) { say(root, syncErrorText(res.error, t, name)); return }
    const base = { root, name, scope, added, preview: null }
    if (res.candidates.length > 1) { setPending({ ...base, kind: 'cloud', target: { kind: 'penzor' }, candidates: res.candidates }); return }
    const c = res.candidates[0]
    // 云端没有同名的:按文件夹名新建(apply 时才建,契约 U-1 第 1 条)
    await runPreview(c ? { ...base, kind: 'cloud', target: { kind: 'penzor', candidate: c } } : { ...base, kind: 'new', target: { kind: 'penzor', candidate: CREATE_CANDIDATE } })
  }, [names, runPreview, t])

  /** 已有绑定扩大范围:预演新范围 → 汇总卡(kind scope)。 */
  const widen = useCallback(async (b: BindingView, next: BindingScope, added: ScopeItem[]): Promise<void> => {
    say(b.root, null)
    // 去处沿用这一行此刻的:网盘那一行按蓬洲云去预演 = 换了去处
    await runPreview({ root: b.root, name: b.name, kind: 'scope', bindingId: b.id, target: previewTargetOf(b), scope: next, added, preview: null, base: b.scope, baseTarget: targetIdentity(b.target) })
  }, [runPreview])

  /** 改范围:纯收缩直接 setScope;引擎说要预演(有新加的)就出汇总卡。 */
  const changeScope = useCallback(async (b: BindingView, next: BindingScope, added: ScopeItem[]): Promise<void> => {
    if (added.length || (next.mode === 'all' && b.scope.mode !== 'all')) { await widen(b, next, added); return }
    setBusy(true)
    const r = await vaultSync.setScope(b.id, next)
    setBusy(false)
    if (!r.ok && /preview_required/.test(r.error)) { await widen(b, next, added); return }
    say(b.root, r.ok ? null : syncErrorText(r.error, t, b.name))
    await reload()
  }, [reload, t, widen])

  /** 换「同步到哪」:蓬洲云先按名字找同名库(一个直接比 / 几个让人挑 / 没有就新建);网盘 / 本地文件夹按那条去处预演。都先出汇总卡,点了才换。 */
  const switchTarget = useCallback(async (b: BindingView, key: string, label?: string): Promise<boolean> => {
    say(b.root, null)
    if (key === currentTargetKey(b)) return false
    const base = { root: b.root, name: b.name, bindingId: b.id, scope: b.scope, added: [] as ScopeItem[], preview: null, base: b.scope, baseTarget: targetIdentity(b.target) }
    if (key !== 'penzor') return runPreview({ ...base, kind: 'target', target: { kind: 'remote', targetId: key }, targetLabel: label })
    // 换回蓬洲云:按名字认库。认到的同名库走「云端已经有一份」那张卡(带「这不是同一个库…」);没有就按新建走(撞名时能回到候选)
    const my = ++reqRef.current
    const r = await vaultSync.resolveName(b.root)
    if (my !== reqRef.current) return false
    const res = r.ok && r.value ? r.value : null
    if (!res || res.error) { say(b.root, syncErrorText(res?.error ?? (r.ok ? 'empty' : r.error), t, b.name)); return false }
    if (res.candidates.length > 1) { setPending({ ...base, kind: 'cloud', target: { kind: 'penzor' }, candidates: res.candidates }); return false }
    const c = res.candidates[0]
    return runPreview(c ? { ...base, kind: 'cloud', target: { kind: 'penzor', candidate: c } } : { ...base, kind: 'new', target: { kind: 'penzor', candidate: CREATE_CANDIDATE } })
  }, [runPreview, t])
  const switchRef = useRef(switchTarget)
  switchRef.current = switchTarget
  const bindingsRef = useRef(data.bindings)
  bindingsRef.current = data.bindings

  /** 加一个本地文件夹去处:宿主选文件夹、存进 sync-targets,再按它出汇总卡。 */
  const addFolder = useCallback(async (b: BindingView): Promise<void> => {
    const dir = await window.tangu?.pickDirectory?.().catch(() => null)
    if (!dir) return
    const r = await addFolderTarget(dir)
    if (!r.ok) { say(b.root, t(targetErrorKey(r.error))); return }
    await loadTargets()
    // 去处已经存上了:预演没出卡时说清楚,免得再选一次同一个文件夹建出第二条
    if (!(await switchTarget(b, r.target.id, r.target.label))) setMsg((m) => ({ ...m, [b.root]: [m[b.root], t(m[b.root] ? 'ssync.target.savedOnly' : 'ssync.target.saved', { label: r.target.label })].filter(Boolean).join(' ') }))
  }, [loadTargets, switchTarget, t])

  /** 连接 / 重新授权 Dropbox:宿主做完 OAuth,凭据直接进 sync-targets(H-9);这里只等结果事件。Google Drive 这一版不支持(H-10)。 */
  const authSeq = useRef(0)
  // 结果事件可能比 authStart 的回包先到(被顶掉时宿主马上发 auth-superseded):先记下,回包到了再认
  const early = useRef(new Map<string, AuthEvent>())
  const handleAuth = useRef<(ev: AuthEvent) => void>(() => {})
  const connect = useCallback(async (b: BindingView, kind: AuthKind, reauthId?: string): Promise<void> => {
    say(b.root, null)
    const seq = ++authSeq.current
    if (authRef.current) { cancelAuth(authRef.current.attempt); setAuth(null) }
    const r = await startAuth(kind, reauthId ? { id: reauthId } : undefined)
    // 回包回来之前用户又点了别的(另一行 / 另一个网盘):这次作废,不盖掉后来的那个
    if (seq !== authSeq.current) { if (r.ok) cancelAuth(r.attempt); return }
    if (!r.ok) { setAuth(null); say(b.root, t(targetErrorKey(r.error))); return }
    const st: AuthState = { root: b.root, bindingId: b.id, attempt: r.attempt, mode: r.mode, kind, reauth: !!reauthId }
    authRef.current = st
    setAuth(st)
    const ev = early.current.get(r.attempt)
    if (ev) { early.current.delete(r.attempt); handleAuth.current(ev) }
  }, [t])
  const stopAuth = useCallback((): void => { ++authSeq.current; const a = authRef.current; if (a) cancelAuth(a.attempt); authRef.current = null; setAuth(null) }, [])
  handleAuth.current = (ev: AuthEvent): void => {
    const a = authRef.current
    if (!a || ev.attempt !== a.attempt) {
      // 不是在等的那次:记下(可能回包还没到);成功的照样刷新去处清单(宿主已经存上了,菜单里要看得见),但不替哪一行换去处
      early.current.set(ev.attempt, ev)
      if (early.current.size > 8) early.current.delete(early.current.keys().next().value!)
      if (ev.ok) void loadTargets()
      return
    }
    authRef.current = null
    setAuth(null)
    if (!ev.ok) { if (ev.error !== 'auth-cancelled') say(a.root, t(targetErrorKey(ev.error))); return }
    void loadTargets()
    if (a.reauth) { say(a.root, t('ssync.auth.reauthed', { account: ev.account })); void reload(); return }
    const b = bindingsRef.current.find((x) => x.id === a.bindingId)
    if (b) void switchRef.current(b, ev.target.id, ev.target.label)
  }
  useEffect(() => onAuth((ev) => handleAuth.current(ev)), [])

  const apply = async (onDiffer: 'newer' | 'hold'): Promise<void> => {
    if (!pending?.preview) return
    setBusy(true)
    // 换去处:卡上带的是出卡那一刻的整份范围。点「开始同步」前再核一次引擎此刻的范围,变了(别处刚排除了什么)就按新的重比,
    // 不把刚排除的带到新去处(Codex P1)
    if (pending.bindingId && pending.base && pending.kind !== 'scope') {
      const g = await vaultSync.get()
      const fresh = g.ok ? g.value?.bindings.find((b) => b.id === pending.bindingId) : undefined
      if (!fresh || targetIdentity(fresh.target) !== pending.baseTarget) { setBusy(false); setPending(null); say(pending.root, staleCardText(pending, g, fresh, t)); await reload(); return }
      if (JSON.stringify(fresh.scope) !== JSON.stringify(pending.base)) { setBusy(false); await runPreview({ ...pending, scope: fresh.scope, base: fresh.scope, note: t('ssync.stale') }); return }
    }
    const r = await vaultSync.apply({ token: pending.preview.token, generation: pending.preview.generation, onDiffer })
    // 跨种类换去处在新那本账写入那一刻被准入拦下(E-16 附 K4):原来那条留在原来的去处、停着。只对准入码回读,回读完之前这一行还算忙
    // (不让人在旧回包落地前又点了别的,Codex P1-2);出卡时开着、现在同一个去处上停着 = 走到了这一步
    let k4 = false
    if (!r.ok && isCrossKind(pending) && K4_CODES.test(r.error) && data.bindings.find((x) => x.id === pending.bindingId)?.enabled) {
      const g = await vaultSync.get()
      const now = g.ok ? g.value?.bindings.find((x) => x.id === pending.bindingId) : undefined
      k4 = !!now && !now.enabled && targetIdentity(now.target) === pending.baseTarget
    }
    setBusy(false)
    if (!r.ok && /stale/.test(r.error)) {
      // 过期:改范围的卡按引擎此刻的绑定重算(别人期间去掉 / 加上的不被这张旧卡盖掉);去处变了 / 绑定没了 → 这张卡作废(Codex P1-1)
      if (pending.bindingId && pending.base) {
        const g = await vaultSync.get()
        const fresh = g.ok ? g.value?.bindings.find((b) => b.id === pending.bindingId) : undefined
        if (!fresh || targetIdentity(fresh.target) !== pending.baseTarget) { setPending(null); say(pending.root, staleCardText(pending, g, fresh, t)); await reload(); return }
        // 换去处的卡不改范围:直接用引擎此刻的范围重比(期间别处排除的不被带回来);改范围的卡把「这次改了什么」套上去
        const scope = pending.kind === 'scope' ? rebaseScope(pending.base, pending.scope, fresh.scope) : fresh.scope
        await runPreview({ ...pending, scope, added: addedItems(fresh.scope, scope), base: fresh.scope, note: t('ssync.stale') })
        return
      }
      await runPreview({ ...pending, note: t('ssync.stale') })
      return
    }
    const p = pending
    setPending(null)
    // 成功不另起一行提示:行里的状态就会变成「同步中…」,提示留着反倒在同步完以后还挂着
    if (r.ok) say(p.root, null)
    else {
      const text = crossKindError(p, r.error, t, withHolder(dataRef.current, r.inUseBy, r.uncovered))
      say(p.root, k4 ? `${text} ${t('ssync.err.moveHalf')}` : text)
    }
    refreshVaultSync()
    await reload()
  }

  // 从右键 / 首登卡片带来的落点:滚到那一行,算关联闭包、勾好,出汇总卡
  useEffect(() => {
    if (!focus?.root || !vaults || consumedFocus.has(focus)) return
    const row = rows.find((r) => r.root === focus.root)
    if (!row) return // 库行还没出来(清单在路上):等 rows 变了再来,先别记成处理过
    consumedFocus.add(focus)
    requestAnimationFrame(() => document.querySelector(`[data-ssync-root="${CSS.escape(focus.root!)}"]`)?.scrollIntoView({ block: 'center' }))
    const b = bindingOf(focus.root)
    void (async () => {
      if (!focus.path) {
        if (focus.intent === 'start' && !b) await startOpen(row.root, row.name, { mode: 'all' }, [])
        return
      }
      const kind = focus.kind ?? 'page'
      if (b && scopeCovers(b.scope, focus.path)) { say(row.root, t('ssync.scope.covered', { name: baseName(focus.path) })); return }
      const closure = row.current && kind !== 'file'
        ? await window.amadeusSync?.entrySyncClosure?.(focus.path, kind === 'folder' ? 'folder' : 'page').catch(() => null) ?? null
        : null
      const ex = b?.scope.mode === 'some' ? b.scope.exclude ?? [] : []
      const { items: all, exclude } = closureItems(focus.path, kind, closure, (p) => ex.includes(p))
      // 关联项里:已经被范围盖住的(比如整个 Work 文件夹已在同步)不再单列、不标「刚勾上」;
      // 用户排除过的不因为被链接到就跟着进来 —— 只有右键点的那一项本身能把排除解开(Codex P1-2)
      const items = b ? all.filter((it) => it.path === all[0]!.path || (!scopeCovers(b.scope, it.path) && !isExcluded(b.scope, it.path))) : all
      if (b) await widen(b, mergeScope(b.scope, items, exclude), items)
      else await startOpen(row.root, row.name, mergeScope(null, items, exclude), items)
    })()
  }, [focus, vaults, rows]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (pending) sumRef.current?.scrollIntoView({ block: 'nearest' }) }, [pending?.preview, pending?.candidates]) // eslint-disable-line react-hooks/exhaustive-deps

  const bound = new Set(data.bindings.filter((b) => b.target.kind === 'penzor').map((b) => (b.target as { vaultId: string }).vaultId))
  const cloudOnly = (data.cloudVaults ?? []).filter((v) => !bound.has(v.id) && !rows.some((r) => r.name === v.name))
  const cadenceValue = data.cadence.kind === 'manual' ? 'manual' : String(data.cadence.minutes)

  const groups: HostSettingsGroup[] = [
    {
      id: 'ssync-vaults', anchor: 'ssync-vaults', icon: <Cloud size={16} />, title: t('ssync.vaults'),
      desc: deviceLabel ? t('ssync.device', { name: deviceLabel }) : t('ssync.deviceUnknown'),
      headActions: (
        <button type="button" className="btn sm" disabled={!data.bindings.some((b) => b.enabled)} onClick={() => { void vaultSync.run().then(() => refreshVaultSync()) }}>
          <RefreshCw size={12} aria-hidden="true" /> {t('ssync.syncNow')}
        </button>
      ),
      items: rows.map((r) => ({
        type: 'block' as const, id: `vault:${r.root}`, node: (
          <VaultRow key={r.root} row={r} binding={bindingOf(r.root)} data={data} names={names[r.root]} message={msg[r.root]}
            busy={busy || pending?.root === r.root} expanded={expanded === r.root} entries={r.current && entries?.root === r.root ? entries : null}
            v2={v2?.bindings.find((x) => x.id === bindingOf(r.root)?.id) as StatusBindingExtras | undefined}
            onExpand={() => setExpanded((e) => (e === r.root ? null : r.root))}
            onToggle={async (on) => {
              const b = bindingOf(r.root)
              if (!on) {
                if (pending?.root === r.root) { ++reqRef.current; setPending(null) }
                if (b) { const res = await vaultSync.setEnabled(b.id, false); say(r.root, res.ok ? null : syncErrorText(res.error, t, r.name, withHolder(dataRef.current, res.inUseBy, res.uncovered))); refreshVaultSync(); await reload() }
                return
              }
              if (b) { const res = await vaultSync.setEnabled(b.id, true); say(r.root, res.ok ? null : syncErrorText(res.error, t, r.name, withHolder(dataRef.current, res.inUseBy, res.uncovered))); await reload(); return }
              await startOpen(r.root, r.name, { mode: 'all' }, [])
            }}
            onScope={(b, next, added) => void changeScope(b, next, added)}
            targets={targets}
            auth={auth?.root === r.root ? auth : null}
            onTarget={(b, key, label) => void switchTarget(b, key, label)}
            onAddFolder={(b) => void addFolder(b)}
            onConnect={(b, kind, id) => void connect(b, kind, id)}
            onAuthCancel={stopAuth}
            onOpenDrive={legacy ? openDrive : undefined}
            onReupload={(b) => void runPreview({ root: b.root, name: r.name, kind: 'new', bindingId: b.id, target: { kind: 'penzor', candidate: CREATE_CANDIDATE }, scope: b.scope, added: [], preview: null })}
            onAuthCode={async (code) => { const a = authRef.current; if (!a) return; const res = await finishAuth(a.attempt, code); if (!res.ok) say(a.root, t(targetErrorKey(res.error ?? 'auth-failed'))) }}
            onPair={(b) => void runPreview({ root: b.root, name: b.name, kind: 'cloud', bindingId: b.id, target: { kind: 'penzor' }, scope: b.scope, added: [], preview: null })}
            onNewVault={(b) => void (async () => {
              // 改名后「当成新库上云」:引擎回 next: preview → 按新文件夹名预演一个新库,汇总卡确认了才建、换过去(旧库原样留着)
              const res = await vaultSync.renameAnswer(b.id, 'newVault')
              if (!res.ok) { say(r.root, syncErrorText(res.error, t, r.name, withHolder(dataRef.current, res.inUseBy, res.uncovered))); return }
              await runPreview({ root: b.root, name: r.name, kind: 'new', bindingId: b.id, target: { kind: 'penzor', candidate: CREATE_CANDIDATE }, scope: b.scope, added: [], preview: null })
            })()}
            reload={reload} say={(text) => say(r.root, text)} onRecovery={() => setRecKey((k) => k + 1)} />
        ),
      })),
    },
    ...(cloudOnly.length ? [{
      id: 'ssync-cloud', anchor: 'ssync-cloud', title: t('ssync.cloudOnly'), desc: t('ssync.cloudOnlyHint'),
      items: [{ type: 'block' as const, id: 'cloud-only', node: (
        <div className="ssync-block">
          {cloudOnly.map((v) => (
            <div key={v.id} className="ssync-cloud-row">
              <Cloud size={14} aria-hidden="true" />
              <b>{v.kind === 'default' ? t('ssync.cloudNotes') : v.name}</b>
              <span className="ssync-faint">
                {v.deviceNames?.length ? t('ssync.cloudDevices', { names: v.deviceNames.join(t('ssync.listSep')) }) : v.devices ? t('ssync.cloudDeviceCount', { n: v.devices }) : t('ssync.cloudNoDevice')}
                {typeof v.files === 'number' ? ` · ${t('ssync.cloudFiles', { n: v.files })}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) }],
    }] : []),
    {
      id: 'ssync-cadence', anchor: 'ssync-cadence', title: t('ssync.cadence'),
      items: [{
        type: 'segmented', id: 'cadence', anchor: 'ssync-cadence-row', title: t('ssync.cadenceRow'),
        desc: data.cadence.kind === 'manual' ? t('ssync.cadenceManualDesc') : t('ssync.cadenceDesc'),
        value: cadenceValue,
        options: [
          { value: '5', label: t('ssync.cadence.5') }, { value: '10', label: t('ssync.cadence.10') },
          { value: '30', label: t('ssync.cadence.30') }, { value: 'manual', label: t('ssync.cadence.manual') },
        ],
        onChange: async (v: string) => {
          const c: Cadence = v === 'manual' ? { kind: 'manual' } : { kind: 'interval', minutes: Number(v) as 5 | 10 | 30 }
          await vaultSync.setCadence(c)
          await reload()
        },
      }],
    },
    {
      id: 'ssync-backup', anchor: 'ssync-backup', title: t('ssync.backup'), desc: t('ssync.backupDesc'),
      items: [{ type: 'button', id: 'backup-add', title: t('ssync.backupNone'), desc: t('ssync.backupLater'), disabled: true,
        buttons: [{ label: t('ssync.backupAdd'), disabled: true, onClick: () => {} }] }],
    },
    {
      id: 'ssync-records', anchor: 'ssync-records', title: t('ssync.records'),
      items: [{ type: 'block', id: 'records', node: <RecordsBlock /> }],
    },
    {
      id: 'ssync-recovery', anchor: 'ssync-recovery', title: t('ssync.recovery'),
      items: [{ type: 'block', id: 'recovery', node: <RecoveryList refreshKey={recKey + data.recoveryCount} /> }],
    },
    ...(legacy ? [{
      id: 'ssync-drive', anchor: 'ssync-drive', title: t('ssync.drive'), desc: t('ssync.driveDesc'),
      headActions: (
        <button type="button" className="btn ghost sm" aria-expanded={driveOpen} onClick={() => setDriveOpen((v) => !v)}>
          {driveOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} {driveOpen ? t('ssync.driveHide') : t('ssync.driveShow')}
        </button>
      ),
      items: driveOpen ? [{ type: 'block' as const, id: 'drive', node: <div className="ssync-drive">{legacy}</div> }] : [],
    }] : []),
    {
      id: 'ssync-sealed', anchor: 'ssync-sealed', title: t('ssync.sealed'), desc: t('ssync.sealedDesc'),
      items: [{ type: 'block', id: 'sealed', node: (
        <div className="ssync-block ssync-sealed" aria-disabled="true">
          <div className="ssync-sealed-row"><Lock size={13} aria-hidden="true" />{t('ssync.sealedAgents')}</div>
          <div className="ssync-sealed-row"><Lock size={13} aria-hidden="true" />{t('ssync.sealedPlugins')}</div>
        </div>
      ) }],
    },
  ]

  return (
    <div className="ssync-page" data-ssync-mode="full">
      <SettingsPage host schema={{ groups }} />
      {pending && (
        <div className="ssync-sum-dock" ref={sumRef}>
          {pending.note && <div className="ssync-faint ssync-sum-note" role="status">{pending.note}</div>}
          {pending.candidates ? (
            <section className="ssync-sum" data-ssync-summary="pick">
              <div className="ssync-sum-head"><Cloud size={15} aria-hidden="true" /><b>{t('ssync.pickCandidate')}</b></div>
              <div className="ssync-sum-list">
                {pending.candidates.map((c) => (
                  <button key={`${c.kind}:${c.vaultId}:${'prefix' in c ? c.prefix : ''}`} type="button" className="ssync-cand"
                    onClick={() => void runPreview({ ...pending, kind: 'cloud', target: { kind: 'penzor', candidate: c } })}>
                    {c.kind === 'own' ? t('ssync.cand.own', { name: c.name }) : t('ssync.cand.legacy', { name: c.name ?? c.prefix })}
                  </button>
                ))}
              </div>
              <div className="ssync-sum-acts"><span className="ssync-grow" /><button type="button" className="btn sm" onClick={() => { ++reqRef.current; setPending(null) }}>{t('ssync.sum.cancel')}</button></div>
            </section>
          ) : (
            <SummaryCard name={pending.name} preview={pending.preview} busy={busy} kind={pending.kind} added={pending.added} remote={pending.target.kind === 'remote'}
              dest={destOf(pending, data, t)} onApply={(d) => void apply(d)} onCancel={() => { ++reqRef.current; setPending(null) }} />
          )}
        </div>
      )}
      <SyncRecordsDialogHost />
    </div>
  )
}

/** 一个库一行:名字 / 位置 · 状态 · 同步到 · 范围 · 开关;下面挂提示、要你选的、等你定、接手卡。 */
interface AuthState { root: string; bindingId: string; attempt: string; mode: 'auto' | 'manual'; kind: AuthKind; reauth: boolean }

function VaultRow({ row, binding: b, data, names, message, busy, expanded, entries, v2, onExpand, onToggle, onScope, onPair, onNewVault, reload, say, onRecovery, targets, auth, onTarget, onAddFolder, onConnect, onAuthCancel, onAuthCode, onOpenDrive, onReupload }: {
  row: { root: string; name: string; display: string; current: boolean; exists: boolean }
  binding: BindingView | undefined
  data: VaultSyncGet
  names: ResolveNameResult | { error: string } | undefined
  message: string | undefined
  busy: boolean
  expanded: boolean
  entries: { items: ScopeItem[] | null; failed?: boolean } | null
  v2: StatusBindingExtras | undefined
  onExpand: () => void
  onToggle: (on: boolean) => Promise<void>
  onScope: (b: BindingView, next: BindingScope, added: ScopeItem[]) => void
  onPair: (b: BindingView) => void
  onNewVault: (b: BindingView) => void
  /** 云端库被删了:重新上传成新库(走预演 / 汇总卡换去处,Extend #146) */
  onReupload?: (b: BindingView) => void
  reload: () => Promise<void>
  say: (text: string | null) => void
  onRecovery: () => void
  targets: SyncTargetSummary[] | null
  auth: AuthState | null
  onTarget: (b: BindingView, key: string, label?: string) => void
  onAddFolder: (b: BindingView) => void
  onConnect: (b: BindingView, kind: AuthKind, reauthId?: string) => void
  onAuthCancel: () => void
  onAuthCode: (code: string) => Promise<void>
  /** 展开下面「同步到网盘（原来的方式）」那张卡并滚过去(D 封着时的出口:给旧同步换目录 / 去掉它) */
  onOpenDrive?: () => void
}) {
  const { t } = useI18n()
  const view = useVaultSync({ root: row.root, side: 'local' })
  const words = vaultSyncWords(view, view.now, t)
  const [toggling, setToggling] = useState(false)
  const on = !!b?.enabled
  // 没绑定、名字云端不收(保留名 / 非法 / 老服务端):开关灰掉,写明原因;云端没有同名的照样能开(新建库)
  const blocked = !b && names && 'candidates' in names && names.error ? syncErrorText(names.error, t, row.name) : null
  const take = data.takeover.find((x) => x.root === row.root)
  const dHold = dHoldOf(data, row.root)
  const dArchived = !!dHold && (!!b || D_ARCHIVED.has(dHold.phase))
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    const r = await fn()
    say(r.ok ? null : syncErrorText((r as { error: string }).error, t, row.name))
    await reload()
  }
  const scopeLabel = !b ? t('ssync.scope.all') : b.scope.mode === 'all' ? t('ssync.scope.all') : t('ssync.scope.some', { n: b.scope.items.length })
  const held = v2?.review?.differs?.map((d) => ({ path: d.path, newer: d.newer, ref: d.ref })) ?? null
  const heldCount = v2?.review?.differsTotal ?? b?.status.held ?? 0
  const deletes = v2?.review?.deletes ?? null

  return (
    <div className="ssync-vault" data-ssync-root={row.root} data-state={b?.state ?? 'none'} data-on={on || undefined}>
      <div className="ssync-vault-main">
        <Folder size={15} aria-hidden="true" className="ssync-vault-icon" />
        <div className="ssync-vault-id">
          <div className="ssync-vault-line">
            <b className="ssync-vault-name">{row.name}</b>
            <span className="ssync-faint ssync-vault-path" title={row.root}>{row.exists ? row.display : t('ssync.missing')}</span>
          </div>
          {/* 第二行照 V6:同步到 X ⌄ · 范围 ⌄ · 状态;没绑定的库只写「只在这台」(打开开关再走汇总卡) */}
          <div className="ssync-vault-line ssync-vault-meta">
            {b ? (
              <>
                <TargetPicker binding={b} targets={targets} disabled={busy || !!auth}
                  onPick={(key, label) => onTarget(b, key, label)} onAddFolder={() => onAddFolder(b)} onConnect={(kind, id) => onConnect(b, kind, id)} />
                <span className="ssync-dot" aria-hidden="true">·</span>
                <button type="button" className="ssync-scope-btn" aria-expanded={expanded} onClick={onExpand}>
                  {scopeLabel}<ChevronDown size={12} aria-hidden="true" />
                </button>
                {on && (
                  <>
                    <span className="ssync-dot" aria-hidden="true">·</span>
                    <span className={`ssync-vault-status tone-${words.tone}`} title={words.text}><Mark short={words.short} /><span>{words.text}</span></span>
                  </>
                )}
              </>
            ) : <span>{t('ssync.thisOnly')}</span>}
          </div>
        </div>
        <SettingsSwitch checked={on} disabled={busy || toggling || (!on && !!blocked) || !row.exists} label={t('ssync.switch', { name: row.name })}
          onChange={(next) => { setToggling(true); void onToggle(next).finally(() => setToggling(false)) }} />
      </div>
      {b?.target.kind === 'penzor' && b.target.placement === 'legacy-entry' && (
        <div className="ssync-note ssync-faint">{t('ssync.target.legacyPlace', { name: b.target.prefix.split('/').filter(Boolean).pop() ?? b.target.prefix })}</div>
      )}
      {b?.target.kind === 'remote' && !b.target.conditionalWrites && <div className="ssync-note ssync-faint">{t(b.target.backend === 'folder' ? 'ssync.target.noCasFolder' : 'ssync.target.noCas')}</div>}
      {blocked && !on && <div className="ssync-note ssync-faint">{blocked}</div>}
      {message && <div className="ssync-note" role="status">{message}</div>}
      {auth && <AuthPanel auth={auth} onCancel={onAuthCancel} onCode={onAuthCode} />}
      {dHold && (
        <div className="ssync-note ssync-warn" data-ssync-dhold={dHold.reason}>
          <span>{dHoldText(dHold, dArchived, t, data)}</span>
          {canGoto(data, dHold.inUseBy) && (
            <button type="button" className="btn ghost sm" data-ssync-goto={dHold.inUseBy.bindingId} onClick={() => gotoBinding(data, dHold.inUseBy!.bindingId)}>
              {t('ssync.reason.gotoHolder', { name: dHold.inUseBy.name })}
            </button>
          )}
          {!dArchived && onOpenDrive && <button type="button" className="btn ghost sm" data-ssync-open-old="" onClick={onOpenDrive}>{t('ssync.dhold.openOld')}</button>}
        </div>
      )}
      {b?.status.reason && !dHold && (
        <div className="ssync-note ssync-warn" data-ssync-reason={b.status.reason}>
          <span>{reasonText(b, t, data)}</span>
          {b.status.reason === 'remote_dir_in_use' && canGoto(data, b.status.inUseBy) && (
            <button type="button" className="btn ghost sm" data-ssync-goto={b.status.inUseBy.bindingId} onClick={() => gotoBinding(data, b.status.inUseBy!.bindingId)}>
              {t('ssync.reason.gotoHolder', { name: b.status.inUseBy.name })}
            </button>
          )}
          {b.status.reason === 'cloud_deleted' && (() => {
            // 已清理 / 在清理 / 分库撤销的 410 一直停着,恢复和「重试」都没用;撤销的文件回了原库,不给「重新上传」免得多一份
            const cd = b.status.cloudDeleted
            const restorable = !cd || (!cd.purged && !cd.purging && !cd.reverted)
            return (<>
              {restorable && (
                <button type="button" className="btn ghost sm" data-ssync-open-penzor="" onClick={() => window.tangu?.requestMainAction?.('open-space', PENZOR_SPACE_ID)}>{t('ssync.act.openPenzor')}</button>
              )}
              {/* 「重试」= setEnabled(true):引擎只刷新、不跑轮次,接着要 run 这一条(Extend #146) */}
              {restorable && (
                <button type="button" className="btn ghost sm" data-ssync-retry-deleted="" onClick={() => void (async () => {
                  const res = await vaultSync.setEnabled(b.id, true)
                  if (!res.ok) { say(syncErrorText(res.error, t, row.name, withHolder(data, res.inUseBy, res.uncovered))); return }
                  say(null)
                  await vaultSync.run(b.id)
                  refreshVaultSync()
                  await reload()
                })()}>{t('ssync.retry')}</button>
              )}
              {b.target.kind === 'penzor' && !cd?.reverted && onReupload && (
                <button type="button" className="btn ghost sm" data-ssync-reupload="" onClick={() => onReupload(b)}>{t('ssync.act.reupload')}</button>
              )}
            </>)
          })()}
        </div>
      )}
      {b?.status.overlapsLegacy && (
        <div className="ssync-note" data-ssync-overlaps-legacy="">
          {/* 和原来的网盘同步用着同一个去处(E-19):这条照跑,只提醒两边都会写 */}
          <span>{b.status.overlapsLegacy.name ? t('ssync.note.overlapsLegacy', { name: b.status.overlapsLegacy.name }) : t('ssync.note.overlapsLegacyAnon')}</span>
          {onOpenDrive && <button type="button" className="btn ghost sm" data-ssync-open-old="" onClick={onOpenDrive}>{t('ssync.dhold.openOld')}</button>}
        </div>
      )}
      {b?.state === 'takeover' && (
        <div className="ssync-note">
          <span>{t('ssync.note.takeover')}</span>
          {take && <button type="button" className="ssync-link" onClick={() => void (async () => {
            const r = await vaultSync.takeoverRevert(row.root, take.source)
            const code = r.ok ? '' : (/([a-z][a-z0-9_]+)\s*$/.exec(r.error)?.[1] ?? r.error)
            // 封着的 D 点退回会被拒,码就是 reason 本身(H):照「为什么封着、怎么解开」说
            say(r.ok ? null : take.source === 'remotesync' && D_HOLD.has(code) ? dHoldText({ ...take, reason: code as TakeoverHoldReason, inUseBy: r.inUseBy ?? (code === take.reason ? take.inUseBy : undefined) }, dArchived, t, data) : syncErrorText(r.error, t, row.name, withHolder(data, r.inUseBy, r.uncovered)))
            await reload()
          })()}>{t('ssync.act.revert')}</button>}
        </div>
      )}
      {b?.state === 'needs-choice' && (
        <div className="ssync-note ssync-ask">
          <span>{t('ssync.note.needsChoice')}</span>
          <div className="ssync-ask-acts">
            {(['primary', 'backup', 'off'] as const).map((c) => (
              <button key={c} type="button" className={`btn sm${c === 'primary' ? ' primary' : ''}`} onClick={() => void act(() => vaultSync.choose(b.id, c))}>{t(`ssync.act.${c}`)}</button>
            ))}
          </div>
        </div>
      )}
      {b?.state === 'needs-card' && (
        <div className="ssync-note ssync-ask">
          <span>{t('ssync.note.needsCard')}</span>
          <div className="ssync-ask-acts"><button type="button" className="btn primary sm" onClick={() => onPair(b)}>{t('ssync.act.pair')}</button></div>
        </div>
      )}
      {b?.state === 'needs-rename-answer' && (
        <div className="ssync-note ssync-ask">
          <span>{b.renamedFrom ? t('ssync.note.renamedFrom', { from: b.renamedFrom, to: row.name }) : t('ssync.note.renamed')}</span>
          <div className="ssync-ask-acts">
            {b.target.kind === 'penzor' && b.target.placement === 'own'
              ? <button type="button" className="btn primary sm" onClick={() => void act(() => vaultSync.renameAnswer(b.id, 'renameCloud'))}>{t('ssync.act.renameCloud')}</button>
              : <button type="button" className="btn sm" disabled title={t('ssync.act.renameCloudLegacy')}>{t('ssync.act.renameCloud')}</button>}
            <button type="button" className="btn sm" onClick={() => onNewVault(b)}>{t('ssync.act.newVault')}</button>
            <button type="button" className="btn sm" onClick={() => void act(() => vaultSync.renameAnswer(b.id, 'pause'))}>{t('ssync.act.pause')}</button>
          </div>
        </div>
      )}
      {b?.takeoverCard && (
        <HandoverCard bindingId={b.id} items={b.scope.mode === 'some' ? b.scope.items.length : 1} cadence={data.cadence} card={b.takeoverCard} remoteLabel={b.target.kind === 'remote' ? b.target.label : undefined} onDismissed={() => void reload()} />
      )}
      {b && on && heldCount > 0 && <HeldReview bindingId={b.id} count={heldCount} items={held} token={v2?.review?.differsToken} direction={b.target.kind === 'remote' ? b.target.direction : undefined} onDone={() => { onRecovery(); void reload() }} />}
      {b && on && (b.status.deletesPending > 0 || deletes) && (
        <div className="ssync-note ssync-ask">
          <span>{t('ssync.review.deletes', { n: deletes?.count ?? b.status.deletesPending })}</span>
          {/* 「照删」只在名单摆在眼前时给:看不到删哪一边、哪些文件就不放行整批(Codex P1-6);清单被截断时写还有多少 */}
          {!!deletes?.items?.length && (
            <div className="ssync-del-list" aria-label={t('ssync.review.deletesList')}>
              {deletes.items.slice(0, 20).map((d) => (
                <div key={`${d.side}:${d.path}`} className="ssync-del-row" title={d.path}>
                  <span className="ssync-del-side">{t(d.side === 'cloud' ? 'ssync.review.deletesCloud' : 'ssync.review.deletesLocal')}</span><span>{d.path}</span>
                </div>
              ))}
              {deletes.count > Math.min(20, deletes.items.length) && <div className="ssync-faint">{t('ssync.sum.more', { n: deletes.count - Math.min(20, deletes.items.length) })}</div>}
            </div>
          )}
          {deletes?.token && !!deletes.items?.length && (
            <div className="ssync-ask-acts">
              <button type="button" className="btn sm" onClick={() => void act(() => vaultSync.deletesAbandon(b.id, deletes.token))}>{t('ssync.review.deletesAbandon')}</button>
              <button type="button" className="btn danger sm" onClick={() => void act(() => vaultSync.deletesConfirm(b.id, deletes.token))}>{t('ssync.review.deletesConfirm')}</button>
            </div>
          )}
        </div>
      )}
      {expanded && b && <ScopeEditor binding={b} current={row.current} entries={entries} onScope={onScope} />}
    </div>
  )
}

/** 范围清单:整个库 / 选中的文件夹和笔记;只能挑当前打开的库(别的库要打开它再改)。 */
function ScopeEditor({ binding: b, current, entries, onScope }: {
  binding: BindingView; current: boolean; entries: { items: ScopeItem[] | null; failed?: boolean } | null
  onScope: (b: BindingView, next: BindingScope, added: ScopeItem[]) => void
}) {
  const { t } = useI18n()
  const [err, setErr] = useState<string | null>(null)
  // 清单读不出来 = 不知道库里有什么:按顶层项勾选 / 从整库收窄都不许(拿残缺清单写范围会漏掉没读到的,Codex P1-3)
  const list = entries?.items ?? null
  const failed = !!entries?.failed
  const some = b.scope.mode === 'some'
  const pickAll = (): void => { if (some) onScope(b, { mode: 'all' }, []) }
  const pickSome = (): void => { if (!some && list?.length) onScope(b, { mode: 'some', items: list }, []) }
  const toggle = (it: ScopeItem, checked: boolean): void => {
    setErr(null)
    if (checked) { onScope(b, mergeScope(b.scope, [it]), [it]); return }
    if (b.scope.mode === 'all') { if (!list) return; const rest = list.filter((e) => e.path !== it.path); if (rest.length) onScope(b, { mode: 'some', items: rest }, []); else setErr(t('ssync.scope.noneLeft')); return }
    const next = removeItem(b.scope, it.path)
    if (next) onScope(b, next, [])
    else setErr(t('ssync.scope.noneLeft'))
  }
  return (
    <div className="ssync-scope" role="group" aria-label={t('ssync.scope.someOpt')}>
      <div className="ssync-scope-modes">
        <label><input type="radio" checked={!some} onChange={pickAll} /> {t('ssync.scope.allOpt')}</label>
        <label><input type="radio" checked={some} disabled={!current || !list?.length} onChange={pickSome} /> {t('ssync.scope.someOpt')}</label>
      </div>
      {!current && <div className="ssync-faint ssync-note">{t('ssync.scope.otherVault')}</div>}
      {current && failed && <div className="ssync-error" role="alert">{t('ssync.scope.listFailed')}</div>}
      {current && list && (
        <div className="ssync-scope-list">
          {/* 右键加进来的那一项和它的关联项多半不在顶层:照样列出来、勾着(可以单独去掉) */}
          {b.scope.mode === 'some' && b.scope.items.filter((it) => !list.some((e) => e.path === it.path)).map((it) => (
            <label key={`x:${it.path}`} className="ssync-scope-item" title={it.path} data-scope-extra="">
              <input type="checkbox" checked onChange={() => toggle(it, false)} />
              <span>{it.kind === 'folder' ? it.path : it.path.replace(/\.md$/i, '')}</span>
            </label>
          ))}
          {list.map((it) => {
            const covered = !!scopeCovers(b.scope, it.path)
            return (
              <label key={it.path} className="ssync-scope-item" title={it.path}>
                <input type="checkbox" checked={covered} onChange={(e) => toggle(it, e.currentTarget.checked)} />
                <span>{it.kind === 'folder' ? it.path : baseName(it.path)}</span>
              </label>
            )
          })}
        </div>
      )}
      {b.scope.mode === 'some' && !current && (
        <div className="ssync-scope-list">
          {b.scope.items.map((it) => <div key={it.path} className="ssync-scope-item"><Check size={12} aria-hidden="true" /><span>{it.kind === 'folder' ? it.path : baseName(it.path)}</span></div>)}
        </div>
      )}
      {err && <div className="ssync-error" role="alert">{err}</div>}
    </div>
  )
}

const AUTH_LABEL: Record<AuthKind, string> = { dropbox: 'Dropbox' }
/** 去处种类的叫法:网盘是品牌名(不翻译),只有本地文件夹要按语言写。gdrive 只在列存档里已有的那条时用到(H-10)。 */
const KIND_BRAND: Partial<Record<SyncTargetSummary['kind'], string>> = { s3: 'S3', webdav: 'WebDAV', gdrive: 'Google Drive', ...AUTH_LABEL }
const kindLabel = (kind: SyncTargetSummary['kind'], t: TFn): string => KIND_BRAND[kind] ?? t('ssync.target.kind.folder')

/** 网盘授权在途:浏览器里登录、授权;Dropbox 回调口被占时(manual)把网页上的授权码贴回来(契约 H-9)。 */
function AuthPanel({ auth, onCancel, onCode }: { auth: AuthState; onCancel: () => void; onCode: (code: string) => Promise<void> }) {
  const { t } = useI18n()
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const service = AUTH_LABEL[auth.kind]
  return (
    <div className="ssync-note ssync-auth" role="status" data-ssync-auth={auth.mode}>
      <span>{t(auth.mode === 'manual' ? 'ssync.auth.manual' : 'ssync.auth.waiting', { service })}</span>
      {auth.mode === 'manual' && (
        <input className="ssync-auth-code" value={code} placeholder={t('ssync.auth.codePlaceholder')} aria-label={t('ssync.auth.codePlaceholder')}
          onChange={(e) => setCode(e.target.value)} disabled={sending} />
      )}
      <span className="ssync-grow" />
      {auth.mode === 'manual' && (
        <button type="button" className="btn primary sm" disabled={sending || !code.trim()}
          onClick={() => { setSending(true); void onCode(code.trim()).finally(() => setSending(false)) }}>{t('ssync.auth.submit')}</button>
      )}
      <button type="button" className="btn sm" onClick={onCancel}>{t('ssync.auth.cancel')}</button>
    </div>
  )
}

/** 同步到:蓬洲云 · 已有的网盘 / 本地文件夹去处 · 加一个本地文件夹 · 连接 Dropbox(宿主做授权,H-9)。
 *  Google Drive 这一版不支持(H-10):不给连接;存档里已有的 gdrive 去处照列,但点不了。
 *  换去处先出汇总卡(引擎状态按新去处从零开始,不删任何一边,契约 E-4 第 54 行)。旧主进程没有去处接缝:网盘项灰掉、写还用原来的方式。 */
function TargetPicker({ binding: b, targets, disabled, onPick, onAddFolder, onConnect }: {
  binding: BindingView
  targets: SyncTargetSummary[] | null
  disabled: boolean
  onPick: (key: string, label?: string) => void
  onAddFolder: () => void
  onConnect: (kind: AuthKind, reauthId?: string) => void
}) {
  const { t } = useI18n()
  const [at, setAt] = useState<{ x: number; y: number; top: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!at) return
    const off = (e: PointerEvent): void => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setAt(null) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setAt(null) }
    document.addEventListener('pointerdown', off, true)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', esc) }
  }, [at])
  const cur = currentTargetKey(b)
  const label = b.target.kind === 'remote' ? b.target.label : t('ssync.target.penzor')
  const pick = (fn: () => void) => () => { setAt(null); fn() }
  const host = hasTargets()
  const auth = canAuth()
  const reauth = b.target.kind === 'remote' && b.target.backend === 'dropbox' && auth ? b.target : null
  const Radio = ({ on }: { on: boolean }) => <Check size={14} aria-hidden="true" style={{ visibility: on ? 'visible' : 'hidden' }} />
  return (
    <>
      <button ref={btn} type="button" className="ssync-target-btn" aria-haspopup="menu" aria-expanded={!!at} title={t('ssync.syncTo')} disabled={disabled}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setAt((v) => (v ? null : { x: r.left, y: r.bottom + 4, top: r.top })) }}>
        <span className="ssync-faint">{t('ssync.syncTo')}</span> <b>{label}</b> <ChevronDown size={12} aria-hidden="true" />
      </button>
      {at && (
        <OverlayAt className="ctx-menu ssync-target-menu" role="menu" x={at.x} y={at.y} anchorTop={at.top} innerRef={(el: HTMLDivElement | null) => { menu.current = el }}>
          <button type="button" role="menuitemradio" aria-checked={cur === 'penzor'} data-ssync-target="penzor" onClick={pick(() => onPick('penzor'))}>
            <Radio on={cur === 'penzor'} />
            <span className="ssync-target-opt"><span>{t('ssync.target.penzor')}</span><span className="ssync-faint">{t('ssync.target.penzorHint')}</span></span>
          </button>
          {(targets ?? []).map((x) => {
            const off = isUnsupportedKind(x.kind)
            return (
              <button key={x.id} type="button" role="menuitemradio" aria-checked={cur === x.id} data-ssync-target={x.id} disabled={off} aria-disabled={off || undefined}
                onClick={off ? undefined : pick(() => onPick(x.id, x.label))}>
                <Radio on={cur === x.id} />
                <span className="ssync-target-opt"><span>{x.label}</span><span className="ssync-faint" title={x.dirDefault}>{off ? t('ssync.target.unsupportedKind', { service: kindLabel(x.kind, t) }) : kindLabel(x.kind, t)}</span></span>
              </button>
            )
          })}
          {host && targets === null && (
            <button type="button" role="menuitem" disabled aria-disabled="true"><Radio on={false} /><span className="ssync-target-opt"><span className="ssync-faint">{t('ssync.target.listFailed')}</span></span></button>
          )}
          <div className="ctx-separator" role="separator" />
          {host ? (
            <>
              <button type="button" role="menuitem" data-ssync-target-add="folder" onClick={pick(onAddFolder)}>
                <Radio on={false} /><span className="ssync-target-opt"><span>{t('ssync.target.addFolder')}</span></span>
              </button>
              {auth && (['dropbox'] as const).map((k) => (
                <button key={k} type="button" role="menuitem" data-ssync-target-add={k} onClick={pick(() => onConnect(k))}>
                  <Radio on={false} /><span className="ssync-target-opt"><span>{t('ssync.target.connect', { service: AUTH_LABEL[k] })}</span></span>
                </button>
              ))}
              {reauth && (
                <button type="button" role="menuitem" data-ssync-target-reauth="" onClick={pick(() => onConnect(reauth.backend as AuthKind, reauth.targetId))}>
                  <Radio on={false} /><span className="ssync-target-opt"><span>{t('ssync.target.reauth', { name: reauth.label })}</span></span>
                </button>
              )}
            </>
          ) : (
            <button type="button" role="menuitem" disabled aria-disabled="true" title={t('ssync.target.driveLater')}>
              <Radio on={false} />
              <span className="ssync-target-opt"><span>{t('ssync.target.addDrive')}</span><span className="ssync-faint">{t('ssync.target.driveLater')}</span></span>
            </button>
          )}
        </OverlayAt>
      )}
    </>
  )
}
