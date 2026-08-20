/**
 * 设置 → Spaces:列出所有已注册 Space —— 内置只读,用户/市场安装的可卸载。
 * 数据源 = useSpaceStore(与 ribbon 图标同一单例,增删即时反映);卸载复用 userSpaces.deleteUserSpace
 * (按 id→磁盘目录映射删配方 + 撤 ribbon 图标 + 清命名布局)。判定内置/用户用 isUserSpace。
 */
import React from 'react'
import { useSpaceStore, label } from '@lcl/engine'
import { isUserSpace, deleteUserSpace } from '../userSpaces'
import { DEFAULT_SPACE_KEY, LAST_EXIT_SPACE, startupSpacePref } from '../spaces'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { LayoutGrid, Rocket } from 'lucide-react'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'

export const SpacesTab: React.FC = () => {
  const { t } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)
  const [startup, setStartup] = React.useState<string>(startupSpacePref)
  const changeStartup = (v: string): void => {
    setStartup(v)
    try { localStorage.setItem(DEFAULT_SPACE_KEY, v) } catch { /* private mode */ }
  }

  const uninstall = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(t('spaces.deleteConfirm', { name }))) return
    await deleteUserSpace(id)
    useApp.getState().toast(t('settings.spaces.uninstalled', { name }))
  }

  return (
    <>
      {/* 启动时进入哪个 Space:默认「上次退出时的 Space」(连同当时开着的标签页一起恢复);
          也可固定某个 Space —— 那时冷启动进的是**那个 Space 自己上次的布局**。 */}
      <SettingsPanel icon={<Rocket size={16} />} title={t('settings.spaces.startupTitle')} description={t('settings.spaces.startupHint')}>
        <SettingsRow
          label={t('settings.spaces.startupLabel')}
          control={(
            <select value={startup} onChange={(e) => changeStartup(e.target.value)}>
              <option value={LAST_EXIT_SPACE}>{t('settings.spaces.lastExit')}</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.id}>{label(sp.name)}</option>)}
            </select>
          )}
        />
      </SettingsPanel>

      <SettingsPanel icon={<LayoutGrid size={16} />} title={t('settings.spaces.libraryTitle', { count: spaces.length })} description={t('settings.spaces.hint')}>
        <div className="settings-collection-list">
          {spaces.length === 0 && <div className="settings-empty-row">{t('settings.spaces.empty')}</div>}
          {spaces.map((sp) => {
            const name = label(sp.name)
            const user = isUserSpace(sp.id)
            const Icon = sp.icon
            return (
              <div key={sp.id} className="settings-collection-row">
                <span className="settings-collection-icon">{Icon ? <Icon size={16} /> : <LayoutGrid size={16} />}</span>
                <span className="settings-collection-name"><strong>{name}</strong><small>{sp.id}</small></span>
                <span className="settings-badge">{user ? t('settings.spaces.user') : t('settings.spaces.builtin')}</span>
                {user && <button className="btn ghost sm danger-ink" onClick={() => void uninstall(sp.id, name)}>{t('settings.spaces.uninstall')}</button>}
              </div>
            )
          })}
        </div>
      </SettingsPanel>
    </>
  )
}
