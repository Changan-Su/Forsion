/**
 * Chat Box 的「添加」胶囊。
 *
 * 一级菜单负责动作入口；对话 / View 走贴边二级菜单，直接消费项目已有的会话与 View MRU，
 * 不另存一份历史。最终只把结构化引用交还 Composer2，引用如何落成 chip / 正文仍由 Composer 统一处理。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, FileText, MessageSquarePlus, MessagesSquare,
  PanelsTopLeft, Paperclip, Plus, Search,
} from 'lucide-react'
import { allViews, getView, label, useEdgeNudge, useWorkspace, zoomOf } from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'
import { usePageStore } from '../../amadeus/store/pageStore'
import { useRecentViews } from '../../recentViews'
import { useApp } from '../../stores/appStore'
import type { ChatRef } from './chatDragRef'

registerMessages({
  'addMenu.label': { zh: '添加', en: 'Add' },
  'addMenu.newChat': { zh: '新对话', en: 'New chat' },
  'addMenu.files': { zh: '添加文件或文件夹', en: 'Add files or folders' },
  'addMenu.conversation': { zh: '添加对话', en: 'Add conversation' },
  'addMenu.view': { zh: '添加正在使用的 View', en: 'Add an active View' },
  'addMenu.searchChats': { zh: '搜索全部对话', en: 'Search all conversations' },
  'addMenu.searchViews': { zh: '搜索全部 View', en: 'Search all Views' },
  'addMenu.recent': { zh: '最近使用', en: 'Recent' },
  'addMenu.allChats': { zh: '全部对话', en: 'All conversations' },
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

const OMIT_VIEW_TYPES = new Set(['chat', 'home', 'launcher', 'sidebar-empty'])

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
  onPickPaths: (items: Array<{ path: string; isDirectory: boolean }>) => void | Promise<void>
  onPickFiles: (files: FileList | null) => void | Promise<void>
  onAddReference: (ref: AddContentReference) => void
}> = ({
  open, disabled, activeSessionId, canUsePathPicker, onOpenChange, onNewSession,
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
  const menuFix = useEdgeNudge(open)
  const subFix = useEdgeNudge(pane ? `${pane}:${placement}` : '')

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
      const cardRect = menu.closest('.t2c-card')?.getBoundingClientRect()
      const zoom = zoomOf(sub)
      const width = sub.offsetWidth * zoom
      const gap = 6 * zoom
      const edge = 8
      const next = !cardRect || menuRect.right + gap + width <= cardRect.right - edge
        ? 'right'
        : menuRect.left - gap - width >= cardRect.left + edge
        ? 'left'
        : 'stacked'
      setPlacement((prev) => prev === next ? prev : next)
      setStackOffset((prev) => prev === menu.offsetHeight + 6 ? prev : menu.offsetHeight + 6)
    }
    update()
    window.addEventListener('resize', update)
    const ro = new ResizeObserver(update)
    ro.observe(menu)
    ro.observe(sub)
    const card = menu.closest('.t2c-card')
    if (card) ro.observe(card)
    return () => {
      window.removeEventListener('resize', update)
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

  const choosePaths = async (): Promise<void> => {
    if (canUsePathPicker && window.tangu?.pickPaths) {
      onOpenChange(false)
      const items = await window.tangu.pickPaths()
      if (items.length) await onPickPaths(items)
      return
    }
    fileInputRef.current?.click()
  }

  const viewIcon = (type: string): React.ComponentType<{ size?: number; className?: string }> => getView(type)?.icon || PanelsTopLeft

  const renderViewRows = (items: ViewCandidate[]): React.ReactNode => items.map((item) => {
    const Icon = item.ref.kind === 'file' || item.ref.kind === 'note' ? FileText : viewIcon(item.type)
    return (
      <button key={item.key} className="menu-item add-menu-result" title={item.meta || item.title} onClick={() => selectReference(item.ref)}>
        <Icon size={14} />
        <span className="grow add-menu-result-main">
          <span className="add-menu-result-title">{item.title}</span>
          {item.meta && <span className="add-menu-result-meta">{item.meta}</span>}
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
        onClick={() => onOpenChange(!open)}
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
          <button className="menu-item" onClick={() => { onNewSession?.(); onOpenChange(false) }}>
            <MessageSquarePlus size={14} />
            <span className="grow">{t('addMenu.newChat')}</span>
          </button>
          <button className="menu-item" onClick={() => { void choosePaths() }}>
            <Paperclip size={14} />
            <span className="grow">{t('addMenu.files')}</span>
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
                {sessionMatches.map((session) => (
                  <button
                    key={session.id}
                    className="menu-item add-menu-result"
                    title={session.summary || session.title || ''}
                    onClick={() => selectReference({ kind: 'session', id: session.id, title: session.title || 'Chat' })}
                  >
                    <MessagesSquare size={14} />
                    <span className="grow add-menu-result-main">
                      <span className="add-menu-result-title">{session.title || 'Chat'}</span>
                      {session.summary && <span className="add-menu-result-meta">{session.summary}</span>}
                    </span>
                  </button>
                ))}
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
