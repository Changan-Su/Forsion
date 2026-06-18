/**
 * Historian 工作区：Historian 的活动流（标题更新 / 日志写入 / 记忆写入）。隔离于普通会话。
 */
import React, { useEffect, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { getHistorianActivity } from '../services/backendService'
import type { HistorianActivityItem, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

const ACTION_KEY: Record<string, string> = {
  title_updated: 'special.action.title_updated',
  log_appended: 'special.action.log_appended',
  memory_appended: 'special.action.memory_appended',
}

export const HistorianView: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { t } = useI18n()
  const [items, setItems] = useState<HistorianActivityItem[] | null>(null)

  const load = (): void => { void getHistorianActivity(cfg, 100).then(setItems).catch(() => setItems([])) }
  useEffect(() => {
    load()
    const id = setInterval(load, 6000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, padding: '16px 20px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontWeight: 600 }}>
        <History size={16} /> {t('special.historian.title')}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={load}><RefreshCw size={13} /></button>
      </div>
      {items && items.length === 0 && <div className="hint">{t('special.historian.empty')}</div>}
      {!!items?.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it) => (
            <div key={it.id} className="file-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
              <span style={{ fontSize: 11, color: 'var(--accent)', minWidth: 76 }}>
                {t(ACTION_KEY[it.action] || it.action)}
              </span>
              <span className="file-name" style={{ flex: 1, whiteSpace: 'normal' }}>{it.detail}</span>
              <span className="file-size" style={{ fontSize: 11 }}>{String(it.created_at).replace('T', ' ').slice(0, 16)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
