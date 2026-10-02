/**
 * New Chat 主界面的「Project(工作区)」选择器 pill + 下拉(对齐 Codex)。
 * 决定这条新对话落进哪个工作区:本地目录(host)或 Cloud 云沙箱。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Folder, Cloud, ChevronDown, Check, Search, FolderPlus, FolderX } from 'lucide-react'
import type { WorkspaceDescriptor } from '../types'
import { useI18n } from '../i18n'
import { isCoarsePointer } from '../touch'
import { nativeSheetPresenter, openNativeSheetMenu, presentNativePrompt, useEdgeNudge, type SheetMenu, type SheetMenuItem } from '@lcl/engine'

export const ProjectSelector: React.FC<{
  workspaces: WorkspaceDescriptor[]
  value: string | null
  onChange: (ws: WorkspaceDescriptor) => void
  onAddProject?: () => void
  /** 新建云端 Project(名字经内联输入收集);与 onAddProject(本地目录)可并存。 */
  onAddCloudProject?: (name: string) => void
}> = ({ workspaces, value, onChange, onAddProject, onAddCloudProject }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 下拉是 absolute-in-relative + 标准选择面宽度、左对齐，窄屏用视口夹取兜底。
  const menuFix = useEdgeNudge(open)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false); setQ(''); setNaming(false); setDraft('')
      }
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false); setQ(''); setNaming(false); setDraft('')
      ref.current?.querySelector<HTMLButtonElement>('.project-pill')?.focus()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  // 仅在工作区(排除微信);选中项先按真实 key 或默认工作区的历史路径别名匹配。
  // 否则旧默认路径的草稿会被发送链归入当前默认组，pill 却显示别的项目。
  const pickable = workspaces.filter((w) => w.kind !== 'channel')
  const selected = pickable.find((w) => w.key === value || (!!value && w.sessionKeys?.includes(value)))
    || pickable.find((w) => w.kind === 'local' && w.system)
    || pickable[0] || null
  const projectless = pickable.find((w) => w.kind === 'rootless') || null
  const projects = pickable.filter((w) => w.kind !== 'rootless')
  const query = q.trim().toLowerCase()
  const list = projects.filter((w) => !query || `${w.name} ${w.path || ''} ${w.project || ''}`.toLowerCase().includes(query))
  // 项目少时搜索只是一行噪音；达到需要浏览的数量再渐进披露。
  const showSearch = projects.length >= 6
  const SelectedIcon = selected?.kind === 'cloud' ? Cloud : selected?.kind === 'rootless' ? FolderX : Folder
  const closeMenu = (): void => { setOpen(false); setQ(''); setNaming(false); setDraft('') }
  const pick = (ws: WorkspaceDescriptor): void => { onChange(ws); closeMenu() }

  // 菜单条目的唯一一份:Web 下拉与 Android 原生半屏(lcl nativeSheet 可选宿主)都从这里渲染。
  const projectItem = (w: WorkspaceDescriptor): SheetMenuItem => ({
    id: `ws:${w.key}`, label: w.name, icon: w.kind === 'cloud' ? <Cloud size={14} /> : <Folder size={14} />,
    checked: w.key === selected?.key, run: () => pick(w),
  })
  const projectlessItem = projectless ? {
    id: `ws:${projectless.key}`, label: t('input.project.dontWork'), icon: <FolderX size={14} />,
    checked: projectless.key === selected?.key, run: () => pick(projectless),
  } satisfies SheetMenuItem : null
  /** 云端 Project 的名字:Web 是菜单里的内联输入,原生半屏是原生输入框;同一条提交规则(trim 后非空)。 */
  const addCloudItem: SheetMenuItem | null = onAddCloudProject ? {
    id: 'add-cloud', label: t('input.project.addCloud'), icon: <Cloud size={14} />,
    run: () => {
      if (!nativeSheetPresenter()) { setNaming(true); return }
      void presentNativePrompt({ title: t('input.project.addCloud'), placeholder: t('input.project.cloudName'), confirm: t('common.confirm'), cancel: t('common.cancel') }).then((out) => {
        if (!out.handled) { setOpen(true); setNaming(true); return }
        const name = out.value?.text.trim()
        if (name) onAddCloudProject(name)
      })
    },
  } : null
  const addLocalItem: SheetMenuItem | null = onAddProject ? {
    id: 'add-local', label: t('input.project.add'), icon: <FolderPlus size={14} />, run: () => { onAddProject(); closeMenu() },
  } : null
  const nativeMenu = (): SheetMenu => ({
    title: t('input.project.label'),
    back: t('common.back'),
    ...(showSearch ? { search: { placeholder: t('input.project.search'), empty: t('input.project.noMatches') } } : {}),
    sections: [
      { items: projects.map(projectItem) },
      { items: projectlessItem ? [projectlessItem] : [] },
      { items: [addCloudItem, addLocalItem].filter((x): x is SheetMenuItem => !!x) },
    ],
  })

  useEffect(() => {
    if (!open || isCoarsePointer()) return
    const frame = requestAnimationFrame(() => {
      const target = showSearch
        ? menuRef.current?.querySelector<HTMLInputElement>('.project-menu-search input')
        : menuRef.current?.querySelector<HTMLButtonElement>('.project-menu-item.active')
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, showSearch])

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('.project-menu-item:not(:disabled)') || [])]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
      : event.key === 'ArrowDown' ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div className={`project-selector${open ? ' is-open' : ''}`} ref={ref}>
      <button
        className={`composer-chip project-pill${open ? ' is-open' : ''}`}
        onClick={() => {
          if (open) { closeMenu(); return }
          // Android:原生半屏;没有原生宿主(桌面 / 网页)照旧展开 Web 下拉,宿主呈现失败也回落 Web。
          if (openNativeSheetMenu(nativeMenu, { onFallback: () => setOpen(true) })) return
          setOpen(true)
        }}
        title={t('input.project.label')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <SelectedIcon size={13} />
        <span className="project-pill-name">{selected?.name || t('input.project.none')}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          ref={(el) => { menuRef.current = el; menuFix.ref.current = el }}
          className="composer-menu project-menu"
          style={menuFix.style}
          role="menu"
          aria-label={t('input.project.label')}
          onKeyDown={moveMenuFocus}
        >
          {showSearch && (
            <label className="project-menu-search">
              <Search size={13} />
              {/* 触屏不自动聚焦：软键盘会让向上弹的菜单移位，导致首次点击落空。 */}
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('input.project.search')} />
            </label>
          )}
          <div className="project-menu-list">
            {list.map(projectItem).map((it) => (
              <button
                key={it.id}
                className={`menu-item project-menu-item${it.checked ? ' active' : ''}`}
                role="menuitemradio"
                aria-checked={!!it.checked}
                onClick={it.run}
              >
                {it.icon}
                <span className="grow project-menu-name">{it.label}</span>
                <span className="project-menu-check">{it.checked ? <Check size={13} /> : null}</span>
              </button>
            ))}
            {!list.length && <div className="project-menu-empty">{t('input.project.noMatches')}</div>}
          </div>
          {/* 项目外是一种选择，与新建动作分组；每行保留自己的圆角和键盘聚焦底。 */}
          {projectlessItem && (
            <div className="project-menu-section project-menu-projectless-section" role="group">
              <button
                className={`menu-item project-menu-item project-menu-projectless${projectlessItem.checked ? ' active' : ''}`}
                role="menuitemradio"
                aria-checked={projectlessItem.checked}
                onClick={projectlessItem.run}
              >
                {projectlessItem.icon}
                <span className="grow project-menu-name">{projectlessItem.label}</span>
                <span className="project-menu-check">{projectlessItem.checked ? <Check size={13} /> : null}</span>
              </button>
            </div>
          )}
          {(addCloudItem || addLocalItem) && (
            <div className="project-menu-section project-menu-actions" role="group">
              {onAddCloudProject && addCloudItem && (naming ? (
                <label className="project-menu-search project-menu-naming">
                  <Cloud size={13} />
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={t('input.project.cloudName')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && draft.trim()) { onAddCloudProject(draft.trim()); closeMenu() }
                      if (e.key === 'Escape') { e.stopPropagation(); setDraft(''); setNaming(false) }
                    }}
                  />
                </label>
              ) : (
                <button className="menu-item project-menu-item project-menu-add" role="menuitem" onClick={addCloudItem.run}>
                  {addCloudItem.icon}<span className="grow">{addCloudItem.label}</span>
                </button>
              ))}
              {addLocalItem && (
                <button className="menu-item project-menu-item project-menu-add" role="menuitem" onClick={addLocalItem.run}>
                  {addLocalItem.icon}<span className="grow">{addLocalItem.label}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
