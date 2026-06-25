/**
 * New Chat 主界面的「Project(工作区)」选择器 pill + 下拉(对齐 Codex)。
 * 决定这条新对话落进哪个工作区:本地目录(host)或 Cloud 云沙箱。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Folder, Cloud, ChevronDown, Check, Search, FolderPlus } from 'lucide-react'
import type { WorkspaceDescriptor } from '../types'
import { useI18n } from '../i18n'

export const ProjectSelector: React.FC<{
  workspaces: WorkspaceDescriptor[]
  value: string | null
  onChange: (ws: WorkspaceDescriptor) => void
  onAddProject?: () => void
}> = ({ workspaces, value, onChange, onAddProject }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  // 仅在工作区(排除微信);选中项缺省取 value,再退回常驻系统本地区(Tangu 默认),再退回首个。
  const pickable = workspaces.filter((w) => w.kind !== 'wechat')
  const selected = pickable.find((w) => w.key === value)
    || pickable.find((w) => w.kind === 'local' && w.system)
    || pickable[0] || null
  const list = pickable.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="project-selector" ref={ref}>
      <button className="project-pill" onClick={() => setOpen((o) => !o)} title={t('input.project.label')}>
        {selected?.kind === 'cloud' ? <Cloud size={13} /> : <Folder size={13} />}
        <span className="project-pill-name">{selected?.name || t('input.project.none')}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="project-menu">
          <div className="project-menu-search">
            <Search size={13} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('input.project.search')} />
          </div>
          <div className="project-menu-list">
            {list.map((w) => (
              <button key={w.key} className="project-menu-item" onClick={() => { onChange(w); setOpen(false) }}>
                {w.kind === 'cloud' ? <Cloud size={14} /> : <Folder size={14} />}
                <span className="project-menu-name">{w.name}</span>
                {w.key === selected?.key && <Check size={14} className="project-menu-check" />}
              </button>
            ))}
          </div>
          {onAddProject && (
            <button className="project-menu-item project-menu-add" onClick={() => { onAddProject(); setOpen(false) }}>
              <FolderPlus size={14} /> {t('input.project.add')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
