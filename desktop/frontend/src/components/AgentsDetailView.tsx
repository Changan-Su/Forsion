/**
 * 后台智能体详情(主区面板):Historian 活动流 + Muse 状态/待办 合一。
 * 右上「设置」进入 设置·后台智能体(Historian/Muse 配置)。
 */
import React, { useEffect, useState } from 'react'
import { History, Sparkles, RefreshCw, Settings } from 'lucide-react'
import { getHistorianActivity, getMuseStatus, getMuseTodos } from '../services/backendService'
import type { HistorianActivityItem, MuseStatusInfo, MuseTodo, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

const ACTION_KEY: Record<string, string> = {
  title_updated: 'special.action.title_updated',
  log_appended: 'special.action.log_appended',
  memory_appended: 'special.action.memory_appended',
  memory_updated: 'special.action.memory_updated',
}

export const AgentsDetailView: React.FC<{ cfg: TanguDesktopConfig; onOpenSettings: () => void }> = ({ cfg, onOpenSettings }) => {
  const { t } = useI18n()
  const [activity, setActivity] = useState<HistorianActivityItem[] | null>(null)
  const [muse, setMuse] = useState<MuseStatusInfo | null>(null)
  const [todos, setTodos] = useState<MuseTodo[]>([])

  const load = (): void => {
    void getHistorianActivity(cfg, 50).then(setActivity).catch(() => setActivity([]))
    void getMuseStatus(cfg).then(setMuse).catch(() => setMuse(null))
    void getMuseTodos(cfg, 'pending').then(setTodos).catch(() => setTodos([]))
  }
  useEffect(() => {
    load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="agentsd">
      <div className="agentsd-inner">
        <div className="agentsd-head">
          <Sparkles size={16} /> <span className="agentsd-title">{t('agents.detail.title')}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title={t('common.refresh')} onClick={load}><RefreshCw size={13} /></button>
          <button className="btn ghost sm" onClick={onOpenSettings}><Settings size={13} /> {t('agents.detail.settings')}</button>
        </div>

        <div className="agentsd-label"><History size={13} /> {t('agents.detail.historian')}</div>
        {activity && activity.length === 0 && <div className="hint">{t('agents.detail.noActivity')}</div>}
        {!!activity?.length && (
          <div className="agentsd-list">
            {activity.map((it) => (
              <div key={it.id} className="agentsd-row">
                <span className="agentsd-action">{t(ACTION_KEY[it.action] || it.action)}</span>
                <span className="agentsd-detail">{it.detail}</span>
                <span className="agentsd-time">{String(it.created_at).replace('T', ' ').slice(5, 16)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="agentsd-label" style={{ marginTop: 18 }}>
          <Sparkles size={13} /> {t('agents.detail.muse')}
          <span className={`mini-dot ${muse?.running ? 'ok' : ''}`} style={{ marginLeft: 6 }} />
        </div>
        {todos.length === 0 ? (
          <div className="hint">{muse?.running ? t('agents.detail.noTodos') : t('agents.detail.museOff')}</div>
        ) : (
          <div className="agentsd-list">
            {todos.map((td) => (
              <div key={td.id} className="agentsd-row">
                <span className="agentsd-detail" style={{ flex: 1 }}><b>{td.title}</b>{td.detail ? ` — ${td.detail}` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
