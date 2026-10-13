/**
 * 设置 → 系统 → 电脑历史。只做界面:落盘 / 保留 / 清除 / 暂停 / 连 helper 全在主进程(electron/computerHistory.ts)。
 * 读写、开关、按 rev 取最新、权限卡忙时不触发 get() 这些在 useComputerHistory(首次引导共用同一份,⚠️ 见那边文件头);
 * 状态行文案与各入口出不出现在 computerHistoryModel 的 statusLine / statusEntries;五条说明在 ComputerHistoryAbout。
 * 清除 / 改排除表同样会让主进程重订阅,权限卡忙时一并禁用(主进程的拉起本身也按 helperBusy 把关)。
 * 辅助功能授权复用 DesktopPermissions(只画 computerAccessibility;不涉及屏幕录制)。
 * Windows:没有要授的系统权限,也没有单独安装的助手(采集组件随 Forsion 内置的 Computer Use 包走)—— 不挂权限卡,
 * 缺 / 旧组件的状态行改说「重装 / 更新 Forsion」,同意说明里与 mac 不同的条目换 computerHistory.win.* 的键。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, FolderOpen, Globe2, History, Loader2, MousePointer2, Play, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import type { ComputerHistoryExclude, ComputerHistorySession } from '../../../shared/computerHistory'
import { useI18n } from '../i18n'
import { formatLongDate, formatTime } from '../format/time'
import { ipcErrorText } from '../ipcError'
import { DesktopPermissions, hasDesktopPermissions } from './DesktopPermissions'
import { SettingsPanel, SettingsRow, SettingsState, SettingsSwitch } from './SettingsPrimitives'
import {
  CLEAR_CHOICES, PAUSE_CHOICES, clearArg, dayOptions, dayRange, dayStartAgo, normalizeBundleId, normalizeExeName,
  normalizeDomain, historyBlocks, pauseArg, statusEntries, statusLine, type ClearChoice,
} from './computerHistoryModel'
import { ComputerHistoryAbout } from './ComputerHistoryAbout'
import { useComputerHistory } from './useComputerHistory'
import './computerHistoryMessages'
import './computerHistory.css'

export { computerHistoryApi } from './useComputerHistory'

/** 图标取不到时的首字母方块。 */
function AppIcon({ name, src }: { name: string; src?: string | null }): React.ReactNode {
  return src
    ? <img className="ch-app-icon" src={src} alt="" draggable={false} />
    : <span className="ch-app-icon ch-app-icon--letter" aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() ?? '?'}</span>
}

/** @param anchor 设置搜索落点(settingsSearchIndex.ts),挂在首张面板上。 */
export function ComputerHistorySettings({ mode, anchor }: { mode: 'light' | 'dark'; anchor?: string }): React.ReactNode {
  const { t } = useI18n()
  const history = useComputerHistory()
  const {
    api, view, loadError, busy, actionError, setActionError, alive, load, act, hostUnsupported,
    confirmEnable, setConfirmEnable, toggleEnabled, enable, permissionBusy, permissionBusyRef, onPermissionBusy,
    statusRefreshing, permissionRefresh, refreshStatus,
  } = history
  const [sessions, setSessions] = useState<ComputerHistorySession[]>([])
  const [recentApps, setRecentApps] = useState<Array<{ name: string; bundleId: string }>>([])
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  /** 时间线看往回第几天(0 = 今天)。day = 下拉框选的;sessionsDay = 手上 sessions 属于哪天(切换瞬间两者不同,按后者画)。 */
  const [day, setDay] = useState(0)
  const [sessionsDay, setSessionsDay] = useState(0)
  /** 有记录的日子(YYYY-MM-DD):下拉只列这些。 */
  const [days, setDays] = useState<string[]>([])
  const dayRef = useRef(0)
  const [recentError, setRecentError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState<ClearChoice | null>(null)
  const [cleared, setCleared] = useState(false)
  const [domainDraft, setDomainDraft] = useState('')
  const [appDraft, setAppDraft] = useState('')
  /** 存文案 key 而不是文案:切语言时跟着变。 */
  const [domainError, setDomainError] = useState<string | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  /** 预览请求序号:只认最后发出的那次(清除后的重拉不能被清除前发出、晚到的旧结果盖回去)。 */
  const recentSeq = useRef(0)

  const loadRecent = useCallback(async (): Promise<void> => {
    if (!api) return
    const seq = ++recentSeq.current
    const offset = dayRef.current
    const { hours, end } = dayRange(Date.now(), offset)
    try {
      const [list, apps, recorded] = await Promise.all([api.recent(hours, end), api.recentApps(), api.days()])
      if (!alive.current || seq !== recentSeq.current) return
      setSessions(list)
      setSessionsDay(offset)
      setDays(recorded)
      setRecentApps(apps)
      setRecentError(null)
      // 图标后到:不挡列表,取不到就一直是首字母方块(主进程有缓存,重复刷新不再查 Spotlight)
      const ids = [...new Set(list.map((s) => s.bundleId).filter((id): id is string => !!id))]
      if (ids.length) api.appIcons(ids).then((got) => { if (alive.current) setIcons((prev) => ({ ...prev, ...got })) }, () => {})
    } catch (error) {
      if (alive.current && seq === recentSeq.current) setRecentError(ipcErrorText(error))
    }
  }, [api])

  // 时间线只有这一页要:挂载时拉一次(状态那一份由 useComputerHistory 自己读,它的 effect 排在前面,alive 已置回 true)。
  useEffect(() => {
    if (api && !hostUnsupported) void loadRecent()
  }, [api, hostUnsupported, loadRecent])

  if (!api) return null
  if (history.unsupported) {
    return <SettingsState icon={<History size={20} />} title={t('computerHistory.unsupportedPlatform.title')} description={t('computerHistory.unsupportedPlatform.body')} />
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
  /** 主进程所在平台(View 自带,比 window.tangu.platform 更贴近真正在采集的那一端)。 */
  const windows = state.platform === 'win32'
  const { tone, label: statusLabel, hint: statusHint, pausedUntil } = statusLine(state, now, t)

  // 芯片上显示 App 名:先查最近见过的 App,再查今天的会话;都没有就露 bundle id。
  const appNames = new Map<string, string>()
  for (const s of sessions) if (s.bundleId) appNames.set(s.bundleId, s.app)
  for (const a of recentApps) appNames.set(a.bundleId, a.name)
  const appName = (bundleId: string): string => appNames.get(bundleId) || bundleId
  const addableApps = recentApps.filter((a) => !exclude.apps.includes(a.bundleId))
  const blocks = historyBlocks(sessions, dayStartAgo(now, sessionsDay))
  const pickDay = (offset: number): void => {
    dayRef.current = offset
    setDay(offset)
    void loadRecent()
  }
  const dayLabel = (offset: number): string =>
    offset === 0 ? t('computerHistory.day.today') : offset === 1 ? t('computerHistory.day.yesterday') : formatLongDate(dayStartAgo(now, offset))

  /** 清除 / 改排除表会让主进程重订阅:权限卡正在更新 / 重启助手时锁住(见文件头 ⚠️)。 */
  const locked = !!busy || permissionBusy
  const saveExclude = async (next: ComputerHistoryExclude): Promise<boolean> =>
    permissionBusyRef.current ? false : act('exclude', (a) => a.setExclude(next))
  const addApp = async (): Promise<void> => {
    // Windows 的 App 标识是小写 exe 文件名(事件里就是小写):手填的也规整成小写,芯片才对得上最近用过的 App 名
    const id = windows ? normalizeExeName(appDraft) : normalizeBundleId(appDraft)
    if (!id) { setAppError(windows ? 'computerHistory.win.invalid' : 'computerHistory.apps.invalid'); return }
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
  const { permission: showPermission, refresh: showRefresh, pause: showPause } = statusEntries(state, permissionBusy, hasDesktopPermissions())

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
        actions={<button type="button" className="btn ghost sm" onClick={reveal}><FolderOpen size={13} aria-hidden="true" />{t(windows ? 'computerHistory.win.reveal' : 'computerHistory.reveal')}</button>}
      >
        <ComputerHistoryAbout view={view} />
      </SettingsPanel>

      <SettingsPanel
        icon={<History size={16} />}
        title={t('computerHistory.recent.title')}
        description={t('computerHistory.recent.hint')}
        actions={<div className="ch-day-row">
          <select className="ch-day" aria-label={t('computerHistory.day.label')} value={day} onChange={(e) => pickDay(Number(e.target.value))}>
            {dayOptions(now, view.keepDays, days, day).map((i) => <option key={i} value={i}>{dayLabel(i)}</option>)}
          </select>
          <button type="button" className="btn ghost sm" onClick={() => void loadRecent()}><RefreshCw size={13} aria-hidden="true" />{t('computerHistory.recent.refresh')}</button>
        </div>}
      >
        {recentError !== null && <p className="ch-field-error ch-recent-error" role="alert">{t('computerHistory.actionFailed', { error: recentError })}</p>}
        {blocks.length === 0
          ? <div className="settings-empty-row">{sessionsDay === 0 ? t('computerHistory.recent.empty') : t('computerHistory.recent.emptyDay')}</div>
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

      <SettingsPanel icon={<Ban size={16} />} title={t('computerHistory.apps.title')} description={t(windows ? 'computerHistory.win.appsHint' : 'computerHistory.apps.hint')}>
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
            placeholder={t(windows ? 'computerHistory.win.manualPlaceholder' : 'computerHistory.apps.manualPlaceholder')}
            aria-label={t(windows ? 'computerHistory.win.manualLabel' : 'computerHistory.apps.manualLabel')}
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
