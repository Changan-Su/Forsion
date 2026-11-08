/**
 * 电脑历史的说明弹窗。consent = 从关到开的同意说明(同意那一段 + 完整说明 + 「取消 / 开启记录」);否则只看完整说明。
 * 首启引导团队屏的「详情」(只看说明)和主页那一行的「开启…」(同意说明)共用这一份;
 * 词条与设置页同一份(computerHistoryMessages + ComputerHistoryAbout),这里不另写隐私口径。
 * 台架靠的名字:.ob-history-dialog / .ob-history-consent / .ob-history-dialog-foot / .ob-history-dialog-error
 * (check:onboardinghistory 在 computer-history-harness 的 ?ask / ?dialog 里量,check:first-run 在真应用里走)。
 */
import React, { useEffect, useRef } from 'react'
import { Loader2, Play, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { ComputerHistoryAbout } from './ComputerHistoryAbout'
import type { ComputerHistoryHandle } from './useComputerHistory'
import './computerHistoryMessages'
import './computerHistoryDialog.css'

export function ComputerHistoryDialog({ history, consent, open, onClose, onEnabled }: {
  history: ComputerHistoryHandle
  consent: boolean
  open: boolean
  onClose: () => void
  /** 「开启记录」写成了(主页那一行在 macOS 上接着请辅助功能)。 */
  onEnabled?: () => void
}): React.ReactNode {
  const { t } = useI18n()
  const ref = useRef<HTMLDialogElement>(null)
  const { view, busy } = history
  const saving = busy === 'enable'
  const shown = !!view && open
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (shown && !dialog.open) {
      dialog.showModal()
      // 落点放在不做决定的那个按钮上(同意时 = 取消)。
      dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
    } else if (!shown && dialog.open) dialog.close()
  }, [shown])
  if (!view) return null
  const title = t(consent ? 'computerHistory.enableConfirm.title' : 'computerHistory.about.title')
  const confirm = async (): Promise<void> => { if (await history.enable()) onEnabled?.() }
  return <dialog ref={ref} className="ob-history-dialog" aria-label={title}
    onCancel={(event) => { if (saving) event.preventDefault(); else onClose() }}
    onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <div className="ob-changelog-head">
      <h2>{title}</h2>
      <button type="button" className="icon-btn" aria-label={t('common.close')} disabled={saving} data-initial-focus={consent ? undefined : ''} onClick={onClose}><X size={18} /></button>
    </div>
    <div className="ob-history-dialog-body">
      {consent && <p className="ob-history-consent">{t('computerHistory.enableConfirm.body', { days: view.keepDays })}</p>}
      <ComputerHistoryAbout view={view} />
    </div>
    {consent && <div className="ob-history-dialog-foot">
      {history.actionError !== null && <span className="ob-history-dialog-error" role="alert">{t('computerHistory.actionFailed', { error: history.actionError })}</span>}
      <button type="button" className="btn ghost" data-initial-focus="" disabled={saving} onClick={onClose}>{t('computerHistory.cancel')}</button>
      <button type="button" className="btn primary" disabled={!!busy} onClick={() => void confirm()}>
        {saving ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}{t('computerHistory.enableConfirm.confirm')}
      </button>
    </div>}
  </dialog>
}
