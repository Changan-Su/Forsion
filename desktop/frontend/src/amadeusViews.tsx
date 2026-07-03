/** Amadeus Space 的引擎视图 —— 外壳用 Tangu 原生 UI 重建(复刻侧栏 t2s- 视觉 + base.css 的 .ctx-menu),
 *  只复用 Amadeus 的数据层(pageStore)与块编辑器内核(PageView/Milkdown)。
 *  左 笔记库 / 主 编辑器 / 右 大纲·反链。除编辑器(块组件用 Amadeus 契约 token,需 .am-app+bridge)外,
 *  外壳直接用 Tangu token/类 → 与 Tangu Desktop 一致,并随其换肤/明暗同步。 */
import { type ReactNode, type CSSProperties, type DragEvent as RDragEvent, type MouseEvent as RMouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  SquarePen, FolderOpen, Folder, FolderPlus, Plus, MoreHorizontal, Pencil, Trash2,
  ChevronRight, Search, Code2, Eye, CalendarDays, Star, History, Paperclip, FileDown,
} from 'lucide-react'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { useUiOverlay } from './amadeusOverlayStore'
import { amadeus } from '@amadeus/api'
import { getAttachmentPrefs } from '@amadeus/lib/attachments'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { installAmadeusPlugins } from './amadeusPlugins'
import { AmadeusPropertiesPanel } from './amadeusProperties'
import { openDailyNote } from './amadeusTemplates'
import { useAmadeusPrefs } from './amadeusPrefs'
import { openNote } from './amadeusNav'
import { useRecentViews } from './recentViews'
import { buildTree, type TreeNode } from '@amadeus/lib/pageTree'
import { compile, parsePageSource } from '@amadeus-shared/compiler'
import { recordNav, useWorkspace, activeMainPanel } from './engine'
import type { ViewProps } from './engine'
import { PageView } from '@amadeus/components/PageView'
import '@amadeus/blocks' // 注册内置块类型(markdown→Milkdown);缺此 side-effect 导入则块显示「未知块类型」
import './views/chat2/sidebar2.css' // t2s- 侧栏样式(通常已随 SessionsView 全局加载;显式引入以防独立挂载)

const ps = () => usePageStore.getState()
const baseName = (p: string): string => p.split(/[\\/]/).pop()!.replace(/\.md$/, '')
/** buildTree 把两种分隔符都当分隔并用 '/' 连接文件夹路径;父级计算必须说同一种「方言」,
 *  否则拖拽守卫/展开集合与树节点路径对不上(Windows 反斜杠路径、含 '\' 的文件名)。 */
const parentOf = (p: string): string => { const a = p.split(/[\\/]/).filter(Boolean); a.pop(); return a.join('/') }
const folderName = (p: string): string => p.split('/').pop() || p
/** 归一化并返回全部祖先前缀(含自身):'a/b/c' → ['a','a/b','a/b/c']。喂给 expanded 集合逐级展开。 */
const prefixesOf = (p: string): string[] => {
  const out: string[] = []
  let acc = ''
  for (const seg of p.split(/[\\/]/).filter(Boolean)) { acc = acc ? `${acc}/${seg}` : seg; out.push(acc) }
  return out
}

/** 把某页改名:renamePage 作用于当前活动页,故先 loadPage 再改名(修复非活动页改名失效)。 */
async function renameAt(path: string, newName: string): Promise<void> {
  if (ps().activePage !== path) await ps().loadPage(path)
  await ps().renamePage(newName)
}

/** 跨视图定位信号:编辑器面包屑点击 → 左栏笔记库展开 / 滚动 / 高亮该 folder 或 page。n 自增以重触发同路径。 */
const useAmadeusNav = create<{ locate: { path: string; n: number } | null; requestLocate: (p: string) => void }>((set) => ({
  locate: null,
  requestLocate: (path) => set((s) => ({ locate: { path, n: (s.locate?.n ?? 0) + 1 } })),
}))

// ── 笔记切换喂 per-tab 导航历史(箭头由引擎在主区左上角渲染,见 WorkspaceHost)。
//    记入当前活动 editor leaf 的栈;推迟一拍(microtask)等 openView/navigateLeaf 就位(同 chat 订阅,
//    back/forward 复原期间 navigating 闸仍闭合,不会重记)。restore 作用于该 leaf 自身:若它已被
//    就地切成别的视图,先 navigateLeaf 切回编辑器再 loadPage。 ──
usePageStore.subscribe((state, prev) => {
  const p = state.activePage
  if (!p || p === prev.activePage) return
  queueMicrotask(() => {
    const api = useWorkspace.getState().api
    const am = api ? activeMainPanel(api) : null
    const leafId = am && ((am.params ?? {}) as { __type?: string }).__type === 'amadeus-editor' ? am.id : null
    recordNav(leafId, `amadeus:${p}`, () => {
      const w = useWorkspace.getState()
      const cur = leafId ? w.api?.getPanel(leafId) : null
      if (!cur) return
      if (((cur.params ?? {}) as { __type?: string }).__type !== 'amadeus-editor') w.navigateLeaf(leafId!, 'amadeus-editor', { notePath: p })
      void usePageStore.getState().loadPage(p)
    })
  })
  useRecentViews.getState().record({ key: `note:${p}`, kind: 'note', id: p, title: baseName(p) })
})

/** 编辑器顶部面包屑:默认只显示当前标题(可用区内居中);悬停标题栏时父级路径从标题左侧
 *  逐级展开淡入(宽度 0fr→1fr + 段级 stagger,见 amadeus-host.css),移出反向收拢。
 *  当前标题自始至终是同一个元素,由父级展开的布局变化推它右移(无双文字交叉闪烁)。
 *  父级超过 3 段压缩为「首2 + … + 末1」,当前标题永远完整。点任意段在左栏定位高亮。 */
function Breadcrumb() {
  const activePage = usePageStore((s) => s.activePage)
  const requestLocate = useAmadeusNav((s) => s.requestLocate)
  if (!activePage) return null
  const segs = activePage.replace(/\.md$/, '').split('/')
  const leaf = segs[segs.length - 1]
  const parents = segs.slice(0, -1).map((seg, i) => ({ seg, target: segs.slice(0, i + 1).join('/') as string | null }))
  const shown = parents.length > 3
    ? [...parents.slice(0, 2), { seg: '…', target: null }, parents[parents.length - 1]]
    : parents
  const n = shown.length
  return (
    <div className="amx-crumbs">
      {n > 0 && (
        <span className="amx-crumbs-parents">
          <span className="amx-crumbs-parents-in">
            {shown.map((p, i) => (
              // 靠近标题的段先淡入(delay 递减);收起态无 delay,同步淡出(见 CSS)。
              <span className="amx-crumb-seg" key={`${p.target ?? 'gap'}-${i}`} style={{ '--d': `${(n - 1 - i) * 25}ms` } as CSSProperties}>
                {p.target ? (
                  <button className="amx-crumb" title={p.target} onClick={() => requestLocate(p.target!)}>{p.seg}</button>
                ) : (
                  <span className="amx-crumb amx-crumb-ellipsis" title={activePage}>…</span>
                )}
                <span className="amx-crumb-sep">/</span>
              </span>
            ))}
          </span>
        </span>
      )}
      <button className="amx-crumb amx-crumb-leaf" title={activePage} onClick={() => requestLocate(activePage)}>{leaf}</button>
    </div>
  )
}

// ─────────────────────────────── 左:笔记库(原生 t2s 外壳) ───────────────────────────────

interface Ctx { kind: 'page' | 'folder' | 'asset'; path: string; x: number; y: number }

const isNotePath = (p: string): boolean => /\.md$/i.test(p)

/** 收藏⭐ / 最近🕘 分区(顶部,可折叠):渲染对 pages 过滤 → 已删除的自然消失。 */
function PrefsSections({ row, pages }: { row: (path: string) => ReactNode; pages: string[] }) {
  const starredAll = useAmadeusPrefs((s) => s.starred)
  const recentsAll = useAmadeusPrefs((s) => s.recents)
  const [openStar, setOpenStar] = useState(true)
  const [openRecent, setOpenRecent] = useState(false)
  const exists = new Set(pages)
  const starred = starredAll.filter((p) => exists.has(p))
  const recents = recentsAll.filter((p) => exists.has(p)).slice(0, 8)
  if (!starred.length && !recents.length) return null
  const section = (icon: ReactNode, label: string, items: string[], open: boolean, toggle: () => void): ReactNode => (
    items.length > 0 && (
      <div className="amx-prefs-group">
        <button className="t2s-group-toggle" onClick={toggle}>
          <span className={`t2s-chev${open ? ' open' : ''}`}><ChevronRight size={12} /></span>
          <span className="t2s-group-name">{icon}<span className="t2s-group-label">{label}</span><span className="t2s-count">{items.length}</span></span>
        </button>
        {open && <div className="t2s-group-sessions">{items.map((p) => row(p))}</div>}
      </div>
    )
  )
  return (
    <>
      {section(<Star size={12} />, '收藏', starred, openStar, () => setOpenStar((o) => !o))}
      {section(<History size={12} />, '最近', recents, openRecent, () => setOpenRecent((o) => !o))}
    </>
  )
}

export function AmadeusPagesView() {
  const pages = usePageStore((s) => s.pages)
  const folders = usePageStore((s) => s.folders)
  const files = usePageStore((s) => s.files)
  const activePage = usePageStore((s) => s.activePage)
  const vaultRoot = usePageStore((s) => s.vaultRoot)

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set()) // 文件夹默认全折叠
  const [dragPath, setDragPath] = useState<string | null>(null) // 正在拖动的笔记
  const [dragOver, setDragOver] = useState<string | null>(null) // 悬停的目标文件夹('' = 根)
  const [menu, setMenu] = useState<Ctx | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const nav = useAmadeusNav((s) => s.locate)
  const [flash, setFlash] = useState<string | null>(null)
  const flashRef = useRef<HTMLElement | null>(null)

  // 首次挂载装插件(builtins 子集 + 外部插件)+ 恢复上次 Vault + 订阅外部文件变更。
  useEffect(() => {
    if (!restoreTried) { restoreTried = true; installAmadeusPlugins(); void ps().restoreVault() }
    const offExt = amadeus.onExternalChange?.((p) => void ps().reconcileExternal(p))
    const offStruct = amadeus.onStructureChange?.(() => void ps().refreshStructure())
    return () => { offExt?.(); offStruct?.() }
  }, [])
  useEffect(() => { if (renaming) renameRef.current?.select() }, [renaming])
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [menu])
  // 面包屑定位:逐级展开目标 folder(或 page 的父 folder)的所有祖先 → 滚动到目标行 → 短暂高亮。
  useEffect(() => {
    if (!nav) return
    const open = folders.includes(nav.path) ? nav.path : parentOf(nav.path)
    if (open) setExpanded((prev) => new Set([...prev, ...prefixesOf(open)]))
    setFlash(nav.path)
    const t = setTimeout(() => setFlash(null), 1200)
    return () => clearTimeout(t)
  }, [nav?.n]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (flash) flashRef.current?.scrollIntoView({ block: 'nearest' }) }, [flash])

  const q = query.trim().toLowerCase()
  // 嵌套树:文件夹在前、字母序,空文件夹可见;笔记之外的所有文件(附件/.db/…)也进树,Obsidian 语义。
  const tree = useMemo(() => buildTree([...pages, ...files], folders), [pages, files, folders])
  const matches = useMemo(
    () => (q ? [...pages, ...files].filter((p) => baseName(p).toLowerCase().includes(q)) : []),
    [q, pages, files],
  )

  const toggle = (f: string): void => setExpanded((prev) => {
    const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n
  })
  /** 拖笔记进文件夹 / 拖回根目录(复用会话列表的 HTML5 drag 模式)。 */
  const dropTo = (folder: string): void => {
    if (dragPath && parentOf(dragPath) !== folder) void ps().movePage(dragPath, folder)
    setDragPath(null)
    setDragOver(null)
  }
  const commitRename = (): void => {
    const path = renaming
    setRenaming(null)
    if (path && draft.trim() && draft.trim() !== baseName(path)) void renameAt(path, draft.trim())
  }
  const startRename = (path: string): void => { setDraft(baseName(path)); setRenaming(path); setMenu(null) }
  const newFolder = (parent: string): void => {
    const name = window.prompt(parent ? `在「${folderName(parent)}」中新建文件夹` : '新建文件夹', '新文件夹')?.trim()
    if (name) {
      void ps().createFolder(parent, name)
      // 展开父链,否则折叠父级下新建的子文件夹看不见(用户会误以为没建成)。
      setExpanded((prev) => new Set([...prev, ...prefixesOf(parent ? `${parent}/${name}` : name)]))
    }
    setMenu(null)
  }

  const row = (path: string, depth = 0): ReactNode => {
    const isNote = isNotePath(path)
    const ctxKind = isNote ? 'page' : 'asset'
    return (
    <button
      key={path}
      ref={(el) => { if (path === flash) flashRef.current = el }}
      className={`t2s-srow${path === activePage ? ' active' : ''}${path === flash ? ' amx-flash' : ''}${path === dragPath ? ' dragging' : ''}`}
      style={depth > 0 ? { paddingLeft: 18 + depth * 14 } : undefined}
      onClick={(e) => { isNote ? void openNote(path, { newTab: e.metaKey || e.ctrlKey }) : void amadeus.openVaultFile(path).catch(() => {}) }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: ctxKind, path, x: e.clientX, y: e.clientY }) }}
      draggable={renaming !== path}
      onDragStart={(e) => {
        // 用元素自身作拖影并按抓取点对齐光标(同会话列表:默认拖影/setState 重渲会让内容与光标错位)。
        const r = e.currentTarget.getBoundingClientRect()
        e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
        e.dataTransfer.effectAllowed = 'move'
        setDragPath(path)
      }}
      onDragEnd={() => { setDragPath(null); setDragOver(null) }}
      title={path}
    >
      {renaming === path ? (
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
        <span className="t2s-srow-title">
          {!isNote && <Paperclip size={11} className="t2s-dim" style={{ marginRight: 5, verticalAlign: -1 }} />}
          {isNote ? baseName(path) : path.split(/[\\/]/).pop()}
        </span>
      )}
      <span className="t2s-srow-menu" onClick={(e) => { e.stopPropagation(); setMenu({ kind: ctxKind, path, x: e.clientX, y: e.clientY }) }}>
        <MoreHorizontal size={14} />
      </span>
    </button>
    )
  }

  /** 递归渲染树节点(Obsidian 式嵌套):文件夹头 + 展开的子树,均按 depth 缩进。
   *  拖拽时无论是否可落都 stopPropagation,防止事件冒泡让祖先文件夹误抢落点。 */
  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    if (node.kind === 'file') return row(node.path, depth)
    const folder = node.path
    const isCol = !expanded.has(folder)
    const fileCount = node.children.filter((c) => c.kind === 'file').length
    const folderDragOver = (e: RDragEvent<HTMLDivElement>): void => {
      if (!dragPath) return
      e.stopPropagation()
      if (parentOf(dragPath) === folder) return // 拖回原文件夹 = 不可落(且不让祖先接手)
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dragOver !== folder) setDragOver(folder)
    }
    return (
      <div key={folder}>
        <div
          ref={(el) => { if (folder === flash) flashRef.current = el }}
          className={`t2s-group${folder === flash ? ' amx-flash' : ''}${dragPath && dragOver === folder ? ' amx-drop-into' : ''}`}
          style={depth > 0 ? { paddingLeft: depth * 14 } : undefined}
          onDragOver={folderDragOver}
          onDragLeave={() => { if (dragOver === folder) setDragOver(null) }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropTo(folder) }}
        >
          <button className="t2s-group-toggle" onClick={() => toggle(folder)}>
            <span className={`t2s-chev${isCol ? '' : ' open'}`}><ChevronRight size={12} /></span>
            <span className="t2s-group-name"><Folder size={12} /><span className="t2s-group-label">{folderName(folder)}</span><span className="t2s-count">{fileCount}</span></span>
          </button>
          <button className="t2s-group-add" title="在此文件夹新建笔记" onClick={() => { setExpanded((prev) => new Set([...prev, ...prefixesOf(folder)])); void ps().createPageInFolder(folder) }}><Plus size={14} /></button>
          <button className="t2s-group-add" title="文件夹操作" onClick={(e) => { e.stopPropagation(); setMenu({ kind: 'folder', path: folder, x: e.clientX, y: e.clientY }) }}><MoreHorizontal size={14} /></button>
        </div>
        {/* 展开的文件夹内部(含其中的笔记行)也是该文件夹的落点——与文件管理器语义一致。 */}
        {!isCol && (
          <div
            className={`t2s-group-sessions${dragPath && dragOver === folder ? ' amx-drop-into' : ''}`}
            onDragOver={folderDragOver}
            onDragLeave={() => { if (dragOver === folder) setDragOver(null) }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropTo(folder) }}
          >
            {node.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
      <aside className="t2s-side amx-tree">
        <div className="t2s-search">
          <Search size={13} className="t2s-dim" />
          <input value={query} placeholder="搜索笔记" onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div
          className={`t2s-scroll${dragPath && dragOver === '' ? ' amx-drop-root' : ''}`}
          onDragOver={(e) => {
            // 根目录落点 = 真空白区。行/组/分区上不 preventDefault → 松手即取消,绝不静默搬到根。
            if (!dragPath || parentOf(dragPath) === '' || q) return
            if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group, .t2s-group-sessions, .t2s-special-group')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dragOver !== '') setDragOver('')
          }}
          onDragLeave={() => { if (dragOver === '') setDragOver(null) }}
          onDrop={(e) => {
            if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group, .t2s-group-sessions, .t2s-special-group')) return
            e.preventDefault()
            dropTo('')
          }}
        >
          {q ? (
            matches.length ? matches.map((p) => row(p)) : <div className="t2s-hint">没有匹配的笔记</div>
          ) : (
            <>
              <div className="t2s-special-group">
                <button className="t2s-special" onClick={() => void ps().createPage()}>
                  <span className="t2s-special-ic"><SquarePen size={15} /></span>
                  <span className="t2s-special-title">新建笔记</span>
                </button>
                {vaultRoot && (
                  <button className="t2s-special" onClick={() => void openDailyNote()} title="打开(或创建)今天的日记">
                    <span className="t2s-special-ic"><CalendarDays size={15} /></span>
                    <span className="t2s-special-title">今天</span>
                  </button>
                )}
                <button className="t2s-special" onClick={() => void ps().openVault()} title={vaultRoot || undefined}>
                  <span className="t2s-special-ic"><FolderOpen size={15} /></span>
                  <span className="t2s-special-title">{vaultRoot ? `Vault：${baseName(vaultRoot)}` : '打开 Vault'}</span>
                </button>
              </div>

              {!vaultRoot && <div className="t2s-hint">打开一个 Vault 文件夹开始。</div>}
              <PrefsSections row={row} pages={pages} />
              {tree.children.map((n) => renderNode(n, 0))}

              {vaultRoot && <button className="t2s-add-ws" onClick={() => newFolder('')}><FolderPlus size={14} /> 新建文件夹</button>}
            </>
          )}
        </div>
      </aside>

      {menu?.kind === 'page' && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { void openNote(menu.path, { newTab: true }); setMenu(null) }}><Plus size={13} /> 在新标签页打开</button>
          <button onClick={() => startRename(menu.path)}><Pencil size={13} /> 重命名</button>
          <button onClick={() => { useAmadeusPrefs.getState().toggleStar(menu.path); setMenu(null) }}>
            <Star size={13} /> {useAmadeusPrefs.getState().starred.includes(menu.path) ? '取消收藏' : '收藏'}
          </button>
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); if (window.confirm(`删除笔记「${baseName(p)}」?此操作不可撤销。`)) { useRecentViews.getState().remove(`note:${p}`); void ps().deletePage(p) } }}><Trash2 size={13} /> 删除</button>
        </div>
      )}
      {menu?.kind === 'asset' && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><Eye size={13} /> 打开</button>
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); if (window.confirm(`删除文件「${p.split(/[\\/]/).pop()}」?此操作不可撤销。`)) void ps().deletePage(p) }}><Trash2 size={13} /> 删除</button>
        </div>
      )}
      {menu?.kind === 'folder' && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setExpanded((prev) => new Set([...prev, ...prefixesOf(menu.path)])); void ps().createPageInFolder(menu.path); setMenu(null) }}><SquarePen size={13} /> 新建笔记</button>
          <button onClick={() => newFolder(menu.path)}><FolderPlus size={13} /> 新建子文件夹</button>
          <button onClick={() => { const f = menu.path; setMenu(null); const name = window.prompt('重命名文件夹', folderName(f))?.trim(); if (name) void ps().renameFolder(f, name) }}><Pencil size={13} /> 重命名</button>
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const f = menu.path; setMenu(null); if (window.confirm(`删除文件夹「${folderName(f)}」及其全部内容?不可撤销。`)) void ps().deleteFolder(f) }}><Trash2 size={13} /> 删除</button>
        </div>
      )}

    </div>
  )
}

let restoreTried = false

// ─────────────────────────────── 主:编辑器(Amadeus 内核 + Tangu 排版) ───────────────────────────────

/** 编辑器需 Amadeus 契约 token → 包 .am-app.tangu-lovable + 镜像 Tangu mode/flat,经 bridge 取色。 */
function EditorScope({
  children, dragging, onDrop, onDragOver, onDragLeave, onClick,
}: {
  children: ReactNode
  dragging?: boolean
  onDrop?: (e: RDragEvent<HTMLDivElement>) => void
  onDragOver?: (e: RDragEvent<HTMLDivElement>) => void
  onDragLeave?: (e: RDragEvent<HTMLDivElement>) => void
  onClick?: (e: RMouseEvent<HTMLDivElement>) => void
}) {
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  return (
    <div
      className={`am-app tangu-lovable amx-pane amx-editor${dragging ? ' amx-dragover' : ''}`}
      data-mode={mode}
      data-flat={flat ? '1' : '0'}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

/** 附件链接(关预览时)Markdown 形式;含空格/括号的路径包 `<>` 保证合法。 */
function mdLink(name: string, rel: string): string {
  const dest = /[ ()<>]/.test(rel) ? `<${rel}>` : rel
  return `[${name.replace(/[[\]]/g, '')}](${dest})`
}

/** 可编辑笔记标题 = 文件名(manifest.title 恒取 basename),提交即 renamePage。在编辑器内联改标题。 */
function NoteTitle() {
  const activePage = usePageStore((s) => s.activePage)
  const manifest = usePageStore((s) => s.manifest)
  const current = manifest?.title || (activePage ? baseName(activePage) : '')
  const [val, setVal] = useState(current)
  // 切换笔记 / 改名后(activePage=newPath)把输入重置为最新标题。
  useEffect(() => { setVal(current) }, [activePage]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (): void => {
    const next = val.trim()
    if (next && next !== current) void ps().renamePage(next)
    else setVal(current)
  }
  return (
    <input
      className="amx-title-input"
      value={val}
      placeholder="未命名"
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
        if (e.key === 'Escape') { setVal(current); e.currentTarget.blur() }
      }}
    />
  )
}

/** 源码模式 = 真实 .md 文件:frontmatter(amadeus_page/schema/layout)+ `<!-- a id -->` 块标记 + 内容,
 *  经 compile() 呈现、parsePageSource() 往返(保留块与 2D 布局;标记只由 <!-- a id --> 切分)。
 *  失焦提交(仅在真正改动时);破坏 frontmatter 则退化为外部单块(优雅降级,不丢内容)。 */
function SourceEditor() {
  const readSrc = (): string => {
    const m = ps().manifest
    if (!m) return ''
    const contents: Record<string, string> = {}
    for (const [id, b] of Object.entries(ps().blocks)) contents[id] = b.content
    return compile(m, contents)
  }
  const [src, setSrc] = useState(readSrc)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const grow = (): void => { const el = taRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }
  useEffect(grow, [src])
  const commit = (): void => {
    const page = ps().activePage
    if (!page || src === readSrc()) return
    const parsed = parsePageSource(page, src, new Date().toISOString())
    ps()._commit(parsed.manifest, parsed.blocks)
  }
  return (
    <textarea
      ref={taRef}
      className="amx-source"
      value={src}
      spellCheck={false}
      onChange={(e) => setSrc(e.target.value)}
      onBlur={commit}
    />
  )
}

/** 插件贡献的状态条项(如字数统计)→ 编辑器工具条(engine 无全局状态栏,就近呈现)。 */
function PluginStatusItems() {
  const items = usePluginStore((s) => s.statusItems)
  if (!items.length) return null
  return (
    <span className="amx-status">
      {items.map((o) => {
        const C = o.item.component
        return <C key={`${o.pluginId}:${o.item.id}`} />
      })}
    </span>
  )
}

// 多编辑器 tab 间「最近活动的编辑器」:侧栏点笔记时(焦点可能在侧栏,无 main tab 处于 active)由它认领。
let lastActiveEditorLeafId: string | null = null

export function AmadeusEditorView({ leaf }: ViewProps) {
  const activePage = usePageStore((s) => s.activePage)
  // 模式在 uiOverlayStore(供命令面板「切换 源码/可视」),不再是组件内 state。
  const mode = useUiOverlay((s) => s.editorMode)
  const [dragging, setDragging] = useState(false)
  // 笔记多功能菜单(Obsidian 式右上角 ⋮):导出/收藏/定位/删除。
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null)
  const printHostRef = useRef<HTMLElement | null>(null) // 本编辑器实例的 EditorScope 根(分屏下导出各自的)
  const starred = useAmadeusPrefs((s) => !!activePage && s.starred.includes(activePage))
  useEffect(() => {
    if (!noteMenu) return
    const close = (): void => setNoteMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [noteMenu])

  /** 导出 PDF:把本编辑器 DOM 克隆进 #amx-print-root(同文档 → amadeus-asset/KaTeX 字体照常可用),
   *  @media print 只呈现克隆并隐藏应用壳(见 amadeus-host.css),主进程 printToPDF 收尾。导出恒浅色。 */
  const exportPdf = async (): Promise<void> => {
    const page = ps().activePage
    const host = printHostRef.current
    if (!page || !host) return
    const wrap = document.createElement('div')
    wrap.id = 'amx-print-root'
    const clone = host.cloneNode(true) as HTMLElement
    clone.setAttribute('data-mode', 'light')
    wrap.appendChild(clone)
    document.body.appendChild(wrap)
    try {
      const saved = await amadeus.exportPdf(baseName(page))
      if (saved) useApp.getState().toast(`已导出 PDF:${saved}`)
    } catch (err) {
      useApp.getState().toast(`导出 PDF 失败:${String(err)}`, true)
    } finally {
      wrap.remove()
    }
  }
  const isActiveLeaf = useWorkspace((s) => s.mainTabs.find((t) => t.id === leaf.id)?.active ?? false)
  const notePath = typeof leaf.params.notePath === 'string' ? leaf.params.notePath : null
  const prevActiveRef = useRef(false)

  // 恢复的 tab 一挂载就有笔记名(不必等激活)。
  useEffect(() => { if (notePath) leaf.setTitle(baseName(notePath)) }, [notePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // 认领 / 激活(stage 1:单活文档,全局 pageStore):
  //  - 切回本 tab(becameActive)且它认领的笔记 ≠ 当前全局笔记 → 加载它的笔记;
  //  - 本 tab 为当前编辑器(active,或焦点在侧栏时的「最近活动编辑器」)期间发生导航 → 认领新笔记(写 params+标题)。
  useEffect(() => {
    const becameActive = isActiveLeaf && !prevActiveRef.current
    prevActiveRef.current = isActiveLeaf
    if (isActiveLeaf) lastActiveEditorLeafId = leaf.id
    // null 兜底只允许「唯一编辑器」的情形——多编辑器时会互相覆盖认领(恢复的分屏被同一笔记吞掉)。
    const editorCount = ((useWorkspace.getState() as unknown as { api?: { panels: Array<{ params?: Record<string, unknown> }> } }).api?.panels
      .filter((p) => p.params?.__type === 'amadeus-editor').length) ?? 1
    const mine = isActiveLeaf || lastActiveEditorLeafId === leaf.id || (lastActiveEditorLeafId === null && editorCount <= 1)
    if (!mine) return
    const globalPage = ps().activePage
    if (becameActive && notePath && notePath !== globalPage) {
      void ps().loadPage(notePath)
      return
    }
    if (globalPage) {
      if (leaf.params.notePath !== globalPage) leaf.setParams({ ...leaf.params, notePath: globalPage })
      leaf.setTitle(baseName(globalPage))
    }
  }, [isActiveLeaf, activePage]) // eslint-disable-line react-hooks/exhaustive-deps

  // stage 1 局限:分屏同时可见的两个编辑器共享全局文档——认领了别的笔记的非活动编辑器渲染占位,不显示错误文档。
  const stale = !!(notePath && activePage && notePath !== activePage)

  // 拖入文件 → 按 Tangu 笔记设置存放(attachments/同目录/固定夹)→ 预览开则插 ![[base]],否则插 [名](相对路径)。
  const onDrop = async (e: RDragEvent<HTMLDivElement>): Promise<void> => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    setDragging(false)
    const page = ps().activePage
    if (!page) return
    const { opts, preview } = await getAttachmentPrefs()
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const { pageRel, base } = await amadeus.saveAttachment(page, f.name, bytes, opts)
        ps().insertBlockAfter(null, undefined, preview ? `![[${base}]]` : mdLink(f.name, pageRel))
      } catch { /* 单个文件失败跳过 */ }
    }
    ps().refreshStructure?.() // 新附件出现在左栏结构
  }
  const onDragOver = (e: RDragEvent<HTMLDivElement>): void => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    if (!dragging) setDragging(true)
  }
  const onDragLeave = (e: RDragEvent<HTMLDivElement>): void => {
    if (e.currentTarget === e.target) setDragging(false)
  }
  // 关预览的附件是 [名](相对路径);点击其渲染的 <a>(href=原始相对路径)在系统默认程序打开。
  const onClick = (e: RMouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a || a.classList.contains('wikilink')) return
    const href = a.getAttribute('href') || ''
    if (!href || /^(https?:|mailto:|amadeus-asset:|#)/i.test(href)) return
    e.preventDefault()
    const page = ps().activePage
    if (page) void amadeus.openAttachment(page, href)
  }

  if (stale) {
    return (
      <EditorScope>
        <div className="amx-empty">
          <button className="amx-stale-btn" onClick={() => void ps().loadPage(notePath!)}>
            点击加载「{baseName(notePath!)}」
          </button>
          <div className="hint" style={{ marginTop: 8 }}>另一个编辑器正在显示其它笔记(分屏下同一时刻只能编辑一篇)。</div>
        </div>
      </EditorScope>
    )
  }

  return (
    <EditorScope dragging={dragging} onDrop={(e) => void onDrop(e)} onDragOver={onDragOver} onDragLeave={onDragLeave} onClick={onClick}>
      {activePage && (
        // 顶栏与编辑器融为一体:透明浮在纸面上,不是独立的一层(无底色/无分割线;滚动穿过靠 blur,见 CSS)。
        <div className="amx-toolbar">
          <Breadcrumb />
          <PluginStatusItems />
          <button
            className="amx-mode-btn"
            onClick={() => useUiOverlay.getState().toggleEditorMode()}
            title={mode === 'source' ? '切换到可视编辑(所见即所得)' : '切换到源码 Markdown'}
          >
            {mode === 'source' ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          <button
            className="amx-mode-btn amx-more-btn"
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation()
              printHostRef.current = (e.currentTarget as HTMLElement).closest('.amx-editor')
              const r = e.currentTarget.getBoundingClientRect()
              setNoteMenu({ x: Math.max(8, Math.min(r.right - 180, window.innerWidth - 196)), y: r.bottom + 4 })
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      )}
      {noteMenu && activePage && (
        <div className="ctx-menu" style={{ left: noteMenu.x, top: noteMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setNoteMenu(null); void exportPdf() }}><FileDown size={13} /> 导出为 PDF</button>
          <button onClick={() => { useAmadeusPrefs.getState().toggleStar(activePage); setNoteMenu(null) }}>
            <Star size={13} /> {starred ? '取消收藏' : '收藏'}
          </button>
          <button onClick={() => { void amadeus.revealInFileManager(activePage); setNoteMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const p = activePage; setNoteMenu(null); if (window.confirm(`删除笔记「${baseName(p)}」?此操作不可撤销。`)) { useRecentViews.getState().remove(`note:${p}`); void ps().deletePage(p) } }}>
            <Trash2 size={13} /> 删除笔记
          </button>
        </div>
      )}
      {!activePage ? (
        <div className="amx-empty">从左栏选择一篇笔记,或新建 / 打开一个 Vault 开始。</div>
      ) : mode === 'source' ? (
        <SourceEditor key={activePage} />
      ) : (
        <>
          <div className="amx-doc"><NoteTitle /><AmadeusPropertiesPanel /></div>
          <PageView bare />
        </>
      )}
    </EditorScope>
  )
}

// ─────────────────────────────── 右:大纲 / 反链(原生 Tangu 列表) ───────────────────────────────

interface Head { id: string; level: number; text: string; key: string }

export function AmadeusOutlineView() {
  const manifest = usePageStore((s) => s.manifest)
  const blocks = usePageStore((s) => s.blocks)
  const heads = useMemo<Head[]>(() => {
    if (!manifest) return []
    const out: Head[] = []
    for (const r of manifest.root.children)
      for (const c of r.columns)
        for (const ref of c.children)
          for (const line of (blocks[ref.ref]?.content ?? '').split('\n')) {
            const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim())
            if (m) out.push({ id: ref.ref, level: m[1].length, text: m[2], key: `${ref.ref}:${out.length}` })
          }
    return out
  }, [manifest, blocks])
  const goto = (id: string): void => { document.querySelector(`[data-block-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

  return (
    <div className="amx-panel">
      <div className="amx-panel-head">大纲</div>
      {heads.length === 0 ? (
        <div className="amx-panel-empty">没有标题</div>
      ) : (
        <div className="amx-list">
          {heads.map((h) => (
            <button key={h.key} className="amx-list-item" style={{ paddingLeft: 10 + (h.level - 1) * 12 }} onClick={() => goto(h.id)} title={h.text}>{h.text}</button>
          ))}
        </div>
      )}
    </div>
  )
}

export function AmadeusBacklinksView() {
  const activePage = usePageStore((s) => s.activePage)
  const version = usePageStore((s) => s.linkGraphVersion)
  const [refs, setRefs] = useState<Array<{ path: string; title: string; snippet: string }>>([])
  useEffect(() => {
    let live = true
    if (!activePage) { setRefs([]); return }
    void amadeus.backlinks(activePage).then((r) => { if (live) setRefs(r) })
    return () => { live = false }
  }, [activePage, version])

  return (
    <div className="amx-panel">
      <div className="amx-panel-head">反链 · {refs.length}</div>
      {!activePage ? (
        <div className="amx-panel-empty">未打开笔记</div>
      ) : refs.length === 0 ? (
        <div className="amx-panel-empty">还没有其它笔记链接到这里</div>
      ) : (
        <div className="amx-list">
          {refs.map((r) => (
            <button key={r.path} className="amx-list-item" onClick={() => void openNote(r.path)} title={r.path}>
              {r.title}
              {r.snippet && <span className="amx-backlink-snippet">{r.snippet}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
