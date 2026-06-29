/**
 * 侧栏(编辑式新视觉,全量重写——非换肤)。完整复刻旧 Sidebar 的行为:
 * 按工作区分组(Cloud / Tangu 默认 常驻 + 本地)、组拖拽排序、折叠持久化、会话搜索、
 * 内联重命名、右键/省略号菜单(归档/删除/微信设为连接)、工作区菜单(改名/移除)、
 * 微信组连接状态、归档区、每区会话上限 + View More。底部常驻个人中心卡片 + 设置(品牌在全局顶栏)。
 * 样式全在 sidebar2.css(t2s- 前缀,token 驱动);右键菜单复用 base.css 的 .ctx-menu。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, ChevronDown, ChevronRight, Folder, Cloud, FolderPlus, SquarePen, Sparkles, Search, Smartphone, Settings } from 'lucide-react'
import { CLOUD_WORKSPACE_KEY, type SessionRecord, type TanguDesktopConfig, type WorkspaceDescriptor } from '../../types'
import { AccountCard } from '../../components/AccountCard'
import { AnimatedCollapse } from '../../components/AnimatedUI'
import { useI18n } from '../../i18n'
import { getWechatStatus, setWechatConnectedSession } from '../../services/backendService'
import './sidebar2.css'

const COLLAPSE_KEY = 'forsion_tangu_collapsed_projects'
const WS_ORDER_KEY = 'forsion_tangu_workspace_order'

function loadCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')) } catch { return new Set() }
}
function saveCollapsed(s: Set<string>): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}
function loadWsOrder(): string[] {
  try { const v = JSON.parse(localStorage.getItem(WS_ORDER_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
function saveWsOrder(o: string[]): void {
  try { localStorage.setItem(WS_ORDER_KEY, JSON.stringify(o)) } catch { /* ignore */ }
}

export interface SidebarPaneProps {
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
  workspaces: WorkspaceDescriptor[]
  onNewInWorkspace: (ws: WorkspaceDescriptor) => void
  onAddWorkspace: () => void
  onRenameWorkspace: (ws: WorkspaceDescriptor, name: string) => void
  onRemoveWorkspace: (ws: WorkspaceDescriptor) => void
  onRename: (id: string, title: string) => void
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  onToast?: (text: string, error?: boolean) => void
  onAuthChange?: () => void
  showSpecial?: boolean
  historianEnabled?: boolean
  museEnabled?: boolean
  wechatEnabled?: boolean
  specialView?: 'wechat' | 'agents' | 'workspace' | null
  onOpenSpecial?: (v: 'wechat' | 'agents') => void
  onNewChat: () => void
  onOpenAgentsSettings: () => void
  onOpenWorkspace: (wsKey: string) => void
  /** 共享「进入的工作区」key(与文件面板手风琴同步)。 */
  activeWorkspaceKey?: string | null
  onEnterWorkspace?: (key: string) => void
}

interface MenuState { id: string; x: number; y: number; archived: boolean }

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

/** 顶部入口行(新对话 / 记忆 / 后台智能体):图标 + 名 + 可选展开箭头。 */
const SpecialRow: React.FC<{
  icon: React.ReactNode; title: string; active: boolean; onClick: () => void; onExpand?: () => void
}> = ({ icon, title, active, onClick, onExpand }) => (
  <button className={`t2s-special${active ? ' active' : ''}`} onClick={onClick}>
    <span className="t2s-special-ic">{icon}</span>
    <span className="t2s-special-title">{title}</span>
    {onExpand && (
      <span className="t2s-special-go" onClick={(e) => { e.stopPropagation(); onExpand() }}><ChevronRight size={14} /></span>
    )}
  </button>
)

export const SidebarPane: React.FC<SidebarPaneProps> = (p) => {
  const { t } = useI18n()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
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
  const [wsOrder, setWsOrder] = useState<string[]>(loadWsOrder)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const [wsMenu, setWsMenu] = useState<{ ws: WorkspaceDescriptor; x: number; y: number } | null>(null)
  const [wsRenaming, setWsRenaming] = useState<string | null>(null)
  const [wsDraft, setWsDraft] = useState('')
  const wsRenameRef = useRef<HTMLInputElement>(null)
  const hasWechatWs = p.workspaces.some((w) => w.kind === 'wechat')
  const wechatConnected = useWechatConnectedCount(p.cfg, hasWechatWs)

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

  const orderedWorkspaces = useMemo(() => {
    const byKey = new Map(p.workspaces.map((w) => [w.key, w] as const))
    const out: WorkspaceDescriptor[] = []
    for (const k of wsOrder) { const w = byKey.get(k); if (w) { out.push(w); byKey.delete(k) } }
    const rest = [...byKey.values()].sort((a, b) => (a.kind === 'wechat' ? -1 : 0) - (b.kind === 'wechat' ? -1 : 0))
    return [...out, ...rest]
  }, [p.workspaces, wsOrder])

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
    if (fi < ti) ti--
    keys.splice(ti, 0, from)
    setWsOrder(keys)
    saveWsOrder(keys)
  }

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
  // 手风琴:进入某工作区(点工作区头 / 点其会话)→ 只展开它,收起其余;并同步给文件面板(共享 key)。
  const accordion = (key: string): void => {
    p.onEnterWorkspace?.(key)
    const next = new Set(orderedWorkspaces.map((w) => w.key).filter((k) => k !== key))
    setCollapsedGroups(next)
    saveCollapsed(next)
  }
  // 文件面板那侧进入工作区时,本面板同步只展开它(收起其余)。
  useEffect(() => {
    if (p.activeWorkspaceKey == null) return
    const next = new Set(orderedWorkspaces.map((w) => w.key).filter((k) => k !== p.activeWorkspaceKey))
    setCollapsedGroups(next)
    saveCollapsed(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.activeWorkspaceKey])

  useEffect(() => { if (renaming) renameRef.current?.select() }, [renaming])
  useEffect(() => { if (wsRenaming) wsRenameRef.current?.select() }, [wsRenaming])
  useEffect(() => {
    if (!menu && !wsMenu) return
    const close = () => { setMenu(null); setWsMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [menu, wsMenu])

  const openMenu = (e: React.MouseEvent, s: SessionRecord) => {
    e.preventDefault(); e.stopPropagation(); setWsMenu(null)
    setMenu({ id: s.id, x: e.clientX, y: e.clientY, archived: !!s.archived })
  }
  const openWsMenu = (e: React.MouseEvent, ws: WorkspaceDescriptor) => {
    e.preventDefault(); e.stopPropagation(); setMenu(null)
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
      className={`t2s-srow${s.id === p.activeId ? ' active' : ''}`}
      onClick={() => { p.onSelect(s.id); accordion(s.project_path || CLOUD_WORKSPACE_KEY) }}
      onContextMenu={(e) => openMenu(e, s)}
    >
      {p.runningIds.has(s.id) && <span className="t2s-dot running" title={t('sidebar.running')} />}
      {!p.runningIds.has(s.id) && p.unreadIds.has(s.id) && <span className="t2s-dot unread" title={t('sidebar.unread')} />}
      {renaming === s.id ? (
        <input
          ref={renameRef}
          className="t2s-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="t2s-srow-title">{s.title || 'New Chat'}</span>
      )}
      <span className="t2s-srow-menu" onClick={(e) => openMenu(e as React.MouseEvent, s)}>
        <MoreHorizontal size={14} />
      </span>
    </button>
  )

  return (
    <aside className="t2s-side">
      <div className="t2s-search">
        <Search size={13} className="t2s-dim" />
        <input value={query} placeholder={t('sidebar.search.placeholder')} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="t2s-scroll">
        {q ? (
          matchAll.length
            ? matchAll.map(renderItem)
            : <div className="t2s-hint">{t('sidebar.search.noResults')}</div>
        ) : (
          <>
            {p.showSpecial && (
              <div className="t2s-special-group">
                <SpecialRow icon={<SquarePen size={15} />} title={t('sidebar.newChat')} active={false} onClick={p.onNewChat} />
                {(p.historianEnabled || p.museEnabled) && (
                  <SpecialRow icon={<Sparkles size={15} />} title={t('sidebar.agents')} active={p.specialView === 'agents'} onClick={p.onOpenAgentsSettings} onExpand={() => p.onOpenSpecial?.('agents')} />
                )}
              </div>
            )}

            {orderedWorkspaces.map((ws) => {
              const items = grouped.get(ws.key) || []
              const isCollapsed = collapsedGroups.has(ws.key)
              return (
                <React.Fragment key={ws.key}>
                  <div
                    className={`t2s-group${dragKey && dragOverKey === ws.key && dragKey !== ws.key ? ' drag-over' : ''}${dragKey === ws.key ? ' dragging' : ''}`}
                    draggable={wsRenaming !== ws.key}
                    onDragStart={(e) => {
                      // 用元素自身作拖影并按抓取点对齐光标(否则默认拖影/setState 重渲会让图标与光标错位)。
                      const r = e.currentTarget.getBoundingClientRect()
                      e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragKey(ws.key)
                    }}
                    onDragOver={(e) => { if (dragKey && dragKey !== ws.key) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverKey !== ws.key) setDragOverKey(ws.key) } }}
                    onDragLeave={() => { if (dragOverKey === ws.key) setDragOverKey(null) }}
                    onDrop={(e) => { e.preventDefault(); dropWorkspace(ws.key) }}
                    onDragEnd={() => { setDragKey(null); setDragOverKey(null) }}
                  >
                    {wsRenaming === ws.key ? (
                      <div className="t2s-group-toggle" style={{ cursor: 'default' }}>
                        <span className="t2s-chev">{isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                        <input
                          ref={wsRenameRef}
                          className="t2s-rename"
                          value={wsDraft}
                          onChange={(e) => setWsDraft(e.target.value)}
                          onBlur={commitWsRename}
                          onKeyDown={(e) => { if (e.key === 'Enter') commitWsRename(); if (e.key === 'Escape') setWsRenaming(null) }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    ) : ws.kind === 'wechat' ? (
                      <button className={`t2s-group-toggle${p.specialView === 'wechat' ? ' active' : ''}`} onClick={() => { p.onOpenSpecial?.('wechat'); accordion(ws.key) }} title={t('sidebar.wechat.openHint')}>
                        <span className="t2s-chev" onClick={(e) => { e.stopPropagation(); toggleGroup(ws.key) }}>{isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                        <span className="t2s-group-name"><Smartphone size={12} /><span className="t2s-group-label">{ws.name}</span><span className={`t2s-mini-dot${wechatConnected ? ' ok' : ''}`} /><span className="t2s-count">{items.length}</span></span>
                      </button>
                    ) : (
                      <button className="t2s-group-toggle" onClick={() => { p.onOpenWorkspace(ws.key); accordion(ws.key) }} title={ws.path || undefined}>
                        <span className="t2s-chev" onClick={(e) => { e.stopPropagation(); toggleGroup(ws.key) }}>{isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                        <span className="t2s-group-name">{ws.kind === 'cloud' ? <Cloud size={12} /> : <Folder size={12} />}<span className="t2s-group-label">{ws.name}</span><span className="t2s-count">{items.length}</span></span>
                      </button>
                    )}
                    <button className="t2s-group-add" title={t('sidebar.newChatIn', { name: ws.name })} onClick={() => p.onNewInWorkspace(ws)}><Plus size={14} /></button>
                    {!ws.system && (
                      <button className="t2s-group-add" title={t('sidebar.ws.menu')} onClick={(e) => openWsMenu(e, ws)}><MoreHorizontal size={14} /></button>
                    )}
                  </div>
                  <AnimatedCollapse open={!isCollapsed}>
                    <div className="t2s-group-sessions">
                      {items.slice(0, sessionLimit).map(renderItem)}
                      {items.length > sessionLimit && (
                        <button className="t2s-viewmore" onClick={() => p.onOpenWorkspace(ws.key)}>{t('sidebar.viewMore')} · {items.length}</button>
                      )}
                    </div>
                  </AnimatedCollapse>
                </React.Fragment>
              )
            })}

            {window.tangu?.pickDirectory && <button className="t2s-add-ws" onClick={p.onAddWorkspace}><FolderPlus size={14} /> {t('sidebar.addLocalWorkspace')}</button>}

            {p.archivedSessions.length > 0 && (
              <>
                <button className="t2s-srow t2s-archived-toggle" onClick={() => setShowArchived(!showArchived)}>
                  <span className="t2s-chev"><Archive size={13} /></span>
                  <span className="t2s-srow-title t2s-faint">{t('sidebar.archived', { count: p.archivedSessions.length })}</span>
                </button>
                {showArchived && p.archivedSessions.map(renderItem)}
              </>
            )}
          </>
        )}
      </div>

      {/* 常驻底部:个人中心卡片(头像/昵称/会员/用户中心)+ 设置。与 desktop1.0 一致。 */}
      <div className="t2s-footer">
        <AccountCard onToast={p.onToast} onAuthChange={p.onAuthChange} />
        <button className="t2s-footer-settings" onClick={p.onOpenSettings} title={t('sidebar.settings')}>
          <Settings size={16} />
        </button>
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id); setDraft(s?.title || ''); setRenaming(menu.id); setMenu(null) }}>
            <Pencil size={13} /> {t('sidebar.rename')}
          </button>
          <button onClick={() => { p.onArchive(menu.id, !menu.archived); setMenu(null) }}>
            {menu.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {menu.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
          </button>
          {(() => {
            const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id)
            const wechatWsKey = p.workspaces.find((w) => w.kind === 'wechat')?.key
            if (!s || !wechatWsKey || s.project_path !== wechatWsKey) return null
            return (
              <button onClick={() => {
                setMenu(null)
                void setWechatConnectedSession(p.cfg, menu.id)
                  .then(() => p.onToast?.(t('sidebar.wechat.setConnectedOk')))
                  .catch((e) => p.onToast?.(t('sidebar.wechat.setConnectedFail', { e: e?.message || e }), true))
              }}>
                <Smartphone size={13} /> {t('sidebar.wechat.setAsConnected')}
              </button>
            )
          })()}
          {menu.archived && (
            <button className="danger" onClick={() => {
              const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id)
              setMenu(null)
              if (window.confirm(t('sidebar.deleteConfirm', { name: s?.title || 'New Chat' }))) p.onDelete(menu.id)
            }}>
              <Trash2 size={13} /> {t('sidebar.delete')}
            </button>
          )}
        </div>
      )}

      {wsMenu && (
        <div className="ctx-menu" style={{ left: wsMenu.x, top: wsMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setWsDraft(wsMenu.ws.name); setWsRenaming(wsMenu.ws.key); setWsMenu(null) }}>
            <Pencil size={13} /> {t('sidebar.ws.rename')}
          </button>
          <button className="danger" onClick={() => {
            const ws = wsMenu.ws
            const count = [...p.sessions, ...p.archivedSessions].filter((s) => s.project_path === ws.key).length
            setWsMenu(null)
            if (window.confirm(t('sidebar.ws.removeConfirm', { name: ws.name, count }))) p.onRemoveWorkspace(ws)
          }}>
            <Trash2 size={13} /> {t('sidebar.ws.remove')}
          </button>
        </div>
      )}
    </aside>
  )
}
