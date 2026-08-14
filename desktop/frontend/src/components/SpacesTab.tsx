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

const badge: React.CSSProperties = {
  fontSize: 10.5, color: 'var(--text-faint)', border: 'var(--border-width) solid var(--border)',
  borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap',
}

export const SpacesTab: React.FC = () => {
  const { t } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)
  const zh = document.documentElement.lang.startsWith('zh') // ponytail: 2~3 条新文案内联双语,不为它扩 i18n 字典
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="hint">{t('settings.spaces.hint')}</div>

      {/* 启动时进入哪个 Space:默认「上次退出时的 Space」(连同当时开着的标签页一起恢复);
          也可固定某个 Space —— 那时冷启动进的是**那个 Space 自己上次的布局**。 */}
      <div style={{ border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 10px)', padding: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 13 }}>{zh ? '启动时进入' : 'Open on startup'}</b>
          <div className="hint">
            {zh ? '默认回到上次退出时的 Space,并恢复当时打开的标签页;也可固定进某个 Space'
              : 'Defaults to the Space you left last time, with its open tabs restored; or pin a fixed Space'}
          </div>
        </div>
        <select
          value={startup}
          onChange={(e) => changeStartup(e.target.value)}
          style={{ padding: '4px 8px', border: 'var(--border-width) solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }}
        >
          <option value={LAST_EXIT_SPACE}>{zh ? '上次退出时的 Space(默认)' : 'Last Space on exit (default)'}</option>
          {spaces.map((sp) => <option key={sp.id} value={sp.id}>{label(sp.name)}</option>)}
        </select>
      </div>

      {spaces.length === 0 && <div className="hint">{t('settings.spaces.empty')}</div>}
      {spaces.map((sp) => {
        const name = label(sp.name)
        const user = isUserSpace(sp.id)
        const Icon = sp.icon
        return (
          <div key={sp.id} style={{ border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 10px)', padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {Icon && <Icon size={16} style={{ flex: '0 0 auto', color: 'var(--text-muted)' }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13 }}>{name}</b>
                  <span style={badge}>{user ? t('settings.spaces.user') : t('settings.spaces.builtin')}</span>
                </div>
              </div>
              {user && (
                <button className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={() => void uninstall(sp.id, name)}>
                  {t('settings.spaces.uninstall')}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
