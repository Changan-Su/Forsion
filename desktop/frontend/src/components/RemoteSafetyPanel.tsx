/**
 * 设置 › 远程会话 › 「急停与远程锁定」(P1 · K2 §3.10)。经 K4 的扩展槽挂在远程会话页末尾(R-12:{id:'remote-safety', order:100}),
 * 本包永不改 SettingsModal.tsx。只做界面:锁状态、热键、急停 / 解锁全在主进程(electron/remoteSafety.ts),
 * 经 window.tangu.remoteSafety 读写,另订阅 remoteSafety:changed(托盘 / 热键 / 别的窗口触发的变化)。
 * 设备页 / web / 手机没有这一块(remoteSafetyApi 门控,同 remoteSessionsApi)—— 急停与解锁只在执行设备本机。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Keyboard, Loader2, Lock, LockOpen, MessageSquare, OctagonX, Smartphone, Workflow } from 'lucide-react'
import { useI18n } from '../i18n'
import { formatListTime } from '../format/time'
import { ipcErrorText } from '../ipcError'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'
import { registerRemoteSettingsSection } from './remoteSettingsSections'
import { abortRun } from '../services/agentRunService'
import { homeTarget } from '../services/engine/targets'
import {
  acceleratorFromKeyEvent, DEFAULT_ESTOP_HOTKEY, formatAccelerator,
  type RemoteSafetyApi, type RemoteSafetyHotkey, type RemoteSafetyRun, type RemoteSafetyState, type UnlockResult,
} from '../../../shared/remoteSafety'
import './remoteSafetyCopy'
import './remoteSafety.css'


/** 本端有主进程 API 才有这一块;云端 Web / 移动端 / 设备页没有(急停与解锁只在执行设备本机,方案 §6.1)。 */
export function remoteSafetyApi(): RemoteSafetyApi | undefined {
  const tangu = window.tangu
  if (!tangu || tangu.cloudWeb || tangu.mobile || tangu.unitPage) return undefined
  return typeof tangu.remoteSafety?.get === 'function' ? tangu.remoteSafety : undefined
}

const isMac = (): boolean => { try { return window.tangu?.platform === 'darwin' } catch { return false } }

const RUN_ICON: Record<RemoteSafetyRun['category'], React.ReactNode> = {
  remote: <Smartphone size={14} aria-hidden="true" />,
  channel: <MessageSquare size={14} aria-hidden="true" />,
  unattended: <Workflow size={14} aria-hidden="true" />,
}

export function RemoteSafetyPanel(): React.ReactNode {
  const { t } = useI18n()
  const api = remoteSafetyApi()
  const [st, setSt] = useState<RemoteSafetyState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [hotkeyAttempt, setHotkeyAttempt] = useState<RemoteSafetyHotkey['error']>(null)
  const [recording, setRecording] = useState(false)
  const alive = useRef(true)
  const recorder = useRef<HTMLButtonElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const s = await api.get()
      if (!alive.current) return
      setSt(s)
      setLoadError(null)
    } catch (e) {
      if (alive.current) setLoadError(ipcErrorText(e))
    }
  }, [api])

  useEffect(() => {
    alive.current = true
    if (!api) return
    void load()
    const off = api.onChanged((s) => { if (alive.current) setSt(s) })
    return () => { alive.current = false; off() }
  }, [api, load])

  useEffect(() => { if (recording) recorder.current?.focus() }, [recording])
  // 录制期间请主进程挂起全局热键:macOS 上已注册的 globalShortcut 先于窗口拿到按键,不挂起的话在这里按当前组合键会直接急停、
  // 录制框什么也收不到。保存 / Esc / 失焦 / 卸载都会在这里恢复(保存时主进程的 setHotkey 自己也会先恢复;另有 60s 兜底)。
  useEffect(() => {
    if (!recording || !api) return
    const set = (on: boolean): void => { try { void api.setHotkeyRecording(on).catch(() => {}) } catch { /* 旧 preload */ } }
    set(true)
    return () => set(false)
  }, [recording, api])

  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    if (busy) return null
    setBusy(key)
    setNote(null)
    try {
      return await fn()
    } catch (e) {
      if (alive.current) setNote({ kind: 'error', text: t('remoteSafety.actionFailed', { error: ipcErrorText(e) }) })
      return null
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  if (!api) return null
  if (!st) {
    return loadError !== null
      ? <SettingsPanel anchor="remote-safety" icon={<OctagonX size={16} />} title={t('remoteSafety.title')}>
          <p className="rsf-note rsf-danger" role="alert">{t('remoteSafety.loadFailed', { error: loadError })}</p>
        </SettingsPanel>
      : null
  }

  const mac = isMac()
  const estop = (): void => { void run('estop', () => api.estop()).then((s) => { if (s && alive.current) setSt(s) }) }
  const unlock = (): void => {
    void run('unlock', () => api.unlock()).then((r: UnlockResult | null) => {
      if (!r || !alive.current) return
      if (!r.ok) setNote({ kind: 'error', text: t(`remoteSafety.unlock.${r.reason}`) })
      void load()
    })
  }
  const saveHotkey = (acc: string): void => {
    setRecording(false)
    void run('hotkey', () => api.setHotkey(acc)).then((h) => {
      if (!h || !alive.current) return
      setHotkeyAttempt(h.error === 'disabled' ? null : h.error)
      void load()
    })
  }
  const onRecordKey = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { setRecording(false); return }
    const acc = acceleratorFromKeyEvent(e)
    if (acc) saveHotkey(acc)
  }
  const stopRun = (runId: string): void => { void run(`stop:${runId}`, () => abortRun(homeTarget(), runId)) }

  const hk = st.hotkey
  const hotkeyError = hotkeyAttempt ?? (hk.error === 'disabled' ? null : hk.error)
  const hotkeyDesc = recording ? t('remoteSafety.recordingHint')
    : hk.error === 'disabled' ? t('remoteSafety.hotkey.disabled')
    : hotkeyError ? t(`remoteSafety.hotkey.${hotkeyError}`)
    : t('remoteSafety.hotkeyOk')
  const lockedDesc = st.locked && st.lockedAt
    ? t('remoteSafety.lockedAt', { time: formatListTime(st.lockedAt), source: t(`remoteSafety.source.${st.lockSource ?? 'settings'}`) })
    : st.locked ? t('remoteSafety.lockedAt', { time: '—', source: t(`remoteSafety.source.${st.lockSource ?? 'settings'}`) }) : t('remoteSafety.unlocked')

  return (
    <SettingsPanel anchor="remote-safety" className="rsf" icon={<OctagonX size={16} />} title={t('remoteSafety.title')} description={t('remoteSafety.hint')}>
      <div className="settings-control-list" data-rsf-locked={st.locked || undefined}>
        <SettingsRow className="rsf-row"
          label={<span className="rsf-row-title">{st.locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}{t('remoteSafety.access')}</span>}
          description={<>
            <span data-rsf-lock-state={st.locked ? 'locked' : 'unlocked'}>{lockedDesc}</span>
            {st.locked && <span className="rsf-meta">{t('remoteSafety.lockedDesc')}</span>}
            {st.lockPersistFailed && <span className="rsf-meta rsf-danger" data-rsf-persist-failed="">{t('remoteSafety.persistFailed')}</span>}
            {st.pendingEstop && <span className="rsf-meta rsf-danger" data-rsf-pending-estop="">{t('remoteSafety.pendingEstop')}</span>}
          </>}
          control={<div className="rsf-actions">
            {st.locked && (
              <button type="button" className="btn ghost sm" data-rsf="unlock" title={t('remoteSafety.unlockHint')} disabled={!!busy} onClick={unlock}>
                {busy === 'unlock' && <Loader2 size={12} className="spin" aria-hidden="true" />}{t('remoteSafety.unlock')}
              </button>
            )}
            <button type="button" className="btn danger sm" data-rsf="estop" disabled={!!busy} onClick={estop}>
              {busy === 'estop' && <Loader2 size={12} className="spin" aria-hidden="true" />}{t('remoteSafety.estopNow')}
            </button>
          </div>} />

        <SettingsRow className="rsf-row"
          label={<span className="rsf-row-title"><Keyboard size={14} aria-hidden="true" />{t('remoteSafety.hotkey')}</span>}
          description={<span className={hotkeyError && !recording ? 'rsf-danger' : undefined} data-rsf-hotkey-state={hk.error ?? 'ok'}>{hotkeyDesc}</span>}
          control={<div className="rsf-actions">
            {recording
              ? <button ref={recorder} type="button" className="rsf-kbd rsf-kbd--recording" data-rsf="hotkey-recorder" onKeyDown={onRecordKey} onBlur={() => setRecording(false)}>{t('remoteSafety.recording')}</button>
              : <kbd className={`rsf-kbd${hk.registered ? '' : ' rsf-kbd--off'}`} data-rsf="hotkey">{hk.accelerator ? formatAccelerator(hk.accelerator, mac) : t('remoteSafety.hotkeyNone')}</kbd>}
            {!recording && <button type="button" className="btn ghost sm" data-rsf="hotkey-change" disabled={!!busy} onClick={() => { setHotkeyAttempt(null); setRecording(true) }}>{t('remoteSafety.change')}</button>}
            {!recording && hk.accelerator !== '' && <button type="button" className="btn ghost sm" data-rsf="hotkey-off" disabled={!!busy} onClick={() => saveHotkey('')}>{t('remoteSafety.turnOff')}</button>}
            {!recording && hk.accelerator !== DEFAULT_ESTOP_HOTKEY && <button type="button" className="btn ghost sm" data-rsf="hotkey-reset" disabled={!!busy} onClick={() => saveHotkey(DEFAULT_ESTOP_HOTKEY)}>{t('remoteSafety.reset')}</button>}
          </div>} />
      </div>

      {note && <p className={`rsf-note${note.kind === 'error' ? ' rsf-danger' : ''}`} role={note.kind === 'error' ? 'alert' : undefined} data-rsf-note="">{note.text}</p>}

      <div className="rsf-sub">
        <strong className="rsf-sub-title">{t('remoteSafety.running')}</strong>
        <div className="settings-control-list">
          {st.remoteRuns.length === 0 && <div className="settings-empty-row" data-rsf-empty="">{t('remoteSafety.runningEmpty')}</div>}
          {st.remoteRuns.map((r) => (
            <SettingsRow key={r.runId} className="rsf-row"
              label={<span className="rsf-row-title">{RUN_ICON[r.category] ?? <Bot size={14} aria-hidden="true" />}<span className="rsf-name" title={r.label}>{r.label}</span></span>}
              description={<>
                {t('remoteSafety.startedAt', { time: formatListTime(r.startedAt) })}
                {r.pendingApprovals + r.pendingInquiries > 0 && <span className="rsf-badge" data-rsf-waiting="">{t('remoteSafety.waiting')}</span>}
              </>}
              control={<button type="button" className="btn ghost sm" data-rsf-stop={r.runId} disabled={!!busy} onClick={() => stopRun(r.runId)}>
                {busy === `stop:${r.runId}` && <Loader2 size={12} className="spin" aria-hidden="true" />}{t('remoteSafety.stop')}
              </button>} />
          ))}
        </div>
      </div>

      <p className="rsf-note" data-rsf-keepawake="">{t('remoteSafety.keepAwake')}</p>
    </SettingsPanel>
  )
}

// R-12:经 K4 的扩展槽挂在「设置 › 远程会话」页末尾;没有主进程 API 的端组件自己回 null。
registerRemoteSettingsSection({ id: 'remote-safety', order: 100, render: () => <RemoteSafetyPanel /> })
