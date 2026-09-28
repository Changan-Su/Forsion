/**
 * 设置 → 系统 → 远程会话(P1 · K4)。只做界面:开关、信任、审批档上限的落盘与校验全在主进程(electron/remoteSessions.ts),
 * 这里经 window.tangu.remoteSessions(shared/remoteSessions.ts 的 RemoteSessionsApi)读写,每个写操作回最新 View 直接替换,
 * 另订阅 remoteSessions:changed(本机弹框里点了允许 / 别的窗口改了)。三块 + 扩展槽:
 *   remote-sessions-switch   开关(父开关关 / 设备凭据未加密时置灰;G9:只管 Agent 会话,主机文件与智库不受影响)
 *   remote-approval-cap      最高审批档(选全自动须勾「我了解风险」再确认,之后常驻警示 —— 方案 §6.4 边界)
 *   remote-trusted-devices   已允许的设备 + 「本账号的浏览器与网页版」+ 等待确认项,可撤销
 * 设备页 / web / 手机没有这一页(remoteSessionsApi 门控,同 computerHistoryApi)。
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, Globe, Laptop, Loader2, MonitorSmartphone, ShieldAlert, Smartphone, TriangleAlert } from 'lucide-react'
import { useI18n } from '../i18n'
import { formatDate, formatListTime } from '../format/time'
import { ipcErrorText } from '../ipcError'
import { onRadioGroupKeyDown, radioTabIndex } from './radioGroupKeys'
import { SettingsPanel, SettingsRow, SettingsState, SettingsSwitch } from './SettingsPrimitives'
import { SecretStorageNotice } from './SecretStorageNotice'
import { remoteSessionsApi } from '../services/remoteSessionsApi'
import { onRemoteSettingsSectionsChange, remoteSettingsSections } from './remoteSettingsSections'
import { CAP_MODES, SECRET_STORE_INSECURE, type CapMode, type RemoteSessionsApi, type RemoteSessionsView } from '../../../shared/remoteSessions'
import './remoteSessionsCopy'
import './remoteSessions.css'

export { registerRemoteSettingsSection, type RemoteSettingsSection } from './remoteSettingsSections'

/** 本端有主进程 API 才列这一页;云端 Web / 移动端 / 设备页没有(开关只能在执行设备本机改,方案 §6.1)。 */
export { remoteSessionsApi }

const CAP_LABEL: Record<CapMode, string> = { readonly: 'approval.mode.readonly', 'auto-edit': 'approval.mode.autoEdit', 'full-auto': 'approval.mode.fullAuto' }
const CAP_DESC: Record<CapMode, string> = { readonly: 'remoteSessions.capDesc.readonly', 'auto-edit': 'remoteSessions.capDesc.autoEdit', 'full-auto': 'remoteSessions.capDesc.fullAuto' }

/** IPC 抛错的可读原因:secret-store-insecure 换成本地化那句,其余照 ipcErrorText。 */
function actionErrorText(e: unknown, t: (k: string) => string): string {
  const raw = ipcErrorText(e)
  return raw.includes(SECRET_STORE_INSECURE) ? t('remoteSessions.insecure') : raw
}

export function RemoteSessionsSettings(): React.ReactNode {
  const { t } = useI18n()
  const api = remoteSessionsApi()
  const [view, setView] = useState<RemoteSessionsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 选了全自动:先就地确认(勾「我了解风险」才能点确认),确认前不写盘。 */
  const [confirmFullAuto, setConfirmFullAuto] = useState(false)
  const [ack, setAck] = useState(false)
  const alive = useRef(true)
  const sections = useSyncExternalStore(onRemoteSettingsSectionsChange, remoteSettingsSections, remoteSettingsSections)

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const v = await api.get()
      if (!alive.current) return
      setView(v)
      setLoadError(null)
    } catch (e) {
      if (alive.current) setLoadError(ipcErrorText(e))
    }
  }, [api])

  useEffect(() => {
    alive.current = true
    if (!api) return
    void load()
    const off = api.onChanged((v) => { if (alive.current) setView(v) })
    const onVisible = (): void => { if (document.visibilityState === 'visible') void load() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      off()
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, load])

  const act = async (key: string, fn: (a: RemoteSessionsApi) => Promise<RemoteSessionsView>): Promise<boolean> => {
    if (!api || busy) return false
    setBusy(key)
    setActionError(null)
    try {
      const v = await fn(api)
      if (alive.current) setView(v)
      return true
    } catch (e) {
      if (alive.current) setActionError(actionErrorText(e, t))
      return false
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  if (!api) return null
  if (!view) {
    return loadError !== null
      ? <SettingsState icon={<MonitorSmartphone size={18} />} title={t('remoteSessions.loadFailed', { error: loadError })}
          actions={<button type="button" className="btn ghost sm" onClick={() => void load()}>{t('remoteSessions.retry')}</button>} />
      : <SettingsState icon={<Loader2 size={18} className="spin" />} title={t('remoteSessions.tab')} busy />
  }

  const on = view.enabled && view.permitted
  const switchLocked = !view.hostEnabled || !view.permitted
  const pickCap = (m: CapMode): void => {
    if (m === view.maxApprovalMode) { setConfirmFullAuto(false); return }
    if (m === 'full-auto') { setAck(false); setConfirmFullAuto(true); return }
    setConfirmFullAuto(false)
    void act(`cap:${m}`, (a) => a.setMaxApprovalMode(m))
  }
  const accountRow = view.trusted.find((r) => r.principal === 'account')
  const unitRows = view.trusted.filter((r) => r.principal === 'unit')
  const kindLabel = (k: 'phone' | 'desktop' | undefined): string => t(k === 'phone' ? 'remoteSessions.kind.phone' : 'remoteSessions.kind.desktop')

  return (
    <div className="rs-page" data-rs-on={on || undefined}>
      {actionError !== null && <div className="rs-alert" role="alert">{t('remoteSessions.actionFailed', { error: actionError })}</div>}

      <SettingsPanel anchor="remote-sessions-switch" icon={<MonitorSmartphone size={16} />} title={t('remoteSessions.switch')}
        description={t('remoteSessions.switchHint')}
        actions={<SettingsSwitch checked={on} disabled={switchLocked || !!busy} label={t('remoteSessions.switch')}
          onChange={(next) => void act('enabled', (a) => a.setEnabled(next))} />}>
        {!view.hostEnabled && <p className="rs-note" data-rs-need-host="">{t('remoteSessions.needHost')}</p>}
        {!view.permitted && (
          <div className="rs-secrets">
            <p className="rs-note" data-rs-insecure="">{t('remoteSessions.insecure')}</p>
            <SecretStorageNotice onChange={() => { void load() }} className="secnotice-inpanel" />
          </div>
        )}
        <p className="rs-scope" data-rs-scope="">{t('remoteSessions.scope')}</p>
      </SettingsPanel>

      <SettingsPanel anchor="remote-approval-cap" icon={<ShieldAlert size={16} />} title={t('remoteSessions.cap')} description={t('remoteSessions.capHint')}>
        <div className="settings-choice-grid rs-cap-grid" role="radiogroup" aria-label={t('remoteSessions.cap')} onKeyDown={onRadioGroupKeyDown}>
          {CAP_MODES.map((m, i) => {
            const checked = confirmFullAuto ? m === 'full-auto' : view.maxApprovalMode === m
            return (
              <button key={m} type="button" role="radio" aria-checked={checked} tabIndex={radioTabIndex(checked, i, true)} data-cap={m}
                className={`settings-choice-card${checked ? ' active' : ''}`} disabled={!!busy} onClick={() => pickCap(m)}>
                <span><strong>{t(CAP_LABEL[m])}</strong><small>{t(CAP_DESC[m])}</small></span>
                {checked && (busy === `cap:${m}` ? <Loader2 size={14} className="spin settings-choice-check" /> : <Check size={15} className="settings-choice-check" />)}
              </button>
            )
          })}
        </div>
        {confirmFullAuto && (
          <div className="rs-confirm" role="group" aria-label={t('remoteSessions.fullAutoTitle')} data-rs-fullauto-confirm="">
            <div>
              <strong>{t('remoteSessions.fullAutoTitle')}</strong>
              <p>{t('remoteSessions.fullAutoWarn')}</p>
              <label className="rs-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>{t('remoteSessions.fullAutoAck')}</span>
              </label>
            </div>
            <div className="rs-confirm-actions">
              <button type="button" className="btn ghost sm" autoFocus onClick={() => { setConfirmFullAuto(false); setAck(false) }}>{t('remoteSessions.cancel')}</button>
              <button type="button" className="btn danger sm" disabled={!ack || !!busy}
                onClick={() => void act('cap:full-auto', (a) => a.setMaxApprovalMode('full-auto')).then((ok) => { if (ok && alive.current) { setConfirmFullAuto(false); setAck(false) } })}>
                {busy === 'cap:full-auto' && <Loader2 size={12} className="spin" aria-hidden="true" />}{t('remoteSessions.fullAutoConfirm')}
              </button>
            </div>
          </div>
        )}
        {!confirmFullAuto && view.maxApprovalMode === 'full-auto' && (
          <div className="rs-warn" role="note" data-rs-fullauto-warn="">
            <TriangleAlert size={14} aria-hidden="true" />
            <div>
              <strong>{t('remoteSessions.fullAutoTitle')}</strong>
              <p>{t('remoteSessions.fullAutoWarn')}</p>
            </div>
          </div>
        )}
      </SettingsPanel>

      <SettingsPanel anchor="remote-trusted-devices" icon={<Smartphone size={16} />} title={t('remoteSessions.trusted')} description={t('remoteSessions.trustedHint')}>
        <div className="settings-control-list rs-trusted">
          {view.pending.map((p) => (
            <SettingsRow key={`pending:${p.principal}:${p.unitId ?? ''}`} className="rs-row"
              label={<span className="rs-row-title">{p.principal === 'account' ? <Globe size={14} aria-hidden="true" /> : p.kind === 'desktop' ? <Laptop size={14} aria-hidden="true" /> : <Smartphone size={14} aria-hidden="true" />}{p.principal === 'account' ? t('remoteSessions.account') : (p.name || '…')}</span>}
              description={t('remoteSessions.pendingHint')}
              control={<span className="rs-badge" data-rs-pending="">{t('remoteSessions.pending')}</span>} />
          ))}
          {accountRow && (
            <SettingsRow className="rs-row" label={<span className="rs-row-title"><Globe size={14} aria-hidden="true" />{t('remoteSessions.account')}</span>}
              description={<>{t('remoteSessions.accountDesc')}<span className="rs-meta">{accountRow.preconfirmed ? t('remoteSessions.preconfirmed') : t('remoteSessions.confirmedAt', { time: formatListTime(accountRow.confirmedAt) })}</span></>}
              control={<button type="button" className="btn ghost sm" data-rs-revoke="account" disabled={!!busy} onClick={() => void act('revoke:account', (a) => a.revoke('account'))}>{t('remoteSessions.revoke')}</button>} />
          )}
          {unitRows.map((r) => r.principal === 'unit' && (
            <SettingsRow key={r.unitId} className="rs-row"
              label={<span className="rs-row-title">{r.kind === 'desktop' ? <Laptop size={14} aria-hidden="true" /> : <Smartphone size={14} aria-hidden="true" />}<span className="rs-name" title={r.name}>{r.name || '…'}</span></span>}
              description={[
                [kindLabel(r.kind), r.platform].filter(Boolean).join(' · '),
                r.registeredAt ? t('remoteSessions.registeredAt', { date: formatDate(r.registeredAt) }) : null,
                t('remoteSessions.confirmedAt', { time: formatListTime(r.confirmedAt) }),
              ].filter(Boolean).join(' · ')}
              control={<button type="button" className="btn ghost sm" data-rs-revoke={r.unitId} disabled={!!busy} onClick={() => void act(`revoke:${r.unitId}`, (a) => a.revoke(r.unitId))}>{t('remoteSessions.revoke')}</button>} />
          ))}
          {!accountRow && unitRows.length === 0 && view.pending.length === 0 && <div className="settings-empty-row">{t('remoteSessions.trustedEmpty')}</div>}
        </div>
      </SettingsPanel>

      {sections.map((s) => <React.Fragment key={s.id}>{s.render()}</React.Fragment>)}
    </div>
  )
}
