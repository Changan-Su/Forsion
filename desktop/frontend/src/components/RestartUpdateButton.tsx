import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { notifyApp, useNotifications } from '../stores/notificationStore'
import { ipcErrorText } from '../ipcError'
import { windowKind } from '../windowKind'
import type { UpdaterStatusInfo } from '../types'
import type { CorePluginUpdates } from '../../../shared/corePlugins'
import { useCorePluginUpdates } from './CorePluginUpdates'
import { useMarketPluginUpdates } from './MarketPluginAutoUpdate'
import './restartUpdate.css'

registerMessages({
  'restartUpdate.button': { zh: '重启更新', en: 'Restart to update' },
  'restartUpdate.hint': { zh: '更新已准备好', en: 'Update ready' },
  'restartUpdate.message': { zh: '{updates} 已下载。重启 Forsion 即可启用；有未完成任务时会先提醒。', en: '{updates} downloaded. Restart Forsion to apply the update. You will be warned if tasks are still active.' },
  'restartUpdate.failed': { zh: '重启失败：{error}', en: 'Could not restart: {error}' },
})

export function readyUpdateNames(core: CorePluginUpdates, app: UpdaterStatusInfo): string[] {
  const names = core.items.filter((item) => item.phase === 'staged' || !!item.pendingVersion && item.pendingVersion !== item.installedVersion)
    .map((item) => `${item.id === 'forsion-extend' ? 'Forsion Extend' : item.id === 'tangu-computer-use' ? 'Computer Use' : item.packageName} ${item.pendingVersion || item.latestVersion || ''}`.trim())
  if (app.phase === 'downloaded') names.unshift(`Forsion ${app.version || ''}`.trim())
  return names.sort()
}

/** Pinned above the account, independent of hidden/reordered command icons and dismissible notifications. */
export function RestartUpdateButton({ expanded }: { expanded: boolean }) {
  const { t } = useI18n()
  const core = useCorePluginUpdates()
  const market = useMarketPluginUpdates()
  const [app, setApp] = useState<UpdaterStatusInfo>({ phase: 'idle' })
  const [busy, setBusy] = useState(false)
  const requesting = useRef(false)
  const notified = useRef(new Set<string>())
  const notice = useRef<string | null>(null)
  useEffect(() => window.tangu?.onUpdaterStatus?.(setApp), [])
  const updates = [...readyUpdateNames(core, app), ...market.items.filter((x) => !!x.pendingVersion).map((x) => `${x.name} ${x.pendingVersion}`)].sort()
  const key = updates.join(' · ')
  const restart = async () => {
    if (requesting.current) return
    requesting.current = true; setBusy(true)
    try { await window.tangu?.restartForUpdate?.() }
    catch (error) { notifyApp({ level: 'error', text: t('restartUpdate.failed', { error: ipcErrorText(error) }), receipt: true }) }
    finally { requesting.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!key) {
      if (notice.current) useNotifications.getState().dismiss(notice.current)
      notice.current = null
      return
    }
    if (core.checking || market.checking || windowKind() !== 'main' || notified.current.has(key)) return
    notified.current.add(key)
    notice.current = notifyApp({
      title: t('restartUpdate.hint'), text: t('restartUpdate.message', { updates: key }),
      level: 'info', event: 'system.generic', dedupeKey: 'updates.restart-ready', durationMs: 10000,
      action: { label: t('restartUpdate.button'), run: () => { void restart() } },
    })
  }, [key, core.checking, market.checking, t])
  if (!key) return null
  return <button type="button" className="rb-btn rb-restart-update" data-restart-update
    aria-label={t('restartUpdate.button')} data-rb-tip={expanded ? undefined : `${t('restartUpdate.button')} · ${key}`}
    title={expanded ? key : undefined} disabled={busy} onClick={() => void restart()}>
    <span className="rb-restart-update-icon"><RefreshCw size={18} /><span className="rb-restart-update-dot" /></span>
    {expanded && <span className="rb-restart-update-copy"><span>{t('restartUpdate.button')}</span><small>{t('restartUpdate.hint')}</small></span>}
  </button>
}
