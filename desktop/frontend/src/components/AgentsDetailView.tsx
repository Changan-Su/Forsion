/**
 * 后台智能体详情(主区面板):Historian 活动流 + 完整 Muse 工作区(勾选/忽略/注入)合一。
 * Muse 部分直接复用 MuseView(自带 4s 轮询与状态 pill);右上「设置」进入 设置·后台智能体。
 */
import React, { useEffect, useState } from 'react'
import { History, Sparkles, RefreshCw, Settings } from 'lucide-react'
import { getHistorianActivity } from '../services/backendService'
import type { HistorianActivityItem, SessionRecord, TanguDesktopConfig } from '../types'
import { useApp } from '../stores/appStore'
import { registerMessages, useI18n } from '../i18n'
import { MuseView } from './MuseView'
import { homeTarget } from '../services/engine/targets'

registerMessages({
  'special.action.icon_updated': { zh: '更新图标', en: 'icon updated' },
  'special.action.memory_candidates': { zh: '记下记忆候选', en: 'memory candidates noted' },
  'special.action.project_memory_added': { zh: '写入项目记忆', en: 'project memory saved' },
  'special.action.project_memory_compacted': { zh: '项目记忆写满，已压缩', en: 'project memory compacted when full' },
  'special.action.harness_adopted': { zh: '写入进化记录', en: 'evolution-record entry added' },
  'special.action.harness_candidates': { zh: '记下进化记录候选', en: 'evolution-record candidates noted' },
  'special.action.harness_confirm': { zh: '进化记录候选等你确认', en: 'evolution-record candidates awaiting your decision' },
  'special.action.project_memory_candidates': { zh: '项目记忆候选等你确认', en: 'project-memory candidates awaiting your decision' },
})
const ACTION_KEY: Record<string, string> = {
  icon_updated: 'special.action.icon_updated',
  title_updated: 'special.action.title_updated',
  summary_updated: 'special.action.summary_updated',
  log_appended: 'special.action.log_appended',
  memory_candidates: 'special.action.memory_candidates',
  project_memory_added: 'special.action.project_memory_added',
  project_memory_compacted: 'special.action.project_memory_compacted',
  harness_adopted: 'special.action.harness_adopted',
  harness_candidates: 'special.action.harness_candidates',
  harness_confirm: 'special.action.harness_confirm',
  project_memory_candidates: 'special.action.project_memory_candidates',
  memory_appended: 'special.action.memory_appended',
  memory_updated: 'special.action.memory_updated',
  assist_discussion: 'special.action.assist_discussion',
}

export const AgentsDetailView: React.FC<{
  cfg: TanguDesktopConfig
  sessions: SessionRecord[]
  onOpenSession: (id: string) => void
  onOpenSettings: () => void
}> = ({ cfg, sessions, onOpenSession, onOpenSettings }) => {
  const { t } = useI18n()
  const connState = useApp((s) => s.connState)
  const [activity, setActivity] = useState<HistorianActivityItem[] | null>(null)

  const load = (): void => {
    void getHistorianActivity(homeTarget(), 50).then(setActivity).catch(() => setActivity([]))
  }
  useEffect(() => {
    if (connState !== 'ok') return // 未连上后端前不发请求(避免启动期 ERR_CONNECTION_REFUSED;连上后重跑)
    load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState])

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

        {/* Muse 完整工作区(自带标题/状态 pill/轮询;注入后跳转目标会话) */}
        <div style={{ marginTop: 18 }}>
          <MuseView cfg={cfg} sessions={sessions} onInjected={onOpenSession} />
        </div>
      </div>
    </div>
  )
}
