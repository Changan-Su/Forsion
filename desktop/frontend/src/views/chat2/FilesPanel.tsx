/** 文件面板(右侧栏):镜像会话侧栏结构 —— 列所有本地工作区文件夹(手风琴:展开一个,收起其余),
 *  展开后用 Electron listDir 列真实磁盘目录,子文件夹可逐级展开。
 *  交互(与旧 RightPanel 工作区树对齐,复用同一套 fs IPC):单击选中,双击在主区开预览标签页;
 *  右键菜单(打开/系统默认打开/新建文件/文件夹/重命名/复制路径/文件管理器显示/回收站);
 *  行拖进文件夹=移动、Alt+拖=原生拖出、OS 文件拖入=复制;行内重命名/新建。
 *  云端工作区(无磁盘路径)暂不在此面板(之后再开发)。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw,
  Eye, ExternalLink, FilePlus2, FolderPlus, Pencil, Copy, FolderSearch, Trash2,
} from 'lucide-react'
import type { WorkspaceDescriptor } from '../../types'
import type { PreviewTarget } from '../../components/WorkspaceFilePreview'
import { ContextMenu, menuPos, type CtxItem, type CtxMenu } from '../../components/RightPanel'
import { useI18n } from '../../i18n'
import { iconForFile, mimeForExt, fmtSize } from '../../services/fileKinds'
import { AnimatedCollapse } from '../../components/AnimatedUI'
import { useApp } from '../../stores/appStore'
import { hostTargetFor } from '../wsFileNav'
import './sidebar2.css'

interface Entry { name: string; isDir: boolean; size: number; path: string }

const DRAG_MIME = 'application/x-tangu-paths' // 与 RightPanel 同值,跨面板互拖也成立
const sortEntries = (es: Entry[]): Entry[] =>
  [...es].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))
/** 单段文件名合法性(与主进程 safeName 同规):无路径分隔符、非 ./..、非空、<256。 */
const validName = (s: string): boolean => !!s && s.length < 256 && !/[\\/]/.test(s) && !s.includes('\0') && s !== '.' && s !== '..'

/** 目录刷新总线:文件操作后 bump(目录绝对路径)→ 对应节点丢缓存重拉;'*' = 全树(run 结束等)。 */
const fsBus = new EventTarget()
export const bumpDir = (dir: string): void => { fsBus.dispatchEvent(new CustomEvent('fs-bump', { detail: dir })) }

/** 树的共享交互上下文(递归行组件经它拿状态与操作,避免层层传参)。 */
interface TreeCtx {
  selected: string | null
  select: (p: string) => void
  openFile: (e: Entry) => void
  onMenu: (ev: React.MouseEvent, e: Entry) => void
  renaming: string | null
  commitRename: (e: Entry, name: string) => void
  creating: { dir: string; kind: 'file' | 'folder' } | null
  commitCreate: (dir: string, kind: 'file' | 'folder', name: string) => void
  cancelEdit: () => void
  dropDir: string | null
  rowDragStart: (ev: React.DragEvent, e: Entry) => void
  dragEnd: () => void
  dragOverDir: (ev: React.DragEvent, dir: string) => void
  dragLeaveDir: (dir: string) => void
  dropOnDir: (ev: React.DragEvent, dir: string) => void
}

/** 行内输入(重命名 / 新建文件、文件夹):Enter 提交,Esc 取消,失焦提交。 */
function NameInput({ initial, depth, onCommit, onCancel }: { initial: string; depth: number; onCommit: (name: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  const done = useRef(false)
  const commit = (): void => { if (done.current) return; done.current = true; onCommit(v.trim()) }
  return (
    <input
      className="t2sf-input"
      style={{ marginLeft: 6 + depth * 14 + 16 }}
      value={v}
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') { done.current = true; onCancel() }
      }}
      onBlur={commit}
    />
  )
}

function FileRow({ entry, depth, ctx }: { entry: Entry; depth: number; ctx: TreeCtx }) {
  const Icon = iconForFile(mimeForExt(entry.path) || '', entry.path)
  if (ctx.renaming === entry.path) return <NameInput initial={entry.name} depth={depth} onCommit={(n) => ctx.commitRename(entry, n)} onCancel={ctx.cancelEdit} />
  return (
    <div
      className={`t2sf-row t2sf-file${ctx.selected === entry.path ? ' sel' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      title={entry.name}
      draggable
      onDragStart={(e) => ctx.rowDragStart(e, entry)}
      onDragEnd={ctx.dragEnd}
      onClick={() => ctx.select(entry.path)}
      onDoubleClick={() => ctx.openFile(entry)}
      onContextMenu={(e) => ctx.onMenu(e, entry)}
    >
      <span className="t2sf-chev" />
      <Icon size={14} className="t2sf-fic" />
      <span className="t2sf-name">{entry.name}</span>
      {entry.size > 0 && <span className="t2sf-size">{fmtSize(entry.size)}</span>}
    </div>
  )
}

/** 目录节点:惰性加载,可递归展开;是移动/复制的投放目标。forceOpen=位于该路径链上的目录自动展开。 */
function DirRow({ entry, depth, ctx, forceOpen }: { entry: Entry; depth: number; ctx: TreeCtx; forceOpen?: string | null }) {
  const onPath = !!forceOpen && (forceOpen === entry.path || forceOpen.startsWith(entry.path + '/') || forceOpen.startsWith(entry.path + '\\'))
  const [open, setOpen] = useState(onPath)
  const [kids, setKids] = useState<Entry[] | null>(null)
  useEffect(() => { if (onPath) setOpen(true) }, [onPath, forceOpen])
  // 刷新总线:本目录被 bump(或 '*' 全树)→ 丢缓存;open && !kids 的加载 effect 会重拉。
  useEffect(() => {
    const h = (ev: Event): void => {
      const d = (ev as CustomEvent).detail
      if (d === '*' || d === entry.path) setKids(null)
    }
    fsBus.addEventListener('fs-bump', h)
    return () => fsBus.removeEventListener('fs-bump', h)
  }, [entry.path])
  // 在本目录里新建 → 自动展开(输入框在子级渲染)。
  const creatingHere = ctx.creating?.dir === entry.path
  useEffect(() => { if (creatingHere) setOpen(true) }, [creatingHere])
  useEffect(() => {
    if (!open || kids) return
    let alive = true
    void window.tangu?.listDir?.(entry.path)
      .then((es) => { if (alive) setKids(sortEntries(es as Entry[])) })
      .catch(() => { if (alive) setKids([]) })
    return () => { alive = false }
  }, [open, kids, entry.path])

  return (
    <>
      {ctx.renaming === entry.path
        ? <NameInput initial={entry.name} depth={depth} onCommit={(n) => ctx.commitRename(entry, n)} onCancel={ctx.cancelEdit} />
        : (
          <div
            className={`t2sf-row${ctx.selected === entry.path ? ' sel' : ''}${ctx.dropDir === entry.path ? ' drop' : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            title={entry.name}
            draggable
            onDragStart={(e) => ctx.rowDragStart(e, entry)}
            onDragEnd={ctx.dragEnd}
            onDragOver={(e) => ctx.dragOverDir(e, entry.path)}
            onDragLeave={() => ctx.dragLeaveDir(entry.path)}
            onDrop={(e) => ctx.dropOnDir(e, entry.path)}
            onClick={(e) => { ctx.select(entry.path); if (e.detail === 1) setOpen((o) => !o) }}
            onContextMenu={(e) => ctx.onMenu(e, entry)}
          >
            <span className="t2sf-chev">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
            {open ? <FolderOpen size={14} className="t2sf-fic" /> : <Folder size={14} className="t2sf-fic" />}
            <span className="t2sf-name">{entry.name}</span>
          </div>
        )}
      <AnimatedCollapse open={open}>
        {creatingHere && ctx.creating && (
          <NameInput initial="" depth={depth + 1} onCommit={(n) => ctx.commitCreate(entry.path, ctx.creating!.kind, n)} onCancel={ctx.cancelEdit} />
        )}
        {kids === null
          ? <div className="t2sf-loading" style={{ paddingLeft: 6 + (depth + 1) * 14 + 16 }}>…</div>
          : <>{kids.map((k) => k.isDir
            ? <DirRow key={k.path} entry={k} depth={depth + 1} ctx={ctx} forceOpen={onPath ? forceOpen : null} />
            : <FileRow key={k.path} entry={k} depth={depth + 1} ctx={ctx} />)}</>}
      </AnimatedCollapse>
    </>
  )
}

export function FilesPanel({ workspaces, onOpenPreview, activeWorkspaceKey, onEnterWorkspace, expandToPath }: {
  workspaces: WorkspaceDescriptor[]
  onOpenPreview: (t: PreviewTarget) => void
  /** 共享「进入的工作区」key(与会话面板手风琴同步)。 */
  activeWorkspaceKey?: string | null
  onEnterWorkspace?: (key: string | null) => void
  /** 自动展开到某绝对目录(统一工作区视图定位笔记所在目录;仅作用于当前展开的工作区)。 */
  expandToPath?: string | null
}) {
  const { t } = useI18n()
  const running = useApp((s) => Object.keys(s.runningBySession).length > 0)
  const locals = workspaces.filter((w) => w.kind === 'local' && !!w.path)
  const [rootsByKey, setRootsByKey] = useState<Record<string, Entry[] | null>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'folder' } | null>(null)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const draggingRef = useRef<string[] | null>(null)

  const toast = (m: string, err?: boolean): void => useApp.getState().toast(m, err)
  const openFile = (e: Entry): void => { if (!e.isDir) onOpenPreview(hostTargetFor(e.path, e.name)) }

  const loadRoot = useCallback((key: string, path: string) => {
    setRootsByKey((m) => ({ ...m, [key]: m[key] ?? null }))
    void window.tangu?.listDir?.(path)
      .then((es) => setRootsByKey((m) => ({ ...m, [key]: sortEntries(es as Entry[]) })))
      .catch(() => setRootsByKey((m) => ({ ...m, [key]: [] })))
  }, [])

  // 根目录也订阅刷新总线(bump 到工作区根路径 / '*')。
  const localsKey = locals.map((w) => `${w.key}\n${w.path}`).join('\u0000')
  useEffect(() => {
    const pairs = localsKey ? localsKey.split('\u0000').map((x) => x.split('\n')) : []
    const h = (ev: Event): void => {
      const d = (ev as CustomEvent).detail
      for (const [key, path] of pairs) {
        if (path && (d === '*' || d === path)) loadRoot(key, path)
      }
    }
    fsBus.addEventListener('fs-bump', h)
    return () => fsBus.removeEventListener('fs-bump', h)
  }, [localsKey, loadRoot])

  // run 结束 → 全树刷新(agent 常在 run 里落新产物)。
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current && !running) bumpDir('*')
    prevRunning.current = running
  }, [running])

  // ── 文件操作(全部走既有 fs IPC,操作后 bump 相关目录)──
  const commitRename = async (e: Entry, name: string): Promise<void> => {
    setRenaming(null)
    if (!name || name === e.name || !window.tangu?.renameHostPath) return
    try { await window.tangu.renameHostPath(e.path, name) }
    catch (err: any) { toast(t('panel.toast.renameFail', { err: err?.message || err }), true) }
    bumpDir(dirOf(e.path))
  }
  const commitCreate = async (dir: string, kind: 'file' | 'folder', name: string): Promise<void> => {
    setCreating(null)
    if (!name) return
    if (!validName(name)) { toast(t('panel.toast.invalidName', { name }), true); return }
    try {
      if (kind === 'folder') await window.tangu?.mkdirHost?.(dir, name)
      else await window.tangu?.writeHostFile?.(`${dir}/${name}`, '', undefined, true)
    } catch (err: any) { toast(t('panel.toast.mkdirFail', { err: err?.message || err }), true) }
    bumpDir(dir)
  }
  const trash = async (e: Entry): Promise<void> => {
    if (!window.tangu?.trashHostPath) return
    if (!window.confirm(t('panel.confirm.trash', { name: e.name }))) return
    try { await window.tangu.trashHostPath(e.path) }
    catch (err: any) { toast(t('panel.toast.deleteFail', { err: err?.message || err }), true) }
    if (selected === e.path) setSelected(null)
    bumpDir(dirOf(e.path))
  }
  const moveInto = async (destDir: string, paths: string[]): Promise<void> => {
    if (!window.tangu?.moveHostPath) return
    // 不能拖进自身/自己的子孙目录
    const todo = paths.filter((p) => p !== destDir && !destDir.startsWith(p + '/') && !destDir.startsWith(p + '\\'))
    try {
      for (const p of todo) { await window.tangu.moveHostPath(p, destDir); bumpDir(dirOf(p)) }
    } catch (err: any) { toast(t('panel.toast.moveFail', { err: err?.message || err }), true) }
    if (todo.length) bumpDir(destDir)
  }
  const copyFilesInto = async (files: FileList, destDir: string): Promise<void> => {
    if (!window.tangu?.copyHostFiles || !window.tangu?.getPathForFile) return
    const paths = Array.from(files).map((f) => { try { return window.tangu!.getPathForFile!(f) } catch { return '' } }).filter(Boolean)
    if (!paths.length) return
    try {
      const r = await window.tangu.copyHostFiles(paths, destDir)
      toast(t('panel.toast.copied', { n: String(r.copied) }))
    } catch (err: any) { toast(t('panel.toast.copyFail', { err: err?.message || err }), true) }
    bumpDir(destDir)
  }

  // ── 右键菜单 ──
  const onMenu = (ev: React.MouseEvent, e: Entry): void => {
    ev.preventDefault(); ev.stopPropagation()
    setSelected(e.path)
    const items: CtxItem[] = []
    if (!e.isDir) {
      items.push({ label: t('panel.action.open'), icon: <Eye size={13} />, run: () => openFile(e) })
      if (window.tangu?.openHostPath) items.push({ label: t('preview.openWithDefault'), icon: <ExternalLink size={13} />, run: () => {
        void window.tangu?.openHostPath?.(e.path).then((r) => { if (r && !r.ok) toast(r.error || 'open failed', true) })
      } })
    } else {
      items.push({ label: t('panel.action.newFile'), icon: <FilePlus2 size={13} />, run: () => setCreating({ dir: e.path, kind: 'file' }) })
      items.push({ label: t('panel.action.newFolder'), icon: <FolderPlus size={13} />, run: () => setCreating({ dir: e.path, kind: 'folder' }) })
    }
    items.push({ label: t('panel.action.rename'), icon: <Pencil size={13} />, run: () => setRenaming(e.path) })
    items.push({ label: t('panel.action.copyPath'), icon: <Copy size={13} />, run: () => { void navigator.clipboard.writeText(e.path) } })
    items.push({ label: t('panel.action.revealInFileManager'), icon: <FolderSearch size={13} />, run: () => void window.tangu?.revealHostPath?.(e.path) })
    items.push({ label: t('panel.action.moveToTrash'), icon: <Trash2 size={13} />, danger: true, run: () => void trash(e) })
    setMenu({ ...menuPos(ev, items.length), items })
  }
  const onWsMenu = (ev: React.MouseEvent, ws: WorkspaceDescriptor): void => {
    if (!ws.path) return
    ev.preventDefault(); ev.stopPropagation()
    const path = ws.path
    const items: CtxItem[] = [
      { label: t('panel.action.newFile'), icon: <FilePlus2 size={13} />, run: () => { onEnterWorkspace?.(ws.key); setCreating({ dir: path, kind: 'file' }) } },
      { label: t('panel.action.newFolder'), icon: <FolderPlus size={13} />, run: () => { onEnterWorkspace?.(ws.key); setCreating({ dir: path, kind: 'folder' }) } },
      { label: t('panel.action.revealInFileManager'), icon: <FolderSearch size={13} />, run: () => void window.tangu?.revealHostPath?.(path) },
      { label: t('panel.files.refresh'), icon: <RefreshCw size={13} />, run: () => bumpDir(path) },
    ]
    setMenu({ ...menuPos(ev, items.length), items })
  }

  // ── 拖拽:行拖(内部移动 / Alt=原生拖出);文件夹与工作区头是投放目标;OS 文件拖入=复制 ──
  const rowDragStart = (ev: React.DragEvent, e: Entry): void => {
    if (ev.altKey && window.tangu?.startHostDrag) { ev.preventDefault(); window.tangu.startHostDrag(e.path); return }
    draggingRef.current = [e.path]
    ev.dataTransfer.setData(DRAG_MIME, JSON.stringify([e.path]))
    ev.dataTransfer.effectAllowed = 'move'
  }
  const dragEnd = (): void => { draggingRef.current = null; setDropDir(null) }
  const dragOverDir = (ev: React.DragEvent, dir: string): void => {
    const osFiles = ev.dataTransfer.types.includes('Files')
    const internal = !!draggingRef.current || ev.dataTransfer.types.includes(DRAG_MIME) // 本面板 或 其他面板的行拖
    if (!internal && !osFiles) return
    if (draggingRef.current?.includes(dir)) return
    ev.preventDefault(); ev.stopPropagation()
    setDropDir(dir)
  }
  const dragLeaveDir = (dir: string): void => { setDropDir((d) => (d === dir ? null : d)) }
  const dropOnDir = (ev: React.DragEvent, dir: string): void => {
    ev.preventDefault(); ev.stopPropagation()
    const files = ev.dataTransfer.files
    let dg = draggingRef.current
    if (!dg) { try { dg = JSON.parse(ev.dataTransfer.getData(DRAG_MIME) || 'null') } catch { dg = null } } // 跨面板
    setDropDir(null); draggingRef.current = null
    if (files?.length) void copyFilesInto(files, dir)
    else if (dg?.length) void moveInto(dir, dg)
  }

  const ctx: TreeCtx = {
    selected, select: setSelected, openFile, onMenu,
    renaming, commitRename, creating, commitCreate,
    cancelEdit: () => { setRenaming(null); setCreating(null) },
    dropDir, rowDragStart, dragEnd, dragOverDir, dragLeaveDir, dropOnDir,
  }

  // 手风琴(共享):点工作区头 = 就地展开/收起(与会话面板手风琴同步)。
  const toggleWs = (ws: WorkspaceDescriptor): void => {
    onEnterWorkspace?.(activeWorkspaceKey === ws.key ? null : ws.key)
  }

  // 当前进入的本地工作区首次展开时加载磁盘根目录。
  useEffect(() => {
    if (!activeWorkspaceKey) return
    const w = locals.find((x) => x.key === activeWorkspaceKey)
    if (w?.path && rootsByKey[activeWorkspaceKey] === undefined) loadRoot(activeWorkspaceKey, w.path)
  }, [activeWorkspaceKey, locals, rootsByKey, loadRoot])

  if (!locals.length) return <div className="panel-note" style={{ padding: '18px 12px' }}>{t('panel.files.noLocalWs')}</div>

  return (
    <aside className="t2s-side">
      <div className="t2s-scroll" onClick={(e) => { if (e.target === e.currentTarget) setSelected(null) }}>
        {locals.map((ws) => {
          const open = activeWorkspaceKey === ws.key
          const roots = rootsByKey[ws.key]
          return (
            <div key={ws.key}>
              <div
                className={`t2s-group${dropDir === ws.path ? ' drop' : ''}`}
                onContextMenu={(e) => onWsMenu(e, ws)}
                onDragOver={(e) => { if (ws.path && open) dragOverDir(e, ws.path) }}
                onDragLeave={() => { if (ws.path) dragLeaveDir(ws.path) }}
                onDrop={(e) => { if (ws.path) dropOnDir(e, ws.path) }}
              >
                <button className="t2s-group-toggle" onClick={() => toggleWs(ws)} title={ws.path || undefined}>
                  <span className="t2s-chev">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                  <span className="t2s-group-name"><Folder size={12} /><span className="t2s-group-label">{ws.name}</span></span>
                </button>
                {open && (
                  <button className="t2s-group-add" title={t('panel.action.newFile')} onClick={() => { if (ws.path) setCreating({ dir: ws.path, kind: 'file' }) }}><FilePlus2 size={13} /></button>
                )}
                {open && (
                  <button className="t2s-group-add" title={t('panel.action.newFolder')} onClick={() => { if (ws.path) setCreating({ dir: ws.path, kind: 'folder' }) }}><FolderPlus size={13} /></button>
                )}
                <button className="t2s-group-add" title={t('panel.files.refresh')} onClick={() => { if (ws.path) loadRoot(ws.key, ws.path) }}><RefreshCw size={13} /></button>
              </div>
              <AnimatedCollapse open={open}>
                <div className="t2sf-tree">
                  {creating && ws.path && creating.dir === ws.path && (
                    <NameInput initial="" depth={1} onCommit={(n) => commitCreate(ws.path!, creating.kind, n)} onCancel={() => setCreating(null)} />
                  )}
                  {roots == null ? <div className="t2sf-loading" style={{ paddingLeft: 22 }}>…</div>
                    : roots.length === 0 ? <div className="t2sf-empty">{t('panel.files.empty')}</div>
                    : roots.map((e) => e.isDir
                      ? <DirRow key={e.path} entry={e} depth={1} ctx={ctx} forceOpen={open ? expandToPath : null} />
                      : <FileRow key={e.path} entry={e} depth={1} ctx={ctx} />)}
                </div>
              </AnimatedCollapse>
            </div>
          )
        })}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
