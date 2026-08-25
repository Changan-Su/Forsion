/**
 * 侧栏(编辑式新视觉,全量重写——非换肤)。完整复刻旧 Sidebar 的行为:
 * 按工作区分组(Cloud / Tangu 默认 常驻 + 本地)、组拖拽排序、折叠持久化、会话搜索、
 * 内联重命名、右键/省略号菜单(归档/删除/微信设为连接)、工作区菜单(改名/移除)、
 * 微信组连接状态、归档区、每区会话上限 + View More。底部常驻个人中心卡片 + 设置(品牌在全局顶栏)。
 * 样式全在 sidebar2.css(t2s- 前缀,token 驱动);右键菜单复用 base.css 的 .ctx-menu。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, ChevronRight, Folder, FolderOpen, FolderX, Cloud, FolderPlus, SquarePen, Search, Smartphone, Send, MessagesSquare, MessageSquare } from 'lucide-react'
import { folderPadLeft, rowPadLeft } from '@amadeus/lib/treeIndent'
import { SidebarRow } from '../../components/SidebarRow'
import { moveTo } from '@lcl/engine'
import { sessionWorkspaceKey, type ChannelKind, type SessionRecord, type TanguDesktopConfig, type WorkspaceDescriptor } from '../../types'
import { AnimatedCollapse } from '../../components/AnimatedUI'
import { registerMessages, useI18n } from '../../i18n'
import { useItemSelect } from '../itemSelect'
import { tipProps, tipT } from '../../hoverTip'
import { searchSessions as apiSearchSessions, setChannelConnectedSession, type SessionSearchHit } from '../../services/backendService'
import { useApp } from '../../stores/appStore'
import { useChannels } from '../../stores/channelsStore'
import { setChatRefDrag } from './chatDragRef'
import './sidebar2.css'
import { OverlayAt } from '@lcl/engine'

const CHANNEL_ICONS: Record<ChannelKind, typeof Smartphone> = { wechat: Smartphone, telegram: Send, qq: MessagesSquare }

registerMessages({
  'sidebar.search.inContent': { zh: '内容匹配', en: 'In conversation' },
  'sidebar.search.searching': { zh: '正在搜索内容…', en: 'Searching contents…' },
  'sidebar.search.contentFailed': { zh: '内容搜索没跑成(标题匹配仍可用);改动输入可重试', en: 'Content search failed (title matches still work) — edit the query to retry' },
  'sidebar.openInNewTab': { zh: '在新标签页打开', en: 'Open in new tab' },
  'sidebar.archiveN': { zh: '归档 {n} 项', en: 'Archive {n}' },
  'sidebar.unarchiveN': { zh: '取消归档 {n} 项', en: 'Unarchive {n}' },
  'sidebar.deleteN': { zh: '删除 {n} 项', en: 'Delete {n}' },
  'sidebar.deleteConfirmN': { zh: '删除选中的 {n} 个会话?不可撤销。', en: 'Delete {n} selected chats? This cannot be undone.' },
})

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
  /** opts.newTab = ⌘/Ctrl 单击:把会话开进新标签页而不是就地。 */
  onSelect: (id: string, opts?: { newTab?: boolean }) => void
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
  onNewChat: () => void
  onOpenWorkspace: (wsKey: string) => void
  /** 共享「进入的工作区」key(与文件面板联动展开;不收其余)。 */
  activeWorkspaceKey?: string | null
  onEnterWorkspace?: (key: string) => void
}

/** ids = 本次菜单的作用集合(右键落在多选里 → 整批;否则就它自己);archived 取被右键那条的状态。 */
interface MenuState { id: string; ids: string[]; x: number; y: number; archived: boolean }

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
  const rootRef = useRef<HTMLElement>(null)
  // 会话行的多选(判据与文件树/笔记树同源,见 views/itemSelect)。范围选按 DOM 顺序 → 要整个 aside
  // 作用域:归档区在 sticky footer 里,不在 .t2s-scroll 内。
  const sel = useItemSelect(rootRef)
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
  // 通道连接状态(channelsStore 15s 轮询):kind → 是否有运行中的账号(组头状态点)。
  const channelStatuses = useChannels((s) => s.channels)
  const channelRunning = useMemo(() => {
    const m = new Map<ChannelKind, boolean>()
    for (const c of channelStatuses) m.set(c.kind, c.runtime.some((r) => r.running))
    return m
  }, [channelStatuses])

  const grouped = useMemo(() => {
    const byKey = new Map<string, SessionRecord[]>()
    for (const ws of p.workspaces) byKey.set(ws.key, [])
    for (const s of p.sessions) {
      const key = sessionWorkspaceKey(s)
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key)!.push(s)
    }
    return byKey
  }, [p.workspaces, p.sessions])

  const orderedWorkspaces = useMemo(() => {
    const byKey = new Map(p.workspaces.map((w) => [w.key, w] as const))
    const out: WorkspaceDescriptor[] = []
    for (const k of wsOrder) { const w = byKey.get(k); if (w) { out.push(w); byKey.delete(k) } }
    const rest = [...byKey.values()].sort((a, b) => (a.kind === 'channel' ? -1 : 0) - (b.kind === 'channel' ? -1 : 0))
    return [...out, ...rest]
  }, [p.workspaces, wsOrder])
  const dragIdx = dragKey ? orderedWorkspaces.findIndex((w) => w.key === dragKey) : -1

  /** 落到 targetKey 上 = 顶掉它的位置,其余顺次让位。语义与 ribbon 共用 lcl 的 moveTo(已单测),
   *  别再手写「插到目标之前」那套:下移一格会算成空操作,且永远排不到最末 = 用户报的「线显示了但松手没动」。 */
  const dropWorkspace = (targetKey: string): void => {
    const from = dragKey
    setDragKey(null)
    setDragOverKey(null)
    if (!from || from === targetKey) return
    const keys = orderedWorkspaces.map((w) => w.key)
    const ti = keys.indexOf(targetKey)
    if (ti < 0 || !keys.includes(from)) return
    const next = moveTo(keys, from, ti)
    setWsOrder(next)
    saveWsOrder(next)
  }

  const q = query.trim().toLowerCase()
  const matchAll = useMemo(
    () => (q ? [...p.sessions, ...p.archivedSessions].filter((s) => (s.title || '').toLowerCase().includes(q)) : []),
    [q, p.sessions, p.archivedSessions],
  )

  // 内容级召回(P3):标题匹配是本地即时的,正文匹配要问引擎(与模型侧 search_sessions 同一条 SQL)。
  // 去抖 250ms + AbortController:每键一发会把长会话库的 LIKE 扫描打满,且回包乱序会让结果闪回旧的。
  const [deepHits, setDeepHits] = useState<SessionSearchHit[] | null>(null)
  const [deepBusy, setDeepBusy] = useState(false)
  // 检索失败 ≠ 没搜到:后端出错时若也渲染成「无结果」,用户会以为库里真没有(Codex 真机走查提的)。
  const [deepErr, setDeepErr] = useState(false)
  useEffect(() => {
    const raw = query.trim()
    if (raw.length < 2) { setDeepHits(null); setDeepBusy(false); setDeepErr(false); return }
    const ac = new AbortController()
    setDeepBusy(true)
    const timer = window.setTimeout(() => {
      apiSearchSessions(p.cfg, raw, { limit: 20, signal: ac.signal })
        .then((hits) => { if (!ac.signal.aborted) { setDeepHits(hits); setDeepErr(false); setDeepBusy(false) } })
        // 中止是常态(下一次输入),不当错误;真失败**如实说搜不了**,别伪装成「无匹配」——
        // 标题匹配不受影响,照常可用。
        .catch(() => { if (!ac.signal.aborted) { setDeepHits([]); setDeepErr(true); setDeepBusy(false) } })
    }, 250)
    return () => { window.clearTimeout(timer); ac.abort() }
  }, [query, p.cfg])

  // 标题匹配已在上面列过 → 正文命中只留没重复的那些。
  const contentHits = useMemo(() => {
    if (!deepHits) return []
    const shown = new Set(matchAll.map((s) => s.id))
    return deepHits.filter((h) => !shown.has(h.id))
  }, [deepHits, matchAll])

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      saveCollapsed(next)
      return next
    })
  }
  /** 展开某工作区。**只展开自己,不动别人** —— 原先是手风琴(展开一个收起其余),
   *  用户拍板去掉:多个工作区可以同时开着。enterGroup = 展开 + 同步给文件面板。 */
  const openGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      saveCollapsed(next)
      return next
    })
  }
  const enterGroup = (key: string): void => { p.onEnterWorkspace?.(key); openGroup(key) }
  // 文件面板那侧进入工作区时,本面板同步展开它(同样不收其余)。
  useEffect(() => {
    if (p.activeWorkspaceKey != null) openGroup(p.activeWorkspaceKey)
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
    // 右键落在已选中的会话上 → 整批;落在别处 → 改成只选它。
    const ids = sel.batch(s.id)
    if (ids.length === 1) sel.only(s.id)
    setMenu({ id: s.id, ids, x: e.clientX, y: e.clientY, archived: !!s.archived })
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

  /** 工作区组头的前导槽:图标 ↔ hover 换箭头(与笔记树文件夹行同一套)。三个变体(重命名中/微信/普通)共用。
   *  本地工作区用 Folder/FolderOpen 表达展开态 —— 箭头默认不显,总得有东西担起「展开了没」。 */
  const wsLead = (ws: WorkspaceDescriptor, collapsed: boolean) => {
    const Ic = ws.kind === 'channel' ? CHANNEL_ICONS[ws.channel || 'wechat'] : ws.kind === 'cloud' ? Cloud : ws.kind === 'rootless' ? FolderX : collapsed ? Folder : FolderOpen
    return (
      <span className="t2s-lead">
        <Ic className="t2s-lead-icon" />
        <span className={`t2s-chev t2s-lead-chev${collapsed ? '' : ' open'}`} onClick={(e) => { e.stopPropagation(); toggleGroup(ws.key) }}>
          <ChevronRight size={12} />
        </span>
      </span>
    )
  }

  const renderItem = (s: SessionRecord) => (
    <SidebarRow
      key={s.id}
      as="button"
      className={`${s.id === p.activeId ? 'active' : ''}${sel.has(s.id) ? ' sel' : ''}`.trim() || undefined}
      selId={s.id}
      // Historian 会话摘要 → 悬停预览(无摘要回落标题本身,长标题被截断时仍可读全)。
      title={s.summary || s.title || undefined}
      // 组内行缩进一级(组头 depth 0)—— 与笔记树「文件夹内的笔记」同档,见 treeIndent.ts。
      depth={1}
      // 前导槽:与笔记/插件源 view 同构 → 三模式切换时图标不跳。状态点绝对定位贴在图标角上,
      // **不能内联排在标题前** —— 那样有状态的行会被推右 6px,会话行自己就先不齐了。
      lead={<>
        <MessageSquare className="t2s-lead-icon t2s-dim" />
        {p.runningIds.has(s.id)
          ? <span className="t2s-dot running" title={t('sidebar.running')} />
          : p.unreadIds.has(s.id) ? <span className="t2s-dot unread" title={t('sidebar.unread')} /> : null}
      </>}
      trailing={<span className="t2s-srow-menu" onClick={(e) => openMenu(e as React.MouseEvent, s)}><MoreHorizontal size={14} /></span>}
      // 统一点击语义(见 views/itemSelect):裸击开、⌘ 开新标签、shift/option 只动选中态。
      onClick={(e) => {
        const act = sel.click(s.id, e)
        if (act.open === 'none') return
        p.onSelect(s.id, act.open === 'new' ? { newTab: true } : undefined)
        enterGroup(sessionWorkspaceKey(s))
      }}
      onContextMenu={(e) => openMenu(e, s)}
      // 拖到聊天区 = 插入 [[session:id]] 引用(agent 用 read_session 读)。重命名中不拖,否则选不了文字。
      draggable={renaming !== s.id}
      onDragStart={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
        e.dataTransfer.effectAllowed = 'copy'
        // 拖已选中的会话 = 整批带走(引用块支持多条)。
        const all = [...p.sessions, ...p.archivedSessions]
        const refs = sel.batch(s.id).map((id) => {
          const x = all.find((y) => y.id === id)
          return { kind: 'session' as const, id, title: x?.title || 'New Chat' }
        })
        setChatRefDrag(e.dataTransfer, refs)
      }}
    >
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
    </SidebarRow>
  )

  return (
    <aside className="t2s-side" ref={rootRef}>
      <div className="t2s-search">
        <Search size={13} className="t2s-dim" />
        <input value={query} placeholder={t('sidebar.search.placeholder')} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div
        className="t2s-scroll"
        // 拖组时整列表放行 drop:落在组间外边距 / 列表空白处也提交到当前落点,不再「松手什么都没发生」。
        onDragOver={(e) => { if (dragKey) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
        onDrop={(e) => { if (dragKey && dragOverKey) { e.preventDefault(); dropWorkspace(dragOverKey) } }}
      >
        {q ? (
          <>
            {matchAll.map(renderItem)}
            {/* 正文命中(问引擎):标题匹配之下单独一组,带命中片段;点了直接跳到那条消息。 */}
            {!!contentHits.length && (
              <>
                <div className="t2s-hint t2s-deep-head">{t('sidebar.search.inContent')}</div>
                {contentHits.map((h) => (
                  <button
                    key={h.id}
                    className="t2s-srow t2s-deep"
                    title={h.hit?.snippet || h.summary || h.title}
                    style={{ paddingLeft: rowPadLeft(1) }}
                    onClick={() => { useApp.getState().setJumpTarget(h.id, h.hit?.messageId); p.onSelect(h.id) }}
                  >
                    <span className="t2s-lead"><MessageSquare className="t2s-lead-icon t2s-dim" /></span>
                    <span className="t2s-deep-col">
                      <span className="t2s-srow-title">{h.title || 'New Chat'}</span>
                      <span className="t2s-deep-snip">{h.hit?.snippet || h.summary}</span>
                    </span>
                    <span className="t2s-deep-date">{h.updatedAt}</span>
                  </button>
                ))}
              </>
            )}
            {deepBusy && <div className="t2s-hint">{t('sidebar.search.searching')}</div>}
            {deepErr && !deepBusy && <div className="t2s-hint">{t('sidebar.search.contentFailed')}</div>}
            {!matchAll.length && !contentHits.length && !deepBusy && !deepErr && (
              <div className="t2s-hint">{t('sidebar.search.noResults')}</div>
            )}
          </>
        ) : (
          <>
            {p.showSpecial && (
              <div className="t2s-special-group">
                {/* 尺寸由 .t2s-special-ic > svg 的 --t2s-icon 接管,故不传 size(传了也无效)。 */}
                <SpecialRow icon={<SquarePen />} title={t('sidebar.newChat')} active={false} onClick={p.onNewChat} />
              </div>
            )}

            {orderedWorkspaces.map((ws, wi) => {
              const items = grouped.get(ws.key) || []
              const isCollapsed = collapsedGroups.has(ws.key)
              // 组内会话行也认这一组的落点(否则松手落在会话行上 = 什么都没发生)。
              // 刻意不挂 dragLeave:落点粘住最后悬停过的组,松手落在组间那 4.5px 外边距里也照样成立
              // (列表级兜底见 .t2s-scroll 的 onDragOver/onDrop)。
              const dropOn = {
                // 回到源组上方要把落点清掉(否则线粘在别处,松手却按那条线提交);
                // onDrop 必须 stopPropagation:不然还会冒到 .t2s-scroll 兜底,拿闭包里的旧 dragOverKey 再提交一次。
                onDragOver: (e: React.DragEvent) => {
                  if (!dragKey) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const k = dragKey === ws.key ? null : ws.key
                  if (dragOverKey !== k) setDragOverKey(k)
                },
                onDrop: (e: React.DragEvent) => { if (dragKey) { e.preventDefault(); e.stopPropagation(); dropWorkspace(ws.key) } },
              }
              // 顶掉目标位置 → 下移时落点在整块「之下」,插入线就得画到块下沿(展开态 = sessions 容器下沿),
              // 不能还画在组头上方骗人。也正因如此,拖到最后一组 = 能真的排到最末(旧的插入语义排不到)。
              const overThis = !!dragKey && dragOverKey === ws.key && dragKey !== ws.key
              const after = overThis && dragIdx >= 0 && dragIdx < wi
              const overCls = after ? (isCollapsed ? ' drag-over below' : '') : overThis ? ' drag-over' : ''
              return (
                <React.Fragment key={ws.key}>
                  <div
                    className={`t2s-group${overCls}${dragKey === ws.key ? ' dragging' : ''}`}
                    // 组头 = depth 0;减掉 toggle 自带内边距,槽才与组内会话行落在同一竖线(见 treeIndent.ts)。
                    style={{ paddingLeft: folderPadLeft(0) }}
                    {...tipProps(() => [
                      ws.path || '',
                      tipT('tip.sessions', { count: items.length }),
                    ].filter(Boolean))}
                    draggable={wsRenaming !== ws.key}
                    onDragStart={(e) => {
                      // 用元素自身作拖影并按抓取点对齐光标(否则默认拖影/setState 重渲会让图标与光标错位)。
                      const r = e.currentTarget.getBoundingClientRect()
                      e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragKey(ws.key)
                    }}
                    {...dropOn}
                    onDragEnd={() => { setDragKey(null); setDragOverKey(null) }}
                  >
                    {wsRenaming === ws.key ? (
                      <div className="t2s-group-toggle t2s-folder-row" style={{ cursor: 'default' }}>
                        {wsLead(ws, isCollapsed)}
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
                    ) : ws.kind === 'channel' ? (
                      // 通道文件夹:纯展开折叠(与普通工作区一致)。行尾连接状态点。
                      <button className="t2s-group-toggle t2s-folder-row" onClick={() => { isCollapsed ? enterGroup(ws.key) : toggleGroup(ws.key) }}>
                        {wsLead(ws, isCollapsed)}
                        <span className="t2s-group-label">{ws.name}</span>
                        <span className={`t2s-mini-dot${channelRunning.get(ws.channel || 'wechat') ? ' ok' : ''}`} />
                      </button>
                    ) : (
                      // 点组头 = 纯展开/折叠,**不跳主区**(用户拍板;进工作区详情走「查看更多」或组菜单)。
                      // 已展开再点 = 折叠(toggleGroup 不动 activeWorkspaceKey,不会被联动 effect 弹回);收起时点 = 展开自己。
                      <button className="t2s-group-toggle t2s-folder-row" onClick={() => { isCollapsed ? enterGroup(ws.key) : toggleGroup(ws.key) }}>
                        {wsLead(ws, isCollapsed)}
                        <span className="t2s-group-label">{ws.name}</span>
                      </button>
                    )}
                    {/* 行尾顺序:… 在左、+ 在右(同笔记树)。 */}
                    {!ws.system && (
                      <button className="t2s-group-add" title={t('sidebar.ws.menu')} onClick={(e) => openWsMenu(e, ws)}><MoreHorizontal size={14} /></button>
                    )}
                    <button className="t2s-group-add" title={t('sidebar.newChatIn', { name: ws.name })} onClick={() => p.onNewInWorkspace(ws)}><Plus size={14} /></button>
                  </div>
                  <AnimatedCollapse open={!isCollapsed}>
                    <div className={`t2s-group-sessions${after && !isCollapsed ? ' drag-over-end' : ''}`} {...dropOn}>
                      {items.slice(0, sessionLimit).map(renderItem)}
                      {items.length > sessionLimit && (
                        <button className="t2s-viewmore" onClick={() => p.onOpenWorkspace(ws.key)}>{t('sidebar.viewMore')} · {items.length}</button>
                      )}
                    </div>
                  </AnimatedCollapse>
                </React.Fragment>
              )
            })}

          </>
        )}
      </div>

      {/* 「添加本地工作区」+「已归档」常驻侧栏底部(sticky footer),不随会话列表滚走。 */}
      {(window.tangu?.pickDirectory || p.archivedSessions.length > 0) && (
        <div className="t2s-foot">
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
        </div>
      )}

      {/* 个人中心卡片 + 设置已移到左侧 ribbon 底部(见 bootstrapEngine rb-settings / rb-account)。 */}

      {menu && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          {/* 与笔记树右键菜单同一项(amadeusViews 的「在新标签页打开」);⌘/Ctrl 单击是它的快捷路径。 */}
          {menu.ids.length === 1 && (
            <button onClick={() => { p.onSelect(menu.id, { newTab: true }); setMenu(null) }}>
              <Plus size={13} /> {t('sidebar.openInNewTab')}
            </button>
          )}
          {menu.ids.length === 1 && (
            <button onClick={() => { const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id); setDraft(s?.title || ''); setRenaming(menu.id); setMenu(null) }}>
              <Pencil size={13} /> {t('sidebar.rename')}
            </button>
          )}
          <button onClick={() => { for (const id of menu.ids) p.onArchive(id, !menu.archived); sel.clear(); setMenu(null) }}>
            {menu.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {menu.ids.length > 1
              ? t(menu.archived ? 'sidebar.unarchiveN' : 'sidebar.archiveN', { n: String(menu.ids.length) })
              : menu.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
          </button>
          {menu.ids.length === 1 && (() => {
            // 通道会话 → 「设为正在连接」(该通道的入站消息改走此会话)。
            const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id)
            const chWs = s?.project_path ? p.workspaces.find((w) => w.kind === 'channel' && w.key === s.project_path) : null
            if (!s || !chWs?.channel) return null
            const Ic = CHANNEL_ICONS[chWs.channel]
            return (
              <button onClick={() => {
                setMenu(null)
                void setChannelConnectedSession(p.cfg, chWs.channel!, menu.id)
                  .then(() => p.onToast?.(t('sidebar.wechat.setConnectedOk')))
                  .catch((e) => p.onToast?.(t('sidebar.wechat.setConnectedFail', { e: e?.message || e }), true))
              }}>
                <Ic size={13} /> {t('sidebar.channel.setAsConnected')}
              </button>
            )
          })()}
          {/* 删除仍只给已归档的(旧规矩:先归档再删);多选时要求**整批都已归档**,免得一刀切进活跃会话。 */}
          {menu.ids.every((id) => p.archivedSessions.some((x) => x.id === id)) && (
            <button className="danger" onClick={() => {
              const ids = menu.ids
              const s = [...p.sessions, ...p.archivedSessions].find((x) => x.id === menu.id)
              setMenu(null)
              const ok = ids.length > 1
                ? window.confirm(t('sidebar.deleteConfirmN', { n: String(ids.length) }))
                : window.confirm(t('sidebar.deleteConfirm', { name: s?.title || 'New Chat' }))
              if (!ok) return
              for (const id of ids) p.onDelete(id)
              sel.clear()
            }}>
              <Trash2 size={13} /> {menu.ids.length > 1 ? t('sidebar.deleteN', { n: String(menu.ids.length) }) : t('sidebar.delete')}
            </button>
          )}
        </OverlayAt>
      )}

      {wsMenu && (
        <OverlayAt className="ctx-menu" x={wsMenu.x} y={wsMenu.y} onClick={(e) => e.stopPropagation()}>
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
        </OverlayAt>
      )}
    </aside>
  )
}
