/**
 * 设置 → 系统 → 电脑历史。只做界面:落盘 / 保留 / 清除 / 暂停 / 连 helper 全在主进程(electron/computerHistory.ts),
 * 这里经 window.tangu.computerHistory(shared/computerHistory.ts 的 ComputerHistoryApi)读写,每个写操作回最新 View 直接替换。
 * 状态实时性:onChanged 推送 + 窗口回到前台时 get() 一次(从系统设置授权回来,不必等主进程的重试)。
 * 三路来的 View(get 回包 / 写操作结果 / 推送)一律按主进程的 rev 取最新:旧的 get() 回包晚到不能把新推送盖回去。
 * ⚠️ 主进程的 get() 在失败态会立刻重连(连不上就拉起 helper)。权限卡正在「更新并重启助手」时别触发它:
 * 旧助手 shutdown 到新字节落盘之间一重连,就会把旧版拉起来占住 socket,新版随即作为多余实例退出。
 * 清除 / 改排除表同样会让主进程重订阅,期间一并禁用(主进程的拉起本身也按 helperBusy 把关)。
 * 辅助功能授权复用 DesktopPermissions(只画 computerAccessibility;不涉及屏幕录制)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, FolderOpen, Globe2, History, Loader2, MousePointer2, Play, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import type { ComputerHistoryApi, ComputerHistoryExclude, ComputerHistorySession, ComputerHistoryView } from '../../../shared/computerHistory'
import { useI18n } from '../i18n'
import { formatTime } from '../format/time'
import { ipcErrorText } from '../ipcError'
import { DesktopPermissions, hasDesktopPermissions } from './DesktopPermissions'
import { SettingsPanel, SettingsRow, SettingsState, SettingsSwitch } from './SettingsPrimitives'
import {
  CLEAR_CHOICES, PAUSE_CHOICES, STATUS_KEYS, clearArg, clockLabel, hoursSinceLocalMidnight, needsHelperSetup, normalizeBundleId,
  normalizeDomain, historyBlocks, pauseArg, statusTone, type ClearChoice,
} from './computerHistoryModel'
import './computerHistoryMessages'
import './computerHistory.css'

/** 本端有主进程 API 才列这一页(非 darwin 也列,页内写「目前仅支持 macOS」);云端 Web / 移动端 / 设备页没有。 */
export function computerHistoryApi(): ComputerHistoryApi | undefined {
  const tangu = window.tangu
  if (!tangu || tangu.cloudWeb || tangu.mobile || tangu.unitPage) return undefined
  return typeof tangu.computerHistory?.get === 'function' ? tangu.computerHistory : undefined
}

/** 图标取不到时的首字母方块。 */
function AppIcon({ name, src }: { name: string; src?: string | null }): React.ReactNode {
  return src
    ? <img className="ch-app-icon" src={src} alt="" draggable={false} />
    : <span className="ch-app-icon ch-app-icon--letter" aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() ?? '?'}</span>
}

/** @param anchor 设置搜索落点(settingsSearchIndex.ts),挂在首张面板上。 */
export function ComputerHistorySettings({ mode, anchor }: { mode: 'light' | 'dark'; anchor?: string }): React.ReactNode {
  const { t } = useI18n()
  const api = computerHistoryApi()
  const hostPlatform = window.tangu?.platform
  const [view, setView] = useState<ComputerHistoryView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ComputerHistorySession[]>([])
  const [recentApps, setRecentApps] = useState<Array<{ name: string; bundleId: string }>>([])
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const [recentError, setRecentError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState<ClearChoice | null>(null)
  const [cleared, setCleared] = useState(false)
  /** 从关到开先就地确认(复述同意说明要点):开关在同意说明上方,不能一点就开录。 */
  const [confirmEnable, setConfirmEnable] = useState(false)
  const [domainDraft, setDomainDraft] = useState('')
  const [appDraft, setAppDraft] = useState('')
  /** 存文案 key 而不是文案:切语言时跟着变。 */
  const [domainError, setDomainError] = useState<string | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  /** 权限卡正在授权 / 安装 / 更新助手:期间不因回到前台去 get()(见文件头 ⚠️),卡片也别因状态跳变被卸掉。 */
  const [permissionBusy, setPermissionBusy] = useState(false)
  const permissionBusyRef = useRef(false)
  /** 状态行「刷新状态」:重读电脑历史状态 + 让权限卡重读快照(卡自己的工具条在嵌入时不画)。 */
  const [statusRefreshing, setStatusRefreshing] = useState(false)
  const [permissionRefresh, setPermissionRefresh] = useState(0)
  const alive = useRef(true)
  const busyRef = useRef<string | null>(null)
  /** 手上 View 的 rev:只收更大的(见文件头)。 */
  const revRef = useRef(-Infinity)
  /** 预览请求序号:只认最后发出的那次(清除后的重拉不能被清除前发出、晚到的旧结果盖回去)。 */
  const recentSeq = useRef(0)
  // 平台已知不是 darwin 就不去读(主进程那边只会回 unsupported)。
  const hostUnsupported = !!hostPlatform && hostPlatform !== 'darwin'

  /** 收一份 View:比手上的旧(或一样)就丢。 */
  const accept = useCallback((next: ComputerHistoryView): void => {
    if (!alive.current || next.rev <= revRef.current) return
    revRef.current = next.rev
    setView(next)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const next = await api.get()
      if (!alive.current) return
      accept(next)
      setLoadError(null)
    } catch (error) {
      if (alive.current) setLoadError(ipcErrorText(error))
    }
  }, [api, accept])

  const loadRecent = useCallback(async (): Promise<void> => {
    if (!api) return
    const seq = ++recentSeq.current
    try {
      const [list, apps] = await Promise.all([api.recent(hoursSinceLocalMidnight(Date.now())), api.recentApps()])
      if (!alive.current || seq !== recentSeq.current) return
      setSessions(list)
      setRecentApps(apps)
      setRecentError(null)
      // 图标后到:不挡列表,取不到就一直是首字母方块(主进程有缓存,重复刷新不再查 Spotlight)
      const ids = [...new Set(list.map((s) => s.bundleId).filter((id): id is string => !!id))]
      if (ids.length) api.appIcons(ids).then((got) => { if (alive.current) setIcons((prev) => ({ ...prev, ...got })) }, () => {})
    } catch (error) {
      if (alive.current && seq === recentSeq.current) setRecentError(ipcErrorText(error))
    }
  }, [api])

  const onPermissionBusy = useCallback((next: boolean): void => {
    const was = permissionBusyRef.current
    permissionBusyRef.current = next
    if (!alive.current) return
    setPermissionBusy(next)
    // 动作结束(新助手已起,或用户选了「稍后设置」)→ 现在再读一次,让主进程按新情况立即重连。
    if (was && !next) void load()
  }, [load])

  useEffect(() => {
    alive.current = true
    if (!api || hostUnsupported) return
    void load()
    void loadRecent()
    const off = api.onChanged(accept)
    const refreshVisible = (): void => { if (document.visibilityState === 'visible' && !permissionBusyRef.current) void load() }
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      alive.current = false
      off()
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [api, hostUnsupported, load, loadRecent, accept])

  /** 写操作统一入口:同一时刻只跑一个(ref 防连点),成功用回来的 View 替换,失败就地报。 */
  const act = async (key: string, run: (a: ComputerHistoryApi) => Promise<ComputerHistoryView>): Promise<boolean> => {
    if (!api || busyRef.current) return false
    busyRef.current = key
    setBusy(key)
    setActionError(null)
    try {
      accept(await run(api))
      return true
    } catch (error) {
      if (alive.current) setActionError(ipcErrorText(error))
      return false
    } finally {
      busyRef.current = null
      if (alive.current) setBusy(null)
    }
  }

  if (!api) return null
  if (hostUnsupported || view?.state.status === 'unsupported' || (view && view.state.platform !== 'darwin')) {
    return <SettingsState icon={<History size={20} />} title={t('computerHistory.macOnly.title')} description={t('computerHistory.macOnly.body')} />
  }
  if (!view) {
    return loadError !== null
      ? <SettingsState
          icon={<History size={20} />}
          title={t('computerHistory.loadFailed', { error: loadError })}
          actions={<button type="button" className="btn ghost sm" onClick={() => void load()}>{t('computerHistory.retry')}</button>}
        />
      : <SettingsState busy icon={<Loader2 size={20} />} title={t('computerHistory.loading')} />
  }

  const now = Date.now()
  const { state, exclude } = view
  const status = state.status
  const pausedUntil = status === 'paused' && state.pausedUntil != null ? state.pausedUntil : null
  const tone = statusTone(status)
  const statusLabel = pausedUntil != null
    ? t('computerHistory.status.pausedUntil', { time: clockLabel(pausedUntil, now) })
    : t(STATUS_KEYS[status].label)
  const statusHint = status === 'recording'
    ? t('computerHistory.status.recordingHint', { time: clockLabel(state.since, now) })
    : pausedUntil != null ? t('computerHistory.status.pausedUntilHint') : t(STATUS_KEYS[status].hint)

  // 芯片上显示 App 名:先查最近见过的 App,再查今天的会话;都没有就露 bundle id。
  const appNames = new Map<string, string>()
  for (const s of sessions) if (s.bundleId) appNames.set(s.bundleId, s.app)
  for (const a of recentApps) appNames.set(a.bundleId, a.name)
  const appName = (bundleId: string): string => appNames.get(bundleId) || bundleId
  const addableApps = recentApps.filter((a) => !exclude.apps.includes(a.bundleId))
  const blocks = historyBlocks(sessions, now)

  /** 清除 / 改排除表会让主进程重订阅:权限卡正在更新 / 重启助手时锁住(见文件头 ⚠️)。 */
  const locked = !!busy || permissionBusy
  const saveExclude = async (next: ComputerHistoryExclude): Promise<boolean> =>
    permissionBusyRef.current ? false : act('exclude', (a) => a.setExclude(next))
  const addApp = async (): Promise<void> => {
    const id = normalizeBundleId(appDraft)
    if (!id) { setAppError('computerHistory.apps.invalid'); return }
    if (exclude.apps.some((x) => x.toLowerCase() === id.toLowerCase())) { setAppError('computerHistory.apps.duplicate'); return }
    setAppError(null)
    if (await saveExclude({ apps: [...exclude.apps, id], domains: exclude.domains })) setAppDraft('')
  }
  const addDomain = async (): Promise<void> => {
    const domain = normalizeDomain(domainDraft)
    if (!domain) { setDomainError('computerHistory.sites.invalid'); return }
    if (exclude.domains.includes(domain)) { setDomainError('computerHistory.sites.duplicate'); return }
    setDomainError(null)
    if (await saveExclude({ apps: exclude.apps, domains: [...exclude.domains, domain] })) setDomainDraft('')
  }
  const runClear = async (choice: ClearChoice): Promise<void> => {
    // 起点在点「删除」这一刻算,不是打开确认条那一刻。
    if (permissionBusyRef.current) return
    if (await act('clear', (a) => a.clear(clearArg(choice, Date.now())))) {
      setConfirmClear(null)
      setCleared(true)
      void loadRecent()
    }
  }
  const reveal = (): void => {
    setActionError(null)
    void api.reveal().catch((error: unknown) => { if (alive.current) setActionError(ipcErrorText(error)) })
  }
  const pendingClear = CLEAR_CHOICES.find((c) => c.id === confirmClear)
  const toggleEnabled = (on: boolean): void => {
    if (on && !state.enabled) { setConfirmEnable(true); return }
    setConfirmEnable(false)
    void act('enable', (a) => a.setEnabled(on))
  }
  const enable = async (): Promise<void> => {
    if (await act('enable', (a) => a.setEnabled(true))) setConfirmEnable(false)
  }
  /** 刷新状态:get() 在失败态会让主进程立刻重连 —— 助手更新 / 重启进行中不许点(见文件头 ⚠️)。 */
  const refreshStatus = async (): Promise<void> => {
    if (permissionBusyRef.current) return
    setPermissionRefresh((n) => n + 1)
    setStatusRefreshing(true)
    try { await load() } finally { if (alive.current) setStatusRefreshing(false) }
  }
  const showPermission = state.enabled && (needsHelperSetup(status) || permissionBusy) && hasDesktopPermissions()
  /** 等用户处理 / 正在重连:状态行给「刷新状态」(授权回来、手动重连)。 */
  const showRefresh = showPermission || (state.enabled && status === 'disconnected')
  /**
   * 暂停只在「在录 / 随时会录上」时有意义:recording,以及 disconnected(主进程正自动重连,随时可能录上;
   * pause() 不看连接态,照样落 pausedUntil 并断订阅,所以想先停一会儿的意愿不该被瞬时断线挡住)。
   * 缺权限 / 没装 / 过旧的助手在用户处理之前录不了,给暂停只会让人以为它在录;已暂停由状态行给「恢复记录」。
   */
  const showPause = state.enabled && (status === 'recording' || status === 'disconnected')

  return (
    <div className="ch-page" data-ch-status={status}>
      {actionError !== null && <div className="ch-alert" role="alert">{t('computerHistory.actionFailed', { error: actionError })}</div>}
      {view.persistError != null && <div className="ch-alert" role="alert" data-ch-persist-error="">{t('computerHistory.persistError', { error: view.persistError })}</div>}
      {view.stateError != null && <div className="ch-alert" role="alert" data-ch-state-error="">{t('computerHistory.stateError', { error: view.stateError })}</div>}

      <SettingsPanel
        anchor={anchor}
        icon={<History size={16} />}
        title={t('computerHistory.enable')}
        description={t('computerHistory.summary')}
        actions={<SettingsSwitch checked={state.enabled} disabled={!!busy} onChange={toggleEnabled} label={t('computerHistory.enable')} />}
      >
        {confirmEnable && !state.enabled && (
          <div className="ch-confirm ch-confirm--consent" role="group" aria-label={t('computerHistory.enableConfirm.title')}>
            <div>
              <strong>{t('computerHistory.enableConfirm.title')}</strong>
              <p>{t('computerHistory.enableConfirm.body', { days: view.keepDays })}</p>
            </div>
            <div className="ch-confirm-actions">
              <button type="button" className="btn ghost sm" autoFocus disabled={busy === 'enable'} onClick={() => setConfirmEnable(false)}>{t('computerHistory.cancel')}</button>
              <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => void enable()}>
                {busy === 'enable' ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}{t('computerHistory.enableConfirm.confirm')}
              </button>
            </div>
          </div>
        )}
        <div className="settings-control-list">
          <SettingsRow
            label={<span className="ch-status"><i className={`settings-status-dot${tone === 'idle' ? '' : ` ${tone}`}`} aria-hidden="true" />{statusLabel}</span>}
            description={statusHint}
            control={pausedUntil != null || status === 'paused'
              ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => void act('resume', (a) => a.resume())}>
                  {busy === 'resume' ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}{t('computerHistory.resume')}
                </button>
              : showRefresh
                ? <button type="button" className="btn ghost sm" data-ch-refresh-status="" disabled={statusRefreshing || permissionBusy} onClick={() => void refreshStatus()}>
                    <RefreshCw size={12} className={statusRefreshing ? 'spin' : undefined} aria-hidden="true" />{t('computerHistory.status.refresh')}
                  </button>
                : undefined}
          />
          {showPause && (
            <SettingsRow
              label={t('computerHistory.pause.label')}
              description={t('computerHistory.pause.hint')}
              control={<div className="ch-btn-row">
                {PAUSE_CHOICES.map((c) => (
                  <button type="button" key={c.id} className="btn ghost sm" disabled={!!busy} onClick={() => void act(`pause:${c.id}`, (a) => a.pause(pauseArg(c.id)))}>
                    {busy === `pause:${c.id}` && <Loader2 size={12} className="spin" aria-hidden="true" />}{t(c.labelKey)}
                  </button>
                ))}
              </div>}
            />
          )}
        </div>
      </SettingsPanel>

      {/* 权限卡用同页面板外壳(头 / 描边 / 15px 边距),卡内只画提示与辅助功能那一行;刷新在上面的状态行。 */}
      {showPermission && (
        <SettingsPanel
          className="ch-permission"
          icon={<MousePointer2 size={16} />}
          title={t('computerHistory.helper.title')}
          description={t('computerHistory.helper.hint')}
        >
          <DesktopPermissions mode={mode} only={['computerAccessibility']} onBusyChange={onPermissionBusy} embedded refreshToken={permissionRefresh} />
        </SettingsPanel>
      )}

      <SettingsPanel
        icon={<ShieldCheck size={16} />}
        title={t('computerHistory.about.title')}
        description={t('computerHistory.about.hint')}
        actions={<button type="button" className="btn ghost sm" onClick={reveal}><FolderOpen size={13} aria-hidden="true" />{t('computerHistory.reveal')}</button>}
      >
        <dl className="ch-about">
          <div className="ch-about-row"><dt>{t('computerHistory.about.recordedLabel')}</dt><dd>{t('computerHistory.about.recorded')}</dd></div>
          <div className="ch-about-row"><dt>{t('computerHistory.about.neverLabel')}</dt><dd>{t('computerHistory.about.never')}</dd></div>
          <div className="ch-about-row"><dt>{t('computerHistory.about.storageLabel')}</dt><dd>{t('computerHistory.about.storage', { path: view.root, days: view.keepDays })}</dd></div>
          <div className="ch-about-row"><dt>{t('computerHistory.about.accessLabel')}</dt><dd>{t('computerHistory.about.access')}</dd></div>
          <div className="ch-about-row"><dt>{t('computerHistory.about.permissionLabel')}</dt><dd>{t('computerHistory.about.permission')}</dd></div>
        </dl>
        <p className="ch-tip">{t('computerHistory.about.tip')}</p>
      </SettingsPanel>

      <SettingsPanel
        icon={<History size={16} />}
        title={t('computerHistory.recent.title')}
        description={t('computerHistory.recent.hint')}
        actions={<button type="button" className="btn ghost sm" onClick={() => void loadRecent()}><RefreshCw size={13} aria-hidden="true" />{t('computerHistory.recent.refresh')}</button>}
      >
        {recentError !== null && <p className="ch-field-error ch-recent-error" role="alert">{t('computerHistory.actionFailed', { error: recentError })}</p>}
        {blocks.length === 0
          ? <div className="settings-empty-row">{t('computerHistory.recent.empty')}</div>
          : <ol className="ch-timeline">
              {blocks.map((b) => {
                const [head, ...rest] = b.items
                return (
                  <li className="ch-block" key={b.start}>
                    <time className="ch-block-time" dateTime={new Date(b.start).toISOString()}>{formatTime(b.start)}</time>
                    <div className="ch-block-body">
                      {head
                        ? <p className="ch-block-title"><strong title={head.title}>{head.title}</strong>{head.host && <span className="ch-host">{head.host}</span>}</p>
                        : <p className="ch-block-title"><strong>{b.apps.map((a) => a.name).join(', ')}</strong></p>}
                      {rest.length > 0 && <ul className="ch-block-items">
                        {rest.slice(0, 3).map((it) => (
                          <li key={`${it.bundleId ?? it.app}:${it.title}`}>
                            {it.title !== it.app && <span className="ch-item-app">{it.app}</span>}
                            <span className="ch-item-title" title={it.title}>{it.title}</span>
                            {it.host && <span className="ch-host">{it.host}</span>}
                          </li>
                        ))}
                      </ul>}
                      <ul className="ch-apps">
                        {b.apps.slice(0, 8).map((a) => (
                          <li className="ch-app" key={a.bundleId ?? a.name} title={a.bundleId}>
                            <AppIcon name={a.name} src={a.bundleId ? icons[a.bundleId] : null} />
                            <span className="ch-app-name">{a.name}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                )
              })}
            </ol>}
      </SettingsPanel>

      <SettingsPanel icon={<Ban size={16} />} title={t('computerHistory.apps.title')} description={t('computerHistory.apps.hint')}>
        <div className="ch-chips">
          {exclude.apps.length === 0
            ? <span className="ch-empty">{t('computerHistory.apps.empty')}</span>
            : exclude.apps.map((id) => (
                <span className="ch-chip" key={id} title={id} data-bundle-id={id}>
                  <span>{appName(id)}</span>
                  <button
                    type="button"
                    aria-label={t('computerHistory.remove', { name: appName(id) })}
                    disabled={locked}
                    onClick={() => void saveExclude({ apps: exclude.apps.filter((x) => x !== id), domains: exclude.domains })}
                  ><X size={12} aria-hidden="true" /></button>
                </span>
              ))}
        </div>
        <div className="ch-add settings-inline-row">
          <select
            value=""
            aria-label={t('computerHistory.apps.add')}
            disabled={locked || addableApps.length === 0}
            onChange={(e) => {
              const id = e.target.value
              if (id && !exclude.apps.includes(id)) void saveExclude({ apps: [...exclude.apps, id], domains: exclude.domains })
            }}
          >
            <option value="">{addableApps.length > 0 ? t('computerHistory.apps.add') : t('computerHistory.apps.noRecent')}</option>
            {addableApps.map((a) => <option key={a.bundleId} value={a.bundleId}>{a.name}</option>)}
          </select>
        </div>
        {/* 还没被记到的 App 也能先排除(同意说明建议排除健康 / 财务类,不该先录一遍才能选)。 */}
        <form className="ch-add settings-inline-row" data-ch-add="app" onSubmit={(e) => { e.preventDefault(); void addApp() }}>
          <input
            type="text"
            value={appDraft}
            onChange={(e) => { setAppDraft(e.target.value); setAppError(null) }}
            placeholder={t('computerHistory.apps.manualPlaceholder')}
            aria-label={t('computerHistory.apps.manualLabel')}
            aria-invalid={appError !== null || undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
          <button type="submit" className="btn ghost sm" disabled={locked || !appDraft.trim()}>{t('computerHistory.apps.manualAdd')}</button>
        </form>
        {appError !== null && <p className="ch-field-error" role="alert">{t(appError)}</p>}
      </SettingsPanel>

      <SettingsPanel icon={<Globe2 size={16} />} title={t('computerHistory.sites.title')} description={t('computerHistory.sites.hint')}>
        <div className="ch-chips">
          {exclude.domains.length === 0
            ? <span className="ch-empty">{t('computerHistory.sites.empty')}</span>
            : exclude.domains.map((domain) => (
                <span className="ch-chip" key={domain} data-domain={domain}>
                  <span>{domain}</span>
                  <button
                    type="button"
                    aria-label={t('computerHistory.remove', { name: domain })}
                    disabled={locked}
                    onClick={() => void saveExclude({ apps: exclude.apps, domains: exclude.domains.filter((x) => x !== domain) })}
                  ><X size={12} aria-hidden="true" /></button>
                </span>
              ))}
        </div>
        <form className="ch-add settings-inline-row" data-ch-add="site" onSubmit={(e) => { e.preventDefault(); void addDomain() }}>
          <input
            type="text"
            value={domainDraft}
            onChange={(e) => { setDomainDraft(e.target.value); setDomainError(null) }}
            placeholder={t('computerHistory.sites.placeholder')}
            aria-label={t('computerHistory.sites.title')}
            aria-invalid={domainError !== null || undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
          <button type="submit" className="btn ghost sm" disabled={locked || !domainDraft.trim()}>{t('computerHistory.sites.add')}</button>
        </form>
        {domainError !== null && <p className="ch-field-error" role="alert">{t(domainError)}</p>}
      </SettingsPanel>

      <SettingsPanel icon={<Trash2 size={16} />} title={t('computerHistory.clear.label')} description={t('computerHistory.clear.hint')}>
        {pendingClear
          ? <div className="ch-confirm" role="group" aria-label={t(pendingClear.confirmKey)}>
              <div>
                <strong>{t(pendingClear.confirmKey)}</strong>
                <p>{t('computerHistory.clear.confirmNote')}</p>
              </div>
              <div className="ch-confirm-actions">
                <button type="button" className="btn ghost sm" autoFocus disabled={busy === 'clear'} onClick={() => setConfirmClear(null)}>{t('computerHistory.cancel')}</button>
                <button type="button" className="btn danger sm" disabled={locked} onClick={() => void runClear(pendingClear.id)}>
                  {busy === 'clear' ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}{t('computerHistory.clear.confirmButton')}
                </button>
              </div>
            </div>
          : <div className="ch-clear">
              {CLEAR_CHOICES.map((c) => (
                <button type="button" key={c.id} className="btn ghost sm" data-clear={c.id} disabled={locked} onClick={() => { setCleared(false); setConfirmClear(c.id) }}>{t(c.labelKey)}</button>
              ))}
              {cleared && <span className="ch-cleared" role="status">{t('computerHistory.clear.done')}</span>}
            </div>}
      </SettingsPanel>
    </div>
  )
}
