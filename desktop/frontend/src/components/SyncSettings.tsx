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
import { Check, ChevronDown, ChevronRight, Cloud, Lock, RefreshCw } from 'lucide-react'
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
import { syncErrorText } from '../sync/v2/errors'
import { closureItems, mergeScope, removeItem, scopeCovers, topLevelEntries } from '../sync/v2/scope'
import type { SyncFocus } from '../sync/v2/openSyncSettings'
import type { StatusBindingExtras } from '../sync/v2/feed'
import type {
  BindingScope, BindingView, Cadence, PreviewTarget, ResolveCandidate, ResolveNameResult, ScopeItem, VaultSyncCompatReason,
  VaultSyncGet, VaultSyncPreview,
} from '../sync/v2/types'
import { ExtendOffNotice, HandoverCard, HeldReview, RecordsBlock, RecoveryList, SummaryCard } from './SyncSettingsParts'
import './syncSettingsMessages'
import './syncSettings.css'

const folderName = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root
const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

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
  if (gate.kind === 'off') return <div className="ssync-page" data-ssync-mode="off"><ExtendOffNotice />{legacy}</div>
  if (gate.kind === 'compat') {
    return (
      <div className="ssync-page" data-ssync-mode="compat" data-compat-reason={gate.reason ?? 'channel-missing'}>
        {gate.reason === 'state-unreadable' && (
          <div className="ssync-off" role="status"><b>{t('ssync.unreadable.title')}</b><p>{t('ssync.unreadable.desc')}</p></div>
        )}
        {legacy}
      </div>
    )
  }
  return <SyncSettingsFull data={gate.data} reload={load} focus={focus} legacy={drive ?? legacy} />
}

interface Pending {
  root: string
  name: string
  kind: 'cloud' | 'new' | 'scope'
  bindingId?: string
  target: PreviewTarget
  scope: BindingScope
  added: ScopeItem[]
  preview: VaultSyncPreview | null
  candidates?: ResolveCandidate[]
  note?: string
}

function SyncSettingsFull({ data, reload, focus, legacy }: { data: VaultSyncGet; reload: () => Promise<void>; focus?: SyncFocus; legacy: ReactNode }) {
  const { t } = useI18n()
  const [vaults, setVaults] = useState<LocalVaultRow[] | null>(null)
  const [device, setDevice] = useState<string | null>(null)
  const [names, setNames] = useState<Record<string, ResolveNameResult | { error: string }>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [entries, setEntries] = useState<ScopeItem[] | null>(null)
  const [driveOpen, setDriveOpen] = useState(false)
  const [recKey, setRecKey] = useState(0)
  const [handled, setHandled] = useState<string | null>(null)
  const v2 = useVaultSyncRaw((s) => s.v2)
  const sumRef = useRef<HTMLDivElement>(null)

  useEffect(() => { ensureVaultSyncSubscribed(); void deviceName().then(setDevice) }, [])
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
    void Promise.all([amadeus.listPages().catch(() => []), amadeus.listFiles().catch(() => [])])
      .then(([pages, files]) => { if (alive) setEntries(topLevelEntries(pages, files)) })
    return () => { alive = false }
  }, [expanded, current])

  const say = (root: string, text: string | null): void => setMsg((m) => { const n = { ...m }; if (text) n[root] = text; else delete n[root]; return n })

  const runPreview = useCallback(async (p: Pending): Promise<void> => {
    setPending({ ...p, preview: null, candidates: undefined })
    const r = await vaultSync.preview({ root: p.root, target: p.target, scope: p.scope, ...(p.bindingId ? { bindingId: p.bindingId } : {}) })
    if (r.ok && r.value) { setPending({ ...p, preview: r.value, candidates: undefined }); return }
    setPending(null)
    const err = r.ok ? 'empty' : r.error
    say(p.root, syncErrorText(err, t, p.name))
  }, [t])

  /** 打开同步(没有绑定的库):按名字找云端 → 一个候选直接比 / 几个候选让人挑 / 没有就新建(U-1 第 1 条)。 */
  const startOpen = useCallback(async (root: string, name: string, scope: BindingScope, added: ScopeItem[]): Promise<void> => {
    say(root, null)
    let res = names[root]
    if (!res || 'error' in res && !('candidates' in res)) {
      const r = await vaultSync.resolveName(root)
      res = r.ok && r.value ? r.value : { error: r.ok ? 'empty' : r.error }
      setNames((m) => ({ ...m, [root]: res! }))
    }
    if (!('candidates' in res)) { say(root, syncErrorText(res.error, t, name)); return }
    if (res.error) { say(root, syncErrorText(res.error, t, name)); return }
    const base = { root, name, scope, added, preview: null }
    if (res.candidates.length > 1) { setPending({ ...base, kind: 'cloud', target: { kind: 'penzor' }, candidates: res.candidates }); return }
    const c = res.candidates[0]
    // 云端没有同名的:按文件夹名新建(apply 时才建,契约 U-1 第 1 条)
    await runPreview(c ? { ...base, kind: 'cloud', target: { kind: 'penzor', candidate: c } } : { ...base, kind: 'new', target: { kind: 'penzor', candidate: { kind: 'create' } } })
  }, [names, runPreview, t])

  /** 已有绑定扩大范围:预演新范围 → 汇总卡(kind scope)。 */
  const widen = useCallback(async (b: BindingView, next: BindingScope, added: ScopeItem[]): Promise<void> => {
    say(b.root, null)
    await runPreview({ root: b.root, name: b.name, kind: 'scope', bindingId: b.id, target: { kind: 'penzor' }, scope: next, added, preview: null })
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

  const apply = async (onDiffer: 'newer' | 'hold'): Promise<void> => {
    if (!pending?.preview) return
    setBusy(true)
    const r = await vaultSync.apply({ token: pending.preview.token, generation: pending.preview.generation, onDiffer })
    setBusy(false)
    if (!r.ok && /stale/.test(r.error)) { await runPreview({ ...pending, note: t('ssync.stale') }); return }
    const p = pending
    setPending(null)
    say(p.root, r.ok ? t('ssync.started', { name: p.name }) : syncErrorText(r.error, t, p.name))
    refreshVaultSync()
    await reload()
  }

  // 从右键 / 首登卡片带来的落点:滚到那一行,算关联闭包、勾好,出汇总卡
  useEffect(() => {
    if (!focus?.root || !vaults) return
    const key = JSON.stringify(focus)
    if (handled === key) return
    setHandled(key)
    const row = rows.find((r) => r.root === focus.root)
    requestAnimationFrame(() => document.querySelector(`[data-ssync-root="${CSS.escape(focus.root!)}"]`)?.scrollIntoView({ block: 'center' }))
    if (!row) return
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
      const { items, exclude } = closureItems(focus.path, kind, closure, (p) => ex.includes(p))
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
      desc: device ? t('ssync.device', { name: device }) : t('ssync.deviceUnknown'),
      headActions: (
        <button type="button" className="btn sm" disabled={!data.bindings.some((b) => b.enabled)} onClick={() => { void vaultSync.run().then(() => refreshVaultSync()) }}>
          <RefreshCw size={12} aria-hidden="true" /> {t('ssync.syncNow')}
        </button>
      ),
      items: rows.map((r) => ({
        type: 'block' as const, id: `vault:${r.root}`, node: (
          <VaultRow key={r.root} row={r} binding={bindingOf(r.root)} data={data} names={names[r.root]} message={msg[r.root]}
            busy={busy || pending?.root === r.root} expanded={expanded === r.root} entries={r.current ? entries : null}
            v2={v2?.bindings.find((x) => x.id === bindingOf(r.root)?.id) as StatusBindingExtras | undefined}
            onExpand={() => setExpanded((e) => (e === r.root ? null : r.root))}
            onToggle={async (on) => {
              const b = bindingOf(r.root)
              if (!on) { if (pending?.root === r.root) setPending(null); if (b) { await vaultSync.setEnabled(b.id, false); await reload() } return }
              if (b) { const res = await vaultSync.setEnabled(b.id, true); say(r.root, res.ok ? null : syncErrorText(res.error, t, r.name)); await reload(); return }
              await startOpen(r.root, r.name, { mode: 'all' }, [])
            }}
            onScope={(b, next, added) => void changeScope(b, next, added)}
            onPair={(b) => void runPreview({ root: b.root, name: b.name, kind: 'cloud', bindingId: b.id, target: { kind: 'penzor' }, scope: b.scope, added: [], preview: null })}
            onNewVault={(b) => void (async () => {
              // 改名后「当成新库上云」:引擎回 next: preview → 按新文件夹名预演一个新库,汇总卡确认了才建、换过去(旧库原样留着)
              const res = await vaultSync.renameAnswer(b.id, 'newVault')
              if (!res.ok) { say(r.root, syncErrorText(res.error, t, r.name)); return }
              await runPreview({ root: b.root, name: r.name, kind: 'new', bindingId: b.id, target: { kind: 'penzor', candidate: { kind: 'create' } }, scope: b.scope, added: [], preview: null })
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
              <div className="ssync-sum-acts"><span className="ssync-grow" /><button type="button" className="btn sm" onClick={() => setPending(null)}>{t('ssync.sum.cancel')}</button></div>
            </section>
          ) : (
            <SummaryCard name={pending.name} preview={pending.preview} busy={busy} kind={pending.kind} added={pending.added}
              onApply={(d) => void apply(d)} onCancel={() => setPending(null)} />
          )}
        </div>
      )}
      <SyncRecordsDialogHost />
    </div>
  )
}

/** 一个库一行:名字 / 位置 · 状态 · 同步到 · 范围 · 开关;下面挂提示、要你选的、等你定、接手卡。 */
function VaultRow({ row, binding: b, data, names, message, busy, expanded, entries, v2, onExpand, onToggle, onScope, onPair, onNewVault, reload, say, onRecovery }: {
  row: { root: string; name: string; display: string; current: boolean; exists: boolean }
  binding: BindingView | undefined
  data: VaultSyncGet
  names: ResolveNameResult | { error: string } | undefined
  message: string | undefined
  busy: boolean
  expanded: boolean
  entries: ScopeItem[] | null
  v2: StatusBindingExtras | undefined
  onExpand: () => void
  onToggle: (on: boolean) => Promise<void>
  onScope: (b: BindingView, next: BindingScope, added: ScopeItem[]) => void
  onPair: (b: BindingView) => void
  onNewVault: (b: BindingView) => void
  reload: () => Promise<void>
  say: (text: string | null) => void
  onRecovery: () => void
}) {
  const { t } = useI18n()
  const view = useVaultSync({ root: row.root, side: 'local' })
  const words = vaultSyncWords(view, view.now, t)
  const [toggling, setToggling] = useState(false)
  const on = !!b?.enabled
  // 没绑定、名字云端不收(保留名 / 非法 / 老服务端):开关灰掉,写明原因;云端没有同名的照样能开(新建库)
  const blocked = !b && names && 'candidates' in names && names.error ? syncErrorText(names.error, t, row.name) : null
  const take = data.takeover.find((x) => x.root === row.root)
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
        <div className="ssync-vault-id">
          <b className="ssync-vault-name">{row.name}</b>
          <span className="ssync-faint ssync-vault-path" title={row.root}>{row.exists ? row.display : t('ssync.missing')}</span>
        </div>
        {b && on && (
          <span className={`ssync-vault-status tone-${words.tone}`} title={words.text}><Mark short={words.short} /><span>{words.text}</span></span>
        )}
        <TargetPicker binding={b} />
        <button type="button" className="ssync-scope-btn" aria-expanded={expanded} disabled={!b} onClick={onExpand}>
          {scopeLabel}{b && <ChevronDown size={12} aria-hidden="true" />}
        </button>
        <SettingsSwitch checked={on} disabled={busy || toggling || (!on && !!blocked) || !row.exists} label={t('ssync.switch', { name: row.name })}
          onChange={(next) => { setToggling(true); void onToggle(next).finally(() => setToggling(false)) }} />
      </div>
      {b?.target.kind === 'penzor' && b.target.placement === 'legacy-entry' && (
        <div className="ssync-note ssync-faint">{t('ssync.target.legacyPlace', { name: b.target.prefix.split('/').filter(Boolean).pop() ?? b.target.prefix })}</div>
      )}
      {b?.target.kind === 'remote' && !b.target.conditionalWrites && <div className="ssync-note ssync-faint">{t('ssync.target.noCas')}</div>}
      {blocked && !on && <div className="ssync-note ssync-faint">{blocked}</div>}
      {message && <div className="ssync-note" role="status">{message}</div>}
      {b?.status.reason && <div className="ssync-note ssync-warn">{t(`ssync.reason.${b.status.reason}`)}</div>}
      {b?.state === 'takeover' && (
        <div className="ssync-note">
          <span>{t('ssync.note.takeover')}</span>
          {take && <button type="button" className="ssync-link" onClick={() => void act(() => vaultSync.takeoverRevert(row.root, take.source))}>{t('ssync.act.revert')}</button>}
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
        <HandoverCard bindingId={b.id} items={b.scope.mode === 'some' ? b.scope.items.length : 1} cadence={data.cadence} card={b.takeoverCard} onDismissed={() => void reload()} />
      )}
      {b && on && heldCount > 0 && <HeldReview bindingId={b.id} count={heldCount} items={held} onDone={() => { onRecovery(); void reload() }} />}
      {b && on && (b.status.deletesPending > 0 || deletes) && (
        <div className="ssync-note ssync-ask">
          <span>{t('ssync.review.deletes', { n: deletes?.count ?? b.status.deletesPending })}</span>
          {deletes?.token && (
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
  binding: BindingView; current: boolean; entries: ScopeItem[] | null
  onScope: (b: BindingView, next: BindingScope, added: ScopeItem[]) => void
}) {
  const { t } = useI18n()
  const [err, setErr] = useState<string | null>(null)
  const some = b.scope.mode === 'some'
  const pickAll = (): void => { if (some) onScope(b, { mode: 'all' }, []) }
  const pickSome = (): void => { if (!some && entries?.length) onScope(b, { mode: 'some', items: entries }, []) }
  const toggle = (it: ScopeItem, checked: boolean): void => {
    setErr(null)
    if (checked) { onScope(b, mergeScope(b.scope, [it]), [it]); return }
    if (b.scope.mode === 'all') { const rest = (entries ?? []).filter((e) => e.path !== it.path); if (rest.length) onScope(b, { mode: 'some', items: rest }, []); else setErr(t('ssync.scope.noneLeft')); return }
    const next = removeItem(b.scope, it.path)
    if (next) onScope(b, next, [])
    else setErr(t('ssync.scope.noneLeft'))
  }
  return (
    <div className="ssync-scope" role="group" aria-label={t('ssync.scope.someOpt')}>
      <div className="ssync-scope-modes">
        <label><input type="radio" checked={!some} onChange={pickAll} /> {t('ssync.scope.allOpt')}</label>
        <label><input type="radio" checked={some} disabled={!current || !entries?.length} onChange={pickSome} /> {t('ssync.scope.someOpt')}</label>
      </div>
      {!current && <div className="ssync-faint ssync-note">{t('ssync.scope.otherVault')}</div>}
      {current && entries && (
        <div className="ssync-scope-list">
          {/* 右键加进来的那一项和它的关联项多半不在顶层:照样列出来、勾着(可以单独去掉) */}
          {b.scope.mode === 'some' && b.scope.items.filter((it) => !entries.some((e) => e.path === it.path)).map((it) => (
            <label key={`x:${it.path}`} className="ssync-scope-item" title={it.path} data-scope-extra="">
              <input type="checkbox" checked onChange={() => toggle(it, false)} />
              <span>{it.kind === 'folder' ? it.path : it.path.replace(/\.md$/i, '')}</span>
            </label>
          ))}
          {entries.map((it) => {
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

/** 同步到:蓬洲云(这一版唯一跑在新同步里的去处)· 网盘灰掉写明「还用原来的方式」(契约 U-1 第 5 条)。 */
function TargetPicker({ binding: b }: { binding: BindingView | undefined }) {
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
  const label = b?.target.kind === 'remote' ? b.target.label : t('ssync.target.penzor')
  return (
    <>
      <button ref={btn} type="button" className="ssync-target-btn" aria-haspopup="menu" aria-expanded={!!at} title={t('ssync.syncTo')}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setAt((v) => (v ? null : { x: r.left, y: r.bottom + 4, top: r.top })) }}>
        <span className="ssync-faint">{t('ssync.syncTo')}</span> {label} <ChevronDown size={12} aria-hidden="true" />
      </button>
      {at && (
        <OverlayAt className="ctx-menu ssync-target-menu" role="menu" x={at.x} y={at.y} anchorTop={at.top} innerRef={(el: HTMLDivElement | null) => { menu.current = el }}>
          <button type="button" role="menuitemradio" aria-checked={b?.target.kind !== 'remote'} onClick={() => setAt(null)}>
            <Check size={14} aria-hidden="true" style={{ visibility: b?.target.kind !== 'remote' ? 'visible' : 'hidden' }} />
            <span className="ssync-target-opt"><span>{t('ssync.target.penzor')}</span><span className="ssync-faint">{t('ssync.target.penzorHint')}</span></span>
          </button>
          <div className="ctx-separator" role="separator" />
          <button type="button" role="menuitem" disabled aria-disabled="true" title={t('ssync.target.driveLater')}>
            <Check size={14} aria-hidden="true" style={{ visibility: 'hidden' }} />
            <span className="ssync-target-opt"><span>{t('ssync.target.addDrive')}</span><span className="ssync-faint">{t('ssync.target.driveLater')}</span></span>
          </button>
        </OverlayAt>
      )}
    </>
  )
}
