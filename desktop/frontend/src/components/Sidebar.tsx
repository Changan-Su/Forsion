/**
 * 会话侧栏:按工作区分组(Cloud 工作区 / Tangu 默认工作区 常驻 + 其它本地工作区)。
 * 每个工作区组头 hover「+」直接在该区新建会话;底部「添加本地工作区」浏览文件夹新增。
 * 折叠态存 localStorage(键=工作区 key)。右键/省略号菜单 + 内联重命名,标记层 token CSS。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, Settings, ChevronDown, ChevronRight, Folder, Cloud, FolderPlus, History, Sparkles } from 'lucide-react'
import { CLOUD_WORKSPACE_KEY, type SessionRecord, type WorkspaceDescriptor } from '../types'
import { BrandLogo } from './BrandLogo'
import { AccountCard } from './AccountCard'
import { useI18n } from '../i18n'

const COLLAPSE_KEY = 'forsion_tangu_collapsed_projects'

function loadCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')) } catch { return new Set() }
}
function saveCollapsed(s: Set<string>): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}

interface SidebarProps {
  collapsed: boolean
  sessions: SessionRecord[]
  archivedSessions: SessionRecord[]
  activeId: string | null
  runningIds: Set<string>
  unreadIds: Set<string>
  onSelect: (id: string) => void
  /** 工作区列表(Cloud + Tangu 默认 常驻 + 其它本地;空工作区也展示)。 */
  workspaces: WorkspaceDescriptor[]
  /** 在指定工作区下新建会话(组头 + 按钮)。 */
  onNewInWorkspace: (ws: WorkspaceDescriptor) => void
  /** 浏览文件夹新增本地工作区。 */
  onAddWorkspace: () => void
  /** 重命名工作区(改其 project_path 下所有会话的 project_name;系统区不触发)。 */
  onRenameWorkspace: (ws: WorkspaceDescriptor, name: string) => void
  /** 移除工作区(删除其下所有会话;磁盘文件夹不动)。 */
  onRemoveWorkspace: (ws: WorkspaceDescriptor) => void
  onRename: (id: string, title: string) => void
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  onToast?: (text: string, error?: boolean) => void
  /** 账号登录/登出后回调(让上层重连托管后端 / 刷新模型)。 */
  onAuthChange?: () => void
  /** Special Agents 工作区入口(本地后端才显示);点击进入 Historian/Muse 视图。 */
  showSpecial?: boolean
  specialView?: 'historian' | 'muse' | null
  onOpenSpecial?: (v: 'historian' | 'muse') => void
}

interface MenuState {
  id: string
  x: number
  y: number
  archived: boolean
}

export const Sidebar: React.FC<SidebarProps> = (p) => {
  const { t } = useI18n()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsed)
  const renameRef = useRef<HTMLInputElement>(null)
  // 工作区操作菜单 + 内联重命名(与会话各自独立的状态,避免 key/id 串扰)。
  const [wsMenu, setWsMenu] = useState<{ ws: WorkspaceDescriptor; x: number; y: number } | null>(null)
  const [wsRenaming, setWsRenaming] = useState<string | null>(null)
  const [wsDraft, setWsDraft] = useState('')
  const wsRenameRef = useRef<HTMLInputElement>(null)

  // 会话按工作区键分组(cloud=哨兵;本地=project_path);工作区列表来自上层(含空的常驻区)。
  const grouped = useMemo(() => {
    const byKey = new Map<string, SessionRecord[]>()
    for (const ws of p.workspaces) byKey.set(ws.key, [])
    for (const s of p.sessions) {
      const key = s.project_path || CLOUD_WORKSPACE_KEY
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key)!.push(s)
    }
    return byKey
  }, [p.workspaces, p.sessions])

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      saveCollapsed(next)
      return next
    })
  }

  useEffect(() => {
    if (renaming) renameRef.current?.select()
  }, [renaming])

  useEffect(() => {
    if (wsRenaming) wsRenameRef.current?.select()
  }, [wsRenaming])

  useEffect(() => {
    if (!menu && !wsMenu) return
    const close = () => { setMenu(null); setWsMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [menu, wsMenu])

  const openMenu = (e: React.MouseEvent, s: SessionRecord) => {
    e.preventDefault()
    e.stopPropagation()
    setWsMenu(null) // 另一菜单互斥关闭(stopPropagation 会绕过窗口级关闭处理)
    setMenu({ id: s.id, x: e.clientX, y: e.clientY, archived: s.archived })
  }

  const openWsMenu = (e: React.MouseEvent, ws: WorkspaceDescriptor) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu(null) // 另一菜单互斥关闭
    setWsMenu({ ws, x: e.clientX, y: e.clientY })
  }

  const commitRename = () => {
    if (renaming && draft.trim()) p.onRename(renaming, draft.trim())
    setRenaming(null)
  }

  const commitWsRename = () => {
    if (wsRenaming && wsDraft.trim()) {
      const ws = p.workspaces.find((w) => w.key === wsRenaming)
      if (ws) p.onRenameWorkspace(ws, wsDraft.trim())
    }
    setWsRenaming(null)
  }

  const renderItem = (s: SessionRecord) => (
    <button
      key={s.id}
      className={`session-item${s.id === p.activeId ? ' active' : ''}`}
      onClick={() => p.onSelect(s.id)}
      onContextMenu={(e) => openMenu(e, s)}
    >
      <span className="session-emoji">{s.emoji || '💬'}</span>
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
            flex: 1, minWidth: 0, background: 'var(--bg-card)', fontSize: 13,
            border: 'var(--border-width) solid var(--accent)', borderRadius: 'var(--radius-sm)',
            padding: '1px 5px', outline: 'none',
          }}
        />
      ) : (
        <span className="session-title">{s.title || 'New Chat'}</span>
      )}
      {p.runningIds.has(s.id) && <span className="session-dot running" title={t('sidebar.running')} />}
      {!p.runningIds.has(s.id) && p.unreadIds.has(s.id) && <span className="session-dot unread" title={t('sidebar.unread')} />}
      <span className="session-menu-btn" onClick={(e) => openMenu(e as any, s)}>
        <MoreHorizontal size={14} />
      </span>
    </button>
  )

  return (
    <aside className={`sidebar${p.collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        <span className="sidebar-brand">
          <BrandLogo size={20} />
          Tangu
        </span>
      </div>

      <div className="session-list">
        {p.showSpecial && p.onOpenSpecial && (
          <div style={{ marginBottom: 6 }}>
            <div className="ws-group-head">
              <span className="ws-name" style={{ paddingLeft: 6, opacity: 0.7 }}>
                <Sparkles size={12} /> {t('sidebar.special.title')}
              </span>
            </div>
            <button className={`session-item${p.specialView === 'historian' ? ' active' : ''}`} onClick={() => p.onOpenSpecial!('historian')}>
              <span className="session-emoji"><History size={13} /></span>
              <span className="session-title">Historian</span>
            </button>
            <button className={`session-item${p.specialView === 'muse' ? ' active' : ''}`} onClick={() => p.onOpenSpecial!('muse')}>
              <span className="session-emoji"><Sparkles size={13} /></span>
              <span className="session-title">Muse</span>
            </button>
          </div>
        )}
        {p.workspaces.map((ws) => {
          const items = grouped.get(ws.key) || []
          const isCollapsed = collapsedGroups.has(ws.key)
          return (
            <React.Fragment key={ws.key}>
              <div className="ws-group-head">
                {wsRenaming === ws.key ? (
                  <div className="ws-group-toggle" style={{ cursor: 'default' }}>
                    <span className="session-emoji">
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </span>
                    <input
                      ref={wsRenameRef}
                      value={wsDraft}
                      onChange={(e) => setWsDraft(e.target.value)}
                      onBlur={commitWsRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitWsRename()
                        if (e.key === 'Escape') setWsRenaming(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        flex: 1, minWidth: 0, background: 'var(--bg-card)', fontSize: 11.5, color: 'var(--text)',
                        border: 'var(--border-width) solid var(--accent)', borderRadius: 'var(--radius-sm)',
                        padding: '2px 5px', outline: 'none',
                      }}
                    />
                  </div>
                ) : (
                  <button className="ws-group-toggle" onClick={() => toggleGroup(ws.key)} title={ws.path || undefined}>
                    <span className="session-emoji">
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </span>
                    <span className="ws-name">
                      {ws.kind === 'cloud' ? <Cloud size={12} /> : <Folder size={12} />}
                      {ws.name}
                      <span style={{ opacity: 0.6 }}>({items.length})</span>
                    </span>
                  </button>
                )}
                <button
                  className="icon-btn ws-add"
                  title={t('sidebar.newChatIn', { name: ws.name })}
                  onClick={() => p.onNewInWorkspace(ws)}
                >
                  <Plus size={14} />
                </button>
                {!ws.system && (
                  <button
                    className="icon-btn ws-add"
                    title={t('sidebar.ws.menu')}
                    onClick={(e) => openWsMenu(e, ws)}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                )}
              </div>
              {!isCollapsed && items.map(renderItem)}
            </React.Fragment>
          )
        })}

        <button className="ws-add-workspace" onClick={p.onAddWorkspace}>
          <FolderPlus size={14} /> {t('sidebar.addLocalWorkspace')}
        </button>

        {p.archivedSessions.length > 0 && (
          <>
            <button className="session-item" onClick={() => setShowArchived(!showArchived)}>
              <span className="session-emoji"><Archive size={13} /></span>
              <span className="session-title" style={{ color: 'var(--text-faint)' }}>
                {t('sidebar.archived', { count: p.archivedSessions.length })}
              </span>
            </button>
            {showArchived && p.archivedSessions.map(renderItem)}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <AccountCard onToast={p.onToast} onAuthChange={p.onAuthChange} />
        <button className="icon-btn" onClick={p.onOpenSettings} title={t('sidebar.settings')}>
          <Settings size={16} />
        </button>
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id)
              setDraft(s?.title || '')
              setRenaming(menu.id)
              setMenu(null)
            }}
          >
            <Pencil size={13} /> {t('sidebar.rename')}
          </button>
          <button
            onClick={() => {
              p.onArchive(menu.id, !menu.archived)
              setMenu(null)
            }}
          >
            {menu.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {menu.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
          </button>
          <button
            className="danger"
            onClick={() => {
              p.onDelete(menu.id)
              setMenu(null)
            }}
          >
            <Trash2 size={13} /> {t('sidebar.delete')}
          </button>
        </div>
      )}

      {wsMenu && (
        <div className="ctx-menu" style={{ left: wsMenu.x, top: wsMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              setWsDraft(wsMenu.ws.name)
              setWsRenaming(wsMenu.ws.key)
              setWsMenu(null)
            }}
          >
            <Pencil size={13} /> {t('sidebar.ws.rename')}
          </button>
          <button
            className="danger"
            onClick={() => {
              const ws = wsMenu.ws
              const count = [...p.sessions, ...p.archivedSessions].filter((s) => s.project_path === ws.key).length
              setWsMenu(null)
              if (window.confirm(t('sidebar.ws.removeConfirm', { name: ws.name, count }))) p.onRemoveWorkspace(ws)
            }}
          >
            <Trash2 size={13} /> {t('sidebar.ws.remove')}
          </button>
        </div>
      )}
    </aside>
  )
}
