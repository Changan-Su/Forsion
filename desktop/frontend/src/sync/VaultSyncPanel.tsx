/**
 * 同步面板(从左栏「智库」那行弹出;智库同步统一方案第 1 步,方案页 progress.html「一轮同步从头到尾，面板上是什么」)。
 * 从上到下:库名 → 去处 + 立即同步 / 等你定 / 这一轮(进度:文件数、字节、在传哪个;限速不算出错;出错说清哪个文件)/ 最近四轮记录 / 同步设置… · 全部记录。
 * 只读状态源,动作只接现成的通道(vaultSyncActions)。不在这一步:汇总卡、同步节奏「每 5 分钟 · 下一轮」、跳过这个、退出小卡。
 */
import React, { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowDown, ArrowUp, ChevronRight, FileText, RefreshCw } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { useI18n } from '../i18n'
import { ipcErrorText } from '../ipcError'
import { HeldSyncNotice } from '../components/CloudSyncDialog'
import type { SyncFeedReport, SyncProgress, SyncReviewItem, VaultSyncView } from '../../../shared/vaultSync'
import { useVaultSyncRaw } from './vaultSyncStore'
import { openDeletesReview, openSyncSettings, retryFailed, syncNow } from './vaultSyncActions'
import { failureText, opText, targetName, vaultSyncWords } from './vaultSyncText'
import { SyncRecordRows, openSyncRecords } from './SyncRecordList'

type Differs = Extract<SyncReviewItem, { kind: 'differs' }>
type Deletes = Extract<SyncReviewItem, { kind: 'deletes' }>

const MB = 1024 * 1024
export function bytesText(n: number): string {
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(1)} GB`
  if (n >= MB) return `${Math.round(n / MB)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

/** 「这一轮」的进度:正在核对 / 进度条 + 文件数 · 字节 + 正在传哪个。 */
function RoundProgress({ progress }: { progress: SyncProgress }) {
  const { t } = useI18n()
  if (progress.stage === 'checking') return <div className="vsp-line">{t('vsync.panel.checkingDots')}</div>
  const { done, total } = progress.files
  const pct = total ? Math.min(100, (done / total) * 100) : null
  const bytes = progress.bytes ? (progress.bytes.total !== null ? `${bytesText(progress.bytes.done)} / ${bytesText(progress.bytes.total)}` : bytesText(progress.bytes.done)) : null
  const cur = progress.current
  return (
    <>
      <div className={`vsp-bar${pct === null ? ' is-busy' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={total ?? undefined} aria-valuenow={done}>
        <span style={pct === null ? undefined : ({ '--vsp-p': pct / 100 } as React.CSSProperties)} />
      </div>
      <div className="vsp-line">
        <span className="vsp-strong">{total ? t('vsync.panel.files', { done, total }) : t('vsync.panel.filesDone', { done })}</span>
        {bytes && <span className="vsp-faint"> · {bytes}</span>}
      </div>
      {cur && (
        <div className="vsp-line vsp-faint vsp-current" title={cur.path}>
          {cur.op === 'download' ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />}
          <span>{opText(cur.op, cur.path, t)}</span>
        </div>
      )}
    </>
  )
}

/** 「等你定」:列出是哪几篇、哪边更新(其余照常同步);「全部…」展开现成的 HeldSyncNotice(它带用哪一份的几个按钮)。 */
function ReviewSection({ view }: { view: VaultSyncView }) {
  const { t } = useI18n()
  const legacy = useVaultSyncRaw((s) => s.legacy)
  const [all, setAll] = useState(false)
  const differs = view.review.filter((r): r is Differs => r.kind === 'differs')
  const deletes = [...view.review.filter((r): r is Deletes => r.kind === 'deletes'), ...view.elsewhere.deletes.filter((d) => d.accountWide)]
  const n = differs.length + deletes.reduce((a, d) => a + d.count, 0)
  if (!n) return null
  // 展开时按引擎分组交给 HeldSyncNotice(binding / shareKey 原样带回去)
  const groups = [...new Set(differs.map((d) => d.ref.feed))].map((feed) => ({ feed, status: legacy[feed] })).filter((g) => g.status?.held?.length)
  const canExpand = groups.length > 0
  return (
    <section className="vsp-sec">
      <div className="vsp-head">{t('vsync.panel.review')} <span className="vsp-count tone-warning">{n}</span></div>
      {!all && differs.slice(0, 3).map((d) => (
        <div key={`${d.ref.feed}:${d.path}`} className="vsp-item" title={d.path}>
          <FileText size={13} aria-hidden="true" />
          <span className="vsp-item-name">{baseName(d.path)}</span>
          <span className="vsp-faint">{d.newer === 'local' ? t('vsync.panel.newerHere') : d.newer === 'cloud' ? t('vsync.panel.newerThere') : t('vsync.panel.newerUnknown')}</span>
        </div>
      ))}
      {differs.length > 0 && canExpand && (
        <button type="button" className="vsp-link" onClick={() => setAll((v) => !v)}>{all ? t('vsync.panel.collapse') : t('vsync.panel.all')}</button>
      )}
      {all && groups.map((g) => (
        <HeldSyncNotice key={g.feed} binding={g.status!.binding ?? null} shareKey={g.status!.shareKey ?? null} held={g.status!.held!} open compact />
      ))}
      {deletes.map((d, i) => (
        <div key={`del:${d.ref.feed}:${i}`} className="vsp-item">
          <AlertCircle size={13} aria-hidden="true" className="tone-warning" />
          <span className="vsp-item-name">{d.accountWide ? t('vsync.panel.deletesAccount', { n: d.count }) : t('vsync.panel.deletes', { n: d.count })}</span>
          <button type="button" className="vsp-link" onClick={() => openDeletesReview(d)}>{t('vsync.panel.deletesGo')}</button>
        </div>
      ))}
    </section>
  )
}

/** 「这一轮」:进度 / 限速 / 出错的文件 / 引擎出错 / 两边一样。 */
function RoundSection({ view, feeds }: { view: VaultSyncView & { now: number }; feeds: SyncFeedReport[] }) {
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now())
  const limited = view.rateLimitedUntil !== null && view.rateLimitedUntil > now
  useEffect(() => {
    if (!view.rateLimitedUntil) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [view.rateLimitedUntil])
  const [busy, setBusy] = useState(false)
  const words = vaultSyncWords(view, view.now, t)
  const shownFailures = view.failures.slice(0, 5)
  return (
    <section className="vsp-sec">
      <div className="vsp-head">{t('vsync.panel.round')}</div>
      {view.progress && <RoundProgress progress={view.progress} />}
      {limited && <div className="vsp-line vsp-faint">{t('vsync.panel.rateLimited', { n: Math.max(1, Math.ceil((view.rateLimitedUntil! - now) / 1000)) })}</div>}
      {view.error && (
        <div className="vsp-card tone-danger" role="alert">
          <div className="vsp-card-head"><AlertCircle size={14} aria-hidden="true" />{t('vsync.error')}</div>
          <div className="vsp-card-body">{ipcErrorText(view.error)}</div>
        </div>
      )}
      {shownFailures.length > 0 && (
        <div className="vsp-card tone-danger">
          <div className="vsp-card-head"><AlertCircle size={14} aria-hidden="true" />{t('vsync.panel.failed', { n: view.failures.length })}</div>
          {shownFailures.map((f) => (
            <div key={f.path} className="vsp-card-body" title={f.path}>
              <span className="vsp-path">{f.path}</span>
              <span className="vsp-faint"> · {failureText(f, view.target, t)}</span>
            </div>
          ))}
          {view.failures.length > shownFailures.length && <div className="vsp-card-body vsp-faint">{t('vsync.panel.more', { n: view.failures.length - shownFailures.length })}</div>}
          <div className="vsp-card-actions">
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setBusy(true); void retryFailed(feeds).finally(() => setBusy(false)) }}>{t('vsync.panel.retry')}</button>
          </div>
        </div>
      )}
      {!view.progress && !view.error && !shownFailures.length && (
        <div className="vsp-line vsp-faint">
          {view.state === 'synced' ? t('vsync.panel.idle') : view.state === 'review' ? t('vsync.panel.restSyncs') : words.text}
        </div>
      )}
    </section>
  )
}

export function VaultSyncPanel({ vault, name, view, anchorRef, onClose }: {
  vault: { root: string | null; side: 'local' | 'cloud' }
  name: string
  view: VaultSyncView & { now: number }
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [at] = useState(() => {
    const r = anchorRef.current?.getBoundingClientRect()
    return r ? { x: r.left, y: r.bottom, top: r.top } : { x: 12, y: window.innerHeight - 12, top: window.innerHeight - 40 }
  })
  const [kicking, setKicking] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const feeds = view.feeds
  const canSync = feeds.some((f) => f.canSyncNow)
  const elsewhere = view.elsewhere.errors + view.elsewhere.review
  return createPortal(
    <div className="ui-popover-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <OverlayAt
        x={at.x} y={at.y} anchorTop={at.top} prefer="above"
        className="ui-popover vsync-panel" role="dialog" aria-label={t('vsync.panel.label', { name })}
        tabIndex={-1} innerRef={(el) => { panelRef.current = el }}
        data-state={view.state}
      >
        <header className="vsp-top">
          <span className="vsp-title"><b>{name}</b> → {targetName(view.target, t)}</span>
          <button type="button" className="btn ghost sm vsp-sync" disabled={!canSync || kicking}
            onClick={() => { setKicking(true); void syncNow(feeds).finally(() => setKicking(false)) }}>
            <RefreshCw size={13} className={kicking || view.state === 'syncing' || view.state === 'checking' ? 'spin' : undefined} aria-hidden="true" />
            {t('vsync.panel.syncNow')}
          </button>
        </header>
        <ReviewSection view={view} />
        <RoundSection view={view} feeds={feeds} />
        <section className="vsp-sec">
          <div className="vsp-head">{t('vsync.panel.records')}</div>
          <SyncRecordRows feeds={feeds.map((f) => f.id)} vault={vault.side === 'local' ? vault.root : null} limit={4} />
        </section>
        <footer className="vsp-foot">
          {elsewhere > 0 ? <span className="vsp-faint tone-warning">{t('vsync.panel.elsewhere', { n: elsewhere })}</span> : <span />}
          <span className="vsp-grow" />
          <button type="button" className="vsp-link" onClick={() => { onClose(); openSyncSettings() }}>{t('vsync.panel.settings')}</button>
          <button type="button" className="vsp-link" onClick={() => { onClose(); openSyncRecords() }}>{t('vsync.panel.allRecords')}<ChevronRight size={13} aria-hidden="true" /></button>
        </footer>
      </OverlayAt>
    </div>,
    document.body,
  )
}
