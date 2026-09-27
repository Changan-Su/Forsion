import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Camera, Check, Loader2, Mic, Monitor, MousePointer2, RefreshCw, ShieldCheck } from 'lucide-react'
import type { DesktopPermissionId, DesktopPermissionsSnapshot } from '../types'
import { useI18n } from '../i18n'
import './desktopPermissionsMessages'
import './desktopPermissions.css'

/** Use the capability, not the Agent backend: single-product desktops need media access too. */
export function hasDesktopPermissions(): boolean {
  const api = window.tangu
  return typeof api?.desktopPermissionsStatus === 'function' && !api.cloudWeb && !api.mobile && !api.unitPage
}

type Action = DesktopPermissionId | 'verify'
type Session = {
  api: NonNullable<Window['tangu']>
  disposed: boolean
  reading: boolean
  action: Action | null
  revision: number
}

const permissionIcons = { computerAccessibility: MousePointer2, computerScreen: Monitor, microphone: Mic, camera: Camera, screen: Monitor }
const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

const COMPUTER_ROWS: DesktopPermissionId[] = ['computerAccessibility', 'computerScreen']
const MEDIA_ROWS: DesktopPermissionId[] = ['microphone', 'camera', 'screen']

/**
 * @param only     只画这几项(插件检查卡用:它的前置条件只含其中一两项)。缺省画全部。给了 only 时不显示
 *                 「以下权限都是可选的」那句 —— 在检查卡里它们正是必需项。
 * @param onSnapshot 每次拿到新快照(3 秒轮询 / 授权动作之后)回调一次;检查卡借它刷新对勾,不必自己再轮询。
 * @param onBusyChange 授权 / 安装 / 更新动作开始与结束时各回调一次(卸载时若还在进行,补一次 false)。
 *                 电脑历史页借它在「更新并重启助手」期间不去触发重连 —— 那会在旧助手退出、新字节落盘之前把旧版拉起来。
 * @param embedded 宿主已画好面板外壳(.settings-panel 的头)与「刷新状态」:不画工具条、分区卡片与分区标题,
 *                 只画状态提示与权限行,行距对齐设置面板的 15px 边距(电脑历史页用)。
 * @param refreshToken 宿主的刷新按钮:值变了就重读一次快照(初值不读,挂载时本来就会读)。
 */
export function DesktopPermissions({ mode, only, onSnapshot, onBusyChange, embedded, refreshToken }: {
  mode: 'light' | 'dark'
  only?: DesktopPermissionId[]
  onSnapshot?: (snapshot: DesktopPermissionsSnapshot) => void
  onBusyChange?: (busy: boolean) => void
  embedded?: boolean
  refreshToken?: number
}): React.ReactNode {
  const { t, locale } = useI18n()
  const headingId = useId()
  const [snapshot, setSnapshot] = useState<DesktopPermissionsSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ action: Action; message: string } | null>(null)
  const session = useRef<Session | null>(null)
  const onSnapshotRef = useRef(onSnapshot)
  onSnapshotRef.current = onSnapshot
  useEffect(() => { if (snapshot) onSnapshotRef.current?.(snapshot) }, [snapshot])
  const onBusyChangeRef = useRef(onBusyChange)
  onBusyChangeRef.current = onBusyChange
  const reportedBusy = useRef(false)
  useEffect(() => {
    const next = busy !== null
    if (next === reportedBusy.current) return
    reportedBusy.current = next
    onBusyChangeRef.current?.(next)
  }, [busy])
  useEffect(() => () => {
    if (reportedBusy.current) { reportedBusy.current = false; onBusyChangeRef.current?.(false) }
  }, [])
  const shown = (id: DesktopPermissionId): boolean => !only || only.includes(id)
  const api = hasDesktopPermissions() ? window.tangu : undefined
  const canVerify = snapshot?.platform === 'darwin' && snapshot.computerUseAvailable
    && snapshot.helperInstalled && snapshot.helperRunning && !snapshot.helperError

  const refresh = useCallback(async (): Promise<void> => {
    const current = session.current
    if (!current || current.disposed || current.reading || current.action) return
    current.reading = true
    const revision = current.revision
    setRefreshing(true)
    try {
      const next = await current.api.desktopPermissionsStatus!()
      if (!current.disposed && current.revision === revision) {
        setSnapshot(next)
        setReadError(null)
      }
    } catch (error) {
      if (!current.disposed && current.revision === revision) setReadError(errorMessage(error))
    } finally {
      current.reading = false
      if (!current.disposed) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!api) return
    const current: Session = { api, disposed: false, reading: false, action: null, revision: 0 }
    session.current = current
    setSnapshot(null)
    setBusy(null)
    setReadError(null)
    setActionError(null)
    void refresh()
    const refreshVisible = (): void => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    const timer = window.setInterval(refreshVisible, 3000)
    return () => {
      current.disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
      // Close immediately even during a request. Main owns cancellation of a guide opened later.
      void api.desktopPermissionsCloseGuide?.().catch(() => {})
    }
  }, [api, refresh])

  const seenRefreshToken = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === seenRefreshToken.current) return
    seenRefreshToken.current = refreshToken
    void refresh()
  }, [refreshToken, refresh])

  const run = async (action: Action): Promise<void> => {
    const current = session.current
    if (!current || current.disposed || current.action) return
    if (action === 'verify' ? !current.api.desktopPermissionsVerify : !current.api.desktopPermissionRequest) return
    if (action === 'verify' && !canVerify) return
    current.action = action
    current.revision++ // A read started before this user action must never overwrite its result.
    setBusy(action)
    setActionError(null)
    try {
      const next = action === 'verify'
        ? await current.api.desktopPermissionsVerify!()
        : await current.api.desktopPermissionRequest!(action, { locale, mode })
      if (!current.disposed) {
        setSnapshot(next)
        setReadError(null)
      }
    } catch (error) {
      if (!current.disposed) setActionError({ action, message: errorMessage(error) })
    } finally {
      current.action = null
      if (!current.disposed) setBusy(null)
    }
  }

  if (!api) return null
  const showComputer = snapshot?.computerUseAvailable && ['darwin', 'win32'].includes(snapshot.platform) && COMPUTER_ROWS.some(shown)
  const showMedia = MEDIA_ROWS.some(shown)
  const helperError = snapshot?.helperError
  const helperFault = helperError && !['not-installed', 'not-running'].includes(helperError)
  const app = snapshot?.appName || 'Forsion'
  const busyKey = busy === 'verify' ? 'desktopPermissions.verifying'
    : busy?.startsWith('computer') && !snapshot?.helperInstalled ? 'desktopPermissions.installing' : 'desktopPermissions.requesting'

  const row = (id: DesktopPermissionId): React.ReactNode => {
    if (!snapshot) return null
    const state = snapshot.permissions[id]
    const computer = id === 'computerAccessibility' || id === 'computerScreen'
    const Icon = permissionIcons[id]
    const canRequest = !!api.desktopPermissionRequest && state !== 'not-required' && (computer || state !== 'unavailable')
    const requestKey = computer && !snapshot.helperInstalled ? 'desktopPermissions.install'
      : computer && !snapshot.helperRunning ? 'desktopPermissions.start'
        : snapshot.platform === 'darwin' || snapshot.platform === 'win32' ? 'desktopPermissions.openSettings' : 'desktopPermissions.request'
    return (
      <li className="desktop-permissions-row" key={id} data-permission={id}>
        {/* 嵌入时面板头已有同一个图标,行里不再重复。 */}
        {!embedded && <Icon className="desktop-permissions-icon" size={18} aria-hidden="true" />}
        <div className="desktop-permissions-copy">
          <h3 id={`${headingId}-${id}`}>{t(`desktopPermissions.${id}.title`)}</h3>
          <p>{t(`desktopPermissions.${id}.hint`)}</p>
          {state === 'unverified' && <p className="desktop-permissions-unverified">{t(computer ? 'desktopPermissions.unverifiedHint' : 'desktopPermissions.mediaUnverifiedHint')}</p>}
        </div>
        <div className="desktop-permissions-row-actions">
          <span className="desktop-permissions-state" data-state={state}>
            {state === 'granted' && <Check size={12} aria-hidden="true" />}{t(`desktopPermissions.state.${state}`)}
          </span>
          {canRequest && <button type="button" className="btn ghost sm" disabled={!!busy} aria-describedby={`${headingId}-${id}`} onClick={() => void run(id)}>
            {busy === id && <Loader2 size={12} className="spin" aria-hidden="true" />}{t(requestKey)}
          </button>}
        </div>
      </li>
    )
  }

  return (
    <div className={`desktop-permissions${embedded ? ' desktop-permissions--embedded' : ''}`}>
      {!embedded && <div className="desktop-permissions-toolbar">
        {!only && <p>{t('desktopPermissions.optional')}</p>}
        <button type="button" className="btn ghost sm" disabled={refreshing || !!busy} onClick={() => void refresh()}>
          <RefreshCw size={13} className={refreshing ? 'spin' : undefined} aria-hidden="true" />{t('desktopPermissions.refresh')}
        </button>
      </div>}
      {!snapshot && !readError && <p role="status">{t('desktopPermissions.loading')}</p>}
      {readError !== null && <div className="desktop-permissions-error" role="alert">
        <div><p>{t('desktopPermissions.readFailed')}</p><p className="desktop-permissions-error-detail">{readError}</p></div>
        <button type="button" className="btn ghost sm" disabled={refreshing || !!busy} onClick={() => void refresh()}>{t('desktopPermissions.retryRead')}</button>
      </div>}
      {busy && <p className="desktop-permissions-progress" role="status"><Loader2 size={14} className="spin" aria-hidden="true" />{t(busyKey)}</p>}
      {actionError && <div className="desktop-permissions-error" role="alert">
        <div><p>{t('desktopPermissions.actionFailed')}</p><p className="desktop-permissions-error-detail">{actionError.message}</p></div>
        <button type="button" className="btn ghost sm" disabled={!!busy || (actionError.action === 'verify' && !canVerify)} onClick={() => void run(actionError.action)}>{t('desktopPermissions.retryAction')}</button>
      </div>}
      {snapshot && <>
        {showComputer && <section className="desktop-permissions-section" aria-labelledby={embedded ? undefined : `${headingId}-computer`}>
          {!embedded && <header>
            <h2 id={`${headingId}-computer`}><MousePointer2 size={16} aria-hidden="true" />{t('desktopPermissions.computerTitle')}</h2>
            <p>{t(snapshot.platform === 'darwin' ? 'desktopPermissions.computerMac' : 'desktopPermissions.computerWindows')}</p>
          </header>}
          {snapshot.platform === 'darwin' && (helperFault ? <p className="desktop-permissions-helper-error" role="alert">{t(`desktopPermissions.helper.${helperError}`)}</p>
            : !snapshot.helperInstalled || helperError === 'not-installed' ? <p className="desktop-permissions-note">{t('desktopPermissions.helperMissing')}</p>
              : !snapshot.helperRunning || helperError === 'not-running' ? <p className="desktop-permissions-note">{t('desktopPermissions.helperStopped')}</p> : null)}
          {snapshot.platform === 'darwin' ? <ul className="desktop-permissions-list">
            {shown('computerAccessibility') && row('computerAccessibility')}
            {shown('computerScreen') && row('computerScreen')}
          </ul> : <p className="desktop-permissions-note">{t('desktopPermissions.windowsLimit')}</p>}
          {/* 验证会实测屏幕访问:只要辅助功能的场景(电脑历史)不画这一块。 */}
          {snapshot.platform === 'darwin' && api.desktopPermissionsVerify && shown('computerScreen') && <div className="desktop-permissions-verify">
            <p id={`${headingId}-verify-hint`}>{t(canVerify ? 'desktopPermissions.verifyHint' : 'desktopPermissions.verifySetupFirst')}</p>
            <button type="button" className="btn ghost sm" disabled={!!busy || !canVerify} aria-describedby={`${headingId}-verify-hint`} onClick={() => void run('verify')}>
              <ShieldCheck size={14} aria-hidden="true" />{t('desktopPermissions.verify')}
            </button>
          </div>}
        </section>}
        {showMedia && <section className="desktop-permissions-section" aria-labelledby={embedded ? undefined : `${headingId}-media`}>
          {!embedded && <header>
            <h2 id={`${headingId}-media`}><ShieldCheck size={16} aria-hidden="true" />{t('desktopPermissions.mediaTitle', { app })}</h2>
            <p>{t('desktopPermissions.mediaDescription', { app })}</p>
            <p>{t(snapshot.platform === 'darwin' ? 'desktopPermissions.mediaMac' : snapshot.platform === 'win32' ? 'desktopPermissions.mediaWindows' : 'desktopPermissions.mediaOther', { app })}</p>
          </header>}
          <ul className="desktop-permissions-list">{MEDIA_ROWS.filter(shown).map(row)}</ul>
        </section>}
      </>}
    </div>
  )
}
