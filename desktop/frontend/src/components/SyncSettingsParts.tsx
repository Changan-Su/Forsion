/**
 * 设置 › 同步(智库同步第 2 步 U 包)的几块零件:页底汇总卡(3B / 2B)、等你定(v2)、被换掉的那份(30 天找回)、
 * 同步记录、Extend 停用 / 读不出时的说明、接手卡(V10,面板顶上用)。数据与动作一律经 sync/v2/client.ts。
 */
import { useEffect, useState } from 'react'
import { AlertCircle, Cloud, FileText, History, RefreshCw } from 'lucide-react'
import { useI18n } from '../i18n'
import { ipcErrorText } from '../ipcError'
import { formatDateTime, formatTime } from '../format/time'
import { useSyncRecords } from '../sync/useSyncRecords'
import { recordSummary, failureText } from '../sync/vaultSyncText'
import { openSyncRecords } from '../sync/SyncRecordList'
import { vaultSync } from '../sync/v2/client'
import type { Cadence, HeldRef, RecoveryEventView, ScopeItem, VaultSyncPreview } from '../sync/v2/types'
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import './syncSettingsMessages'

const MB = 1024 * 1024
const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')
const folderName = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root

/** 页底汇总卡(方案 V9b,3B 的内容 + 2B 的主按钮):四格 + 太大,不一样的前几篇,三颗按钮。 */
export function SummaryCard({ name, preview, busy, kind, added, dest, onApply, onCancel }: {
  name: string
  /** 去处一句话(蓬洲云 · 哪个库);库名和去处要看得见 */
  dest?: string
  /** 这一次新加进范围的项(右键带来的那一项 + 关联闭包),标「刚勾上」 */
  added?: ScopeItem[]
  preview: VaultSyncPreview | null
  busy: boolean
  /** cloud = 云端已有(按名字对上 / 原位置);new = 新建库;scope = 已有绑定里新加的部分 */
  kind: 'cloud' | 'new' | 'scope' | 'target'
  onApply: (onDiffer: 'newer' | 'hold') => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const [notSame, setNotSame] = useState(false)
  const title = kind === 'scope' ? t('ssync.sum.titleScope') : kind === 'target' ? t('ssync.sum.titleTarget') : kind === 'new' ? t('ssync.sum.titleNew') : t('ssync.sum.titleCloud')
  if (!preview) {
    return (
      <section className="ssync-sum" aria-live="polite" data-ssync-summary="comparing">
        <div className="ssync-sum-head"><Cloud size={15} aria-hidden="true" /><b>{title}</b></div>
        <div className="ssync-sum-line ssync-faint"><RefreshCw size={13} className="spin" aria-hidden="true" /> {t('ssync.sum.comparing')}</div>
      </section>
    )
  }
  const differ = preview.differ
  const shown = all ? differ : differ.slice(0, 3)
  const tiles: Array<[string, number, boolean]> = [
    [t('ssync.sum.same'), preview.same, false],
    [t('ssync.sum.onlyLocal'), preview.onlyLocal, false],
    ...(preview.onlyRemote > 0 ? [[t('ssync.sum.onlyRemote'), preview.onlyRemote, false] as [string, number, boolean]] : []),
    [t('ssync.sum.differ'), differ.length, differ.length > 0],
    [t('ssync.sum.tooLarge'), preview.tooLarge.length, false],
  ]
  const maxMb = preview.tooLarge[0] ? Math.round(preview.tooLarge[0].maxBytes / MB) : 0
  return (
    <section className="ssync-sum" role="region" aria-label={title} data-ssync-summary="ready">
      <div className="ssync-sum-head">
        <Cloud size={15} aria-hidden="true" /><b>{title}</b>
        <span className="ssync-faint">{t('ssync.sum.lead')}</span>
      </div>
      {dest && <div className="ssync-sum-dest" data-ssync-dest="">{t('ssync.dest.line', { name, dest })}</div>}
      {!!added?.length && (
        <div className="ssync-sum-added" title={added.map((a) => a.path).join('\n')}>
          <span className="ssync-tag">{t('ssync.scope.justAdded')}</span>
          <span className="ssync-sum-added-names">{added.slice(0, 4).map((a) => baseName(a.path)).join(t('ssync.listSep'))}{added.length > 4 ? ` ${t('ssync.sum.more', { n: added.length - 4 })}` : ''}</span>
        </div>
      )}
      <div className="ssync-sum-tiles">
        {tiles.map(([label, n, warn]) => (
          <div key={label} className={`ssync-sum-tile${warn ? ' is-warn' : ''}`}><b>{n}</b><span>{label}</span></div>
        ))}
      </div>
      {differ.length > 0 && (
        <div className="ssync-sum-list">
          {shown.map((d) => (
            <div key={d.path} className="ssync-sum-row" title={d.path}>
              <span className="ssync-sum-name">{baseName(d.path)}</span>
              <span className={d.newer ? 'ssync-warn' : 'ssync-faint'}>{d.newer === 'local' ? t('ssync.sum.newerHere') : d.newer === 'remote' ? t('ssync.sum.newerCloud') : t('ssync.sum.newerUnknown')}</span>
            </div>
          ))}
          {differ.length > 3 && (
            <div className="ssync-sum-row">
              <span className="ssync-faint">{all ? '' : t('ssync.sum.more', { n: differ.length - 3 })}</span>
              <button type="button" className="ssync-link" onClick={() => setAll((v) => !v)}>{all ? t('ssync.sum.collapse') : t('ssync.sum.all')}</button>
            </div>
          )}
        </div>
      )}
      {preview.tooLarge.length > 0 && (
        <div className="ssync-sum-line ssync-faint" title={preview.tooLarge.map((x) => x.path).join('\n')}>
          {t('ssync.sum.tooLargeList', { mb: maxMb })} {preview.tooLarge.slice(0, 3).map((x) => baseName(x.path)).join(t('ssync.listSep'))}{preview.tooLarge.length > 3 ? '…' : ''}
        </div>
      )}
      <p className="ssync-sum-foot">{differ.length ? t('ssync.sum.foot') : t('ssync.sum.footNoDiffer')}</p>
      {notSame && <p className="ssync-sum-foot">{t('ssync.sum.notSameHint')}</p>}
      <div className="ssync-sum-acts">
        {kind === 'cloud' && <button type="button" className="ssync-link ssync-sum-notsame" onClick={() => setNotSame((v) => !v)}>{t('ssync.sum.notSame')}</button>}
        <span className="ssync-grow" />
        <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>{t('ssync.sum.cancel')}</button>
        {differ.length > 0 && <button type="button" className="btn sm" disabled={busy} data-ssync-apply="hold" onClick={() => onApply('hold')}>{t('ssync.sum.hold')}</button>}
        <button type="button" className="btn primary sm" disabled={busy} data-ssync-apply="newer" onClick={() => onApply(differ.length ? 'newer' : 'hold')}>
          {differ.length ? t('ssync.sum.newer') : t('ssync.sum.start')}
        </button>
      </div>
      <span className="ssync-sr" aria-live="polite">{name}</span>
    </section>
  )
}

/** 等你定(v2):有清单(契约 U-2)就逐篇给四个出口;没有只写计数。 */
export function HeldReview({ bindingId, count, items, onDone }: {
  bindingId: string
  count: number
  items: Array<{ path: string; newer: 'local' | 'remote' | null; ref: HeldRef }> | null
  onDone: () => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!count) return null
  const act = async (ref: HeldRef, action: 'local' | 'cloud' | 'both' | 'newer'): Promise<void> => {
    setBusy(ref.path); setError(null)
    const r = await vaultSync.resolve(ref, action)
    setBusy(null)
    if (!r.ok) setError(r.error === 'stale' ? t('ssync.stale') : ipcErrorText(r.error))
    onDone()
  }
  return (
    <div className="ssync-held" data-binding={bindingId}>
      <div className="ssync-held-head"><span className="vsync-dot is-warning" aria-hidden="true" />{t('ssync.review.count', { n: count })}</div>
      {!items?.length && <div className="ssync-faint ssync-held-note">{t('ssync.review.noList')}</div>}
      {items?.map((h) => (
        <div key={h.path} className="ssync-held-row" title={h.path}>
          <FileText size={13} aria-hidden="true" />
          <span className="ssync-held-name">{baseName(h.path)}</span>
          <span className="ssync-faint">{h.newer === 'local' ? t('ssync.sum.newerHere') : h.newer === 'remote' ? t('ssync.sum.newerCloud') : t('vsync.panel.newerUnknown')}</span>
          <span className="ssync-grow" />
          {(['local', 'cloud', 'both', 'newer'] as const).map((a) => (
            <button key={a} type="button" className="btn ghost sm" disabled={busy !== null || (a === 'newer' && !h.newer)} onClick={() => void act(h.ref, a)}>
              {t(a === 'local' ? 'ssync.review.useLocal' : a === 'cloud' ? 'ssync.review.useCloud' : a === 'both' ? 'ssync.review.both' : 'ssync.review.newer')}
            </button>
          ))}
        </div>
      ))}
      {error && <div className="ssync-error" role="alert">{error}</div>}
    </div>
  )
}

/** 被换掉的那份(30 天找回):读独立的找回账;界面写明「存在这台电脑上」。 */
export function RecoveryList({ refreshKey }: { refreshKey: number }) {
  const { t, locale } = useI18n()
  const [rows, setRows] = useState<RecoveryEventView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void vaultSync.recoveryList().then((r) => {
      if (!alive) return
      if (r.ok) { setRows(r.value ?? []); setError(null) } else { setRows(null); setError(r.error) }
    })
    return () => { alive = false }
  }, [refreshKey])
  const restore = async (ev: RecoveryEventView): Promise<void> => {
    setBusy(ev.eventId)
    const r = await vaultSync.recoveryRestore(ev.eventId)
    setBusy(null)
    if (r.ok) setDone(t('ssync.recoveryRestored', { path: r.value?.path ?? ev.path }))
    else setError(r.error)
  }
  const shown = rows ? (all ? rows : rows.slice(0, 5)) : []
  return (
    <div className="ssync-block" data-ssync-recovery="">
      <p className="ssync-faint ssync-block-lead">{t('ssync.recoveryDesc')}</p>
      {error && <div className="ssync-error" role="alert">{ipcErrorText(error)}</div>}
      {rows && !rows.length && <div className="ssync-faint ssync-empty">{t('ssync.recoveryNone')}</div>}
      {shown.map((ev) => (
        <div key={ev.eventId} className="ssync-rec-row" title={ev.path}>
          <History size={13} aria-hidden="true" />
          <span className="ssync-rec-name">{baseName(ev.path)}</span>
          <span className="ssync-faint">{t(ev.side === 'cloud' ? 'ssync.recoverySide.cloud' : 'ssync.recoverySide.local')} · {formatDateTime(ev.at, { locale: locale === 'zh' ? 'zh' : 'en' })}</span>
          <span className="ssync-grow" />
          <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => void restore(ev)}>{t('ssync.recoveryRestore')}</button>
        </div>
      ))}
      {rows && rows.length > 5 && <button type="button" className="ssync-link" onClick={() => setAll((v) => !v)}>{all ? t('ssync.sum.collapse') : t('ssync.recoveryMore', { n: rows.length - 5 })}</button>}
      {done && <div className="ssync-faint" role="status">{done}</div>}
    </div>
  )
}

/** 同步记录:最近 4 轮(所有库,带库名)+「全部记录（30 天）」。 */
export function RecordsBlock() {
  const { t } = useI18n()
  const { rows, unavailable } = useSyncRecords({ limit: 4, enabled: true })
  if (!window.syncRecords) return null
  const now = Date.now()
  const sameDay = (a: number): boolean => new Date(a).toDateString() === new Date(now).toDateString()
  return (
    <div className="ssync-block" data-ssync-records="">
      {unavailable && <div className="ssync-faint">{t('vsync.panel.recordsUnavailable')}</div>}
      {rows && !rows.length && <div className="ssync-faint ssync-empty">{t('vsync.panel.noRecords')}</div>}
      {rows?.map((r) => (
        <div key={r.id} className="ssync-rec-row" data-failed={r.failedCount > 0 || undefined}>
          <b className="ssync-rec-vault">{r.vault ? folderName(r.vault) : t('ssync.cloudNotes')}</b>
          <span className="ssync-rec-time">{sameDay(r.finishedAt) ? formatTime(r.finishedAt) : formatDateTime(r.finishedAt)}</span>
          <span className="ssync-rec-sum">{recordSummary(r, t)}</span>
          <span className="ssync-grow" />
          {r.failedCount > 0 && (
            <span className="ssync-warn" title={r.failed.map((f) => `${f.path} · ${failureText(f, r.target, t)}`).join('\n')}><AlertCircle size={14} aria-hidden="true" /></span>
          )}
        </div>
      ))}
      <button type="button" className="ssync-link ssync-rec-all" onClick={openSyncRecords}>{t('ssync.recordsAll')} ›</button>
      <p className="ssync-faint ssync-block-foot">{t('ssync.recordsLocal')}</p>
    </div>
  )
}

/** Forsion Extend 停用 / 没加载时的说明 + 启用按钮(契约 §7 第 1 条:停用 Extend 同步也停)。 */
export function ExtendOffNotice() {
  const { t } = useI18n()
  const ext = usePluginStore((s) => s.plugins.find((p) => p.id === 'forsion-extend'))
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(!!ext?.restartPending)
  const off = !!ext?.bundleOff
  const enable = async (): Promise<void> => {
    if (!window.tangu?.setBundleEnabled || !ext) return
    setBusy(true)
    try {
      const { restartPending } = await window.tangu.setBundleEnabled(ext.id, true)
      usePluginStore.setState((s) => ({ plugins: s.plugins.map((x) => (x.id === ext.id ? { ...x, bundleOff: false, restartPending } : x)) }))
      usePluginStore.getState().enable(ext.id, { quiet: true })
      setPending(true)
    } finally { setBusy(false) }
  }
  return (
    <div className="ssync-off" role="status" data-ssync-off={off ? 'disabled' : 'not-loaded'}>
      <AlertCircle size={16} aria-hidden="true" />
      <div className="ssync-off-copy">
        <b>{off || pending ? t('ssync.off.title') : t('ssync.off.notLoaded')}</b>
        <p>{off || pending ? t('ssync.off.desc') : t('ssync.off.notLoadedDesc')}</p>
        {pending && <p className="ssync-faint">{t('ssync.off.restartPending')}</p>}
      </div>
      <div className="ssync-off-acts">
        {off && !pending && window.tangu?.setBundleEnabled && <button type="button" className="btn primary sm" disabled={busy} onClick={() => void enable()}>{t('ssync.off.enable')}</button>}
        {pending && window.tangu?.relaunchApp && <button type="button" className="btn primary sm" onClick={() => void window.tangu!.relaunchApp!()}>{t('ssync.off.restart')}</button>}
        {!off && !pending && <button type="button" className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'amadeus-plugins' }))}>{t('ssync.off.plugins')}</button>}
      </div>
    </div>
  )
}

/** 接手卡(方案 V10):接手完成后在同步面板顶上出一次,数字照实写。dismiss 通道 E 还没有时不画「知道了」(契约 U-1 第 2 条)。 */
export function HandoverCard({ bindingId, items, cadence, card, onDismissed }: {
  bindingId: string
  items: number
  cadence: Cadence
  card: { adopted: number; filled: number; held: number; revived: number }
  onDismissed: () => void
}) {
  const { t } = useI18n()
  const [canDismiss, setCanDismiss] = useState(true)
  const every = cadence.kind === 'interval' ? t('ssync.handover.every', { n: cadence.minutes }) : t('ssync.handover.manual')
  return (
    <div className="ssync-handover" role="status" data-ssync-handover={bindingId}>
      <b>{t('ssync.handover.title')}</b>
      <p>{t('ssync.handover.body', { items, cadence: every })}</p>
      <p className="ssync-faint">{t('ssync.handover.counts', { adopted: card.adopted, filled: card.filled, held: card.held })}</p>
      {card.revived > 0 && <p className="ssync-faint">{t('ssync.handover.revived', { n: card.revived })}</p>}
      {canDismiss && (
        <button type="button" className="btn sm" onClick={() => void vaultSync.dismissCard(bindingId).then((r) => { if (r.ok) onDismissed(); else setCanDismiss(false) })}>
          {t('ssync.handover.ok')}
        </button>
      )}
    </div>
  )
}
