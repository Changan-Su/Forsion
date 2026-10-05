/**
 * Chat Box 的「添加」胶囊。
 *
 * 一级菜单负责动作入口；对话 / View 走贴边二级菜单，直接消费项目已有的会话与 View MRU，
 * 不另存一份历史。最终只把结构化引用交还 Composer2，引用如何落成 chip / 正文仍由 Composer 统一处理。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Camera, ChevronDown, ChevronRight, FileText, Image as ImageIcon, MessageSquarePlus, MessagesSquare,
  PanelsTopLeft, Paperclip, Plus, Search, UserPlus,
} from 'lucide-react'
import { allViews, getView, label, nestedPanelPlacement, openNativeSheetMenu, UI_ZOOM_EVENT, useEdgeNudge, useWorkspace, zoomOf, type SheetMenu, type SheetMenuItem } from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'
import { usePageStore } from '../../amadeus/store/pageStore'
import { useRecentViews } from '../../recentViews'
import { useApp } from '../../stores/appStore'
import type { ChatRef } from './chatDragRef'

registerMessages({
  'addMenu.label': { zh: '添加', en: 'Add' },
  'addMenu.newChat': { zh: '新会话', en: 'New session' },
  'addMenu.agent': { zh: '添加 Agent', en: 'Add agent' },
  'addMenu.files': { zh: '添加文件或文件夹', en: 'Add files or folders' },
  'addMenu.camera': { zh: '拍照', en: 'Take photo' },
  'addMenu.photos': { zh: '相册', en: 'Photos' },
  'addMenu.file': { zh: '文件', en: 'Files' },
  'addMenu.conversation': { zh: '添加会话', en: 'Add session' },
  'addMenu.view': { zh: '添加正在使用的 View', en: 'Add an active View' },
  'addMenu.searchChats': { zh: '搜索全部会话', en: 'Search all sessions' },
  'addMenu.searchViews': { zh: '搜索全部 View', en: 'Search all Views' },
  'addMenu.recent': { zh: '最近使用', en: 'Recent' },
  'addMenu.allChats': { zh: '全部会话', en: 'All sessions' },
  'addMenu.inUse': { zh: '正在使用', en: 'In use' },
  'addMenu.allViews': { zh: '全部 View', en: 'All Views' },
  'addMenu.noMatches': { zh: '没有匹配项', en: 'No matches' },
})

export type AddContentReference = ChatRef | { kind: 'view'; type: string; title: string }

interface ViewCandidate {
  key: string
  type: string
  title: string
  ref: AddContentReference
  meta?: string
}

const OMIT_VIEW_TYPES = new Set(['chat', 'chat-panel', 'home', 'launcher', 'sidebar-empty'])
/** 原生半屏「全部会话」页最多带多少条(原生解析上限 600 项/请求;搜索在原生侧对这份做)。 */
export const NATIVE_ALL_SESSIONS_CAP = 300

/**
 * 原生半屏「添加会话」页的两节(最近 / 其余全部);**装不下就返回 null**,调用方改走 Web 二级面板。
 * 原生页的搜索只在递过去的那份名单里找:此前超过上限时直接截到 300 条,第 301 条以后的会话在原生搜索里
 * 永远搜不到,也没有任何提示(Web 面板搜的是全量)。截断的名单不如不给 —— 整页回落到能搜全量的 Web 面板。
 */
export function nativeSessionPage<S extends { id: string }>(recent: readonly S[], all: readonly S[], cap = NATIVE_ALL_SESSIONS_CAP): { recent: S[]; rest: S[] } | null {
  const recentIds = new Set(recent.map((x) => x.id))
  const rest = all.filter((x) => !recentIds.has(x.id))
  return rest.length > cap ? null : { recent: [...recent], rest }
}

function uniqueViews(items: ViewCandidate[]): ViewCandidate[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.key)) return false
    seen.add(item.key)
    return true
  })
}

export const AddContentMenu: React.FC<{
  open: boolean
  disabled?: boolean
  activeSessionId?: string | null
  canUsePathPicker: boolean
  onOpenChange: (open: boolean) => void
  onNewSession?: () => void
  onAddAgent?: () => void
  onPickPaths: (items: Array<{ path: string; isDirectory: boolean }>) => void | Promise<void>
  onPickFiles: (files: FileList | null) => void | Promise<void>
  onAddReference: (ref: AddContentReference) => void
}> = ({
  open, disabled, activeSessionId, canUsePathPicker, onOpenChange, onNewSession, onAddAgent,
  onPickPaths, onPickFiles, onAddReference,
}) => {
  const { t } = useI18n()
  const [pane, setPane] = useState<'conversation' | 'view' | null>(null)
  const [query, setQuery] = useState('')
  const [placement, setPlacement] = useState<'right' | 'left' | 'stacked'>('right')
  const [stackOffset, setStackOffset] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuFix = useEdgeNudge(open, { boundary: '.t2-chat-view' })
  const subFix = useEdgeNudge(pane ? `${pane}:${placement}` : '', { boundary: '.t2-chat-view' })

  const sessions = useApp((s) => s.sessions)
  const archivedSessions = useApp((s) => s.archivedSessions)
  const recents = useRecentViews((s) => s.items)
  const mainTabs = useWorkspace((s) => s.mainTabs)
  const leftTabs = useWorkspace((s) => s.leftTabs)
  const rightTabs = useWorkspace((s) => s.rightTabs)
  const vaultRoot = usePageStore((s) => s.vaultRoot)

  useEffect(() => {
    if (open) return
    setPane(null)
    setQuery('')
  }, [open])

  useEffect(() => {
    setQuery('')
    if (pane) requestAnimationFrame(() => searchRef.current?.focus())
  }, [pane])

  useLayoutEffect(() => {
    const menu = menuRef.current
    const sub = subRef.current
    if (!pane || !menu || !sub) return
    const update = (): void => {
      const menuRect = menu.getBoundingClientRect()
      const boundaryRect = (menu.closest('.t2c-card') || menu.closest('.t2-chat-view'))?.getBoundingClientRect()
      const zoom = zoomOf(sub)
      const next = boundaryRect
        ? nestedPanelPlacement(menuRect.left, menuRect.right, sub.offsetWidth, boundaryRect.left, boundaryRect.right, zoom)
        : 'right'
      setPlacement((prev) => prev === next ? prev : next)
      setStackOffset((prev) => prev === menu.offsetHeight + 6 ? prev : menu.offsetHeight + 6)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener(UI_ZOOM_EVENT, update)
    const ro = new ResizeObserver(update)
    ro.observe(menu)
    ro.observe(sub)
    const boundary = menu.closest('.t2c-card') || menu.closest('.t2-chat-view')
    if (boundary) ro.observe(boundary)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener(UI_ZOOM_EVENT, update)
      ro.disconnect()
    }
  }, [pane])

  const allSessions = useMemo(() => {
    const seen = new Set<string>()
    return [...sessions, ...archivedSessions].filter((s) => {
      if (s.id === activeSessionId || seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
  }, [sessions, archivedSessions, activeSessionId])

  const recentSessions = useMemo(() => {
    const byId = new Map(allSessions.map((s) => [s.id, s]))
    const fromMru = recents.filter((r) => r.kind === 'chat').map((r) => byId.get(r.id)).filter(Boolean)
    return (fromMru.length ? fromMru : allSessions).slice(0, 6) as typeof allSessions
  }, [allSessions, recents])

  const sessionMatches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return recentSessions
    return allSessions.filter((s) => `${s.title || ''}\n${s.summary || ''}`.toLocaleLowerCase().includes(q)).slice(0, 12)
  }, [query, recentSessions, allSessions])

  const openViews = useMemo<ViewCandidate[]>(() => {
    const main = mainTabs.flatMap((tab): ViewCandidate[] => {
      if (OMIT_VIEW_TYPES.has(tab.type)) return []
      const title = tab.title || label(getView(tab.type)?.displayName || tab.type)
      if (tab.filePath) {
        const note = tab.type === 'amadeus-editor' && !!vaultRoot
        return [{
          key: `${note ? 'note' : 'file'}:${tab.filePath}`,
          type: tab.type,
          title,
          ref: note ? { kind: 'note', path: tab.filePath } : { kind: 'file', path: tab.filePath },
          meta: tab.filePath,
        }]
      }
      return [{ key: `view:${tab.type}`, type: tab.type, title, ref: { kind: 'view', type: tab.type, title } }]
    })
    const sides = [...leftTabs, ...rightTabs].flatMap((tab): ViewCandidate[] => {
      if (OMIT_VIEW_TYPES.has(tab.type)) return []
      return [{ key: `view:${tab.type}`, type: tab.type, title: tab.title, ref: { kind: 'view', type: tab.type, title: tab.title } }]
    })
    return uniqueViews([...main, ...sides]).slice(0, 8)
  }, [mainTabs, leftTabs, rightTabs, vaultRoot])

  const recentViewCandidates = useMemo<ViewCandidate[]>(() => uniqueViews(recents.flatMap((r): ViewCandidate[] => {
    if (r.kind === 'chat') return []
    if (r.kind === 'note') return [{ key: r.key, type: 'amadeus-editor', title: r.title, ref: { kind: 'note', path: r.id }, meta: r.id }]
    if (r.kind === 'file' && r.viewType) return [{ key: r.key, type: r.viewType, title: r.title, ref: { kind: 'file', path: r.id }, meta: r.id }]
    if (r.kind === 'view' && r.viewType && getView(r.viewType)) return [{ key: r.key, type: r.viewType, title: r.title, ref: { kind: 'view', type: r.viewType, title: r.title } }]
    return []
  })).slice(0, 6), [recents])

  // 注册表是运行期可变的（插件可启停）。菜单每次打开都会重渲，直接现读比另造订阅更可靠。
  const registeredViews: ViewCandidate[] = allViews()
    .filter((def) => !OMIT_VIEW_TYPES.has(def.type))
    .map((def) => {
      const title = label(def.displayName)
      return { key: `view:${def.type}`, type: def.type, title, ref: { kind: 'view' as const, type: def.type, title } }
    })

  const viewMatches = (() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return []
    return uniqueViews([...openViews, ...recentViewCandidates, ...registeredViews])
      .filter((v) => `${v.title}\n${v.type}\n${v.meta || ''}`.toLocaleLowerCase().includes(q))
      .slice(0, 12)
  })()

  const selectReference = (ref: AddContentReference): void => {
    onAddReference(ref)
    onOpenChange(false)
  }

  /** Android:这几项是在原生半屏里点的,WebView 没有用户激活 → 文件 input 的 click() 会被 Chromium 丢掉,
   *  改走宿主给的来源(系统文件选择器 / 照片选择器 / 相机)。取消、没拍成 = 空数组,什么都不加。 */
  const attachFrom = async (pick: () => Promise<File[]>): Promise<void> => {
    onOpenChange(false)
    const files = await pick()
    if (!files.length) return
    const dt = new DataTransfer()
    files.forEach((f) => dt.items.add(f))
    await onPickFiles(dt.files)
  }

  const choosePaths = async (): Promise<void> => {
    if (canUsePathPicker && window.tangu?.pickPaths) {
      onOpenChange(false)
      const items = await window.tangu.pickPaths()
      if (items.length) await onPickPaths(items)
      return
    }
    if (window.tangu?.pickFiles) return attachFrom(() => window.tangu!.pickFiles!())
    fileInputRef.current?.click()
  }

  const viewIcon = (type: string): React.ComponentType<{ size?: number; className?: string }> => getView(type)?.icon || PanelsTopLeft

  // ── 条目的唯一一份:Web 菜单与 Android 原生半屏(lcl nativeSheet 可选宿主)都从这里渲染 ──
  const viewItem = (item: ViewCandidate): SheetMenuItem => {
    const Icon = item.ref.kind === 'file' || item.ref.kind === 'note' ? FileText : viewIcon(item.type)
    return { id: `ref:${item.key}`, label: item.title, detail: item.meta, icon: <Icon size={14} />, run: () => selectReference(item.ref) }
  }
  const sessionItem = (session: (typeof allSessions)[number]): SheetMenuItem => ({
    id: `session:${session.id}`, label: session.title || 'Chat', detail: session.summary || undefined, icon: <MessagesSquare size={14} />,
    run: () => selectReference({ kind: 'session', id: session.id, title: session.title || 'Chat' }),
  })
  const newChatItem: SheetMenuItem = { id: 'new-chat', label: t('addMenu.newChat'), icon: <MessageSquarePlus size={14} />, run: () => { onNewSession?.(); onOpenChange(false) } }
  const addAgentItem: SheetMenuItem | null = onAddAgent ? { id: 'add-agent', act: 'add-agent', label: t('addMenu.agent'), icon: <UserPlus size={14} />, run: () => { onAddAgent(); onOpenChange(false) } } : null
  const filesItem: SheetMenuItem = { id: 'files', label: t('addMenu.files'), icon: <Paperclip size={14} />, run: () => { void choosePaths() } }
  /** 宿主给了相机和照片选择器(Android)时,原生半屏把「添加文件」拆成三行;手机上没有「文件夹」,那一行只叫「文件」。 */
  const host = window.tangu
  const sourceItems: SheetMenuItem[] = host?.takePhoto && host.pickPhotos && host.pickFiles ? [
    { id: 'camera', label: t('addMenu.camera'), icon: <Camera size={14} />, run: () => { void attachFrom(() => host.takePhoto!()) } },
    { id: 'photos', label: t('addMenu.photos'), icon: <ImageIcon size={14} />, run: () => { void attachFrom(() => host.pickPhotos!()) } },
    { ...filesItem, label: t('addMenu.file') },
  ] : [filesItem]

  /** 原生半屏:一级 = 同样的动作入口;会话 / View 两个二级页带原生搜索(数据都已在 store 里,同步可得)。
   *  会话多到原生页装不下时,「添加会话」这一项改为打开 Web 菜单并直达会话面板(那里搜的是全量)。 */
  const nativeMenu = (): SheetMenu => {
    const sessionPage = nativeSessionPage(recentSessions, allSessions)
    const shownViews = uniqueViews([...openViews, ...recentViewCandidates])
    const shownKeys = new Set(shownViews.map((v) => v.key))
    const searchEmpty = t('addMenu.noMatches')
    return {
      title: t('addMenu.label'),
      back: t('common.back'),
      sections: [{
        items: [
          newChatItem,
          ...(addAgentItem ? [addAgentItem] : []),
          ...sourceItems,
          sessionPage ? {
            id: 'conversation', label: t('addMenu.conversation'), icon: <MessagesSquare size={14} />,
            search: { placeholder: t('addMenu.searchChats'), empty: searchEmpty },
            children: [
              { title: t('addMenu.recent'), items: sessionPage.recent.map(sessionItem) },
              { title: t('addMenu.allChats'), items: sessionPage.rest.map(sessionItem) },
            ],
          } : {
            id: 'conversation', label: t('addMenu.conversation'), icon: <MessagesSquare size={14} />,
            run: () => { onOpenChange(true); setPane('conversation') },
          },
          {
            id: 'view', label: t('addMenu.view'), icon: <PanelsTopLeft size={14} />,
            search: { placeholder: t('addMenu.searchViews'), empty: searchEmpty },
            children: [
              { title: t('addMenu.inUse'), items: openViews.map(viewItem) },
              { title: t('addMenu.recent'), items: recentViewCandidates.filter((v) => !openViews.some((o) => o.key === v.key)).map(viewItem) },
              { title: t('addMenu.allViews'), items: registeredViews.filter((v) => !shownKeys.has(v.key)).map(viewItem) },
            ],
          },
        ],
      }],
    }
  }

  const renderViewRows = (items: ViewCandidate[]): React.ReactNode => items.map((item) => {
    const it = viewItem(item)
    return (
      <button key={item.key} className="menu-item add-menu-result" title={item.meta || item.title} onClick={it.run}>
        {it.icon}
        <span className="grow add-menu-result-main">
          <span className="add-menu-result-title">{it.label}</span>
          {it.detail && <span className="add-menu-result-meta">{it.detail}</span>}
        </span>
      </button>
    )
  })

  return (
    <span className={`add-pill-wrap t2c-capsule-peer${open ? ' is-open' : ''}`} data-cmenu>
      <button
        className={`t2c-pill add-pill-btn${open ? ' is-open' : ''}`}
        title={t('input.addContent')}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          // Android:原生半屏;没有原生宿主(桌面 / 网页)照旧展开 Web 菜单,宿主呈现失败也回落 Web。
          if (!open && openNativeSheetMenu(nativeMenu, { onFallback: () => onOpenChange(true) })) return
          onOpenChange(!open)
        }}
      >
        <Plus size={16} className="add-pill-plus" />
        <span className="add-pill-label">{t('addMenu.label')}</span>
        <ChevronDown size={10} className="add-pill-chevron" />
      </button>

      {open && (
        <div
          ref={(el) => { menuRef.current = el; menuFix.ref.current = el }}
          className="composer-menu composer-menu--add"
          style={menuFix.style}
        >
          <button className="menu-item" onClick={newChatItem.run}>
            {newChatItem.icon}
            <span className="grow">{newChatItem.label}</span>
          </button>
          {addAgentItem && <button className="menu-item" data-add-agent onClick={addAgentItem.run}>
            {addAgentItem.icon}<span className="grow">{addAgentItem.label}</span>
          </button>}
          <button className="menu-item" onClick={filesItem.run}>
            {filesItem.icon}
            <span className="grow">{filesItem.label}</span>
          </button>
          <button
            className={`menu-item add-menu-parent${pane === 'conversation' ? ' active' : ''}`}
            aria-expanded={pane === 'conversation'}
            onPointerEnter={() => setPane('conversation')}
            onFocus={() => setPane('conversation')}
            onClick={() => setPane('conversation')}
          >
            <MessagesSquare size={14} />
            <span className="grow">{t('addMenu.conversation')}</span>
            <ChevronRight size={13} />
          </button>
          <button
            className={`menu-item add-menu-parent${pane === 'view' ? ' active' : ''}`}
            aria-expanded={pane === 'view'}
            onPointerEnter={() => setPane('view')}
            onFocus={() => setPane('view')}
            onClick={() => setPane('view')}
          >
            <PanelsTopLeft size={14} />
            <span className="grow">{t('addMenu.view')}</span>
            <ChevronRight size={13} />
          </button>

        </div>
      )}

      {open && pane && (
        <div
          ref={(el) => { subRef.current = el; subFix.ref.current = el }}
          className={`composer-menu add-menu-sub ${placement}`}
          data-pane={pane}
          style={{
            ...subFix.style,
            bottom: placement === 'stacked' ? `calc(100% + ${stackOffset}px)` : undefined,
          }}
        >
          <label className="add-menu-search">
            <Search size={13} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder={t(pane === 'conversation' ? 'addMenu.searchChats' : 'addMenu.searchViews')}
            />
          </label>

          <div className="add-menu-sub-scroll">
            {pane === 'conversation' ? (
              <>
                <div className="menu-section">{t(query.trim() ? 'addMenu.allChats' : 'addMenu.recent')}</div>
                {sessionMatches.map((session) => {
                  const it = sessionItem(session)
                  return (
                    <button
                      key={session.id}
                      className="menu-item add-menu-result"
                      title={session.summary || session.title || ''}
                      onClick={it.run}
                    >
                      {it.icon}
                      <span className="grow add-menu-result-main">
                        <span className="add-menu-result-title">{it.label}</span>
                        {it.detail && <span className="add-menu-result-meta">{it.detail}</span>}
                      </span>
                    </button>
                  )
                })}
                {!sessionMatches.length && <div className="add-menu-empty">{t('addMenu.noMatches')}</div>}
              </>
            ) : query.trim() ? (
              <>
                <div className="menu-section">{t('addMenu.allViews')}</div>
                {renderViewRows(viewMatches)}
                {!viewMatches.length && <div className="add-menu-empty">{t('addMenu.noMatches')}</div>}
              </>
            ) : (
              <>
                <div className="menu-section">{t('addMenu.inUse')}</div>
                {renderViewRows(openViews)}
                {!openViews.length && <div className="add-menu-empty">{t('addMenu.noMatches')}</div>}
                {!!recentViewCandidates.length && <div className="menu-section add-menu-section-gap">{t('addMenu.recent')}</div>}
                {renderViewRows(recentViewCandidates)}
              </>
            )}
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => { void onPickFiles(e.currentTarget.files); e.currentTarget.value = ''; onOpenChange(false) }}
      />
    </span>
  )
}
