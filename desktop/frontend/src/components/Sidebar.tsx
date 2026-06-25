/**
 * 会话侧栏:按工作区分组(Cloud 工作区 / Tangu 默认工作区 常驻 + 其它本地工作区)。
 * 每个工作区组头 hover「+」直接在该区新建会话;底部「添加本地工作区」浏览文件夹新增。
 * 折叠态存 localStorage(键=工作区 key)。右键/省略号菜单 + 内联重命名,标记层 token CSS。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, Settings, ChevronDown, ChevronRight, Folder, Cloud, FolderPlus, Brain, SquarePen, Sparkles, Search, Smartphone } from 'lucide-react'
import { CLOUD_WORKSPACE_KEY, type SessionRecord, type TanguDesktopConfig, type WorkspaceDescriptor } from '../types'
import { BrandLogo } from './BrandLogo'
import { AccountCard } from './AccountCard'
import { useI18n } from '../i18n'
import { getWechatStatus, setWechatConnectedSession } from '../services/backendService'

const COLLAPSE_KEY = 'forsion_tangu_collapsed_projects'
const WS_ORDER_KEY = 'forsion_tangu_workspace_order'

function loadCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')) } catch { return new Set() }
}
function saveCollapsed(s: Set<string>): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}

/** 工作区显示顺序(用户拖拽调整,存 ws.key 列表;缺省微信置顶)。 */
function loadWsOrder(): string[] {
  try { const v = JSON.parse(localStorage.getItem(WS_ORDER_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
function saveWsOrder(o: string[]): void {
  try { localStorage.setItem(WS_ORDER_KEY, JSON.stringify(o)) } catch { /* ignore */ }
}

interface SidebarProps {
  collapsed: boolean
  sessions: SessionRecord[]
  archivedSessions: SessionRecord[]
  activeId: string | null
  runningIds: Set<string>
  unreadIds: Set<string>
  onSelect: (id: string) => void
  cfg: TanguDesktopConfig
  modelId: string
  activeSession: SessionRecord | null
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
  /** 顶部入口卡片组(本地后端才显示)。 */
  showSpecial?: boolean
  /** 各 Special Agent / 微信远程 是否开启(入口按此逐个显隐)。 */
  historianEnabled?: boolean
  museEnabled?: boolean
  wechatEnabled?: boolean
  specialView?: 'wechat' | 'agents' | 'memory' | 'workspace' | null
  /** 微信远程 / 后台智能体详情面板入口。 */
  onOpenSpecial?: (v: 'wechat' | 'agents') => void
  /** 顶部「新对话」卡片:进入空白主界面(activeId=null)。 */
  onNewChat: () => void
  /** 顶部「记忆」卡片:打开记忆/日志面板。 */
  onOpenMemory: () => void
  /** 「后台智能体」卡片体点击 → 设置·后台智能体。 */
  onOpenAgentsSettings: () => void
  /** 工作区卡片体点击 / View More → 打开该工作区详情面板。 */
  onOpenWorkspace: (wsKey: string) => void
}

interface MenuState {
  id: string
  x: number
  y: number
  archived: boolean
}

/** 侧栏「微信远程」工作区组头的连接状态(活跃绑定数;0=未连接)。 */
function useWechatConnectedCount(cfg: TanguDesktopConfig, enabled: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!enabled || !cfg.token) { setN(0); return }
    const refresh = (): void => { void getWechatStatus(cfg).then((r) => setN(r.bindings.filter((b) => b.is_active).length)).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cfg.backendUrl, cfg.token])
  return n
}

/** 通用入口卡片(顶部 New Chat / 记忆 / 后台智能体 共用)。紧凑单行:图标 + 名称 + 箭头。
 *  传 onExpand 时右侧箭头变独立点击区(stopPropagation),与卡片体 onClick 分开
 *  (后台智能体:卡片体=设置,箭头=主区详情面板)。 */
const SpecialCard: React.FC<{
  icon: React.ReactNode
  title: string
  active: boolean
  onClick: () => void
  onExpand?: () => void
}> = ({ icon, title, active, onClick, onExpand }) => (
  <button className={`special-card${active ? ' active' : ''}`} onClick={onClick}>
    <div className="special-card-head">
      <span className="sc-icon">{icon}</span>
      <span className="sc-title">{title}</span>
      <span className="sc-go" onClick={onExpand ? (e) => { e.stopPropagation(); onExpand() } : undefined}>
        <ChevronRight size={14} />
      </span>
    </div>
  </button>
)

export const Sidebar: React.FC<SidebarProps> = (p) => {
  const { t } = useI18n()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // 每个工作区在侧栏显示的会话数(设置·高级 可调;localStorage + 自定义事件实时同步)。
  const [sessionLimit, setSessionLimit] = useState(() => {
    try { return Math.max(1, Number(localStorage.getItem('tangu_ws_session_limit')) || 5) } catch { return 5 }
  })
  useEffect(() => {
    const onChange = (): void => { try { setSessionLimit(Math.max(1, Number(localStorage.getItem('tangu_ws_session_limit')) || 5)) } catch { /* ignore */ } }
    window.addEventListener('tangu:wslimit', onChange)
    return () => window.removeEventListener('tangu:wslimit', onChange)
  }, [])
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsed)
  // 工作区拖拽排序:wsOrder 持久化键序;drag/dragOver 为拖拽中临时态(视觉反馈)。
  const [wsOrder, setWsOrder] = useState<string[]>(loadWsOrder)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  // 工作区操作菜单 + 内联重命名(与会话各自独立的状态,避免 key/id 串扰)。
  const [wsMenu, setWsMenu] = useState<{ ws: WorkspaceDescriptor; x: number; y: number } | null>(null)
  const [wsRenaming, setWsRenaming] = useState<string | null>(null)
  const [wsDraft, setWsDraft] = useState('')
  const wsRenameRef = useRef<HTMLInputElement>(null)
  const hasWechatWs = p.workspaces.some((w) => w.kind === 'wechat')
  const wechatConnected = useWechatConnectedCount(p.cfg, hasWechatWs)

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

  // 工作区显示顺序:先按持久化 wsOrder(只取仍存在的键),未排序过的(新区/首次)微信置顶、其余保原序。
  const orderedWorkspaces = useMemo(() => {
    const byKey = new Map(p.workspaces.map((w) => [w.key, w] as const))
    const out: WorkspaceDescriptor[] = []
    for (const k of wsOrder) { const w = byKey.get(k); if (w) { out.push(w); byKey.delete(k) } }
    const rest = [...byKey.values()].sort((a, b) => (a.kind === 'wechat' ? -1 : 0) - (b.kind === 'wechat' ? -1 : 0))
    return [...out, ...rest]
  }, [p.workspaces, wsOrder])

  // 拖拽落定:把 from 插到 target 之前,持久化全量键序(含微信)。
  const dropWorkspace = (targetKey: string): void => {
    const from = dragKey
    setDragKey(null)
    setDragOverKey(null)
    if (!from || from === targetKey) return
    const keys = orderedWorkspaces.map((w) => w.key)
    const fi = keys.indexOf(from)
    let ti = keys.indexOf(targetKey)
    if (fi < 0 || ti < 0) return
    keys.splice(fi, 1)
    // 移除 from 后数组左移:从左往右拖时目标索引要 -1,才能把 from 插到目标「之前」。
    if (fi < ti) ti--
    keys.splice(ti, 0, from)
    setWsOrder(keys)
    saveWsOrder(keys)
  }

  // 会话搜索(仅标题,客户端即时):非空时跨工作区 + 含归档扁平匹配。
  const q = query.trim().toLowerCase()
  const matchAll = useMemo(
    () => (q ? [...p.sessions, ...p.archivedSessions].filter((s) => (s.title || '').toLowerCase().includes(q)) : []),
    [q, p.sessions, p.archivedSessions],
  )

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
    // archived 在 standalone(SQLite)是数字 0/1;强制布尔,避免 {menu.archived && ...} 泄漏字面量「0」。
    setMenu({ id: s.id, x: e.clientX, y: e.clientY, archived: !!s.archived })
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
        <span className="model-search" style={{ margin: '0 6px 8px' }}>
          <Search size={13} />
          <input value={query} placeholder={t('sidebar.search.placeholder')} onChange={(e) => setQuery(e.target.value)} />
        </span>

        {q ? (
          matchAll.length
            ? matchAll.map(renderItem)
            : <div className="hint" style={{ padding: '8px 10px' }}>{t('sidebar.search.noResults')}</div>
        ) : (
        <>
        {/* 顶部入口组:新对话 / 记忆 / 后台智能体(置于工作区之上) */}
        {p.showSpecial && (
          <div style={{ marginBottom: 8 }}>
            <SpecialCard
              icon={<SquarePen size={15} />}
              title={t('sidebar.newChat')}
              active={false}
              onClick={p.onNewChat}
            />
            <SpecialCard
              icon={<Brain size={15} />}
              title={t('sidebar.memory')}
              active={p.specialView === 'memory'}
              onClick={p.onOpenMemory}
            />
            {(p.historianEnabled || p.museEnabled) && (
              <SpecialCard
                icon={<Sparkles size={15} />}
                title={t('sidebar.agents')}
                active={p.specialView === 'agents'}
                onClick={p.onOpenAgentsSettings}
                onExpand={() => p.onOpenSpecial?.('agents')}
              />
            )}
          </div>
        )}
        {orderedWorkspaces.map((ws) => {
          const items = grouped.get(ws.key) || []
          const isCollapsed = collapsedGroups.has(ws.key)
          return (
            <React.Fragment key={ws.key}>
              <div
                className={`ws-group-head${dragKey && dragOverKey === ws.key && dragKey !== ws.key ? ' ws-drag-over' : ''}${dragKey === ws.key ? ' ws-dragging' : ''}`}
                draggable={wsRenaming !== ws.key}
                onDragStart={(e) => { setDragKey(ws.key); e.dataTransfer.effectAllowed = 'move' }}
                onDragOver={(e) => {
                  if (dragKey && dragKey !== ws.key) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverKey !== ws.key) setDragOverKey(ws.key) }
                }}
                onDragLeave={() => { if (dragOverKey === ws.key) setDragOverKey(null) }}
                onDrop={(e) => { e.preventDefault(); dropWorkspace(ws.key) }}
                onDragEnd={() => { setDragKey(null); setDragOverKey(null) }}
              >
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
                ) : ws.kind === 'wechat' ? (
                  <button
                    className={`ws-group-toggle${p.specialView === 'wechat' ? ' active' : ''}`}
                    onClick={() => p.onOpenSpecial?.('wechat')}
                    title={t('sidebar.wechat.openHint')}
                  >
                    <span className="session-emoji" onClick={(e) => { e.stopPropagation(); toggleGroup(ws.key) }}>
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </span>
                    <span className="ws-name">
                      <Smartphone size={12} />
                      {ws.name}
                      <span className={`mini-dot ${wechatConnected ? 'ok' : ''}`} style={{ marginLeft: 2 }} />
                      <span style={{ opacity: 0.6 }}>({items.length})</span>
                    </span>
                  </button>
                ) : (
                  <button className="ws-group-toggle" onClick={() => p.onOpenWorkspace(ws.key)} title={ws.path || undefined}>
                    <span className="session-emoji" onClick={(e) => { e.stopPropagation(); toggleGroup(ws.key) }}>
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
              {!isCollapsed && (
                <div className="ws-sessions">
                  {items.slice(0, sessionLimit).map(renderItem)}
                  {items.length > sessionLimit && (
                    <button className="ws-viewmore" onClick={() => p.onOpenWorkspace(ws.key)}>
                      {t('sidebar.viewMore')} · {items.length}
                    </button>
                  )}
                </div>
              )}
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
          {/* 微信 Project 下的会话:可直接设为「正在连接」(Q2)。 */}
          {(() => {
            const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id)
            const wechatWsKey = p.workspaces.find((w) => w.kind === 'wechat')?.key
            if (!s || !wechatWsKey || s.project_path !== wechatWsKey) return null
            return (
              <button
                onClick={() => {
                  setMenu(null)
                  void setWechatConnectedSession(p.cfg, menu.id)
                    .then(() => p.onToast?.(t('sidebar.wechat.setConnectedOk')))
                    .catch((e) => p.onToast?.(t('sidebar.wechat.setConnectedFail', { e: e?.message || e }), true))
                }}
              >
                <Smartphone size={13} /> {t('sidebar.wechat.setAsConnected')}
              </button>
            )
          })()}
          {/* 永久删除仅对已归档会话开放;活跃会话的破坏性操作即「归档」。 */}
          {menu.archived && (
            <button
              className="danger"
              onClick={() => {
                const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id)
                setMenu(null)
                if (window.confirm(t('sidebar.deleteConfirm', { name: s?.title || 'New Chat' }))) p.onDelete(menu.id)
              }}
            >
              <Trash2 size={13} /> {t('sidebar.delete')}
            </button>
          )}
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
