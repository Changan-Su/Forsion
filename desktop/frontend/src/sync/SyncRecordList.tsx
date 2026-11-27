/**
 * 同步记录的两种看法(一轮一行,不是一个文件一行):面板里这个库的最近四轮(SyncRecordRows),全部记录 30 天(SyncRecordsDialogHost)。
 * 只管怎么画、从 useSyncRecords 读 —— 不管记录存在哪、谁记的。第 2 步把「全部记录」搬进设置 › 同步时,原样搬这两个组件。
 */
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronRight, X } from 'lucide-react'
import { create } from 'zustand'
import { useI18n } from '../i18n'
import type { SyncRoundRecord } from '../../../shared/vaultSync'
import { useSyncRecords } from './useSyncRecords'
import { formatDateTime, formatTime } from '../format/time'
import { failureText, recordFeedLabel, recordSummary } from './vaultSyncText'

/** 今天的只写时刻「14:32」;别的日子带上日期「11月25日 14:32」(日期时间只走 format/time.ts)。 */
function timeText(at: number, locale: string, withDate: boolean): string {
  return withDate ? formatDateTime(at, { locale: locale === 'zh' ? 'zh' : 'en' }) : formatTime(at)
}

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString()

/** 面板里的最近几轮(这个库的那几路)。 */
export function SyncRecordRows({ feeds, vault, limit }: { feeds: string[]; vault: string | null; limit: number }) {
  const { t, locale } = useI18n()
  const rows = useSyncRecords({ feeds, vault, limit, enabled: feeds.length > 0 })
  if (!window.syncRecords) return null
  if (!rows?.length) return <div className="vsp-line vsp-faint">{t('vsync.panel.noRecords')}</div>
  const now = Date.now()
  return (
    <div className="vsr-rows">
      {rows.map((r) => (
        <div key={r.id} className="vsr-row" data-failed={r.failedCount > 0 || undefined}>
          <span className="vsr-time">{timeText(r.finishedAt, locale, !sameDay(r.finishedAt, now))}</span>
          <span className="vsr-sum">{recordSummary(r, t)}</span>
          {r.failedCount > 0 && (
            <span className="vsr-warn" title={r.failed.map((f) => `${f.path} · ${failureText(f, r.target, t)}`).join('\n')}>
              <AlertCircle size={13} aria-hidden="true" />
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

const useRecordsDialog = create<{ open: boolean }>(() => ({ open: false }))
/** 打开「全部记录」(第 1 步的入口是同步面板;第 2 步搬进设置 › 同步)。 */
export function openSyncRecords(): void { useRecordsDialog.setState({ open: true }) }

function RecordLine({ r, locale }: { r: SyncRoundRecord; locale: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className={`vsr-item${open ? ' is-open' : ''}`}>
      <button type="button" className="vsr-row vsr-row-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className="vsr-chev" aria-hidden="true" />
        <span className="vsr-time">{timeText(r.finishedAt, locale, true)}</span>
        <span className="vsr-sum">{recordSummary(r, t)}</span>
        <span className="vsr-feed">{recordFeedLabel(r, t)}</span>
        {r.failedCount > 0 && <span className="vsr-warn"><AlertCircle size={13} aria-hidden="true" /></span>}
      </button>
      {open && (
        <div className="vsr-detail">
          {r.failed.length ? (
            <>
              <div className="vsr-detail-head">{t('vsync.all.failedHead')}</div>
              {r.failed.map((f) => (
                <div key={f.path} className="vsr-fail" title={f.path}>
                  <span className="vsp-path">{f.path}</span>
                  <span className="vsp-faint"> · {failureText(f, r.target, t)}</span>
                </div>
              ))}
              {r.failedCount > r.failed.length && <div className="vsp-faint">{t('vsync.all.moreFailed', { n: r.failedCount - r.failed.length })}</div>}
            </>
          ) : <div className="vsp-faint">{t('vsync.all.noFailures')}</div>}
        </div>
      )}
    </div>
  )
}

/** 「全部记录」弹窗(这台电脑上、这个账号的 30 天,各路都在)。挂一次(amadeusOverlays)。 */
export function SyncRecordsDialogHost() {
  const { t, locale } = useI18n()
  const open = useRecordsDialog((s) => s.open)
  const ref = useRef<HTMLDialogElement>(null)
  const rows = useSyncRecords({ enabled: open })
  const close = (): void => useRecordsDialog.setState({ open: false })
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])
  if (!window.syncRecords) return null
  return (
    <dialog ref={ref} className="vsr-dialog" aria-label={t('vsync.all.title')} onCancel={close}
      onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="vsr-dialog-head">
        <div>
          <h2>{t('vsync.all.title')}</h2>
          <p className="vsp-faint">{t('vsync.all.sub')}</p>
        </div>
        <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={close}><X size={18} /></button>
      </div>
      <div className="vsr-dialog-body">
        {open && (rows?.length ? rows.map((r) => <RecordLine key={r.id} r={r} locale={locale} />)
          : rows ? <div className="vsr-empty vsp-faint">{t('vsync.all.empty')}</div> : null)}
      </div>
    </dialog>
  )
}
