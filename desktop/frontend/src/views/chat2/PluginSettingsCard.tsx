import { Settings2 } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { refForSession } from '../../services/engine/targets'
import { useApp } from '../../stores/appStore'
import type { ToolEvent } from '../../types'
import type { AgentSettingsReport } from '../../../../../tangu-agent/src/contracts/agentSettings'
import './pluginSettingsCard.css'

registerMessages({
  'pluginSettings.title': { zh: '插件设置', en: 'Plugin settings' },
  'pluginSettings.open': { zh: '打开设置', en: 'Open settings' },
  'pluginSettings.configured': { zh: '已配置', en: 'Configured' },
  'pluginSettings.unconfigured': { zh: '未配置', en: 'Not configured' },
  'pluginSettings.unavailable': { zh: '当前无法读取', en: 'Currently unavailable' },
  'pluginSettings.empty': { zh: '暂无插件开放设置读取', en: 'No plugin exposes settings yet' },
  'pluginSettings.ui': { zh: '当前客户端', en: 'This client' },
  'pluginSettings.engine': { zh: '当前引擎', en: 'This engine' },
  'pluginSettings.device': { zh: '设备', en: 'Device' },
  'pluginSettings.account': { zh: '账号', en: 'Account' },
  'pluginSettings.workspace': { zh: '工作区', en: 'Workspace' },
})

/** Only the known structured tool result gets a card; malformed/failed calls retain the generic record. */
export function pluginSettingsReport(event: ToolEvent): AgentSettingsReport | null {
  if (event.name !== 'read_plugin_settings' || !event.done || event.isError || !event.result) return null
  const json = /<ui_data_([a-f0-9]+) command="read_plugin_settings">\n([\s\S]*)\n<\/ui_data_\1>/.exec(event.result)?.[2]
  if (!json || json.length > 7400) return null
  try {
    const r = JSON.parse(json)
    if (r?.kind !== 'plugin_settings' || !['ui', 'engine'].includes(r.source)) return null
    if (r.plugin && (typeof r.plugin.id !== 'string' || typeof r.plugin.name !== 'string')) return null
    if (r.fields && (!Array.isArray(r.fields) || r.fields.some((f: any) => typeof f?.key !== 'string' || typeof f.description !== 'string' || !['string', 'number', 'boolean', 'secret'].includes(f.type)))) return null
    if (r.plugins && (!Array.isArray(r.plugins) || r.plugins.some((p: any) => typeof p?.id !== 'string' || typeof p.name !== 'string'))) return null
    return r
  } catch { return null }
}

export function PluginSettingsCard({ event, sessionId }: { event: ToolEvent; sessionId?: string }) {
  const { t } = useI18n()
  const r = pluginSettingsReport(event)
  if (!r) return null
  const canOpen = r.source === 'ui' || (!!sessionId && refForSession(sessionId).kind === 'home')
  const open = (id: string) => useApp.getState().openSettings(`${r.source === 'ui' ? 'fplugin' : 'plugin'}:${id}`)
  return <section className="plugin-settings-card" aria-label={t('pluginSettings.title')}>
    <header><Settings2 size={14} /><strong>{r.plugin?.name || t('pluginSettings.title')}</strong><span>{t(`pluginSettings.${r.source}`)}</span>{r.plugin && canOpen && <button type="button" onClick={() => open(r.plugin!.id)}>{t('pluginSettings.open')}</button>}</header>
    {r.error ? <p>{t('pluginSettings.unavailable')}</p> : r.fields ? <dl>{r.fields.map((field) => <div key={field.key}>
      <dt title={field.description}>{field.key}<small>{t(`pluginSettings.${field.scope || 'device'}`)}</small></dt>
      <dd>{field.unavailable ? t('pluginSettings.unavailable') : field.type === 'secret' ? t(field.configured ? 'pluginSettings.configured' : 'pluginSettings.unconfigured') : String(field.value ?? '—')}</dd>
    </div>)}</dl> : r.plugins?.length ? <ul>{r.plugins.map((p) => <li key={p.id}><span>{p.name}</span>{canOpen && <button type="button" onClick={() => open(p.id)}>{t('pluginSettings.open')}</button>}</li>)}</ul> : <p>{t('pluginSettings.empty')}</p>}
  </section>
}
