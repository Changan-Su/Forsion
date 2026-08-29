/** 文件面板(右侧栏):镜像会话侧栏结构 —— 列所有本地工作区文件夹(各自独立展开/收起,可多开),
 *  展开后用 Electron listDir 列真实磁盘目录,子文件夹可逐级展开。
 *  **只有一个工作区常驻可见**(pinnedKey,通常 = 当前打开文件所在的那个),其余全部收进底部
 *  「显示全部工作区」折叠区 —— 手上这个文件夹永远在顶上,不用在一长串工作区里找。
 *  交互(三档列表统一,判据单源见 views/itemSelect):单击打开并选中、⌘/Ctrl 单击开新标签页、
 *  shift 单击选范围、option/alt 单击逐个加减选;右键菜单与拖拽对**整批选中**生效。
 *  右键菜单(打开/系统默认打开/新建文件/文件夹/重命名/复制路径/文件管理器显示/回收站);
 *  行拖进文件夹=移动、Alt+拖=原生拖出、OS 文件拖入=复制;行内重命名/新建。
 *  云端 Project 工作区(kind='cloud',无磁盘路径)走 workspace API 按 project 取数(CloudGroup):
 *  只读呈现(预览/下载/删除),web/移动云端无 fs IPC 也可用;run 结束自动刷新。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ChevronRight, Folder, FolderOpen, RefreshCw, Download,
  Eye, ExternalLink, FilePlus2, FolderPlus, Pencil, Copy, FolderSearch, Trash2,
} from 'lucide-react'
import type { WorkspaceDescriptor, WorkspaceFileMeta } from '../../types'
import type { PreviewTarget } from '../../components/WorkspaceFilePreview'
import { ContextMenu, menuPos, type CtxItem, type CtxMenu } from '../../components/RightPanel'
import { registerMessages, useI18n } from '../../i18n'
import { iconForFile, mimeForExt, fmtSize, b64ToBytes } from '../../services/fileKinds'
import { listWorkspace, readWorkspaceFile, downloadWorkspaceFile, deleteWorkspaceFile } from '../../services/backendService'
import { AnimatedCollapse } from '../../components/AnimatedUI'
import { useApp } from '../../stores/appStore'
import { hostTargetFor } from '../wsFileNav'
import { tipProps, fsTipLines } from '../../hoverTip'
import { folderPadLeft, nameLeft, rowPadLeft } from '@amadeus/lib/treeIndent'
import { useItemSelect, type ClickAct, type ItemSelect } from '../itemSelect'
import { PATHS_MIME as DRAG_MIME, REF_MIME } from './chatDragRef' // 行拖载荷的单源(RightPanel 同值)
import './sidebar2.css'

registerMessages({
  'panel.files.showAllWs': { zh: '显示全部工作区', en: 'Show all workspaces' },
})

interface Entry { name: string; isDir: boolean; size: number; path: string }

const sortEntries = (es: Entry[]): Entry[] =>
  [...es].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))

const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))
/** 单段文件名合法性(与主进程 safeName 同规):无路径分隔符、非 ./..、非空、<256。 */
const validName = (s: string): boolean => !!s && s.length < 256 && !/[\\/]/.test(s) && !s.includes('\0') && s !== '.' && s !== '..'

/** 设备页(unitShim)只有 listDir/statPath/readHostFile 只读桥:写类控件按能力嗅探隐藏,否则
 *  新建/重命名/删除/拖拽全是「确认后静默消失」的哑弹(Codex 三轮 P2)。桌面写面同生同灭,
 *  嗅探 mkdirHost 一枚即代表全家;reveal 语义独立单独嗅探。 */
const canWrite = (): boolean => !!window.tangu?.mkdirHost
const canReveal = (): boolean => !!window.tangu?.revealHostPath

/** 目录刷新总线:文件操作后 bump(目录绝对路径)→ 对应节点丢缓存重拉;'*' = 全树(run 结束等)。 */
const fsBus = new EventTarget()
export const bumpDir = (dir: string): void => { fsBus.dispatchEvent(new CustomEvent('fs-bump', { detail: dir })) }

/** 树的共享交互上下文(递归行组件经它拿状态与操作,避免层层传参)。 */
interface TreeCtx {
  isSel: (p: string) => boolean
  /** 行点击唯一入口:先更新选中态,再按修饰键决定开不开(返回值给目录行判断要不要展开)。 */
  rowClick: (ev: React.MouseEvent, e: Entry) => ClickAct
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
      style={{ marginLeft: nameLeft(depth + 1) }}
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
      className={`t2sf-row t2sf-file${ctx.isSel(entry.path) ? ' sel' : ''}`}
      data-sel-id={entry.path}
      style={{ paddingLeft: rowPadLeft(depth + 1) }}
      {...tipProps(() => fsTipLines(entry.path, entry.name))}
      draggable={canWrite()}
      onDragStart={(e) => ctx.rowDragStart(e, entry)}
      onDragEnd={ctx.dragEnd}
      // 落在文件行上 = 落进**它所在的文件夹**(高亮的是那个目录行)。此前文件行完全不是落区,
      // 拖到一个文件上就等于拖了个空 —— 用户口径「拖到准确的文件夹或文件里面」。
      onDragOver={(e) => ctx.dragOverDir(e, dirOf(entry.path))}
      onDragLeave={() => ctx.dragLeaveDir(dirOf(entry.path))}
      onDrop={(e) => ctx.dropOnDir(e, dirOf(entry.path))}
      onClick={(e) => ctx.rowClick(e, entry)}
      onDoubleClick={() => ctx.openFile(entry)}
      onContextMenu={(e) => ctx.onMenu(e, entry)}
    >
      <span className="t2s-lead"><Icon className="t2s-lead-icon t2sf-fic" /></span>
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
            className={`t2sf-row${ctx.isSel(entry.path) ? ' sel' : ''}${ctx.dropDir === entry.path ? ' drop' : ''}`}
            data-sel-id={entry.path}
            style={{ paddingLeft: rowPadLeft(depth + 1) }}
            {...tipProps(() => fsTipLines(entry.path, entry.name))}
            draggable={canWrite()}
            onDragStart={(e) => ctx.rowDragStart(e, entry)}
            onDragEnd={ctx.dragEnd}
            onDragOver={(e) => ctx.dragOverDir(e, entry.path)}
            onDragLeave={() => ctx.dragLeaveDir(entry.path)}
            onDrop={(e) => ctx.dropOnDir(e, entry.path)}
            // 目录的「打开」= 就地展开/收起;shift/option 只选不展开(否则范围选一路把树全撑开)。
            onClick={(e) => { const act = ctx.rowClick(e, entry); if (act.open !== 'none' && e.detail === 1) setOpen((o) => !o) }}
            onContextMenu={(e) => ctx.onMenu(e, entry)}
          >
            {/* 前导槽:与笔记/会话 view 同构(图标 ↔ hover 换箭头);展开态靠 FolderOpen/Folder 表达。 */}
            <span className="t2s-lead">
              {open ? <FolderOpen className="t2s-lead-icon t2sf-fic" /> : <Folder className="t2s-lead-icon t2sf-fic" />}
              <span className={`t2s-chev t2s-lead-chev${open ? ' open' : ''}`}><ChevronRight size={12} /></span>
            </span>
            <span className="t2sf-name">{entry.name}</span>
          </div>
        )}
      <AnimatedCollapse open={open}>
        {creatingHere && ctx.creating && (
          <NameInput initial="" depth={depth + 1} onCommit={(n) => ctx.commitCreate(entry.path, ctx.creating!.kind, n)} onCancel={ctx.cancelEdit} />
        )}
        {kids === null
          ? <div className="t2sf-loading" style={{ paddingLeft: nameLeft(depth + 2) }}>…</div>
          : <>{kids.map((k) => k.isDir
            ? <DirRow key={k.path} entry={k} depth={depth + 1} ctx={ctx} forceOpen={onPath ? forceOpen : null} />
            : <FileRow key={k.path} entry={k} depth={depth + 1} ctx={ctx} />)}</>}
      </AnimatedCollapse>
    </>
  )
}

/** 云端 Project 组:文件在 Penzor 云(files 表),经 workspace API 按 project 取数;fs IPC 不可用 →
 *  只读呈现(双击预览 / 右键 预览・下载・删除)。
 *  ponytail: 平铺相对路径,文件多层级复杂了再做树。 */
function CloudGroup({ ws, open, onToggle, onOpenPreview, sel }: {
  ws: WorkspaceDescriptor
  open: boolean
  onToggle: () => void
  onOpenPreview: (t: PreviewTarget, opts?: { newTab?: boolean }) => void
  /** 与本地工作区共用同一个多选(同一个滚动容器里,范围选要能跨过去)。 */
  sel: ItemSelect
}) {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const running = useApp((s) => Object.keys(s.runningBySession).length > 0)
  const [files, setFiles] = useState<WorkspaceFileMeta[] | null>(null)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const project = ws.project!
  const refresh = useCallback(() => {
    void listWorkspace(cfg, '__project__', project)
      .then((fs) => setFiles([...fs].sort((a, b) => a.path.localeCompare(b.path))))
      .catch(() => setFiles([]))
  }, [cfg, project])
  useEffect(() => { if (open && files === null) refresh() }, [open, files, refresh])
  // run 结束 → 刷新(agent 产物落云端后可见)
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current && !running && open) refresh()
    prevRunning.current = running
  }, [running, open, refresh])

  const download = (f: WorkspaceFileMeta): void => {
    void downloadWorkspaceFile(cfg, '__project__', f.path, project)
      .catch((err) => useApp.getState().toast(err?.message || String(err), true))
  }
  const preview = (f: WorkspaceFileMeta, newTab?: boolean): void => {
    onOpenPreview({
      name: f.path,
      load: async () => {
        const r = await readWorkspaceFile(cfg, '__project__', f.path, project)
        return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size }
      },
      download: () => download(f),
    }, newTab ? { newTab: true } : undefined)
  }
  const del = async (f: WorkspaceFileMeta): Promise<void> => {
    if (!window.confirm(t('panel.confirm.delete', { name: f.path }))) return
    try { await deleteWorkspaceFile(cfg, '__project__', f.path, project); refresh() }
    catch (err: any) { useApp.getState().toast(err?.message || String(err), true) }
  }
  /** 整批删除(云端文件无回收站 → 一次确认后逐个 DELETE)。 */
  const delMany = async (fs: WorkspaceFileMeta[]): Promise<void> => {
    if (!fs.length || !window.confirm(t('panel.confirm.deleteN', { n: String(fs.length) }))) return
    try { for (const f of fs) await deleteWorkspaceFile(cfg, '__project__', f.path, project) }
    catch (err: any) { useApp.getState().toast(err?.message || String(err), true) }
    sel.clear()
    refresh()
  }
  const onRowMenu = (ev: React.MouseEvent, f: WorkspaceFileMeta): void => {
    ev.preventDefault(); ev.stopPropagation()
    const paths = sel.batch(f.path)
    if (paths.length === 1) sel.only(f.path)
    if (paths.length > 1) {
      const targets = (files ?? []).filter((x) => paths.includes(x.path))
      const items: CtxItem[] = [{
        label: t('panel.action.deleteN', { n: String(targets.length) }),
        icon: <Trash2 size={13} />, danger: true,
        run: () => void delMany(targets),
      }]
      setMenu({ ...menuPos(ev, items.length), items })
      return
    }
    const items: CtxItem[] = [
      { label: t('panel.action.preview'), icon: <Eye size={13} />, run: () => preview(f) },
      { label: t('panel.action.download'), icon: <Download size={13} />, run: () => download(f) },
      { label: t('panel.action.delete'), icon: <Trash2 size={13} />, danger: true, run: () => void del(f) },
    ]
    setMenu({ ...menuPos(ev, items.length), items })
  }

  return (
    <div>
      <div className="t2s-group" style={{ paddingLeft: folderPadLeft(0) }}>
        <button className="t2s-group-toggle t2s-folder-row" onClick={onToggle} title={project}>
          <span className="t2s-lead">
            {open ? <FolderOpen className="t2s-lead-icon" /> : <Folder className="t2s-lead-icon" />}
            <span className={`t2s-chev t2s-lead-chev${open ? ' open' : ''}`}><ChevronRight size={12} /></span>
          </span>
          <span className="t2s-group-label">{ws.name}</span>
        </button>
        <button className="t2s-group-add" title={t('panel.files.refresh')} onClick={refresh}><RefreshCw size={13} /></button>
      </div>
      <AnimatedCollapse open={open}>
        <div className="t2sf-tree">
          {files == null ? <div className="t2sf-loading" style={{ paddingLeft: nameLeft(1) }}>…</div>
            : files.length === 0 ? <div className="t2sf-empty">{t('panel.files.empty')}</div>
            : files.map((f) => {
              const Icon = iconForFile(mimeForExt(f.path) || '', f.path)
              return (
                <div
                  key={f.path}
                  className={`t2sf-row t2sf-file${sel.has(f.path) ? ' sel' : ''}`}
                  data-sel-id={f.path}
                  style={{ paddingLeft: rowPadLeft(1) }}
                  onClick={(e) => { const act = sel.click(f.path, e); if (act.open !== 'none') preview(f, act.open === 'new') }}
                  onDoubleClick={() => preview(f)}
                  onContextMenu={(e) => onRowMenu(e, f)}
                >
                  <span className="t2s-lead"><Icon className="t2s-lead-icon t2sf-fic" /></span>
                  <span className="t2sf-name">{f.path}</span>
                  {f.size > 0 && <span className="t2sf-size">{fmtSize(f.size)}</span>}
                </div>
              )
            })}
        </div>
      </AnimatedCollapse>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

export function FilesPanel({ workspaces, onOpenPreview, activeWorkspaceKey, onEnterWorkspace, expandToPath, pinnedWorkspaceKey }: {
  workspaces: WorkspaceDescriptor[]
  /** newTab = ⌘/Ctrl 单击:强开一个新标签页(缺省则同路径已开就聚焦过去)。 */
  onOpenPreview: (t: PreviewTarget, opts?: { newTab?: boolean }) => void
  /** 共享「进入的工作区」key(与会话面板联动:进入 = 展开它 + 置顶,不收其余)。 */
  activeWorkspaceKey?: string | null
  onEnterWorkspace?: (key: string | null) => void
  /** 自动展开到某绝对目录(统一工作区视图定位笔记所在目录;仅作用于当前展开的工作区)。 */
  expandToPath?: string | null
  /** 置顶(常驻可见)的工作区;缺席/认不出 → 退回「进入的工作区」,再退回第一个。 */
  pinnedWorkspaceKey?: string | null
}) {
  const { t } = useI18n()
  const running = useApp((s) => Object.keys(s.runningBySession).length > 0)
  // 展开态放 appStore(不是组件 state):左栏切「会话/文件」档会重挂本面板,组件 state 会把用户展开的一排全塌掉。
  const openKeys = useApp((s) => s.openWorkspaceKeys)
  const toggleOpenWorkspace = useApp((s) => s.toggleOpenWorkspace)
  const locals = workspaces.filter((w) => w.kind === 'local' && !!w.path)
  const clouds = workspaces.filter((w) => w.kind === 'cloud' && !!w.project)
  const [rootsByKey, setRootsByKey] = useState<Record<string, Entry[] | null>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const sel = useItemSelect(scrollRef) // 多选(范围选按 DOM 顺序,故要给容器 ref)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'folder' } | null>(null)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const draggingRef = useRef<string[] | null>(null)

  const toast = (m: string, err?: boolean): void => useApp.getState().toast(m, err)
  const openFile = (e: Entry, newTab?: boolean): void => {
    if (!e.isDir) onOpenPreview(hostTargetFor(e.path, e.name), newTab ? { newTab: true } : undefined)
  }
  /** 行点击:选中态归 itemSelect(三档共用判据),打不打开由它返回的 act 说了算。 */
  const rowClick = (ev: React.MouseEvent, e: Entry): ClickAct => {
    const act = sel.click(e.path, ev)
    if (act.open !== 'none' && !e.isDir) openFile(e, act.open === 'new')
    return act
  }

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
  /** 回收站:对整批选中生效(单个时文案/确认与从前一致)。 */
  const trashPaths = async (paths: string[]): Promise<void> => {
    if (!paths.length || !window.tangu?.trashHostPath) return
    const ok = window.confirm(paths.length === 1
      ? t('panel.confirm.trash', { name: paths[0].split(/[/\\]/).pop() || '' })
      : t('panel.confirm.trashN', { n: String(paths.length) }))
    if (!ok) return
    try { for (const p of paths) await window.tangu.trashHostPath(p) }
    catch (err: any) { toast(t('panel.toast.deleteFail', { err: err?.message || err }), true) }
    sel.clear()
    for (const p of paths) bumpDir(dirOf(p))
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
  const copyPathsInto = async (paths: string[], destDir: string): Promise<void> => {
    if (!window.tangu?.copyHostFiles || !paths.length) return
    try {
      const r = await window.tangu.copyHostFiles(paths, destDir)
      toast(t('panel.toast.copied', { n: String(r.copied) }))
    } catch (err: any) { toast(t('panel.toast.copyFail', { err: err?.message || err }), true) }
    bumpDir(destDir)
  }
  /** 库里的行拖进来:`X.fd` 是 `X.md` 的附属,必须**成对同名**落地(见主进程 fs:copyBundle);
   *  其余(附件/图片/无 .fd 的笔记)照旧逐件复制。老壳没有这个 IPC 就整体回退。 */
  const copyFromVault = async (paths: string[], destDir: string): Promise<void> => {
    const bundleApi = window.tangu?.copyNoteBundles
    if (!bundleApi) return copyPathsInto(paths, destDir)
    const have = new Set(paths)
    const fdOf = (p: string): string => p.replace(/\.md$/i, '.fd')
    const bundles = paths.filter((p) => /\.md$/i.test(p)).map((p) => ({ md: p, fd: have.has(fdOf(p)) ? fdOf(p) : undefined }))
    const paired = new Set(bundles.flatMap((b) => (b.fd ? [b.md, b.fd] : [b.md])))
    // 已被某个 .fd 覆盖的后代(父笔记与其子笔记一起选中)去重,免得子笔记被复制两遍。
    const rest = paths.filter((p) => !paired.has(p) && !bundles.some((b) => b.fd && p.startsWith(`${b.fd}/`)))
    try {
      let n = 0
      if (bundles.length) n += (await bundleApi(bundles, destDir)).copied
      if (rest.length && window.tangu?.copyHostFiles) n += (await window.tangu.copyHostFiles(rest, destDir)).copied
      toast(t('panel.toast.copied', { n: String(n) }))
    } catch (err: any) { toast(t('panel.toast.copyFail', { err: err?.message || err }), true) }
    bumpDir(destDir) // ⚠️ 部分成功也要刷:先复制成功的那些已经落盘了
  }
  const copyFilesInto = async (files: FileList, destDir: string): Promise<void> => {
    if (!window.tangu?.getPathForFile) return
    await copyPathsInto(
      Array.from(files).map((f) => { try { return window.tangu!.getPathForFile!(f) } catch { return '' } }).filter(Boolean),
      destDir,
    )
  }

  // ── 右键菜单 ──
  const onMenu = (ev: React.MouseEvent, e: Entry): void => {
    ev.preventDefault(); ev.stopPropagation()
    // 右键落在已选中的项上 → 整批;落在别处 → 改成只选它(与 Finder 一致)。
    const paths = sel.batch(e.path)
    if (paths.length === 1) sel.only(e.path)
    if (paths.length > 1) {
      const items: CtxItem[] = [
        { label: t('panel.action.copyPath'), icon: <Copy size={13} />, run: () => { void navigator.clipboard.writeText(paths.join('\n')) } },
      ]
      if (canWrite()) items.push({ label: t('panel.action.deleteN', { n: String(paths.length) }), icon: <Trash2 size={13} />, danger: true, run: () => void trashPaths(paths) })
      setMenu({ ...menuPos(ev, items.length), items })
      return
    }
    const items: CtxItem[] = []
    if (!e.isDir) {
      items.push({ label: t('panel.action.open'), icon: <Eye size={13} />, run: () => openFile(e) })
      if (window.tangu?.openHostPath) items.push({ label: t('preview.openWithDefault'), icon: <ExternalLink size={13} />, run: () => {
        void window.tangu?.openHostPath?.(e.path).then((r) => { if (r && !r.ok) toast(r.error || 'open failed', true) })
      } })
    } else if (canWrite()) {
      items.push({ label: t('panel.action.newFile'), icon: <FilePlus2 size={13} />, run: () => setCreating({ dir: e.path, kind: 'file' }) })
      items.push({ label: t('panel.action.newFolder'), icon: <FolderPlus size={13} />, run: () => setCreating({ dir: e.path, kind: 'folder' }) })
    }
    if (canWrite()) items.push({ label: t('panel.action.rename'), icon: <Pencil size={13} />, run: () => setRenaming(e.path) })
    items.push({ label: t('panel.action.copyPath'), icon: <Copy size={13} />, run: () => { void navigator.clipboard.writeText(e.path) } })
    if (canReveal()) items.push({ label: t('panel.action.revealInFileManager'), icon: <FolderSearch size={13} />, run: () => void window.tangu?.revealHostPath?.(e.path) })
    if (canWrite()) items.push({ label: t('panel.action.moveToTrash'), icon: <Trash2 size={13} />, danger: true, run: () => void trashPaths([e.path]) })
    setMenu({ ...menuPos(ev, items.length), items })
  }
  const onWsMenu = (ev: React.MouseEvent, ws: WorkspaceDescriptor): void => {
    if (!ws.path) return
    ev.preventDefault(); ev.stopPropagation()
    const path = ws.path
    const items: CtxItem[] = []
    if (canWrite()) {
      items.push({ label: t('panel.action.newFile'), icon: <FilePlus2 size={13} />, run: () => { onEnterWorkspace?.(ws.key); setCreating({ dir: path, kind: 'file' }) } })
      items.push({ label: t('panel.action.newFolder'), icon: <FolderPlus size={13} />, run: () => { onEnterWorkspace?.(ws.key); setCreating({ dir: path, kind: 'folder' }) } })
    }
    if (canReveal()) items.push({ label: t('panel.action.revealInFileManager'), icon: <FolderSearch size={13} />, run: () => void window.tangu?.revealHostPath?.(path) })
    items.push({ label: t('panel.files.refresh'), icon: <RefreshCw size={13} />, run: () => bumpDir(path) })
    setMenu({ ...menuPos(ev, items.length), items })
  }

  // ── 拖拽:行拖(内部移动 / Alt=原生拖出);文件夹与工作区头是投放目标;OS 文件拖入=复制 ──
  const rowDragStart = (ev: React.DragEvent, e: Entry): void => {
    if (ev.altKey && window.tangu?.startHostDrag) { ev.preventDefault(); window.tangu.startHostDrag(e.path); return }
    const paths = sel.batch(e.path) // 拖已选中的项 = 整批搬走
    draggingRef.current = paths
    ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths))
    // ⚠️ copyMove 而非 move:同一份载荷既可能在面板内移动,也可能被笔记树按**复制**接走 ——
    // 源只允许 move 而目标声明 copy,浏览器按交集协商会把整个投放判成不允许(codex 评审 2026-08-25)。
    ev.dataTransfer.effectAllowed = 'copyMove'
  }
  const dragEnd = (): void => { draggingRef.current = null; setDropDir(null) }
  const dragOverDir = (ev: React.DragEvent, dir: string): void => {
    const osFiles = canWrite() && ev.dataTransfer.types.includes('Files')
    const internal = !!draggingRef.current || ev.dataTransfer.types.includes(DRAG_MIME) // 本面板 或 其他面板的行拖
    if (!internal && !osFiles) return
    if (draggingRef.current?.includes(dir)) return
    // 源本来就在这个目录里 = 原地移动,没意义(同笔记树 parentOf(dragPath) === fd 的守卫);
    // 跨面板拖拽在 dragover 阶段读不到 getData(浏览器安全限制),只能守住本面板这一半。
    if (!osFiles && draggingRef.current?.every((p) => dirOf(p) === dir)) return
    ev.preventDefault(); ev.stopPropagation()
    // 光标要说实话:库里的行(带 REF_MIME)是复制,其余是移动/OS 复制。
    ev.dataTransfer.dropEffect = osFiles || ev.dataTransfer.types.includes(REF_MIME) ? 'copy' : 'move'
    setDropDir(dir)
  }
  const dragLeaveDir = (dir: string): void => { setDropDir((d) => (d === dir ? null : d)) }
  const dropOnDir = (ev: React.DragEvent, dir: string): void => {
    ev.preventDefault(); ev.stopPropagation()
    const files = ev.dataTransfer.files
    let dg = draggingRef.current
    if (!dg) { try { dg = JSON.parse(ev.dataTransfer.getData(DRAG_MIME) || 'null') } catch { dg = null } } // 跨面板
    // 载荷带 REF_MIME = 从笔记库那棵树拖出来的(它同时带绝对路径供这里认):**复制,绝不搬走原件** ——
    // 库里的笔记还有 .fd / 反链 / 同步在依赖它,move 等于把它从库里挖走。
    const fromVault = ev.dataTransfer.types.includes(REF_MIME)
    setDropDir(null); draggingRef.current = null
    if (files?.length) void copyFilesInto(files, dir)
    else if (dg?.length) void (fromVault ? copyFromVault(dg, dir) : moveInto(dir, dg))
  }

  const ctx: TreeCtx = {
    isSel: sel.has, rowClick, openFile, onMenu,
    renaming, commitRename, creating, commitCreate,
    cancelEdit: () => { setRenaming(null); setCreating(null) },
    dropDir, rowDragStart, dragEnd, dragOverDir, dragLeaveDir, dropOnDir,
  }

  // 点工作区头 = 就地展开/收起,**各自独立**(手风琴已去掉);展开时顺带「进入」它(置顶/联动会话面板)。
  const toggleWs = (ws: WorkspaceDescriptor): void => {
    const willOpen = !openKeys.includes(ws.key)
    toggleOpenWorkspace(ws.key, willOpen)
    if (willOpen) onEnterWorkspace?.(ws.key)
  }

  // 别人(会话面板/Coding Space)进入了折叠区里的工作区 → 展开它 + 自动摊开折叠区,
  // 否则用户看见的是「点了没反应」。
  useEffect(() => {
    if (!activeWorkspaceKey) return
    toggleOpenWorkspace(activeWorkspaceKey, true)
    if (activeWorkspaceKey !== pinnedWorkspaceKey) setShowAll(true)
  }, [activeWorkspaceKey, pinnedWorkspaceKey, toggleOpenWorkspace])

  // 展开着的本地工作区首次展开时加载磁盘根目录。
  useEffect(() => {
    for (const key of openKeys) {
      const w = locals.find((x) => x.key === key)
      if (w?.path && rootsByKey[key] === undefined) loadRoot(key, w.path)
    }
  }, [openKeys, locals, rootsByKey, loadRoot])

  if (!locals.length && !clouds.length) return <div className="t2s-hint" style={{ padding: '18px 12px' }}>{t('panel.files.noLocalWs')}</div>

  const renderWs = (ws: WorkspaceDescriptor): ReactNode => {
    if (ws.kind === 'cloud') {
      return (
        <CloudGroup
          key={ws.key}
          ws={ws}
          open={openKeys.includes(ws.key)}
          onToggle={() => toggleWs(ws)}
          onOpenPreview={onOpenPreview}
          sel={sel}
        />
      )
    }
    const open = openKeys.includes(ws.key)
    const roots = rootsByKey[ws.key]
    return (
            <div key={ws.key}>
              <div
                className={`t2s-group${dropDir === ws.path ? ' drop' : ''}`}
                // 组头 = depth 0;其下的文件/文件夹行走 rowPadLeft(depth+1) → 缩进一级(见 treeIndent.ts)。
                style={{ paddingLeft: folderPadLeft(0) }}
                onContextMenu={(e) => onWsMenu(e, ws)}
                onDragOver={(e) => { if (ws.path && open) dragOverDir(e, ws.path) }}
                onDragLeave={() => { if (ws.path) dragLeaveDir(ws.path) }}
                onDrop={(e) => { if (ws.path) dropOnDir(e, ws.path) }}
              >
                <button className="t2s-group-toggle t2s-folder-row" onClick={() => toggleWs(ws)} title={ws.path || undefined}>
                  {/* 前导槽:三个 view 同构;展开态靠 FolderOpen/Folder 表达,箭头 hover 才现。 */}
                  <span className="t2s-lead">
                    {open ? <FolderOpen className="t2s-lead-icon" /> : <Folder className="t2s-lead-icon" />}
                    <span className={`t2s-chev t2s-lead-chev${open ? ' open' : ''}`}><ChevronRight size={12} /></span>
                  </span>
                  <span className="t2s-group-label">{ws.name}</span>
                </button>
                {open && canWrite() && (
                  <button className="t2s-group-add" title={t('panel.action.newFile')} onClick={() => { if (ws.path) setCreating({ dir: ws.path, kind: 'file' }) }}><FilePlus2 size={13} /></button>
                )}
                {open && canWrite() && (
                  <button className="t2s-group-add" title={t('panel.action.newFolder')} onClick={() => { if (ws.path) setCreating({ dir: ws.path, kind: 'folder' }) }}><FolderPlus size={13} /></button>
                )}
                <button className="t2s-group-add" title={t('panel.files.refresh')} onClick={() => { if (ws.path) loadRoot(ws.key, ws.path) }}><RefreshCw size={13} /></button>
              </div>
              <AnimatedCollapse open={open}>
                <div className="t2sf-tree">
                  {creating && ws.path && creating.dir === ws.path && (
                    <NameInput initial="" depth={1} onCommit={(n) => commitCreate(ws.path!, creating.kind, n)} onCancel={() => setCreating(null)} />
                  )}
                  {roots == null ? <div className="t2sf-loading" style={{ paddingLeft: nameLeft(1) }}>…</div>
                    : roots.length === 0 ? <div className="t2sf-empty">{t('panel.files.empty')}</div>
                    : roots.map((e) => e.isDir
                      ? <DirRow key={e.path} entry={e} depth={1} ctx={ctx} forceOpen={open ? expandToPath : null} />
                      : <FileRow key={e.path} entry={e} depth={1} ctx={ctx} />)}
                </div>
              </AnimatedCollapse>
            </div>
    )
  }

  // 置顶谁:当前打开文件所在的工作区 → 进入的工作区 → 第一个(保证顶上永远有一个可见的)。
  const ordered = [...clouds, ...locals]
  const pinKey = [pinnedWorkspaceKey, activeWorkspaceKey, ordered[0]?.key]
    .find((k) => k && ordered.some((w) => w.key === k)) ?? null
  const rest = ordered.filter((w) => w.key !== pinKey)

  return (
    <aside className="t2s-side">
      <div ref={scrollRef} className="t2s-scroll" onClick={(e) => { if (e.target === e.currentTarget) sel.clear() }}>
        {ordered.filter((w) => w.key === pinKey).map(renderWs)}
        {rest.length > 0 && (
          <>
            <button className="t2sf-showall" onClick={() => setShowAll((v) => !v)}>
              <span className={`t2s-chev${showAll ? ' open' : ''}`}><ChevronRight size={12} /></span>
              {t('panel.files.showAllWs')}
              <span className="t2sf-showall-n">{rest.length}</span>
            </button>
            <AnimatedCollapse open={showAll}>{rest.map(renderWs)}</AnimatedCollapse>
          </>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
