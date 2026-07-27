/**
 * 工作区详情(主区面板 / dashboard):标题 + 「在此项目中新建对话」+ 活跃会话网格(末格 View More 翻页)
 * + 可折叠「已归档」区。点击卡片进入会话;右键卡片弹出菜单:重命名 / 归档·解除归档 / 删除。
 * 上下文菜单与归档区复刻侧栏(Sidebar.tsx)同款模式,复用 ctx-menu 样式与 sidebar.* 文案。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Plus, Folder, Cloud, Pencil, Archive, ArchiveRestore, Trash2, ChevronRight, ChevronDown } from 'lucide-react'
import type { SessionRecord, WorkspaceDescriptor } from '../types'
import { useI18n } from '../i18n'
import { OverlayAt } from '@lcl/engine'

const PAGE = 11 // 每页会话格数(留一格给 View More)

export const WorkspaceDetailView: React.FC<{
  workspace: WorkspaceDescriptor
  sessions: SessionRecord[]
  onOpenSession: (id: string) => void
  onNewChat: () => void
  onRename: (id: string, title: string) => void
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
}> = ({ workspace, sessions, onOpenSession, onNewChat, onRename, onArchive, onDelete }) => {
  const { t } = useI18n()
  const [limit, setLimit] = useState(PAGE)
  const [showArchived, setShowArchived] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; archived: boolean } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  // archived 在 standalone(SQLite)是数字 0/1,强制布尔以正确分组、避免泄漏字面量「0」。
  const active = sessions.filter((s) => !s.archived)
  const archived = sessions.filter((s) => !!s.archived)
  const shown = active.slice(0, limit)
  const hasMore = active.length > limit
  const fmt = (s: string | null) => (s ? String(s).replace('T', ' ').slice(5, 16) : '')

  useEffect(() => {
    if (renaming) renameRef.current?.select()
  }, [renaming])

  // 打开菜单后,任意点击 / 右键关闭(与侧栏一致)。
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [menu])

  const openMenu = (e: React.MouseEvent, s: SessionRecord) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ id: s.id, x: e.clientX, y: e.clientY, archived: !!s.archived })
  }

  const commitRename = () => {
    if (renaming && draft.trim()) onRename(renaming, draft.trim())
    setRenaming(null)
  }

  const renderCard = (s: SessionRecord) => (
    <button
      key={s.id}
      className="wsd-card"
      style={s.archived ? { opacity: 0.6 } : undefined}
      onClick={() => { if (renaming !== s.id) onOpenSession(s.id) }}
      onContextMenu={(e) => openMenu(e, s)}
    >
      {renaming === s.id ? (
        <input
          ref={renameRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setRenaming(null)
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%', minWidth: 0, background: 'var(--bg-card)', fontSize: 13, color: 'var(--text)',
            border: 'var(--border-width) solid var(--accent-ink)', borderRadius: 'var(--radius-sm)',
            padding: '1px 5px', outline: 'none',
          }}
        />
      ) : (
        <span className="wsd-card-title">{s.title || 'New Chat'}</span>
      )}
      <span className="wsd-card-time">{fmt(s.updated_at || s.created_at)}</span>
    </button>
  )

  return (
    <div className="wsd">
      <div className="wsd-inner">
        <div className="wsd-head">
          {workspace.kind === 'cloud' ? <Cloud size={16} /> : <Folder size={16} />}
          <span className="wsd-title">{workspace.name}</span>
          <span className="wsd-count">{t('ws.detail.count', { n: active.length })}</span>
        </div>

        <button className="wsd-newchat" onClick={onNewChat}>
          <Plus size={15} /> {t('ws.detail.newChat')}
        </button>

        {active.length === 0 ? (
          <div className="wsd-empty">{t('ws.detail.empty')}</div>
        ) : (
          <div className="wsd-grid">
            {shown.map(renderCard)}
            {hasMore && (
              <button className="wsd-card wsd-more" onClick={() => setLimit((l) => l + PAGE + 1)}>
                {t('ws.detail.viewMore')}
              </button>
            )}
          </div>
        )}

        {/* 可折叠「已归档」区(默认收起;右键归档卡可解除归档 / 删除)。 */}
        {archived.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => setShowArchived((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
                cursor: 'pointer', color: 'var(--text-faint)', fontSize: 13, padding: '4px 2px',
              }}
            >
              {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Archive size={13} />
              <span>{t('sidebar.archived', { count: archived.length })}</span>
            </button>
            {showArchived && (
              <div className="wsd-grid" style={{ marginTop: 8 }}>
                {archived.map(renderCard)}
              </div>
            )}
          </div>
        )}
      </div>

      {menu && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              const s = sessions.find((x) => x.id === menu.id)
              setDraft(s?.title || '')
              setRenaming(menu.id)
              setMenu(null)
            }}
          >
            <Pencil size={13} /> {t('sidebar.rename')}
          </button>
          <button
            onClick={() => {
              onArchive(menu.id, !menu.archived)
              setMenu(null)
            }}
          >
            {menu.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {menu.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
          </button>
          {/* 永久删除仅对已归档会话开放;活跃会话的破坏性操作即「归档」。 */}
          {menu.archived && (
            <button
              className="danger"
              onClick={() => {
                const s = sessions.find((x) => x.id === menu.id)
                setMenu(null)
                if (window.confirm(t('sidebar.deleteConfirm', { name: s?.title || 'New Chat' }))) onDelete(menu.id)
              }}
            >
              <Trash2 size={13} /> {t('sidebar.delete')}
            </button>
          )}
        </OverlayAt>
      )}
    </div>
  )
}
