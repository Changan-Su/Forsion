/**
 * 工作区详情(主区面板):标题 + 「在此项目中新建对话」+ 该项目最近会话网格,末格 View More 翻页。
 * 点击会话卡片进入对应会话。
 */
import React, { useState } from 'react'
import { Plus, Folder, Cloud } from 'lucide-react'
import type { SessionRecord, WorkspaceDescriptor } from '../types'
import { useI18n } from '../i18n'

const PAGE = 11 // 每页会话格数(留一格给 View More)

export const WorkspaceDetailView: React.FC<{
  workspace: WorkspaceDescriptor
  sessions: SessionRecord[]
  onOpenSession: (id: string) => void
  onNewChat: () => void
}> = ({ workspace, sessions, onOpenSession, onNewChat }) => {
  const { t } = useI18n()
  const [limit, setLimit] = useState(PAGE)
  const shown = sessions.slice(0, limit)
  const hasMore = sessions.length > limit
  const fmt = (s: string | null) => (s ? String(s).replace('T', ' ').slice(5, 16) : '')

  return (
    <div className="wsd">
      <div className="wsd-inner">
        <div className="wsd-head">
          {workspace.kind === 'cloud' ? <Cloud size={16} /> : <Folder size={16} />}
          <span className="wsd-title">{workspace.name}</span>
          <span className="wsd-count">{t('ws.detail.count', { n: sessions.length })}</span>
        </div>

        <button className="wsd-newchat" onClick={onNewChat}>
          <Plus size={15} /> {t('ws.detail.newChat')}
        </button>

        {sessions.length === 0 ? (
          <div className="wsd-empty">{t('ws.detail.empty')}</div>
        ) : (
          <div className="wsd-grid">
            {shown.map((s) => (
              <button key={s.id} className="wsd-card" onClick={() => onOpenSession(s.id)}>
                <span className="wsd-card-title">{s.title || 'New Chat'}</span>
                <span className="wsd-card-time">{fmt(s.updated_at || s.created_at)}</span>
              </button>
            ))}
            {hasMore && (
              <button className="wsd-card wsd-more" onClick={() => setLimit((l) => l + PAGE + 1)}>
                {t('ws.detail.viewMore')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
