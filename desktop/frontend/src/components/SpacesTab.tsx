/**
 * 设置 → Spaces:列出所有已注册 Space —— 内置只读,用户/市场安装的可卸载。
 * 数据源 = useSpaceStore(与 ribbon 图标同一单例,增删即时反映);卸载复用 userSpaces.deleteUserSpace
 * (按 id→磁盘目录映射删配方 + 撤 ribbon 图标 + 清命名布局)。判定内置/用户用 isUserSpace。
 */
import React from 'react'
import { useSpaceStore, label } from '@lcl/engine'
import { isUserSpace, deleteUserSpace } from '../userSpaces'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'

const badge: React.CSSProperties = {
  fontSize: 10.5, color: 'var(--text-faint)', border: 'var(--border-width) solid var(--border)',
  borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap',
}

export const SpacesTab: React.FC = () => {
  const { t } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)

  const uninstall = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(t('spaces.deleteConfirm', { name }))) return
    await deleteUserSpace(id)
    useApp.getState().toast(t('settings.spaces.uninstalled', { name }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="hint">{t('settings.spaces.hint')}</div>
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
