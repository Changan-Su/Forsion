/**
 * 首次引导「权限与数据」里的电脑历史一页:开关、当前状态、辅助功能授权,旁边两条摘要 + 完整说明的入口。
 * 状态与开关是设置页那一份(useComputerHistory + computerHistoryModel 的 statusLine / statusEntries),
 * 同意说明和五条说明也是同一份词条(ComputerHistoryAbout),这里不另写隐私口径。
 * 默认关:只把它摆出来。不拨开关就什么都不写;拨了先弹同意说明(同意那一段 + 完整五条),点「开启记录」才开。
 * macOS 一直画辅助功能那一行(授权状态 + 去授权 / 安装 / 更新助手的入口);Windows 没有要授的权限,只说明一句。
 */
import React, { useEffect, useRef, useState } from 'react'
import { ChevronRight, History, Loader2, Play, RefreshCw, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { ComputerHistoryAbout } from './ComputerHistoryAbout'
import { DesktopPermissions, hasDesktopPermissions } from './DesktopPermissions'
import { SettingsSwitch } from './SettingsPrimitives'
import { statusEntries, statusLine } from './computerHistoryModel'
import { useComputerHistory } from './useComputerHistory'
import './computerHistoryMessages'

/**
 * @param onBusyChange 开关正在落盘:引导的上一步 / 下一步 / 跳过等它存完(同后台 Agent 那一步)。
 * @param onUnsupported 主进程说这台电脑没有采集端:引导把这一页整个撤掉。
 */
export function OnboardingComputerHistory({ mode, onBusyChange, onUnsupported }: {
  mode: 'light' | 'dark'
  onBusyChange: (busy: boolean) => void
  onUnsupported: () => void
}): React.ReactNode {
  const { t } = useI18n()
  const history = useComputerHistory()
  const { view, busy, unsupported } = history
  /** 不拨开关、只想看完整说明。 */
  const [aboutOpen, setAboutOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const consent = history.confirmEnable && !view?.state.enabled
  const open = !!view && (consent || aboutOpen)
  const saving = busy === 'enable'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // 落点放在不做决定的那个按钮上(同意时 = 取消)。
      dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
    } else if (!open && dialog.open) dialog.close()
  }, [open])
  useEffect(() => {
    onBusyChange(saving)
    return () => { if (saving) onBusyChange(false) }
  }, [saving, onBusyChange])
  useEffect(() => { if (unsupported) onUnsupported() }, [unsupported, onUnsupported])

  if (!history.api || unsupported) return null
  if (!view) {
    return history.loadError !== null
      ? <div className="ob-history-state" role="alert">
          <p>{t('computerHistory.loadFailed', { error: history.loadError })}</p>
          <button type="button" className="btn ghost sm" onClick={() => void history.load()}>{t('computerHistory.retry')}</button>
        </div>
      : <p className="ob-history-state" role="status"><Loader2 size={14} className="spin" aria-hidden="true" />{t('computerHistory.loading')}</p>
  }

  const { state } = view
  const windows = state.platform === 'win32'
  const line = statusLine(state, Date.now(), t)
  const entries = statusEntries(state, history.permissionBusy, hasDesktopPermissions())
  const close = (): void => { history.setConfirmEnable(false); setAboutOpen(false) }

  return (
    <div className="ob-history" data-ch-status={state.status}>
      <section className="ob-history-card">
        {history.actionError !== null && <div className="ch-alert" role="alert">{t('computerHistory.actionFailed', { error: history.actionError })}</div>}
        {view.persistError != null && <div className="ch-alert" role="alert">{t('computerHistory.persistError', { error: view.persistError })}</div>}
        {view.stateError != null && <div className="ch-alert" role="alert">{t('computerHistory.stateError', { error: view.stateError })}</div>}
        <div className="ob-history-head">
          <History size={18} aria-hidden="true" />
          <div><strong>{t('computerHistory.enable')}</strong><p>{t('computerHistory.summary')}</p></div>
          <SettingsSwitch checked={state.enabled} disabled={!!busy} onChange={history.toggleEnabled} label={t('computerHistory.enable')} />
        </div>
        <div className="ob-history-row" key={state.status}>
          <div>
            <strong className="ch-status"><i className={`settings-status-dot${line.tone === 'idle' ? '' : ` ${line.tone}`}`} aria-hidden="true" />{line.label}</strong>
            <small>{line.hint}</small>
          </div>
          {line.pausedUntil != null || state.status === 'paused'
            ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => void history.act('resume', (a) => a.resume())}>
                {busy === 'resume' ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}{t('computerHistory.resume')}
              </button>
            : entries.refresh && <button type="button" className="btn ghost sm" data-ch-refresh-status="" disabled={history.statusRefreshing || history.permissionBusy} onClick={() => void history.refreshStatus()}>
                <RefreshCw size={12} className={history.statusRefreshing ? 'spin' : undefined} aria-hidden="true" />{t('computerHistory.status.refresh')}
              </button>}
        </div>
        {windows
          ? <p className="ob-history-note">{t('computerHistory.win.permission')}</p>
          : hasDesktopPermissions() && <div className="ob-history-permission">
              <DesktopPermissions mode={mode} only={['computerAccessibility']} embedded onBusyChange={history.onPermissionBusy} refreshToken={history.permissionRefresh} />
            </div>}
      </section>
      <section className="ob-history-card ob-history-about">
        <ComputerHistoryAbout view={view} summary />
        <button type="button" className="ob-history-more" onClick={() => setAboutOpen(true)}>{t('onboarding.history.more')}<ChevronRight size={13} aria-hidden="true" /></button>
      </section>
      <dialog
        ref={dialogRef}
        className="ob-history-dialog"
        aria-label={t(consent ? 'computerHistory.enableConfirm.title' : 'computerHistory.about.title')}
        onCancel={(event) => { if (saving) event.preventDefault(); else close() }}
        onClick={(event) => { if (event.target === event.currentTarget && !saving) close() }}
      >
        <div className="ob-changelog-head">
          <h2>{t(consent ? 'computerHistory.enableConfirm.title' : 'computerHistory.about.title')}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} disabled={saving} data-initial-focus={consent ? undefined : ''} onClick={close}><X size={18} /></button>
        </div>
        <div className="ob-history-dialog-body">
          {consent && <p className="ob-history-consent">{t('computerHistory.enableConfirm.body', { days: view.keepDays })}</p>}
          <ComputerHistoryAbout view={view} />
        </div>
        {consent && <div className="ob-history-dialog-foot">
          <button type="button" className="btn ghost" data-initial-focus="" disabled={saving} onClick={() => history.setConfirmEnable(false)}>{t('computerHistory.cancel')}</button>
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => void history.enable()}>
            {saving ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}{t('computerHistory.enableConfirm.confirm')}
          </button>
        </div>}
      </dialog>
    </div>
  )
}

/** 完成页上那一行:电脑历史此刻的状态(只读;和设置页状态行同一个标签)。 */
export function OnboardingHistoryStatus(): React.ReactNode {
  const { t } = useI18n()
  const { view } = useComputerHistory()
  return view ? statusLine(view.state, Date.now(), t).label : '…'
}
