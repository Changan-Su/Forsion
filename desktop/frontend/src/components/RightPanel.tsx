/**
 * 右侧面板:工作区文件 / 目录(会话大纲) / 记忆·日志 三个 tab(对标 openhanako Desk 的右栏形态)。
 * 文件区是一个迷你文件管理器:单击选中(cmd/shift 多选)、双击打开/预览、右键菜单、
 * 拖行进文件夹移动、拖 OS 文件进来复制(host)。预览走 App 的工作区文件浮层面板。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  FolderOpen, Folder, List, BookOpen, Download, Trash2, Upload, RefreshCw, FileText, Image as ImageIcon, Loader2, CornerLeftUp,
  FolderPlus, Pencil, ExternalLink, Check, X, Eye,
} from 'lucide-react'
import type { AgentConfig, TanguDesktopConfig, UiMessage, WorkspaceFileMeta } from '../types'
import * as api from '../services/backendService'
import { Markdown } from './Markdown'
import { ChatToc } from './ChatToc'
import type { PreviewTarget } from './WorkspaceFilePreview'
import { fmtSize, b64ToBytes } from '../services/fileKinds'
import { useI18n } from '../i18n'

type Tab = 'workspace' | 'toc' | 'memory'

/** 内部拖拽(拖行进文件夹)携带的源路径;区别于 OS 文件拖入('Files')。 */
const DRAG_MIME = 'application/x-tangu-paths'

export const RightPanel: React.FC<{
  cfg: TanguDesktopConfig
  sessionId: string
  sessionConfig: AgentConfig
  running: boolean
  messages: UiMessage[]
  chatScrollRef: React.RefObject<HTMLDivElement | null>
  onToast: (text: string, error?: boolean) => void
  /** 打开工作区文件浮层预览(由 App 在聊天列渲染面板)。 */
  onOpenPreview: (target: PreviewTarget) => void
}> = (p) => {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('workspace')
  return (
    <aside className="right-panel">
      <div className="right-panel-tabs">
        <button className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}>
          <FolderOpen size={13} /> {t('panel.tab.workspace')}
        </button>
        <button className={tab === 'toc' ? 'active' : ''} onClick={() => setTab('toc')}>
          <List size={13} /> {t('panel.tab.toc')}
        </button>
        <button className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
          <BookOpen size={13} /> {t('panel.tab.memory')}
        </button>
      </div>
      <div className="right-panel-body">
        {tab === 'workspace' && <WorkspaceTab {...p} />}
        {tab === 'toc' && <ChatToc containerRef={p.chatScrollRef} scanTrigger={p.messages.length} />}
        {tab === 'memory' && <MemoryTab {...p} />}
      </div>
    </aside>
  )
}

// ── 选中模型 + 右键菜单(两个文件 tab 共用) ──────────────────────────────────────

/** 单击选中,cmd/ctrl 切换,shift 区间;列表变化时剔除消失项。 */
function useSelection(orderedPaths: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  const key = orderedPaths.join('\n')
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((p) => orderedPaths.includes(p)))
      return next.size === prev.size ? prev : next
    })
  }, [key]) // eslint 无 —— key 已涵盖 orderedPaths 变化
  const only = (path: string) => { setSelected(new Set([path])); anchorRef.current = path }
  const clear = () => { setSelected(new Set()); anchorRef.current = null }
  const onClick = (path: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n })
      anchorRef.current = path
    } else if (e.shiftKey && anchorRef.current) {
      const a = orderedPaths.indexOf(anchorRef.current); const b = orderedPaths.indexOf(path)
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSelected(new Set(orderedPaths.slice(lo, hi + 1))) }
      else only(path)
    } else only(path)
  }
  return { selected, onClick, only, clear }
}

interface CtxItem { label: string; icon?: React.ReactNode; danger?: boolean; run: () => void }
type CtxMenu = { x: number; y: number; items: CtxItem[] } | null

/** 右键浮层菜单(portal 到 body;任意点击/右键/Esc/失焦关闭)。 */
const ContextMenu: React.FC<{ menu: NonNullable<CtxMenu>; onClose: () => void }> = ({ menu, onClose }) => {
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [onClose])
  return createPortal(
    <div
      className="ctx-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      {menu.items.map((it, i) => (
        <button key={i} className={`ctx-item${it.danger ? ' danger' : ''}`} onClick={() => { onClose(); it.run() }}>
          {it.icon}<span>{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

/** 右键坐标钳进视口(估算菜单尺寸,避免溢出右/下边)。 */
const menuPos = (e: React.MouseEvent, count: number) => ({
  x: Math.min(e.clientX, window.innerWidth - 200),
  y: Math.min(e.clientY, window.innerHeight - 16 - count * 32),
})

// ── 工作区 ──────────────────────────────────────────────────────────────────

/** 工作区分发:本机会话浏览 cwd 真实目录(Electron fs);云沙箱走后端工作区。 */
const WorkspaceTab: React.FC<{
  cfg: TanguDesktopConfig
  sessionId: string
  sessionConfig?: AgentConfig
  running: boolean
  onToast: (t: string, e?: boolean) => void
  onOpenPreview: (target: PreviewTarget) => void
}> = (p) => {
  if (p.sessionConfig?.execMode === 'host' && p.sessionConfig.cwd && window.tangu?.listDir) {
    return <HostFilesTab cwd={p.sessionConfig.cwd} running={p.running} onToast={p.onToast} onOpenPreview={p.onOpenPreview} />
  }
  return <SandboxFilesTab {...p} />
}

/** 本机工作区文件浏览(根=会话 cwd;进子目录、选中/双击预览、右键菜单、拖拽移动/复制)。 */
const HostFilesTab: React.FC<{
  cwd: string
  running: boolean
  onToast: (t: string, e?: boolean) => void
  onOpenPreview: (target: PreviewTarget) => void
}> = ({ cwd, running, onToast, onOpenPreview }) => {
  const { t } = useI18n()
  const [curDir, setCurDir] = useState(cwd)
  const [entries, setEntries] = useState<Array<{ name: string; isDir: boolean; size: number; path: string }>>([])
  const [loading, setLoading] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [newFolder, setNewFolder] = useState(false)
  const [newFolderVal, setNewFolderVal] = useState('')
  const [menu, setMenu] = useState<CtxMenu>(null)
  const [dragging, setDragging] = useState<string[] | null>(null) // 内部拖拽的源路径
  const [dropDir, setDropDir] = useState<string | null>(null)      // 高亮的拖入目标
  const [dragInFiles, setDragInFiles] = useState(false)            // OS 文件悬停面板

  const sel = useSelection(entries.map((en) => en.path))

  useEffect(() => { setCurDir(cwd); setRenaming(null); setNewFolder(false) }, [cwd])

  const refresh = useCallback(async () => {
    if (!window.tangu?.listDir) return
    setLoading(true)
    try { setEntries(await window.tangu.listDir(curDir)) }
    catch (e: any) { onToast(t('panel.toast.listDirFail', { err: e?.message || e }), true) }
    finally { setLoading(false) }
  }, [curDir, onToast])
  useEffect(() => { void refresh() }, [refresh, running])

  const parentOf = (d: string): string => { const i = Math.max(d.lastIndexOf('/'), d.lastIndexOf('\\')); return i > 0 ? d.slice(0, i) : d }
  const atRoot = curDir === cwd
  const rel = curDir.startsWith(cwd) ? curDir.slice(cwd.length).replace(/^[/\\]+/, '') : curDir

  const preview = (en: { name: string; isDir: boolean; path: string }) => {
    if (en.isDir || !window.tangu?.readHostFile) return
    onOpenPreview({
      name: en.name,
      load: async () => {
        const r = await window.tangu!.readHostFile!(en.path)
        if (r.tooLarge) return { tooLarge: true as const, size: r.size }
        return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size }
      },
      download: () => { void window.tangu?.revealHostPath?.(en.path) },
    })
  }
  const open = (en: { name: string; isDir: boolean; path: string }) => { en.isDir ? setCurDir(en.path) : preview(en) }

  const beginRename = (en: { name: string; path: string }) => { setRenaming(en.path); setRenameVal(en.name) }
  const commitRename = async (en: { name: string; path: string }) => {
    const name = renameVal.trim(); setRenaming(null)
    if (!name || name === en.name || !window.tangu?.renameHostPath) return
    try { await window.tangu.renameHostPath(en.path, name); void refresh() }
    catch (e: any) { onToast(t('panel.toast.renameFail', { err: e?.message || e }), true) }
  }
  const commitNewFolder = async () => {
    const name = newFolderVal.trim(); setNewFolder(false); setNewFolderVal('')
    if (!name || !window.tangu?.mkdirHost) return
    try { await window.tangu.mkdirHost(curDir, name); void refresh() }
    catch (e: any) { onToast(t('panel.toast.mkdirFail', { err: e?.message || e }), true) }
  }
  const trashPaths = async (paths: string[]) => {
    if (!paths.length || !window.tangu?.trashHostPath) return
    const ok = window.confirm(paths.length === 1
      ? t('panel.confirm.trash', { name: paths[0].split(/[/\\]/).pop() || '' })
      : t('panel.confirm.trashN', { n: String(paths.length) }))
    if (!ok) return
    try { for (const p of paths) await window.tangu.trashHostPath(p); sel.clear(); void refresh() }
    catch (e: any) { onToast(t('panel.toast.deleteFail', { err: e?.message || e }), true) }
  }

  // 拖入文件夹 → 移动选中(或被拖)项;OS 文件拖入 → 复制。
  const moveInto = async (destDir: string, paths: string[]) => {
    const todo = paths.filter((p) => p !== destDir)
    if (!todo.length || !window.tangu?.moveHostPath) return
    try { for (const p of todo) await window.tangu.moveHostPath(p, destDir); sel.clear(); void refresh() }
    catch (e: any) { onToast(t('panel.toast.moveFail', { err: e?.message || e }), true) }
  }
  const copyFilesInto = async (files: FileList, destDir: string) => {
    if (!window.tangu?.copyHostFiles || !window.tangu?.getPathForFile) return
    const paths = Array.from(files).map((f) => { try { return window.tangu!.getPathForFile!(f) } catch { return '' } }).filter(Boolean)
    if (!paths.length) return
    try { const r = await window.tangu.copyHostFiles(paths, destDir); onToast(t('panel.toast.copied', { n: String(r.copied) })); void refresh() }
    catch (e: any) { onToast(t('panel.toast.copyFail', { err: e?.message || e }), true) }
  }

  const openMenu = (e: React.MouseEvent, en: { name: string; isDir: boolean; path: string }) => {
    e.preventDefault(); e.stopPropagation()
    const selPaths = sel.selected.has(en.path) ? [...sel.selected] : [en.path]
    if (!sel.selected.has(en.path)) sel.only(en.path)
    const multi = selPaths.length > 1
    const items: CtxItem[] = []
    if (!multi && !en.isDir) items.push({ label: t('panel.action.preview'), icon: <Eye size={13} />, run: () => preview(en) })
    if (!multi) items.push({ label: t('panel.action.rename'), icon: <Pencil size={13} />, run: () => beginRename(en) })
    if (!multi) items.push({ label: t('panel.action.revealInFileManager'), icon: <ExternalLink size={13} />, run: () => window.tangu?.revealHostPath?.(en.path) })
    items.push({
      label: multi ? t('panel.action.deleteN', { n: String(selPaths.length) }) : t('panel.action.moveToTrash'),
      icon: <Trash2 size={13} />, danger: true, run: () => void trashPaths(selPaths),
    })
    setMenu({ ...menuPos(e, items.length), items })
  }

  const rowDragStart = (e: React.DragEvent, en: { path: string }) => {
    // Alt 拖 = 原生拖出到 OS / 其它应用(主进程 startDrag);默认 = 内部移动(拖进文件夹)。
    if (e.altKey && window.tangu?.startHostDrag) { e.preventDefault(); window.tangu.startHostDrag(en.path); return }
    const paths = sel.selected.has(en.path) ? [...sel.selected] : [en.path]
    setDragging(paths)
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths))
    e.dataTransfer.effectAllowed = 'move'
  }
  const folderDragOver = (e: React.DragEvent, destPath: string) => {
    const osFiles = e.dataTransfer.types.includes('Files')
    if (!dragging && !osFiles) return
    if (dragging?.includes(destPath)) return // 不能拖进自身
    e.preventDefault(); e.stopPropagation(); setDropDir(destPath); setDragInFiles(false)
  }
  const folderDrop = (e: React.DragEvent, destPath: string) => {
    e.preventDefault(); e.stopPropagation()
    const files = e.dataTransfer.files; const dg = dragging
    setDropDir(null); setDragging(null)
    if (files?.length) void copyFilesInto(files, destPath)
    else if (dg?.length) void moveInto(destPath, dg)
  }

  return (
    <div
      className={dragInFiles ? 'wsfiles dragover' : 'wsfiles'}
      onClick={(e) => { if (e.target === e.currentTarget) sel.clear() }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') && !dragging) { e.preventDefault(); setDragInFiles(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragInFiles(false) }}
      onDrop={(e) => { e.preventDefault(); setDragInFiles(false); setDropDir(null); if (e.dataTransfer.files?.length && !dragging) void copyFilesInto(e.dataTransfer.files, curDir) }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span className="panel-section-title" style={{ flex: 1, padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={curDir}>
          {rel ? `…/${rel}` : (cwd.split(/[/\\]/).filter(Boolean).pop() || cwd)}
        </span>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => { setNewFolder(true); setNewFolderVal('') }} title={t('panel.action.newFolder')}>
          <FolderPlus size={13} />
        </button>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => window.tangu?.revealHostPath?.(curDir)} title={t('panel.action.openCurDirInFileManager')}>
          <ExternalLink size={13} />
        </button>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => void refresh()} title={t('panel.action.refresh')}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      {newFolder && (
        <div className="file-row" style={{ cursor: 'default' }}>
          <Folder size={13} style={{ color: 'var(--accent)' }} />
          <input
            autoFocus
            className="file-rename-input"
            value={newFolderVal}
            placeholder={t('panel.placeholder.newFolderName')}
            onChange={(e) => setNewFolderVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commitNewFolder(); else if (e.key === 'Escape') { setNewFolder(false); setNewFolderVal('') } }}
            onBlur={() => { setNewFolder(false); setNewFolderVal('') }}
          />
          <span className="file-act" style={{ opacity: 1 }}>
            <button className="icon-btn" style={{ width: 22, height: 22 }} title={t('panel.action.create')} onMouseDown={(e) => { e.preventDefault(); void commitNewFolder() }}><Check size={12} /></button>
            <button className="icon-btn" style={{ width: 22, height: 22 }} title={t('panel.action.cancel')} onMouseDown={(e) => { e.preventDefault(); setNewFolder(false); setNewFolderVal('') }}><X size={12} /></button>
          </span>
        </div>
      )}
      {!atRoot && (
        <div
          className={`file-row${dropDir === parentOf(curDir) ? ' drop-target' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => setCurDir(parentOf(curDir))}
          onDragOver={(e) => folderDragOver(e, parentOf(curDir))}
          onDragLeave={() => setDropDir(null)}
          onDrop={(e) => folderDrop(e, parentOf(curDir))}
        >
          <CornerLeftUp size={13} />
          <span className="file-name">{t('panel.parentDir')}</span>
        </div>
      )}
      {entries.length === 0 && !loading && !newFolder && <div className="panel-note">{t('panel.emptyDir')}</div>}
      {entries.map((en) => {
        const isSel = sel.selected.has(en.path)
        const isDrop = en.isDir && dropDir === en.path
        return (
          <div
            className={`file-row${isSel ? ' selected' : ''}${isDrop ? ' drop-target' : ''}`}
            key={en.path}
            role="button"
            tabIndex={0}
            draggable={renaming !== en.path}
            onDragStart={(e) => rowDragStart(e, en)}
            onDragEnd={() => { setDragging(null); setDropDir(null) }}
            onDragOver={en.isDir ? (e) => folderDragOver(e, en.path) : undefined}
            onDragLeave={en.isDir ? () => setDropDir(null) : undefined}
            onDrop={en.isDir ? (e) => folderDrop(e, en.path) : undefined}
            onClick={(e) => { if (renaming !== en.path) sel.onClick(en.path, e) }}
            onDoubleClick={() => { if (renaming !== en.path) open(en) }}
            onContextMenu={(e) => openMenu(e, en)}
            onKeyDown={(e) => { if (renaming !== en.path && e.key === 'Enter') { e.preventDefault(); open(en) } }}
          >
            {en.isDir ? <Folder size={13} style={{ color: 'var(--accent)' }} /> : /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(en.name) ? <ImageIcon size={13} /> : <FileText size={13} />}
            {renaming === en.path ? (
              <input
                autoFocus
                className="file-rename-input"
                value={renameVal}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void commitRename(en); else if (e.key === 'Escape') setRenaming(null) }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <>
                <span className="file-name">{en.name}</span>
                {!en.isDir && <span className="file-size">{fmtSize(en.size)}</span>}
              </>
            )}
          </div>
        )
      })}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

const SandboxFilesTab: React.FC<{
  cfg: TanguDesktopConfig
  sessionId: string
  sessionConfig?: AgentConfig
  running: boolean
  onToast: (t: string, e?: boolean) => void
  onOpenPreview: (target: PreviewTarget) => void
}> = ({ cfg, sessionId, running, onToast, onOpenPreview }) => {
  const { t } = useI18n()
  const [files, setFiles] = useState<WorkspaceFileMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const sel = useSelection(files.map((f) => f.path))

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setFiles(await api.listWorkspace(cfg, sessionId)) }
    catch (e: any) { onToast(t('panel.toast.workspaceLoadFail', { err: e?.message || e }), true) }
    finally { setLoading(false) }
  }, [cfg, sessionId, onToast])
  useEffect(() => { void refresh() }, [refresh, running]) // run 结束(running 变化)后刷新,看到新产物

  const preview = (f: WorkspaceFileMeta) => {
    onOpenPreview({
      name: f.path,
      load: async () => {
        const r = await api.readWorkspaceFile(cfg, sessionId, f.path)
        return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size }
      },
      download: () => { void api.downloadWorkspaceFile(cfg, sessionId, f.path).catch((err) => onToast(err.message, true)) },
    })
  }
  const download = (path: string) => { void api.downloadWorkspaceFile(cfg, sessionId, path).catch((err) => onToast(err.message, true)) }
  const del = async (paths: string[]) => {
    if (!paths.length) return
    const ok = window.confirm(paths.length === 1
      ? t('panel.confirm.delete', { name: paths[0].replace(/^\//, '') })
      : t('panel.confirm.deleteN', { n: String(paths.length) }))
    if (!ok) return
    try { for (const p of paths) await api.deleteWorkspaceFile(cfg, sessionId, p); sel.clear(); void refresh() }
    catch (err: any) { onToast(err.message, true) }
  }
  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    const payload = await Promise.all(
      Array.from(list).map(async (f) => {
        const buf = new Uint8Array(await f.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        return { path: f.name, content: btoa(bin), encoding: 'base64' as const, mimeType: f.type }
      }),
    )
    try {
      const r = await api.uploadWorkspaceFiles(cfg, sessionId, payload)
      onToast(t('panel.toast.uploaded', { saved: r.saved, total: r.total }))
      void refresh()
    } catch (e: any) {
      onToast(t('panel.toast.uploadFail', { err: e?.message || e }), true)
    }
  }

  const openMenu = (e: React.MouseEvent, f: WorkspaceFileMeta) => {
    e.preventDefault(); e.stopPropagation()
    const selPaths = sel.selected.has(f.path) ? [...sel.selected] : [f.path]
    if (!sel.selected.has(f.path)) sel.only(f.path)
    const multi = selPaths.length > 1
    const items: CtxItem[] = []
    if (!multi) items.push({ label: t('panel.action.preview'), icon: <Eye size={13} />, run: () => preview(f) })
    if (!multi) items.push({ label: t('panel.action.download'), icon: <Download size={13} />, run: () => download(f.path) })
    items.push({
      label: multi ? t('panel.action.deleteN', { n: String(selPaths.length) }) : t('panel.action.delete'),
      icon: <Trash2 size={13} />, danger: true, run: () => void del(selPaths),
    })
    setMenu({ ...menuPos(e, items.length), items })
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) sel.clear() }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files) }}
    >
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <span className="panel-section-title" style={{ flex: 1, padding: 0 }}>{t('panel.sessionFiles')}</span>
        <label className="icon-btn" style={{ width: 24, height: 24 }} title={t('panel.action.uploadFile')}>
          <Upload size={13} />
          <input type="file" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = '' }} />
        </label>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => void refresh()} title={t('panel.action.refresh')}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      {files.length === 0 && <div className="panel-note">{t('panel.noFilesYet')}</div>}
      {files.map((f) => {
        const isSel = sel.selected.has(f.path)
        return (
          <div
            className={`file-row${isSel ? ' selected' : ''}`}
            key={f.path}
            role="button"
            tabIndex={0}
            onClick={(e) => sel.onClick(f.path, e)}
            onDoubleClick={() => preview(f)}
            onContextMenu={(e) => openMenu(e, f)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); preview(f) } }}
          >
            {f.mimeType.startsWith('image/') ? <ImageIcon size={13} /> : <FileText size={13} />}
            <span className="file-name">{f.path.replace(/^\//, '')}</span>
            <span className="file-size">{fmtSize(f.size)}</span>
          </div>
        )
      })}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

// ── 记忆·日志 ────────────────────────────────────────────────────────────────

const MemoryTab: React.FC<{
  cfg: TanguDesktopConfig
  onToast: (t: string, e?: boolean) => void
}> = ({ cfg, onToast }) => {
  const { t } = useI18n()
  const [memory, setMemory] = useState<string | null>(null)
  const [log, setLog] = useState<{ date: string; content: string } | null>(null)
  const [logDate, setLogDate] = useState('')
  const [draft, setDraft] = useState('')

  const refresh = useCallback(async () => {
    try {
      const m = await api.getMemory(cfg)
      setMemory(m.content || '')
    } catch (e: any) {
      setMemory(null)
      onToast(t('panel.toast.memoryLoadFail', { err: e?.message || e }), true)
    }
    try {
      const l = await api.getLog(cfg, logDate || undefined)
      setLog({ date: l.date, content: l.content || '' })
    } catch { /* log 可选 */ }
  }, [cfg, logDate, onToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const append = async () => {
    const text = draft.trim()
    if (!text) return
    try {
      const r = await api.appendMemory(cfg, text)
      onToast(r.appended ? t('panel.toast.memorySaved') : t('panel.toast.memoryNotWritten'))
      setDraft('')
      void refresh()
    } catch (e: any) {
      onToast(t('panel.toast.appendFail', { err: e?.message || e }), true)
    }
  }

  return (
    <div>
      <div className="panel-section-title">{t('panel.memory.title')}</div>
      {memory === null && <div className="panel-note">{t('panel.memory.notConnected')}</div>}
      {memory !== null && (
        memory ? (
          <div style={{ fontSize: 12.5, padding: '0 8px' }} className="msg-content">
            <Markdown content={memory} />
          </div>
        ) : (
          <div className="panel-note">{t('panel.memory.empty')}</div>
        )
      )}
      <div style={{ display: 'flex', gap: 6, padding: '8px 8px 0' }}>
        <input
          type="text"
          value={draft}
          placeholder={t('panel.memory.appendPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void append()}
          style={{
            flex: 1, fontSize: 12.5, padding: '5px 8px', background: 'var(--bg-card)',
            border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)', outline: 'none',
          }}
        />
        <button className="btn ghost sm" onClick={() => void append()}>{t('panel.memory.append')}</button>
      </div>

      <div className="panel-section-title" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        {t('panel.activityLog')}
        <input
          type="date"
          value={logDate}
          onChange={(e) => setLogDate(e.target.value)}
          style={{
            fontSize: 11, background: 'var(--bg-card)', color: 'var(--text-muted)',
            border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1px 4px',
          }}
        />
      </div>
      {log && (
        log.content ? (
          <div style={{ fontSize: 12.5, padding: '0 8px' }} className="msg-content">
            <Markdown content={log.content} />
          </div>
        ) : (
          <div className="panel-note">{t('panel.log.empty', { date: log.date })}</div>
        )
      )}
    </div>
  )
}
