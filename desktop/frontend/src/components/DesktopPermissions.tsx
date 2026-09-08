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

export function DesktopPermissions({ mode }: { mode: 'light' | 'dark' }): React.ReactNode {
  const { t, locale } = useI18n()
  const headingId = useId()
  const [snapshot, setSnapshot] = useState<DesktopPermissionsSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ action: Action; message: string } | null>(null)
  const session = useRef<Session | null>(null)
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
  const showComputer = snapshot?.computerUseAvailable && ['darwin', 'win32'].includes(snapshot.platform)
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
        <Icon className="desktop-permissions-icon" size={18} aria-hidden="true" />
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
    <div className="desktop-permissions">
      <div className="desktop-permissions-toolbar">
        <p>{t('desktopPermissions.optional')}</p>
        <button type="button" className="btn ghost sm" disabled={refreshing || !!busy} onClick={() => void refresh()}>
          <RefreshCw size={13} className={refreshing ? 'spin' : undefined} aria-hidden="true" />{t('desktopPermissions.refresh')}
        </button>
      </div>
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
        {showComputer && <section className="desktop-permissions-section" aria-labelledby={`${headingId}-computer`}>
          <header>
            <h2 id={`${headingId}-computer`}><MousePointer2 size={16} aria-hidden="true" />{t('desktopPermissions.computerTitle')}</h2>
            <p>{t(snapshot.platform === 'darwin' ? 'desktopPermissions.computerMac' : 'desktopPermissions.computerWindows')}</p>
          </header>
          {snapshot.platform === 'darwin' && (helperFault ? <p className="desktop-permissions-helper-error" role="alert">{t(`desktopPermissions.helper.${helperError}`)}</p>
            : !snapshot.helperInstalled || helperError === 'not-installed' ? <p className="desktop-permissions-note">{t('desktopPermissions.helperMissing')}</p>
              : !snapshot.helperRunning || helperError === 'not-running' ? <p className="desktop-permissions-note">{t('desktopPermissions.helperStopped')}</p> : null)}
          {snapshot.platform === 'darwin' ? <ul className="desktop-permissions-list">
            {row('computerAccessibility')}
            {row('computerScreen')}
          </ul> : <p className="desktop-permissions-note">{t('desktopPermissions.windowsLimit')}</p>}
          {snapshot.platform === 'darwin' && api.desktopPermissionsVerify && <div className="desktop-permissions-verify">
            <p id={`${headingId}-verify-hint`}>{t(canVerify ? 'desktopPermissions.verifyHint' : 'desktopPermissions.verifySetupFirst')}</p>
            <button type="button" className="btn ghost sm" disabled={!!busy || !canVerify} aria-describedby={`${headingId}-verify-hint`} onClick={() => void run('verify')}>
              <ShieldCheck size={14} aria-hidden="true" />{t('desktopPermissions.verify')}
            </button>
          </div>}
        </section>}
        <section className="desktop-permissions-section" aria-labelledby={`${headingId}-media`}>
          <header>
            <h2 id={`${headingId}-media`}><ShieldCheck size={16} aria-hidden="true" />{t('desktopPermissions.mediaTitle', { app })}</h2>
            <p>{t('desktopPermissions.mediaDescription', { app })}</p>
            <p>{t(snapshot.platform === 'darwin' ? 'desktopPermissions.mediaMac' : snapshot.platform === 'win32' ? 'desktopPermissions.mediaWindows' : 'desktopPermissions.mediaOther', { app })}</p>
          </header>
          <ul className="desktop-permissions-list">{row('microphone')}{row('camera')}{row('screen')}</ul>
        </section>
      </>}
    </div>
  )
}
