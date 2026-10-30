/**
 * 单个插件的设置页(Obsidian 式:每个已启用且有 settings 的插件在「扩展」组下成一级项,点进此页)。
 * 作用域 全局 / 按 agent;表单由 PluginSettingsForm 据 schema 通用渲染。仅本地后端可用。
 */
import React, { useState } from 'react'
import type { NormalAgentDef, TanguDesktopConfig } from '../types'
import type { PluginInfo } from '../services/backendService'
import { useI18n } from '../i18n'
import { PluginSettingsForm } from './PluginSettingsForm'
import { agentName } from '../agentName'

export const PluginSettingsPage: React.FC<{ cfg: TanguDesktopConfig; plugin: PluginInfo; agents: NormalAgentDef[] }> = ({ cfg, plugin, agents }) => {
  const { t } = useI18n()
  const [scopeMode, setScopeMode] = useState<'global' | 'agent'>('global')
  const [agentSlug, setAgentSlug] = useState(agents[0]?.slug || '')
  const scopeStr = scopeMode === 'agent' && agentSlug ? `agent:${agentSlug}` : 'global'

  if (!plugin.settings) return <div className="hint">{t('settings.plugins.noSettings')}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {plugin.scopes.includes('agent') && (
        <div className="field">
          <label>{t('settings.plugins.scope')}</label>
          <div className="seg" style={{ marginBottom: 6 }}>
            <button className={scopeMode === 'global' ? 'active' : ''} onClick={() => setScopeMode('global')}>{t('settings.plugins.scopeGlobal')}</button>
            <button className={scopeMode === 'agent' ? 'active' : ''} onClick={() => setScopeMode('agent')}>{t('settings.plugins.scopeAgent')}</button>
          </div>
          {scopeMode === 'agent' && (
            <select value={agentSlug} onChange={(e) => setAgentSlug(e.target.value)}>
              {agents.length === 0 && <option value="">{t('settings.plugins.selectAgent')}</option>}
              {agents.map((a) => <option key={a.slug} value={a.slug}>{agentName(a)}</option>)}
            </select>
          )}
        </div>
      )}
      {plugin.settings.fields.length === 0
        ? <div className="hint">{t('settings.plugins.noSettings')}</div>
        : <PluginSettingsForm key={`${plugin.id}:${scopeStr}`} cfg={cfg} pluginId={plugin.id} scope={scopeStr} fields={plugin.settings.fields} />}
    </div>
  )
}
