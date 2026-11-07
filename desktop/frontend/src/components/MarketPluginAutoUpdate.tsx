import { useEffect, useState } from 'react'
import { Pin, RefreshCw, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { ipcErrorText } from '../ipcError'
import { formatDate } from '../format/time'
import { SettingsSwitch } from './SettingsPrimitives'
import { compareMarketVersions, type KeptPluginVersion, type MarketPluginUpdates, type MarketPluginUpdate } from '../../../shared/marketPluginUpdates'
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
  'market.autoUpdateAll': { zh: '自动更新所有插件', en: 'Auto-update all plugins' },
  'market.autoUpdateAllHint': { zh: '新版本在后台下好，下次启动时换上。单个插件可以在详情页关掉或固定版本。', en: 'New versions download in the background and apply the next time Forsion starts. Turn it off or pin a version for a single plugin on its page.' },
  'market.installedVersion': { zh: '已安装 {version}', en: 'Installed {version}' },
  'market.pendingRestart': { zh: '{version} 已下载，重启后启用', en: '{version} downloaded, applies after restart' },
  'market.rollbackPending': { zh: '回退到 {version} 将在重启后完成', en: 'Rollback to {version} finishes after restart' },
  'market.pinnedAt': { zh: '已固定在 {version}，不会自动更新。', en: 'Pinned at {version}. It will not update automatically.' },
  'market.pinnedChip': { zh: '已固定 {version}', en: 'Pinned at {version}' },
  'market.resumeAutoUpdate': { zh: '恢复自动更新', en: 'Resume auto-update' },
  'market.keptVersions': { zh: '本机保留的旧版本', en: 'Versions kept on this device' },
  'market.keptAt': { zh: '{date} 留存', en: 'Kept {date}' },
  'market.keptIncompatible': { zh: '需要更新的 Forsion', en: 'Needs a newer Forsion' },
  'market.rollback': { zh: '回退', en: 'Roll back' },
  'market.switchBack': { zh: '换回', en: 'Switch back' },
  'market.rollbackHint': { zh: '回退只换插件本身，插件的资料不动；新版若改过资料格式，旧版可能读不了。', en: 'Rolling back only swaps the plugin itself and leaves its data as is. If a newer version changed the data format, an older one may not read it.' },
  'market.rollbackHintStore': { zh: '更早的版本可在「版本」页从商店重装。', en: 'Install earlier versions from the store on the Versions tab.' },
  'market.rollbackFailed': { zh: '没能回退：{error}', en: 'Could not roll back: {error}' },
  'market.rolledBack': { zh: '{name} 已换成 {version}', en: '{name} is now on {version}' },
  'market.rollbackRestart': { zh: '重启 Forsion 后生效', en: 'Takes effect after restarting Forsion' },
  'market.rollbackDeferred': { zh: '{name} 的文件正在使用，重启后换成 {version}', en: '{name} is in use. It switches to {version} after a restart' },
})

const v = (version: string) => `v${version.replace(/^v/, '')}`
const EMPTY: MarketPluginUpdates = { checking: false, autoUpdateAll: true, items: [], local: [] }

export function useMarketPluginUpdates(): MarketPluginUpdates {
  const [state, setState] = useState<MarketPluginUpdates>(EMPTY)
  useEffect(() => window.tangu?.onMarketUpdateStatus?.((next) => setState({ ...EMPTY, ...next })), [])
  return state
}

/** Kept versions newer than the installed one are the way back after a rollback ("Switch back"). */
const isNewer = (a: string, b?: string) => (compareMarketVersions(a, b) ?? 0) > 0

/**
 * The version block in a plugin's detail sidebar (store) or detail page (settings, hand-copied plugins).
 * Store plugins get the auto-update switch and pin; hand-copied plugins only the kept versions.
 */
export function PluginVersionBlock({ id, item, installedVersion, kept, autoUpdateAll, disabled, onError, onRollback }: {
  /** Store item id; absent for hand-copied plugins (no auto-update). */
  id?: string
  item?: MarketPluginUpdate
  installedVersion?: string | null
  kept: KeptPluginVersion[]
  autoUpdateAll: boolean
  disabled?: boolean
  onError: (text: string) => void
  onRollback: (version: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [choice, setChoice] = useState<boolean | null>(null)
  const [rolling, setRolling] = useState<string | null>(null)
  const store = !!id && !!window.tangu?.marketSetAutoUpdate
  const installed = item?.installedVersion || installedVersion || undefined
  const pinned = item?.pinnedVersion
  const on = choice ?? (item ? item.autoUpdate : autoUpdateAll)
  const setAuto = async (next: boolean) => {
    if (!id) return
    setSaving(true); setChoice(next)
    try { await window.tangu!.marketSetAutoUpdate!(id, next) }
    catch (e) { onError(t('market.autoUpdateFailed', { error: ipcErrorText(e) })) }
    finally { setSaving(false); setChoice(null) }
  }
  const roll = async (version: string) => {
    setRolling(version)
    try { await onRollback(version) } finally { setRolling(null) }
  }
  const busy = disabled || saving || !!rolling
  if (!store && !kept.length) return null
  return <div className="pvb" data-plugin-versions={id || ''} onClick={(e) => e.stopPropagation()}>
    {store && pinned && <div className="pvb-pin" data-plugin-pinned={pinned}>
      <Pin size={13} aria-hidden="true" />
      <div>{t('market.pinnedAt', { version: v(pinned) })}<br /><button className="btn sm" disabled={busy} onClick={() => void setAuto(true)}>{t('market.resumeAutoUpdate')}</button></div>
    </div>}
    {store && <div className="pvb-row" title={t('market.autoUpdateHint')}>
      <span>{t('market.autoUpdate')}</span>
      <SettingsSwitch checked={on} disabled={busy} label={t('market.autoUpdate')} data-market-auto-update={id} onChange={(next) => void setAuto(next)} />
    </div>}
    {store && installed && <div className="pvb-sub" role="status">
      {t('market.installedVersion', { version: v(installed) })}
      {item?.pendingVersion ? <> · {t(item.pendingRollback ? 'market.rollbackPending' : 'market.pendingRestart', { version: v(item.pendingVersion) })}</>
        : item?.phase === 'downloading' ? <> · {t('market.autoUpdateDownloading')}</>
          : item?.phase === 'checking' ? <> · {t('market.autoUpdateChecking')}</> : null}
    </div>}
    {item?.phase === 'error' && <div className="pvb-sub is-error" role="alert">{t('market.autoUpdateError', { error: item.error || '' })}</div>}
    {!!kept.length && <>
      <div className="pvb-head">{t('market.keptVersions')}</div>
      {kept.map((k) => <div className="pvb-ver" key={k.version} data-kept-version={k.version}>
        <div>{v(k.version)}<small>{!k.compatible ? t('market.keptIncompatible') : k.keptAt ? t('market.keptAt', { date: formatDate(k.keptAt) }) : ''}</small></div>
        <button className="btn sm" disabled={busy || !k.compatible} data-plugin-rollback={k.version} onClick={() => void roll(k.version)}>
          {rolling === k.version ? <RefreshCw size={13} className="mk-spin" /> : <Undo2 size={13} />}{t(isNewer(k.version, installed) ? 'market.switchBack' : 'market.rollback')}
        </button>
      </div>)}
      <p className="pvb-hint">{t('market.rollbackHint')}{store ? ` ${t('market.rollbackHintStore')}` : ''}</p>
    </>}
  </div>
}

/** Only pinned plugins carry a badge on their card. */
export function PinnedChip({ item }: { item?: MarketPluginUpdate }) {
  const { t } = useI18n()
  if (!item?.pinnedVersion) return null
  return <span className="pvb-tag is-accent" data-market-pinned={item.id}><Pin size={11} aria-hidden="true" />{t('market.pinnedChip', { version: v(item.pinnedVersion) })}</span>
}

/** The global switch on the Updates page, next to "Check plugin updates". */
export function AutoUpdateAllRow({ state, onError, children }: { state: MarketPluginUpdates; onError: (text: string) => void; children?: React.ReactNode }) {
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [choice, setChoice] = useState<boolean | null>(null)
  if (!window.tangu?.marketSetAutoUpdateAll) return <>{children}</>
  const change = async (on: boolean) => {
    setSaving(true); setChoice(on)
    try { await window.tangu!.marketSetAutoUpdateAll!(on) }
    catch (e) { onError(t('market.autoUpdateFailed', { error: ipcErrorText(e) })) }
    finally { setSaving(false); setChoice(null) }
  }
  return <div className="pvb-tools" data-market-auto-update-all>
    <div className="pvb-row">
      <SettingsSwitch checked={choice ?? state.autoUpdateAll} disabled={saving} label={t('market.autoUpdateAll')} onChange={(on) => void change(on)} />
      <div><span>{t('market.autoUpdateAll')}</span><span className="pvb-sub">{t('market.autoUpdateAllHint')}</span></div>
    </div>
    {children}
  </div>
}

/**
 * 设置 → 插件 里手动拷进来的插件(不是商店装的):只有「本机保留的旧版本」,没有自动更新开关。
 * 按 manifest id 认(装载 id 与目录名可以不同,版本库按目录记)。开发态加载(链接)不在版本库里,自然不出现。
 */
export function LocalPluginVersions({ type, pluginId, name, say, onRolledBack }: {
  type: 'plugin' | 'amadeus-plugin'; pluginId: string; name: string
  say: (text: string, error?: boolean) => void
  /** Reload after the swap; `restart` = the running copy cannot be replaced without a restart (or reloading failed). */
  onRolledBack: (res: { type: string; id?: string }) => Promise<{ restart?: boolean } | void>
}) {
  const { t } = useI18n()
  const state = useMarketPluginUpdates()
  const local = state.local.find((x) => x.type === type && x.id === pluginId)
  if (!local || !window.tangu?.marketRollback) return null
  const roll = async (version: string) => {
    try {
      const res = await window.tangu!.marketRollback!(local.type, local.slug, version)
      const after = await Promise.resolve(onRolledBack(res)).catch(() => ({ restart: true }))
      say(`${t('market.rolledBack', { name, version: v(version) })}${after?.restart ? ` · ${t('market.rollbackRestart')}` : ''}`)
    } catch (e) { say(t('market.rollbackFailed', { error: ipcErrorText(e) }), true) }
  }
  return <PluginVersionBlock installedVersion={local.version} kept={local.keptVersions} autoUpdateAll={state.autoUpdateAll} onError={(text) => say(text, true)} onRollback={roll} />
}
