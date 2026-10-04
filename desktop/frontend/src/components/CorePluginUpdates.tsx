import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import type { CorePluginUpdate, CorePluginUpdates as UpdateState } from '../../../shared/corePlugins'
import { ipcErrorText } from '../ipcError'
import './pluginManagement.css'

registerMessages({
  'plugins.core.title': { zh: '核心插件', en: 'Core plugins' },
  'plugins.core.hint': { zh: '提供 Forsion 的基础能力，与其他插件分开管理。', en: 'Essential Forsion features, managed separately from other plugins.' },
  'plugins.installed.title': { zh: '已安装插件', en: 'Installed plugins' },
  'plugins.installed.hint': { zh: '搜索插件，打开详情调整设置，或使用开关启停。', en: 'Find a plugin, open its settings, or toggle it on and off.' },
  'plugins.search': { zh: '搜索插件', en: 'Search plugins' },
  'plugins.noResults': { zh: '没有匹配的插件。', en: 'No matching plugins.' },
  'plugins.developer': { zh: '开发工具', en: 'Developer tools' },
  'plugins.editorExtensions': { zh: '编辑器扩展', en: 'Editor extensions' },
  'plugins.bundledFeatures': { zh: '内置功能', en: 'Built-in features' },
  'plugins.core.extend': { zh: '账号、云同步、设备互联与 Connect。', en: 'Account, cloud sync, device connections and Connect.' },
  'plugins.core.computerUse': { zh: '通过 Agent 操作电脑上的应用。', en: 'Let agents operate apps on your computer.' },
  'plugins.core.amadeus': { zh: '笔记、编辑器与多维表。', en: 'Notes, editor and databases.' },
  'plugins.core.tangu': { zh: '本地 Agent 引擎与工具运行能力。', en: 'Local agent engine and tool runtime.' },
  'plugins.core.withApp': { zh: '随 Forsion 更新', en: 'Updated with Forsion' },
  'plugins.core.updates': { zh: '核心插件更新', en: 'Core plugin updates' },
  'plugins.core.updateHint': { zh: '检查更新包含核心插件。新版下载后，在下次启动时启用。', en: 'Update checks include core plugins. Downloaded updates take effect on the next launch.' },
  'plugins.core.idle': { zh: '尚未检查', en: 'Not checked yet' },
  'plugins.core.checking': { zh: '正在检查', en: 'Checking' },
  'plugins.core.downloading': { zh: '正在下载', en: 'Downloading' },
  'plugins.core.current': { zh: '已是最新', en: 'Up to date' },
  'plugins.core.staged': { zh: '已下载，重启后生效', en: 'Downloaded · restart to apply' },
  'plugins.core.incompatible': { zh: '暂无兼容的更新，请先检查 Forsion 更新', en: 'No compatible update; check for a Forsion update' },
  'plugins.core.error': { zh: '检查失败，可重试', en: 'Check failed · try again' },
  'plugins.core.development': { zh: '开发版由项目依赖管理更新', en: 'Development build · managed by project dependencies' },
  'plugins.core.restart': { zh: '重启并启用更新', en: 'Restart to apply updates' },
  'plugins.core.check': { zh: '检查所有更新', en: 'Check all updates' },
})

export function useCorePluginUpdates(): UpdateState {
  const [state, setState] = useState<UpdateState>({ checking: false, items: [] })
  useEffect(() => {
    let alive = true
    let received = false
    const off = window.tangu?.onCorePluginUpdates?.((next) => { received = true; if (alive) setState(next) })
    void window.tangu?.getCorePluginUpdates?.().then((next) => { if (alive && !received) setState(next) }).catch(() => {})
    return () => { alive = false; off?.() }
  }, [])
  return state
}

export function CorePluginUpdateStatus({ item }: { item?: CorePluginUpdate }) {
  const { t } = useI18n()
  if (!item) return null
  return <span className="plugin-update-status" data-core-phase={item.phase} title={item.error}>
    {item.installedVersion && <span>v{item.installedVersion}</span>}
    {item.pendingVersion && item.pendingVersion !== item.installedVersion && <span>→ v{item.pendingVersion}</span>}
    <span>{t(`plugins.core.${item.phase}`)}</span>
  </span>
}

/** The app updater and plugin updater have independent results; one must never mask the other's error. */
export function CorePluginUpdates({ controls = false }: { controls?: boolean }) {
  const { t } = useI18n()
  const state = useCorePluginUpdates()
  const [error, setError] = useState('')
  if (!state.items.length) return null
  const restart = state.items.some((item) => item.phase === 'staged' || !!item.pendingVersion && item.pendingVersion !== item.installedVersion)
  return <section className="core-plugin-updates" aria-label={t('plugins.core.updates')}>
    <div className="plugin-section-heading"><strong>{t('plugins.core.updates')}</strong>
      {controls && <button className="btn ghost sm" disabled={state.checking} onClick={() => { setError(''); void window.tangu?.checkForUpdates?.().catch((e) => setError(ipcErrorText(e))) }}>
        <RefreshCw size={13} className={state.checking ? 'spin' : undefined} /> {t('plugins.core.check')}
      </button>}
    </div>
    <div className="hint">{t('plugins.core.updateHint')}</div>
    {state.items.map((item) => <div className="core-plugin-update-row" key={item.id}>
      <span>{item.id === 'forsion-extend' ? 'Forsion Extend' : item.id === 'tangu-computer-use' ? 'Computer Use' : item.packageName}</span>
      <CorePluginUpdateStatus item={item} />
    </div>)}
    {error && <div role="alert" className="hint">{error}</div>}
    {restart && window.tangu?.relaunchApp && <button className="btn sm" onClick={() => { setError(''); void (window.tangu!.restartForUpdate?.() ?? window.tangu!.relaunchApp!()).catch((e) => setError(ipcErrorText(e))) }}><RefreshCw size={13} />{t('plugins.core.restart')}</button>}
  </section>
}
