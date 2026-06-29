/**
 * 设置 → 插件管理(Obsidian 风):列出所有插件(内置 + 文件夹)+ 启用开关。
 * 启用且有 settings 的插件,其设置页移到左栏「扩展」组下的一级 nav 项(见 SettingsModal),此处给「设置」直达按钮。
 * 插件清单与 agents 由 SettingsModal 统一持有并下传(避免双拉,启用态变更即时反映到 nav)。仅本地后端可用。
 */
import React from 'react'
import { setPluginEnabled, type PluginInfo } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

export const PluginsTab: React.FC<{
  cfg: TanguDesktopConfig
  plugins: PluginInfo[] | null
  onReload: () => void
  onOpenSettings: (id: string) => void
}> = ({ cfg, plugins, onReload, onOpenSettings }) => {
  const { t, locale } = useI18n()
  const nm = (p: PluginInfo): string => (locale === 'en' && p.nameEn ? p.nameEn : p.name)
  const ds = (p: PluginInfo): string => (locale === 'en' && p.descriptionEn ? p.descriptionEn : p.description)

  const toggle = async (p: PluginInfo): Promise<void> => {
    try { await setPluginEnabled(cfg, p.id, !p.enabled); onReload() } catch { /* ignore */ }
  }

  if (!plugins) return <div className="hint">{t('common.loading')}</div>
  if (!plugins.length) return <div className="hint">{t('settings.plugins.empty')}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {plugins.map((p) => (
        <div key={p.id} style={{ border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 10px)', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <b style={{ fontSize: 13 }}>{nm(p)}</b>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)', border: 'var(--border-width) solid var(--border)', borderRadius: 4, padding: '0 4px' }}>
                  {p.source === 'folder' ? t('settings.plugins.folder') : t('settings.plugins.builtin')}
                </span>
                {p.needsRestart && (
                  <span title={t('settings.plugins.needsRestartHint')} style={{ fontSize: 10.5, color: 'var(--warn, #b8860b)', border: 'var(--border-width) solid var(--warn, #b8860b)', borderRadius: 4, padding: '0 4px' }}>
                    {t('settings.plugins.needsRestart')}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{ds(p)}</div>
            </div>
            {p.settings && p.enabled && (
              <button className="btn ghost sm" onClick={() => onOpenSettings(p.id)}>{t('settings.plugins.openSettings')}</button>
            )}
            <input type="checkbox" checked={p.enabled} onChange={() => void toggle(p)} style={{ cursor: 'pointer' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
