import { useEffect, useState } from 'react'
import { registerMessages, useI18n } from '../i18n'
import { ipcErrorText } from '../ipcError'
import type { MarketPluginUpdates, MarketPluginUpdate } from '../../../shared/marketPluginUpdates'
import './marketPluginUpdates.css'

registerMessages({
  'market.autoUpdate': { zh: '自动更新', en: 'Auto-update' },
  'market.autoUpdateHint': { zh: '检测到新版本后自动下载安装；需要重启时会提醒。', en: 'Automatically download and install new versions. You will be notified when a restart is needed.' },
  'market.autoUpdateFailed': { zh: '没能保存自动更新选项：{error}', en: 'Could not save auto-update preference: {error}' },
  'market.autoUpdateDownloading': { zh: '正在下载更新', en: 'Downloading update' },
  'market.autoUpdateChecking': { zh: '正在检查更新', en: 'Checking for updates' },
  'market.autoUpdatePending': { zh: '{version} 已准备好，重启后启用', en: '{version} ready, restart to apply' },
  'market.autoUpdateError': { zh: '自动更新失败：{error}', en: 'Auto-update failed: {error}' },
  'market.autoUpdateCheck': { zh: '检查插件更新', en: 'Check plugin updates' },
})

export function useMarketPluginUpdates(): MarketPluginUpdates {
  const [state, setState] = useState<MarketPluginUpdates>({ checking: false, items: [] })
  useEffect(() => window.tangu?.onMarketUpdateStatus?.(setState), [])
  return state
}

export function MarketPluginAutoUpdate({ id, item, disabled, onError }: {
  id: string; item?: MarketPluginUpdate; disabled?: boolean; onError: (text: string) => void
}) {
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [choice, setChoice] = useState<boolean | null>(null)
  if (!window.tangu?.marketSetAutoUpdate) return null
  const change = async (on: boolean) => {
    setSaving(true); setChoice(on)
    try { await window.tangu!.marketSetAutoUpdate!(id, on) }
    catch (e) { onError(t('market.autoUpdateFailed', { error: ipcErrorText(e) })) }
    finally { setSaving(false); setChoice(null) }
  }
  return <div className="mk-auto-update" data-market-auto-update={id} onClick={(e) => e.stopPropagation()}>
    <label title={t('market.autoUpdateHint')}>
      <input type="checkbox" checked={choice ?? item?.autoUpdate ?? false} disabled={disabled || saving} onChange={(e) => void change(e.target.checked)} />
      <span>{t('market.autoUpdate')}</span>
    </label>
    {item?.pendingVersion ? <small role="status">{t('market.autoUpdatePending', { version: item.pendingVersion })}</small>
      : item?.phase === 'downloading' ? <small role="status">{t('market.autoUpdateDownloading')}</small>
        : item?.phase === 'checking' ? <small role="status">{t('market.autoUpdateChecking')}</small> : null}
    {item?.phase === 'error' && <small className="is-error" role="alert">{t('market.autoUpdateError', { error: item.error || '' })}</small>}
  </div>
}
