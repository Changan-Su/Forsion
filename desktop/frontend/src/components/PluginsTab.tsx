/**
 * 设置 → 插件管理(Obsidian 风):列出所有插件(内置 + 文件夹)+ 启用开关。
 * 启用且有 settings 的插件,其设置页移到左栏「扩展」组下的一级 nav 项(见 SettingsModal),此处给「设置」直达按钮。
 * 插件清单与 agents 由 SettingsModal 统一持有并下传(避免双拉,启用态变更即时反映到 nav)。仅本地后端可用。
 */
import React, { useEffect, useState } from 'react'
import { setPluginEnabled, uninstallPlugin, installPluginFromNpm, rescanPlugins, type PluginInfo } from '../services/backendService'
import { useApp } from '../stores/appStore'
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

  // 用户目录(~/.tangu/plugins)里的 manifest id 集合:只有这些可卸载(<pkg>/plugins 首方插件删不到,不给按钮)。
  const [userIds, setUserIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    window.tangu?.pluginsUserInstalled?.().then((l) => setUserIds(new Set(l.map((x) => x.id)))).catch(() => {})
  }, [plugins])

  // 从 npm 一条命令装引擎插件。
  const [spec, setSpec] = useState('')
  const [preferMirror, setPreferMirror] = useState(false)
  const [installing, setInstalling] = useState(false)

  const toggle = async (p: PluginInfo): Promise<void> => {
    try { await setPluginEnabled(cfg, p.id, !p.enabled); onReload() } catch { /* ignore */ }
  }

  // 运行期重扫:发现新装入文件夹的插件(市场/手动拷贝)。已有插件的代码改动受 ESM 缓存影响,仍需重启后端。
  const [rescanning, setRescanning] = useState(false)
  const doRescan = async (): Promise<void> => {
    setRescanning(true)
    try {
      const r = await rescanPlugins(cfg)
      const msg = r.addedIds.length
        ? t('settings.plugins.rescanAdded', { n: String(r.addedIds.length) })
        : t('settings.plugins.rescanNone')
      useApp.getState().toast(r.needsRestart ? `${msg} · ${t('settings.plugins.needsRestartHint')}` : msg)
      onReload()
    } catch (e: any) {
      useApp.getState().toast(e?.message || String(e), true)
    } finally { setRescanning(false) }
  }

  const uninstall = async (p: PluginInfo): Promise<void> => {
    if (!window.confirm(t('settings.plugins.uninstallConfirm', { name: nm(p) }))) return
    try {
      await uninstallPlugin(cfg, p.id).catch(() => {}) // 后端不在也继续:剩孤儿设置好过卸不掉
      await window.tangu?.pluginsUninstall?.(p.id)
      await window.tangu?.backendRestart?.() // 工具/路由无法运行期反注册,重启后 discoverPlugins 不再发现它
      useApp.getState().toast(t('settings.plugins.uninstalled', { name: nm(p) }))
      onReload()
    } catch (e: any) {
      useApp.getState().toast(e?.message || String(e), true)
    }
  }

  const doInstall = async (): Promise<void> => {
    const s = spec.trim()
    if (!s) return
    const norm = s.startsWith('npm:') ? s : `npm:${s}`
    if (!window.confirm(t('settings.plugins.npmInstallConfirm', { spec: norm }))) return
    setInstalling(true)
    try {
      const r = await installPluginFromNpm(cfg, norm, preferMirror)
      useApp.getState().toast(t('settings.plugins.installed', { id: r.id, version: r.version }))
      setSpec('')
      onReload()
    } catch (e: any) {
      useApp.getState().toast(e?.message || String(e), true)
    } finally { setInstalling(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {window.tangu?.openPluginsDir && (
          <button className="btn ghost sm" onClick={() => void window.tangu?.openPluginsDir?.()}>{t('settings.plugins.openFolder')}</button>
        )}
        <button className="btn ghost sm" title={t('settings.plugins.rescanHint')} disabled={rescanning} onClick={() => void doRescan()}>
          {rescanning ? t('settings.plugins.rescanning') : t('settings.plugins.rescan')}
        </button>
      </div>
      <div style={{ border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 10px)', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{t('settings.plugins.npmInstallTitle')}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="npm:@scope/plugin[@version]"
            value={spec}
            disabled={installing}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doInstall() }}
            style={{ flex: 1, minWidth: 200 }}
          />
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={preferMirror} onChange={(e) => setPreferMirror(e.target.checked)} />
            {t('settings.plugins.preferMirror')}
          </label>
          <button className="btn sm" onClick={() => void doInstall()} disabled={installing || !spec.trim()}>
            {installing ? t('settings.plugins.installing') : t('settings.plugins.installBtn')}
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('settings.plugins.npmInstallHint')}</div>
      </div>
      {!plugins
        ? <div className="hint">{t('common.loading')}</div>
        : !plugins.length
          ? <div className="hint">{t('settings.plugins.empty')}</div>
          : plugins.map((p) => (
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
            {p.source === 'folder' && userIds.has(p.id) && (
              <button className="btn ghost sm" style={{ color: 'var(--danger, #c0392b)' }} onClick={() => void uninstall(p)}>
                {t('settings.plugins.uninstall')}
              </button>
            )}
            <input type="checkbox" checked={p.enabled} onChange={() => void toggle(p)} style={{ cursor: 'pointer' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
