/** Amadeus Space 的引擎视图 —— 外壳用 Tangu 原生 UI 重建(复刻侧栏 t2s- 视觉 + base.css 的 .ctx-menu),
 *  只复用 Amadeus 的数据层(pageStore)与块编辑器内核(PageView/Milkdown)。
 *  左 笔记库 / 主 编辑器 / 右 大纲·反链。除编辑器(块组件用 Amadeus 契约 token,需 .am-app+bridge)外,
 *  外壳直接用 Tangu token/类 → 与 Tangu Desktop 一致,并随其换肤/明暗同步。 */
import { Fragment, type ReactNode, type CSSProperties, type RefObject, type DragEvent as RDragEvent, type MouseEvent as RMouseEvent, type ClipboardEvent as RClipboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  SquarePen, FolderOpen, Folder, FolderPlus, Plus, MoreHorizontal, Pencil, Trash2,
  ChevronRight, Search, Code2, Eye, Star, Paperclip, FileDown, FileImage,
  Database, ExternalLink, FileText, Share2, Cloud, CloudOff, Pin, PenTool, Upload, LayoutDashboard,
  Undo2, Redo2, ChevronsDown,
} from 'lucide-react'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { activePageScope, cascadeFdAfterRename, disposePageScope, flushAllScopes, pageStoreFor, PageScopeCtx, remapScopePaths, setActivePageScope, usePageScope, usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { retireUnifiedPath, insertFilesForPath } from '@amadeus/unified/lifecycle'
import { useUiOverlay } from './amadeusOverlayStore'
import { amadeus } from '@amadeus/api'
import { UnifiedPage } from '@amadeus/unified/UnifiedPage'
import { NoteCover, CoverPicker, IconPicker, randomEmoji, useActiveCover, UNTITLED_RE } from '@amadeus/chrome/pageChrome'
import { routeNote, type RouteDecision } from '@amadeus/unified/router'
import { upgradeV4Enabled } from '@amadeus/lib/upgradeV4'
import { cursorFromSource, setModeCursor, sourceOffsetFor, takeModeCursor } from '@amadeus/lib/modeCursor'
import { importToPage, importToFolder, pasteImagesToPage } from './amadeusImport'
import { usePluginStore, findFileType, fileTypeBaseName } from '@amadeus/plugins/pluginStore'
import { resolveIcon } from '@amadeus/components/icons'
import { ensureAmadeusReady } from './amadeusPlugins'
import { AmadeusPropertiesPanel } from './amadeusProperties'
import { useAmadeusPrefs } from './amadeusPrefs'
import type { TrashEntry } from '@amadeus-shared/ipc'
import type { AmadeusSyncStatus } from './types'
import { openNote, openDb, openPdf, openImage, openDrawing, openDashboard, openFile, createDrawing, createDashboard, openSearch } from './amadeusNav'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { isDashboardPath } from '@amadeus-shared/dashboard'
import { REF_MIME, readChatRefs, setChatRefDrag } from './views/chat2/chatDragRef'
import { useItemSelect } from './views/itemSelect'
import { useSearchSeed } from './amadeusPanels'
import { askString } from '@amadeus/components/askString'
import { askDeleteAssets, deleteAssetsPref } from '@amadeus/components/askDeleteAssets'
import { renameDb } from '@amadeus/lib/dbFileOps'
import { emptyDb, serializeDb } from '@amadeus-shared/db/schema'
import { useRecentViews } from './recentViews'
import { buildTree, mergeFdNotes, type TreeNode } from '@amadeus/lib/pageTree'
import { fdDirOf, isNoteMd } from '@amadeus/lib/fd'
import { useSectionOpen } from '@amadeus/lib/sectionOpen'
import { folderPadLeft, rowPadLeft } from '@amadeus/lib/treeIndent'
import { compile, parsePageSource } from '@amadeus-shared/compiler'
import { recordNav, useWorkspace, activeMainPanel, Skeleton, zoomOf, UI_MODE } from '@lcl/engine'
import { isCoarsePointer } from './touch'
import type { ViewProps } from '@lcl/engine'
import { PageView, focusBody } from '@amadeus/components/PageView'
// 移动端块面板的清单与落点(与桌面 slash 菜单同一份真源,见 MarkdownBlock)。
import { useAllSlashItems, getFocusedBlockApply, type SlashItem } from '@amadeus/blocks/markdown/MarkdownBlock'
import { CloudVaultPanel } from './components/CloudVaultPanel'
import { PresenceDots } from './components/PresenceDots'
import { ShareCard } from './components/ShareCard'
import { ShareStatus } from './components/ShareStatus'
import { tipProps, tipT, fsTipLines, type TipLines } from './hoverTip'
import { useEntrySync, ensureEntrySyncSubscribed, isSyncedEntry } from './stores/entrySyncStore'
import { openCloudSyncDialog } from './components/CloudSyncDialog'
import { track } from './achievements/store'
import { act } from './activity/log'
import '@amadeus/blocks' // 注册内置块类型(markdown→Milkdown);缺此 side-effect 导入则块显示「未知块类型」
import './views/chat2/sidebar2.css' // t2s- 侧栏样式(通常已随 SessionsView 全局加载;显式引入以防独立挂载)
import { OverlayAt } from '@lcl/engine'

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

/** 把某页改名:纯路径链(flush → renamePageFile 物理移动+全库引用重写 → 各面板跟队 → .fd 级联)。
 *  ⚠️ 不许走「loadPage + renamePage」老路(Codex P0):loadPage 会把 v4/外来 md 灌进 v3 编译管线,
 *  renamePage 落盘时就把它改写成 v3 格式(注 amadeus_page+块标记)= 毁档;纯移动对 v3 同样正确
 *  (noteViewStore.renameNote 就是这条链)。 */
/** 改名后重定向所有开着旧路径的编辑器 leaf(Codex 终审 P1):unified 实例已被退休,
 *  不换 leaf 参数的话那个标签就永远卡在不存在的旧路径上、输入不再保存。
 *  移动端单列壳 api 恒 null → 跳过(单 leaf 场景由 onRenamed/自身导航兜)。 */
function retargetEditorLeaves(oldPath: string, newPath: string): void {
  const w = useWorkspace.getState()
  for (const p of w.api?.panels ?? []) {
    const params = (p.params ?? {}) as { __type?: string; notePath?: string }
    if (params.__type === 'amadeus-editor' && params.notePath === oldPath) {
      w.navigateLeaf(p.id, 'amadeus-editor', { ...params, notePath: newPath })
    }
  }
}

async function renameAt(path: string, newName: string): Promise<void> {
  try {
    await flushAllScopes()
    const newPath = await amadeus.renamePageFile(path, newName)
    if (newPath !== path) {
      retireUnifiedPath(path) // 开着这页的 unified 实例停写旧路径(防幽灵文件)
      remapScopePaths(path, newPath, 'file')
      await cascadeFdAfterRename(path, newPath)
      retargetEditorLeaves(path, newPath)
      // 某个面板正开着这页(v3):remap 换了 activePage 但 manifest.title 还是旧名 → 重载对齐。
      const st = ps()
      if (st.activePage === newPath) void st.loadPage(newPath)
    }
  } catch (e) {
    window.alert(`重命名失败:${e instanceof Error ? e.message : String(e)}`)
  }
  await ps().refreshStructure()
}

/** 有回收站(桌面端)→ 删除免确认(可恢复);无 → 弹原確认。 */
const canTrash = (): boolean => !!amadeus.trashEntry

/** 删除确认文案:笔记带 .fd 子文件时点明「N 个子文件一并删除」(级联在 pageStore.deletePage)。 */
function deleteNoteMsg(p: string): string {
  const fd = fdDirOf(p)
  const n = [...ps().pages, ...ps().files].filter((x) => x.startsWith(`${fd}/`)).length
  return n > 0
    ? `删除笔记「${baseName(p)}」?其中包含 ${n} 个子文件,将一并删除。此操作不可撤销。`
    : `删除笔记「${baseName(p)}」?此操作不可撤销。`
}

/**
 * 删除笔记的完整流程:确认 → 问「只被它引用的附件」怎么办 → 删笔记(+ 按选择清附件)。
 * 独占判据在主进程 vaultIndex.exclusiveAssets(别的笔记也引用的一律保留);没有独占附件就
 * 一句话不问,和从前一样静默移入回收站。选择可勾「下次不再问」,设置→笔记能改回。
 */
async function deleteNoteFlow(p: string, store: typeof ps = ps): Promise<void> {
  if (!confirmedDelete('note', p)) return
  const assets = (await amadeus.exclusiveAssets?.(p).catch(() => [] as string[])) ?? []
  let withAssets = assets.length > 0 ? deleteAssetsPref() : false
  if (assets.length > 0 && withAssets === null) {
    const choice = await askDeleteAssets(baseName(p), assets)
    if (choice === null) return
    withAssets = choice === 'with'
  }
  useRecentViews.getState().remove(`note:${p}`)
  await store().deletePage(p)
  if (!withAssets) return
  for (const a of assets) {
    try {
      if (amadeus.trashEntry) await amadeus.trashEntry(a)
      else await amadeus.deletePage(a) // removeEntry:对任意 vault 文件通用(同左栏删文件)
    } catch { /* 单个附件删不掉不该中断整个删除 */ }
  }
  await store().refreshStructure()
}

/** 删除笔记/文件/文件夹的统一入口:回收站可用即静默移入(toast 在 pageStore),否则确认后硬删。 */
function confirmedDelete(kind: 'note' | 'file' | 'folder', path: string): boolean {
  if (canTrash()) return true
  if (kind === 'note') return window.confirm(deleteNoteMsg(path))
  if (kind === 'file') return window.confirm(`删除文件「${path.split(/[\\/]/).pop()}」?此操作不可撤销。`)
  return window.confirm(`删除文件夹「${path.split(/[\\/]/).pop()}」及其全部内容?不可撤销。`)
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
  // ⚠️ 归属面板必须**在这里**定下来:门面订阅来自「当前活动面板」,也就是刚刚导航的那个。
  // 放进 microtask 里再问 activeMainPanel(),用户手快切到另一半屏时这条历史就记到隔壁去了,
  // 后退时也会把笔记退进隔壁(Codex 复审)。
  const originScope = activePageScope()
  queueMicrotask(() => {
    const api = useWorkspace.getState().api
    const am = api ? activeMainPanel(api) : null
    const leafId = am && ((am.params ?? {}) as { __type?: string }).__type === 'amadeus-editor' && am.id === originScope ? am.id : originScope
    recordNav(leafId, `amadeus:${p}`, () => {
      const w = useWorkspace.getState()
      // ⚠️ 用跨端的 leafById,别用 w.api?.getPanel —— 移动单列壳 api 恒 null,那样写恒 return,
      //    安卓返回键消耗一条历史却什么都不发生(2026-08-05 修)。
      const cur = leafId ? w.leafById(leafId) : null
      if (!cur) return
      if (cur.type !== 'amadeus-editor') w.navigateLeaf(leafId!, 'amadeus-editor', { notePath: p })
      // 对着**这条历史所属的那个面板**装,不能用 usePageStore.getState()(那是「当前活动面板」)——
      // 用户点后退时焦点完全可能已经在另外半屏,笔记就会退到隔壁去。
      void pageStoreFor(leafId!).getState().loadPage(p)
    })
  })
  useRecentViews.getState().record({ key: `note:${p}`, kind: 'note', id: p, title: baseName(p) })
})

/** 编辑器顶部面包屑:默认只显示当前标题(可用区内居中);悬停标题栏时父级路径从标题左侧
 *  逐级展开淡入(宽度 0fr→1fr + 段级 stagger,见 amadeus-host.css),移出反向收拢。
 *  当前标题自始至终是同一个元素,由父级展开的布局变化推它右移(无双文字交叉闪烁)。
 *  父级超过 3 段压缩为「首2 + … + 末1」,当前标题永远完整。点任意段在左栏定位高亮。 */
export function Breadcrumb({ path }: { path?: string } = {}) {
  const storePage = usePageStore((s) => s.activePage)
  const requestLocate = useAmadeusNav((s) => s.requestLocate)
  const activePage = path ?? storePage // unified 笔记不设 activePage,显式传路径
  if (!activePage) return null
  const segs = activePage.replace(/(\.dashboard)?\.md$/i, '').split('/')
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
                  <button className="amx-crumb" title={p.target} onClick={() => requestLocate(p.target!)}>{p.seg.replace(/\.fd$/i, '')}</button>
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

/** 右键菜单目标;kind='multi' = 作用于整批选中(paths)。 */
interface Ctx { kind: 'page' | 'folder' | 'asset' | 'root' | 'multi'; path: string; paths?: string[]; x: number; y: number }

const isNotePath = (p: string): boolean => /\.md$/i.test(p)
const isDbPath = (p: string): boolean => /\.db$/i.test(p)
const isPdfPath = (p: string): boolean => /\.pdf$/i.test(p)
const isImagePath = (p: string): boolean => /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(p)
const dbBaseName = (p: string): string => (p.split(/[\\/]/).pop() || p).replace(/\.db$/i, '')

/** 回收站(桌面端 .trash):树底入口 + 浮层(恢复/彻底删/清空)。缺 API 的端(web/mobile)不渲染。 */
function TrashSection() {
  const [items, setItems] = useState<TrashEntry[] | null>(null)
  const [open, setOpen] = useState(false)
  const has = !!amadeus.listTrash
  const refresh = (): void => {
    void amadeus.listTrash?.().then(setItems).catch(() => {})
  }
  useEffect(() => {
    if (has) refresh()
  }, [has])
  useEffect(() => {
    if (!has) return
    return amadeus.onStructureChange(() => refresh()) // 删除入站/恢复出站 → 计数保鲜
  }, [has])
  if (!has) return null
  const n = items?.length ?? 0
  const dirOfOrig = (o: string): string => {
    const i = o.replace(/\\/g, '/').lastIndexOf('/')
    return i === -1 ? '/' : o.slice(0, i)
  }
  return (
    <>
      <button className="t2s-special amx-trash-entry" onClick={() => { refresh(); setOpen(true) }} title="查看回收站(删除的笔记/文件可恢复)">
        <span className="t2s-special-ic"><Trash2 /></span>
        <span className="t2s-special-title">回收站{n > 0 ? ` (${n})` : ''}</span>
      </button>
      {open && (
        <div className="amx-trash-wrap" onMouseDown={() => setOpen(false)}>
          <div className="amx-trash-pop" onMouseDown={(e) => e.stopPropagation()}>
            <div className="amx-trash-head">
              <span>回收站</span>
              {n > 0 && (
                <button
                  className="amx-trash-clear"
                  onClick={() => {
                    if (window.confirm('清空回收站?其中内容将永久删除。')) void amadeus.emptyTrash?.().then(refresh)
                  }}
                >
                  清空
                </button>
              )}
            </div>
            <div className="amx-trash-list">
              {(items ?? []).map((it) => (
                <div key={it.name} className="amx-trash-row">
                  <span className="amx-trash-ic">{it.dir ? <Folder /> : <FileText />}</span>
                  <span className="amx-trash-name" title={`原位置:${it.original}`}>
                    {it.name}
                    <span className="amx-trash-orig">{dirOfOrig(it.original)}</span>
                  </span>
                  <button
                    className="amx-trash-act"
                    onClick={() => {
                      void amadeus.restoreTrash?.(it.name).then(() => {
                        refresh()
                        void ps().refreshStructure()
                      })
                    }}
                  >
                    恢复
                  </button>
                  <button
                    className="amx-trash-act amx-trash-danger"
                    onClick={() => {
                      if (window.confirm(`彻底删除「${it.name}」?不可恢复。`)) void amadeus.deleteTrashEntry?.(it.name).then(refresh)
                    }}
                    aria-label="delete forever"
                  >
                    删除
                  </button>
                </div>
              ))}
              {n === 0 && <div className="t2s-hint">回收站是空的。</div>}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** 收藏⭐ / 最近🕘 分区(顶部,可折叠):渲染对 pages 过滤 → 已删除的自然消失。 */
function PrefsSections({ row, pages }: { row: (path: string) => ReactNode; pages: string[] }) {
  const starredAll = useAmadeusPrefs((s) => s.starred)
  const collections = useAmadeusPrefs((s) => s.collections)
  // 默认折叠 + 记住手动开合(用户拍板);只有 Vault(树所在的分区)默认展开。
  const [openStar, toggleStar] = useSectionOpen('starred')
  const [openColl, toggleColl] = useSectionOpen('collections')
  const exists = new Set(pages)
  const starred = starredAll.filter((p) => exists.has(p))
  if (!starred.length && !collections.length) return null
  const section = (label: string, items: string[], open: boolean, toggle: () => void): ReactNode => (
    items.length > 0 && (
      <div className="amx-prefs-group">
        <button className="t2s-group-toggle amx-sec-grab" onClick={toggle}>
          <span className="t2s-group-name amx-sec-head">
            <span className="t2s-group-label">{label}</span>
            <span className={`t2s-chev${open ? ' open' : ''}`}><ChevronRight size={12} /></span>
            <span className="t2s-count">{items.length}</span>
          </span>
        </button>
        {open && <div className="t2s-group-sessions">{items.map((p) => row(p))}</div>}
      </div>
    )
  )
  return (
    <>
      {section('收藏', starred, openStar, toggleStar)}
      {/* 「最近」分区已按用户要求移除(收藏/集合保留)。 */}
      {collections.length > 0 && (
        <div className="amx-prefs-group">
          <button className="t2s-group-toggle amx-sec-grab" onClick={toggleColl}>
            <span className="t2s-group-name amx-sec-head">
              <span className="t2s-group-label">集合</span>
              <span className={`t2s-chev${openColl ? ' open' : ''}`}><ChevronRight size={12} /></span>
              <span className="t2s-count">{collections.length}</span>
            </span>
          </button>
          {openColl && (
            <div className="t2s-group-sessions">
              {collections.map((c) => (
                <div
                  key={c.name}
                  className="t2s-srow amx-coll-row"
                  role="button"
                  tabIndex={0}
                  title={`搜索:${c.query}`}
                  onClick={() => { openSearch(); useSearchSeed.getState().request(c.query) }}
                >
                  <span className="amx-coll-ic"><Search /></span>
                  <span className="amx-coll-name">{c.name}</span>
                  <button
                    className="amx-coll-del"
                    title="移除集合"
                    aria-label="remove collection"
                    onClick={(e) => { e.stopPropagation(); useAmadeusPrefs.getState().removeCollection(c.name) }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** 「与我共享」分区(window.amadeusCollab 解闸):别人共享给我的页面;点击进入(必要时切库)。 */
function SharedWithMeSection() {
  const collab = window.amadeusCollab
  const [items, setItems] = useState<Array<{ vaultId: string; path: string; title: string; role: string; ownerName: string | null; localPath?: string }>>([])
  const [activeVault, setActiveVault] = useState('')
  useEffect(() => {
    if (!collab) return
    void collab.sharedWithMe().then(setItems).catch(() => {})
    void collab.activeVaultId().then(setActiveVault).catch(() => {})
  }, [collab])
  if (!collab || items.length === 0) return null
  return (
    <div className="t2s-special-group" style={{ marginTop: 6 }}>
      <div className="t2s-hint amx-sec-grab" style={{ padding: '2px 10px 2px', fontSize: 11.5 }}>与我共享</div>
      {items.map((s) => (
        <button
          key={`${s.vaultId}:${s.path}`}
          className="t2s-special"
          title={`${s.ownerName ?? ''} · ${s.role === 'viewer' ? '只读' : '可编辑'}`}
          onClick={() => {
            // 桌面:localPath=镜像内路径(与我共享/<slug>/…),本地直开(离线可用);web:切库或同库直开。
            if (s.localPath) void openNote(s.localPath)
            else if (s.vaultId === activeVault) void openNote(s.path)
            else collab.switchVault(s.vaultId)
          }}
        >
          <span className="t2s-special-ic"><Share2 /></span>
          <span className="t2s-special-title">{s.title}</span>
        </button>
      ))}
    </div>
  )
}

/** 可折叠分区头(置顶/云同步/Vault名/Cloud工作区共用;PrefsSections 的 section 同款视觉)。
 *  纯文字标题(无图标),折叠箭头紧跟文字之后(amx-sec-head 布局),计数/状态点靠行尾。
 *  dropProps 挂在分区根上(头+体都是落点),dropActive 时整区描边(amx-drop-into 同款)。 */
function SideSection({ id, defaultOpen, label, count, extra, dropProps, dropActive, children }: {
  /** 折叠态的记忆键(要稳定;vault 分区用库名 → 每库各记各的)。 */
  id: string
  /** 缺省 false = 默认折叠(用户拍板);只有「树所在的那个分区」才给 true。 */
  defaultOpen?: boolean
  label: string
  count?: number
  extra?: ReactNode
  dropProps?: { onDragOver: (e: RDragEvent<HTMLDivElement>) => void; onDragLeave: () => void; onDrop: (e: RDragEvent<HTMLDivElement>) => void }
  dropActive?: boolean
  children: ReactNode
}) {
  const [open, toggle] = useSectionOpen(id, defaultOpen)
  return (
    <div className={`amx-prefs-group${dropActive ? ' amx-drop-into' : ''}`} {...dropProps}>
      <button className="t2s-group-toggle amx-sec-grab" onClick={toggle}>
        <span className="t2s-group-name amx-sec-head">
          <span className="t2s-group-label">{label}</span>
          <span className={`t2s-chev${open ? ' open' : ''}`}><ChevronRight size={12} /></span>
          {count !== undefined && <span className="t2s-count">{count}</span>}
          {extra}
        </span>
      </button>
      {open && <div className="t2s-group-sessions">{children}</div>}
    </div>
  )
}

/** 「置顶」分区(amadeusPrefs,每 vault 一份 localStorage;编辑器图钉按钮写入):
 *  故意不进 frontmatter——fm 随云同步跟文件走,会让本地/云端两侧共享置顶。
 *  恒显(空时引导文案);笔记可拖入=置顶(标记不挪位置)。 */
function PinnedSection({ row, dragPath }: { row: (path: string) => ReactNode; dragPath: string | null }) {
  const pins = useAmadeusPrefs((s) => s.pins)
  const pages = usePageStore((s) => s.pages)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const [over, setOver] = useState(false)
  const items = useMemo(() => pages.filter((p) => pins.includes(p)), [pages, pins])
  if (!vaultRoot) return null
  const accepts = !!dragPath && isNotePath(dragPath) && !pins.includes(dragPath)
  return (
    <SideSection
      id="pinned"
      label="置顶"
      count={items.length}
      dropActive={over}
      dropProps={{
        onDragOver: (e) => {
          if (!accepts) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          if (!over) setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
          if (!accepts) return
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          useAmadeusPrefs.getState().togglePin(dragPath!)
        },
      }}
    >
      {items.length ? items.map((p) => row(p)) : <div className="t2s-hint amx-sec-hint">拖入笔记置顶,或点编辑器右上角的图钉</div>}
    </SideSection>
  )
}

/** 引擎跳过原因 → 人话(engine.ts 的 skipped reason;上限与服务端 MAX_TEXT/BINARY_BYTES=5MB 一致)。 */
const skipLabel = (r: string): string => (r === 'TOO_LARGE' ? '超过 5MB,云端不收' : r === 'ASSET_404' ? '云端缺失' : r)

const skipWarnRow = (skipped: Array<{ path: string; reason: string }>): ReactNode => (
  <div
    className="t2s-hint amx-sec-hint amx-cs-warn"
    title={skipped.map((s) => `${s.path} — ${skipLabel(s.reason)}`).join('\n')}
  >
    ⚠ {skipped.length} 项未同步
    {skipped.some((s) => s.reason === 'TOO_LARGE') ? '(有文件超过 5MB,云端单文件上限)' : ''},悬停看明细
  </div>
)

/** 云端侧镜像引擎的跳过警示(如 >5MB 拒收):amadeusSync.onStatus 推送。此前这些跳过只藏在
 *  设置页与状态点 tooltip 里,用户放个大文件进云端文件夹毫无反馈 —— 在云端树顶明示。 */
function CloudSkipWarn() {
  const [st, setSt] = useState<AmadeusSyncStatus | null>(null)
  useEffect(() => {
    const sync = window.amadeusSync
    if (!sync) return
    void sync.get().then(setSt).catch(() => {})
    // status 通道两家共用:带 binding 的是按条目绑定引擎(CloudSyncSection 的地盘),这里只收镜像引擎。
    return sync.onStatus((s) => { if (!s.binding) setSt(s) })
  }, [])
  if (!st?.enabled || !st.skipped.length) return null
  return skipWarnRow(st.skipped)
}

/** 「云同步」分区(仅本地侧):当前 vault 已开启同步的条目汇总(原树位置不动),
 *  分区头带该 vault 条目绑定引擎的状态点;行尾 ✕ 关闭同步;路径已不存在显 ghost。
 *  恒显(空时引导文案);笔记/文件可拖入=走「开启云同步」关联勾选弹窗(与右键同流程)。 */
function CloudSyncSection({ dragPath }: { dragPath: string | null }) {
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const pages = usePageStore((s) => s.pages)
  const files = usePageStore((s) => s.files)
  const folders = usePageStore((s) => s.folders)
  const vaults = useEntrySync((s) => s.vaults)
  const status = useEntrySync((s) => (vaultRoot ? s.status[vaultRoot] : undefined))
  const [over, setOver] = useState(false)
  const rec = vaults.find((v) => v.vaultRoot === vaultRoot)
  if (!window.amadeusSync?.entrySyncEnable || !vaultRoot) return null
  const entries = rec?.entries ?? []
  const norm = (p: string): string => p.replace(/\\/g, '/').normalize('NFC')
  const pageSet = new Set(pages.map(norm))
  const fileSet = new Set(files.map(norm))
  const folderSet = new Set(folders.map(norm))
  const exists = (e: { path: string; kind: string }): boolean =>
    e.kind === 'folder' ? folderSet.has(e.path) : e.kind === 'page' ? pageSet.has(e.path) : fileSet.has(e.path)
  const dot = status?.state === 'error' || status?.state === 'auth-required' ? 'err' : status?.state === 'offline' ? 'off' : 'ok'
  const dotTitle = rec ? `云端「${rec.cloudName}」${status ? ` · ${status.state}${status.skipped.length ? ` · ${status.skipped.length} 项跳过` : ''}` : ''}` : '尚未开启云同步'
  const accepts = !!dragPath && !isSyncedEntry(vaultRoot, dragPath)
  return (
    <SideSection
      id="cloudsync"
      label="云同步"
      count={entries.length}
      extra={rec ? <span className={`amx-sync-dot ${dot}`} title={dotTitle} /> : undefined}
      dropActive={over}
      dropProps={{
        onDragOver: (e) => {
          if (!accepts) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          if (!over) setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
          if (!accepts) return
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          openCloudSyncDialog(dragPath!, isNotePath(dragPath!) ? 'page' : 'asset')
        },
      }}
    >
      {!entries.length && <div className="t2s-hint amx-sec-hint">拖入笔记/文件,或右键条目「开启云同步」</div>}
      {!!status?.skipped.length && skipWarnRow(status.skipped)}
      {entries.map((e) => {
        const ok = exists(e)
        return (
          <div
            key={e.path}
            className={`t2s-srow amx-cs-row${ok ? '' : ' amx-cs-ghost'}`}
            role="button"
            tabIndex={0}
            title={ok ? e.path : `${e.path}(已不存在)`}
            onClick={() => {
              if (!ok) return
              if (e.kind === 'page') void openNote(e.path)
              else if (e.kind === 'asset' && isDbPath(e.path)) openDb(e.path)
            }}
          >
            <span className="amx-cs-ic">{e.kind === 'folder' ? <Folder /> : e.kind === 'page' ? <FileText /> : <Paperclip />}</span>
            <span className="t2s-srow-title">{e.kind === 'page' ? baseName(e.path) : e.path.split(/[\\/]/).pop()}</span>
            <button className="amx-coll-del" title="关闭云同步(云端副本保留)" onClick={(ev) => { ev.stopPropagation(); void window.amadeusSync?.entrySyncDisable?.(e.path) }}>✕</button>
          </div>
        )
      })}
    </SideSection>
  )
}

export function AmadeusPagesView() {
  const pages = usePageStore((s) => s.pages)
  const folders = usePageStore((s) => s.folders)
  const files = usePageStore((s) => s.files)
  const icons = usePageStore((s) => s.icons)
  // pendingPage 先行:点击瞬间高亮就位,不等云端 GET 回来(activePage 那时才更新)
  const activePage = usePageStore((s) => s.pendingPage ?? s.activePage)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const vaultSide = usePageStore((s) => s.vaultSide)
  const vaultLoading = usePageStore((s) => s.vaultLoading)
  // 云端笔记库入口:web(无 amadeusSync)恒显示;桌面仅云端模式显示,本地模式给本地 Vault 选择器。
  const cloudLib = !window.amadeusSync || vaultSide === 'cloud'

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set()) // 文件夹默认全折叠
  const [cloudPanel, setCloudPanel] = useState(false) // web:云端库面板(切换/成员/分享)
  const [dragPath, setDragPath] = useState<string | null>(null) // 正在拖动的笔记
  const [dragOver, setDragOver] = useState<string | null>(null) // 悬停的目标文件夹('' = 根)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 行多选:判据与会话列表/文件树同源(views/itemSelect);范围选按 DOM 顺序 → 要容器 ref。
  const sel = useItemSelect(scrollRef)

  // 侧栏分区(置顶/云同步/与我共享/收藏集合/笔记树)拖拽排序:抓分区头拖整块,顺序持久化。
  // ponytail: 云端侧的多个 vault 分区随「tree」整体挪,不支持分区内再排 —— 需要时再细分。
  const [secOrder, setSecOrder] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('amx.sec.order') || '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch { return [] }
  })
  const [secArm, setSecArm] = useState<string | null>(null) // 分区头被按住 → 该分区可拖
  const [secDrag, setSecDrag] = useState<string | null>(null)
  const [secOver, setSecOver] = useState<string | null>(null)
  useEffect(() => {
    // 松手(未成拖)即撤销 draggable:分区体内还有笔记行拖拽/重命名输入框,常驻 draggable 会吞它们。
    if (!secArm) return
    const clear = (): void => setSecArm(null)
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    return () => { window.removeEventListener('pointerup', clear); window.removeEventListener('pointercancel', clear) }
  }, [secArm])
  const BASE_SEC_IDS = ['pinned', 'cloudsync', 'shared', 'prefs', 'tree']
  const secPos = new Map(secOrder.map((sid, i) => [sid, i]))
  // 已存顺序里没有的分区(未来新增)排到末尾,相对次序保持默认(稳定排序)。
  const orderedSecIds = secOrder.length ? [...BASE_SEC_IDS].sort((a, b) => (secPos.get(a) ?? secOrder.length) - (secPos.get(b) ?? secOrder.length)) : BASE_SEC_IDS
  const moveSec = (from: string, to: string, after: boolean): void => {
    const ids = orderedSecIds.filter((x) => x !== from)
    const i = ids.indexOf(to)
    ids.splice(i < 0 ? ids.length : after ? i + 1 : i, 0, from)
    setSecOrder(ids)
    try { localStorage.setItem('amx.sec.order', JSON.stringify(ids)) } catch { /* 私有模式:仅本会话生效 */ }
  }
  /** 分区包装:头(.t2s-group-toggle / .amx-sec-grab)按住才可拖;笔记行拖拽走 secDrag 门禁互不干扰。 */
  const secWrap = (id: string, node: ReactNode): ReactNode => (
    <div
      key={id}
      className={`amx-sec-wrap${secOver === id && secDrag && secDrag !== id ? ' amx-sec-over' : ''}`}
      draggable={secArm === id}
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return
        // 只认专有抓手类 .amx-sec-grab:.t2s-group-toggle 被笔记树的文件夹展开按钮复用,
        // 按它会沿祖先链把整个分区 wrap 当拖拽源,触控板轻微位移即误拖整棵树(评审 P1)。
        if ((e.target as HTMLElement).closest('.amx-sec-grab')) setSecArm(id)
      }}
      onDragStart={(e) => {
        if (secArm !== id) return // 分区体内的笔记行自己的拖拽冒泡上来:放行
        e.stopPropagation()
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('application/x-amx-section', id) } catch { /* 标识而已,真源是 secDrag */ }
        setSecDrag(id)
      }}
      onDragEnd={() => { setSecDrag(null); setSecOver(null); setSecArm(null) }}
      onDragOver={(e) => {
        if (!secDrag || secDrag === id) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (secOver !== id) setSecOver(id)
      }}
      onDragLeave={(e) => {
        if (secOver === id && !e.currentTarget.contains(e.relatedTarget as Node)) setSecOver(null)
      }}
      onDrop={(e) => {
        if (!secDrag || secDrag === id) return
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        moveSec(secDrag, id, e.clientY > r.top + r.height / 2)
        setSecDrag(null)
        setSecOver(null)
      }}
    >
      {node}
    </div>
  )
  const [menu, setMenu] = useState<Ctx | null>(null)
  // 本地侧 <Vault名> 分区:树就在里面 → **唯一默认展开**的分区(用户点名);手动折叠仍会被记住。
  const [vaultOpen, toggleVault] = useSectionOpen('vault', true)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const nav = useAmadeusNav((s) => s.locate)
  const [flash, setFlash] = useState<string | null>(null)
  const flashRef = useRef<HTMLElement | null>(null)

  // 首次挂载装插件(builtins 子集 + 外部插件)+ 恢复上次 Vault。
  // ⚠️外部变更订阅**不在这里**:本组件只在左栏「笔记」档挂载,挂在这儿等于左栏一切走就停止回灌。
  // externalChange → pageStore 模块级;structureChange → dbAggregateStore 模块级。
  useEffect(() => {
    ensureAmadeusReady()
  }, [])
  // 按条目云同步注册表:订阅一次 + 切库/树刷新时重取(activeRoot 跟随主进程活动 vault;
  // mirrorVaults 随镜像逐步物化,所以要跟着树一起重推,不能只在切库时取一次)。
  useEffect(() => {
    ensureEntrySyncSubscribed()
    void useEntrySync.getState().refresh()
  }, [vaultRoot, pages, folders])
  const entryVaults = useEntrySync((s) => s.vaults)
  const mirrorVaults = useEntrySync((s) => s.mirrorVaults)
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
  // mergeFdNotes:X.fd 文件夹隐藏、孩子挂上 X.md 节点(Notion「笔记即文件夹」);孤儿 .fd 保持普通文件夹。
  const tree = useMemo(() => mergeFdNotes(buildTree([...pages, ...files], folders)), [pages, files, folders])
  const matches = useMemo(
    () => (q ? [...pages, ...files].filter((p) => baseName(p).toLowerCase().includes(q)) : []),
    [q, pages, files],
  )
  // web(无 amadeusSync,库本身就在云端):同步 Vault 分区按 .forsion-vault 标记文件推导
  // (桌面 entryEnable 时写入云端 vault 根;详见 cloudBridge 的 amadeusCloudVaults)。
  const [webVaultNames, setWebVaultNames] = useState<string[]>([])
  useEffect(() => {
    const fn = (window as { amadeusCloudVaults?: () => Promise<string[]> }).amadeusCloudVaults
    if (!fn || window.amadeusSync) return
    let alive = true
    void fn().then((names) => { if (alive) setWebVaultNames(names) }).catch(() => {})
    return () => { alive = false }
  }, [pages, folders]) // 树刷新时重推导(标记文件出现/消失)
  // 云端侧:根节点按「同步 Vault 文件夹」切分——桌面=注册表云名(恒显,镜像未拉到时 node=null
  // 显示等待文案)**并上镜像里的标记推导**;web=标记推导。其余节点归「Cloud工作区」。
  // ⚠️并集不是冗余:注册表只认本机开过的(换台设备恒空),标记只认已拉到镜像的(刚开启时还没有)。
  const cloudSections = useMemo(() => {
    const isDesktopCloud = !!window.amadeusSync && vaultSide === 'cloud'
    // web(库本身在云端)恒走云端样式——落进下面的本地分支会把 vault UUID 当 <Vault名> 显示。
    const isWebCloud = !window.amadeusSync && !!(window as { amadeusCloudVaults?: unknown }).amadeusCloudVaults
    if (!isDesktopCloud && !isWebCloud) return null
    const names = isDesktopCloud
      ? [...new Set([...entryVaults.map((v) => v.cloudName), ...mirrorVaults])].sort()
      : webVaultNames
    const nodeOf = new Map(tree.children.filter((n) => n.kind === 'folder').map((n) => [n.path, n]))
    const vaultSecs = names.map((name) => ({ name, node: nodeOf.get(name) ?? null }))
    const nameSet = new Set(names)
    const rest = tree.children.filter((n) => !(n.kind === 'folder' && nameSet.has(n.path)))
    return { vaultSecs, rest }
  }, [tree, entryVaults, mirrorVaults, vaultSide, webVaultNames])

  // 白板/PDF/.db 开在各自的独立视图、不写 activePage → 树行永远不亮。聚焦主 tab 是这类视图时
  // 按其文件参数点亮对应行(编辑器/其他视图聚焦时回落 activePage,原行为)。mainTabs 随激活变化刷新。
  const mainTabs = useWorkspace((s) => s.mainTabs)
  const activeViewFile = useMemo(() => {
    const t = mainTabs.find((x) => x.active)
    const key = t && ({ 'amadeus-drawing': 'drawingPath', 'amadeus-pdf': 'pdfPath', 'amadeus-db': 'dbPath', 'amadeus-plugin-file': 'filePath' } as Record<string, string>)[t.type]
    // leafById 两壳皆有;移动单列壳 api 恒 null(getPanel 读法在手机上恒 null→白板/PDF 树行不亮)。
    const v = key ? (useWorkspace.getState().leafById(t!.id)?.params as Record<string, unknown> | undefined)?.[key] : null
    return typeof v === 'string' ? v : null
  }, [mainTabs])

  // 插件声明的文件类型(如 .mindmap.md):订阅后插件加载即重渲,树行随之显示专属图标 + 点击改道文件类型视图。
  const pluginFileTypes = usePluginStore((s) => s.fileTypes)
  // 插件贡献的「新建 X」项:进 root/folder 右键菜单,和内置 新建笔记/Base/白板 并列。
  const pluginFileCreators = usePluginStore((s) => s.fileCreators)
  /** 点插件「新建 X」:先展开父文件夹,再交给插件 run(parentFolder)(内部 writeFile+openFile,openFile 会 refreshStructure)。
   *  run 多为异步 → 必须 await 其 promise,否则创建失败只会静默(菜单已关,用户以为建好了)。 */
  const runFileCreator = (parent: string, label: string, run: (p: string) => void | Promise<void>): void => {
    setMenu(null)
    if (parent) setExpanded((prev) => new Set([...prev, ...prefixesOf(parent)]))
    void Promise.resolve()
      .then(() => run(parent))
      .catch((e: unknown) => {
        console.error('[plugin] file creator failed', e)
        useApp.getState().toast(`「${label}」失败:${e instanceof Error ? e.message : String(e)}`, true)
      })
  }

  const toggle = (f: string): void => setExpanded((prev) => {
    const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n
  })
  /** 拖笔记进文件夹 / 拖回根目录(复用会话列表的 HTML5 drag 模式)。 */
  const dropTo = (folder: string): void => {
    // 拖的是已选中的行 → 整批搬。守卫逐项复核:单拖时 mergedDragOver 已挡过,但整批里
    // 可能只有其中一项非法(如把笔记拖进它自己的 .fd 子树),不能一票放行也不能一票否决。
    for (const p of dragPath ? sel.batch(dragPath) : []) {
      if (parentOf(p) === folder) continue
      if (isNoteMd(p)) {
        const dfd = fdDirOf(p)
        if (folder === dfd || folder.startsWith(`${dfd}/`)) continue
      }
      void ps().movePage(p, folder)
    }
    setDragPath(null)
    setDragOver(null)
  }
  // ── OS 文件拖入文件树 → 存入库为文件(不嵌入),类似文件管理器导入 ──
  const hasFilesType = (e: RDragEvent<HTMLElement>): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')
  /** 悬停:OS 文件(无内部 dragPath)也点亮目标落区并允许 copy。返回 true=已按 Files 处理。 */
  const filesDragOver = (e: RDragEvent<HTMLElement>, target: string): boolean => {
    if (!hasFilesType(e)) return false
    e.preventDefault(); e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    if (dragOver !== target) setDragOver(target)
    return true
  }
  /** 落下:OS 文件 → 导入到 target 文件夹(空串=库根);否则返回 false 交内部搬动。 */
  const filesDrop = (e: RDragEvent<HTMLElement>, target: string): boolean => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return false
    e.preventDefault(); e.stopPropagation()
    setDragOver(null)
    void importToFolder(files, target)
    return true
  }
  // 根/分区空白落区:仅真空白才导入到库根;落在行/组(skip 选择器)上=取消(与内部拖拽语义一致)。
  // skip 因区而异:外层 t2s-scroll 要排掉分区体 .t2s-group-sessions,而 Vault 段体本身就是
  // .t2s-group-sessions(它是落区容器,排自己会使自身空白无法接收),故各传各的选择器。
  const rootFilesOver = (e: RDragEvent<HTMLElement>, skipSel: string): boolean => {
    if (!hasFilesType(e)) return false
    if (!(e.target as HTMLElement).closest(skipSel)) filesDragOver(e, '')
    return true
  }
  const rootFilesDrop = (e: RDragEvent<HTMLElement>, skipSel: string): boolean => {
    if (!hasFilesType(e)) return false
    if (!(e.target as HTMLElement).closest(skipSel)) filesDrop(e, '')
    return true
  }
  const commitRename = (): void => {
    const path = renaming
    setRenaming(null)
    const name = draft.trim()
    if (!path || !name) return
    if (isNotePath(path)) {
      if (name !== baseName(path)) void renameAt(path, name)
    } else if (isDbPath(path)) {
      // .db 改名走 renameDb 编排器:文件+内部 name+全库引用一起动
      if (name.replace(/\.db$/i, '') !== dbBaseName(path)) {
        renameDb(path, name).catch((e: unknown) => window.alert(`重命名失败:${e instanceof Error ? e.message : String(e)}`))
      }
    }
  }
  const startRename = (path: string): void => { setDraft(isDbPath(path) ? dbBaseName(path) : baseName(path)); setRenaming(path); setMenu(null) }
  const newFolder = async (parent: string): Promise<void> => {
    const name = (await askString(parent ? `在「${folderName(parent)}」中新建文件夹` : '新建文件夹', '新文件夹'))?.trim()
    if (name) {
      void ps().createFolder(parent, name)
      // 展开父链,否则折叠父级下新建的子文件夹看不见(用户会误以为没建成)。
      setExpanded((prev) => new Set([...prev, ...prefixesOf(parent ? `${parent}/${name}` : name)]))
    }
    setMenu(null)
  }
  /** 新建 base(.db 多维表):出生即 文件名=title。saveAttachment 撞名会静默加 -1 后缀破坏一致性,先挡重名。 */
  const newBase = async (parent: string): Promise<void> => {
    setMenu(null)
    const name = (await askString(parent ? `在「${folderName(parent)}」中新建 Base` : '新建 Base', '未命名数据库'))?.trim().replace(/[\\/]/g, '')
    if (!name) return
    const rel = parent ? `${parent}/${name}.db` : `${name}.db`
    if (ps().files.some((f) => f.replace(/\\/g, '/') === rel)) {
      window.alert(`「${name}.db」已存在`)
      return
    }
    void (async () => {
      const bytes = new TextEncoder().encode(serializeDb(emptyDb(name)))
      await amadeus.saveAttachment('', `${name}.db`, bytes, { mode: 'vault', folder: parent })
      track('base.create'); act('base.create', { f: rel })
      await ps().refreshStructure()
      if (parent) setExpanded((prev) => new Set([...prev, ...prefixesOf(parent)]))
      openDb(rel)
    })().catch((e: unknown) => window.alert(`新建 Base 失败:${e instanceof Error ? e.message : String(e)}`))
  }
  /** 新建白板(.excalidraw.md):创建流程在 amadeusNav.createDrawing(命令面板共用),这里只补树的展开。 */
  const newDrawing = (parent: string): void => {
    setMenu(null)
    void createDrawing(parent).then((rel) => {
      if (rel && parent) setExpanded((prev) => new Set([...prev, ...prefixesOf(parent)]))
    })
  }
  /** 新建仪表盘(.dashboard.md):同上,创建流程在 amadeusNav.createDashboard。 */
  const newDashboard = (parent: string): void => {
    setMenu(null)
    void createDashboard(parent).then((rel) => {
      if (rel && parent) setExpanded((prev) => new Set([...prev, ...prefixesOf(parent)]))
    })
  }

  /** 拖拽悬停在「合并笔记节点」上 = 拖进它的 .fd(Notion 语义);守卫拖自己/拖回原处/拖进自己子树。 */
  const mergedDragOver = (e: RDragEvent<HTMLElement>, notePath: string, fd: string): void => {
    if (filesDragOver(e, fd)) return
    if (!dragPath) return
    e.stopPropagation()
    if (dragPath === notePath || parentOf(dragPath) === fd) return
    if (isNoteMd(dragPath)) {
      const dfd = fdDirOf(dragPath)
      if (fd === dfd || fd.startsWith(`${dfd}/`)) return // 不能把笔记拖进它自己的子树
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOver !== fd) setDragOver(fd)
  }

  /** 行的悬停提示:笔记/附件 → 文件名 + 修改/创建时间(走主进程 stat)。vault 未就绪则不弹。 */
  const rowTip = (path: string) => (): Promise<TipLines | null> | null =>
    vaultRoot ? fsTipLines(`${vaultRoot}/${path}`, isNotePath(path) ? baseName(path) : path.split(/[\\/]/).pop() ?? path) : null

  /** 在笔记的 .fd 里建子笔记并打开 —— 行内「+」与右键菜单「新建子笔记」的同一落点。 */
  const newChild = (p: string): void => {
    void ps().createChildNote(p, '未命名').then((np) => {
      setExpanded((prev) => new Set([...prev, ...prefixesOf(fdDirOf(p))]))
      void ps().loadPage(np)
    })
  }

  /** 按路径类型打开对的视图。**判定顺序是毁档防线**:白板(.excalidraw.md)/仪表盘(.dashboard.md)/
   *  插件文件类型(如 .mindmap.md)磁盘上也是 .md,进了 openNote 会被 compiler 当页面改写 = 毁档,
   *  所以必须先于「.md = 笔记」判。行点击与多选菜单共用这一份,别再各写一条链。 */
  const openEntry = (path: string, nt?: { newTab?: boolean }): void => {
    const isDraw = isDrawingPath(path)
    const isDash = !isDraw && isDashboardPath(path)
    const ft = !isDraw && !isDash ? findFileType(pluginFileTypes, path) : undefined
    if (ft) openFile(path, nt)
    else if (isDash) openDashboard(path, nt)
    else if (isDraw) openDrawing(path, nt)
    else if (isNotePath(path)) void openNote(path, nt)
    else if (isDbPath(path)) openDb(path, nt)
    else if (isPdfPath(path)) openPdf(path, undefined, nt)
    else if (isImagePath(path)) openImage(path, nt)
    else void amadeus.openVaultFile(path).catch(() => {})
  }

  const row = (path: string, depth = 0, merged?: { fd: string; open: boolean; count: number }): ReactNode => {
    // 白板(.excalidraw.md)磁盘上也是 .md,必须先于「笔记」判定:进了 openNote 会被 compiler 当页面改写=毁档。
    const isDraw = isDrawingPath(path)
    // 仪表盘(.dashboard.md):**是**一份合法笔记,进编辑器也不会坏文件;先判只是为了打开对的那个视图。
    const isDash = !isDraw && isDashboardPath(path)
    // 插件文件类型(如 .mindmap.md):磁盘是 .md 但归插件管,先于「笔记」判定,免进 openNote 被 compiler 改写=毁档。
    const ft = !isDraw && !isDash ? findFileType(pluginFileTypes, path) : undefined
    const isNote = !isDraw && !isDash && !ft && isNotePath(path)
    const ctxKind = isNote || isDash ? 'page' : 'asset'
    // 无 emoji 时的类型兜底图标(md 笔记也有 —— 用户要求)。尺寸由 CSS .t2s-lead-icon 定,勿传 size。
    const LeadIcon = isDbPath(path) ? Database : isDraw ? PenTool : isDash ? LayoutDashboard : isNote ? FileText : isImagePath(path) ? FileImage : Paperclip
    return (
    <button
      key={path}
      ref={(el) => { if (path === flash) flashRef.current = el }}
      className={`t2s-srow${path === (activeViewFile ?? activePage) ? ' active' : ''}${sel.has(path) ? ' sel' : ''}${path === flash ? ' amx-flash' : ''}${path === dragPath ? ' dragging' : ''}${merged && dragPath && dragOver === merged.fd ? ' amx-drop-into' : ''}`}
      data-sel-id={path}
      style={{ paddingLeft: rowPadLeft(depth) }}
      // 统一点击语义(见 views/itemSelect):裸击开、⌘ 开新标签、shift/option 只动选中态。
      onClick={(e) => {
        const act = sel.click(path, e)
        if (act.open === 'none') return
        openEntry(path, act.open === 'new' ? { newTab: true } : undefined)
      }}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation()
        // 右键落在已选中的行上 → 菜单对整批生效;否则改成只选它。
        const ids = sel.batch(path)
        if (ids.length === 1) sel.only(path)
        setMenu(ids.length > 1 ? { kind: 'multi', path, paths: ids, x: e.clientX, y: e.clientY } : { kind: ctxKind, path, x: e.clientX, y: e.clientY })
      }}
      draggable={renaming !== path}
      onDragStart={(e) => {
        // 用元素自身作拖影并按抓取点对齐光标(同会话列表:默认拖影/setState 重渲会让内容与光标错位)。
        const r = e.currentTarget.getBoundingClientRect()
        e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
        e.dataTransfer.effectAllowed = 'move'
        // 拖到聊天区 = 插入 [[笔记]] 引用(树内移动仍靠 dragPath 本地态,多带一个 MIME 不影响)。
        // 拖已选中的行 = 整批(引用与树内移动都按整批走,见 dropTo)。
        setChatRefDrag(e.dataTransfer, sel.batch(path).map((p) => ({ kind: 'note' as const, path: p })))
        setDragPath(path)
      }}
      onDragEnd={() => { setDragPath(null); setDragOver(null) }}
      onDragOver={merged ? (e) => mergedDragOver(e, path, merged.fd) : undefined}
      onDragLeave={merged ? () => { if (dragOver === merged.fd) setDragOver(null) } : undefined}
      onDrop={merged ? (e) => { if (filesDrop(e, merged.fd)) return; e.preventDefault(); e.stopPropagation(); dropTo(merged.fd) } : undefined}
      {...tipProps(rowTip(path))}
    >
      {/* 前导槽:**每行都有**(含文件夹行),故所有图标左边缘对齐、尺寸也一致(见 .t2s-lead)。
          槽内恒显图标(emoji 优先,否则类型兜底图标);**可展开的行 hover 才把图标换成箭头**(用户拍板)。 */}
      <span className="t2s-lead">
        {icons[path]
          ? <span className="amx-page-emoji">{icons[path]}</span>
          : ft?.icon
          ? <span className="amx-page-emoji">{resolveIcon(ft.icon)}</span>
          : <LeadIcon className="t2s-lead-icon t2s-dim" />}
        {merged && (
          <span
            className={`t2s-chev t2s-lead-chev${merged.open ? ' open' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggle(merged.fd) }}
          >
            <ChevronRight size={12} />
          </span>
        )}
      </span>
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
          {ft ? fileTypeBaseName(path, ft.extensions) : isNote || isDraw ? baseName(path) : path.split(/[\\/]/).pop()}
        </span>
      )}
      {/* 行尾顺序:… 在左、+ 在右(同文件夹头);+ 仅笔记有(附件/.db 没有 .fd)。 */}
      <span className="t2s-srow-menu" onClick={(e) => { e.stopPropagation(); setMenu({ kind: ctxKind, path, x: e.clientX, y: e.clientY }) }}>
        <MoreHorizontal size={14} />
      </span>
      {isNote && (
        <span className="t2s-srow-menu" title="新建子笔记" onClick={(e) => { e.stopPropagation(); newChild(path) }}>
          <Plus size={14} />
        </span>
      )}
    </button>
    )
  }

  /** 递归渲染树节点(Obsidian 式嵌套):文件夹头 + 展开的子树,均按 depth 缩进。
   *  拖拽时无论是否可落都 stopPropagation,防止事件冒泡让祖先文件夹误抢落点。 */
  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    if (node.kind === 'file') {
      if (!node.children.length) return row(node.path, depth)
      // 合并笔记节点(X.md 吸收了 X.fd):笔记行带 chevron+计数,展开渲染 .fd 子树;expand key = .fd 路径
      // (面包屑定位的 parentOf/prefixesOf 天然产出同一键,免改)。
      const fd = fdDirOf(node.path)
      const open = expanded.has(fd)
      return (
        <div key={node.path}>
          {row(node.path, depth, { fd, open, count: node.children.filter((c) => c.kind === 'file').length })}
          {open && (
            <div
              className={`t2s-group-sessions${dragPath && dragOver === fd ? ' amx-drop-into' : ''}`}
              onDragOver={(e) => mergedDragOver(e, node.path, fd)}
              onDragLeave={() => { if (dragOver === fd) setDragOver(null) }}
              onDrop={(e) => { if (filesDrop(e, fd)) return; e.preventDefault(); e.stopPropagation(); dropTo(fd) }}
            >
              {node.children.map((c) => renderNode(c, depth + 1))}
            </div>
          )}
        </div>
      )
    }
    const folder = node.path
    const isCol = !expanded.has(folder)
    const fileCount = node.children.filter((c) => c.kind === 'file').length
    const dirCount = node.children.length - fileCount
    const folderDragOver = (e: RDragEvent<HTMLDivElement>): void => {
      if (filesDragOver(e, folder)) return
      if (!dragPath) return
      e.stopPropagation()
      if (parentOf(dragPath) === folder) return // 拖回原文件夹 = 不可落(且不让祖先接手)
      if (isNoteMd(dragPath)) {
        const dfd = fdDirOf(dragPath)
        if (folder === dfd || folder.startsWith(`${dfd}/`)) return // 不能把笔记拖进它自己的 .fd 子树
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dragOver !== folder) setDragOver(folder)
    }
    return (
      <div key={folder}>
        <div
          ref={(el) => { if (folder === flash) flashRef.current = el }}
          className={`t2s-group${folder === flash ? ' amx-flash' : ''}${dragPath && dragOver === folder ? ' amx-drop-into' : ''}`}
          style={{ paddingLeft: folderPadLeft(depth) }}
          {...tipProps(() => [tipT('tip.folder', { files: fileCount, folders: dirCount })])}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ kind: 'folder', path: folder, x: e.clientX, y: e.clientY }) }}
          onDragOver={folderDragOver}
          onDragLeave={() => { if (dragOver === folder) setDragOver(null) }}
          onDrop={(e) => { if (filesDrop(e, folder)) return; e.preventDefault(); e.stopPropagation(); dropTo(folder) }}
        >
          {/* 与笔记行同构:前导槽(图标 ↔ hover 换箭头)+ 名字。展开态靠 FolderOpen/Folder 表达
              —— 箭头默认不显了(用户拍板),没有它就得由图标担起「展开了没」这个信息。 */}
          <button className="t2s-group-toggle t2s-folder-row" onClick={() => toggle(folder)}>
            <span className="t2s-lead">
              {isCol ? <Folder className="t2s-lead-icon" /> : <FolderOpen className="t2s-lead-icon" />}
              <span className={`t2s-chev t2s-lead-chev${isCol ? '' : ' open'}`}><ChevronRight size={12} /></span>
            </span>
            <span className="t2s-group-label">{folderName(folder)}</span>
          </button>
          <button className="t2s-group-add" title="文件夹操作" onClick={(e) => { e.stopPropagation(); setMenu({ kind: 'folder', path: folder, x: e.clientX, y: e.clientY }) }}><MoreHorizontal size={14} /></button>
          <button className="t2s-group-add" title="在此文件夹新建笔记" onClick={() => { setExpanded((prev) => new Set([...prev, ...prefixesOf(folder)])); void ps().createPageInFolder(folder) }}><Plus size={14} /></button>
        </div>
        {/* 展开的文件夹内部(含其中的笔记行)也是该文件夹的落点——与文件管理器语义一致。 */}
        {!isCol && (
          <div
            className={`t2s-group-sessions${dragPath && dragOver === folder ? ' amx-drop-into' : ''}`}
            onDragOver={folderDragOver}
            onDragLeave={() => { if (dragOver === folder) setDragOver(null) }}
            onDrop={(e) => { if (filesDrop(e, folder)) return; e.preventDefault(); e.stopPropagation(); dropTo(folder) }}
          >
            {node.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  // 尾部「笔记树」分区(云端多分区 / 本地 Vault 分区 / 无 Vault 裸树):整体作为一个可排序单元(见 secWrap)。
  const secTreeNode: ReactNode = cloudSections ? (
    <>
      {/* 云端侧:Cloud工作区(非同步Vault部分)+ 每个同步 Vault 一个分区(镜像内容,双向可编辑;
          注册表有名字但镜像还没拉到时也占位显示)。 */}
      <CloudSkipWarn />
      <SideSection id="cloud-ws" defaultOpen label="Cloud工作区">
        {cloudSections.rest.length ? cloudSections.rest.map((n) => renderNode(n, 0)) : <div className="t2s-hint amx-sec-hint">空</div>}
      </SideSection>
      {cloudSections.vaultSecs.map(({ name, node }) => (
        <SideSection key={name} id={`vault:${name}`} defaultOpen label={name}>
          {node && node.children.length
            ? node.children.map((c) => renderNode(c, 0))
            : <div className="t2s-hint amx-sec-hint">{node ? '空' : '同步内容尚未到达'}</div>}
        </SideSection>
      ))}
    </>
  ) : vaultRoot ? (
    // 本地侧:<Vault名> 分区,现有树整体挂其下;分区内空白区保留「拖回根目录」落点。
    <div className="amx-prefs-group">
      <button className="t2s-group-toggle amx-sec-grab" onClick={toggleVault}>
        <span className="t2s-group-name amx-sec-head">
          <span className="t2s-group-label">{baseName(vaultRoot)}</span>
          <span className={`t2s-chev${vaultOpen ? ' open' : ''}`}><ChevronRight size={12} /></span>
        </span>
      </button>
      {vaultOpen && (
        <div
          className={`t2s-group-sessions${dragPath && dragOver === '' ? ' amx-drop-root' : ''}`}
          onDragOver={(e) => {
            if (rootFilesOver(e, '.t2s-srow, .t2s-group')) return
            // 根目录落点:分区内真空白(行/文件夹自己的 handler 已 stopPropagation)。
            if (!dragPath || parentOf(dragPath) === '' || q) return
            if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dragOver !== '') setDragOver('')
          }}
          onDragLeave={() => { if (dragOver === '') setDragOver(null) }}
          onDrop={(e) => {
            if (rootFilesDrop(e, '.t2s-srow, .t2s-group')) return
            if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group')) return
            e.preventDefault()
            dropTo('')
          }}
        >
          {tree.children.map((n) => renderNode(n, 0))}
        </div>
      )}
    </div>
  ) : (
    <>{tree.children.map((n) => renderNode(n, 0))}</>
  )

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
      <aside className="t2s-side amx-tree">
        <div className="t2s-search">
          <Search size={13} className="t2s-dim" />
          <input value={query} placeholder="搜索笔记" onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div
          ref={scrollRef}
          className={`t2s-scroll${dragPath && dragOver === '' ? ' amx-drop-root' : ''}`}
          onClick={(e) => { if (e.target === e.currentTarget) sel.clear() }} // 点空白 = 清选中
          onContextMenu={(e) => {
            // 空白处右键 = 根目录新建。行/文件夹头/顶部特殊按钮各有自己的右键菜单(已 stopPropagation),这里只兜真空白。
            if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group, .t2s-special-group')) return
            if (!vaultRoot) return
            e.preventDefault()
            e.stopPropagation()
            setMenu({ kind: 'root', path: '', x: e.clientX, y: e.clientY })
          }}
          onDragOver={(e) => {
            if (rootFilesOver(e, '.t2s-srow, .t2s-group, .t2s-group-sessions, .t2s-special-group')) return
            // 根目录落点 = 真空白区。行/组/分区上不 preventDefault → 松手即取消,绝不静默搬到根。
            if (!dragPath || parentOf(dragPath) === '' || q) return
            if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group, .t2s-group-sessions, .t2s-special-group')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dragOver !== '') setDragOver('')
          }}
          onDragLeave={() => { if (dragOver === '') setDragOver(null) }}
          onDrop={(e) => {
            if (rootFilesDrop(e, '.t2s-srow, .t2s-group, .t2s-group-sessions, .t2s-special-group')) return
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
                  <span className="t2s-special-ic"><SquarePen /></span>
                  <span className="t2s-special-title">新建笔记</span>
                </button>
                <button className="t2s-special" onClick={() => newDrawing('')}>
                  <span className="t2s-special-ic"><PenTool /></span>
                  <span className="t2s-special-title">新建白板</span>
                </button>
                {/* 「今天」已移除;「Vault」入口移到底部 footer(回收站下方)。 */}
              </div>

              {/* 恢复 Vault 在途(云端首开 GET /vaults+/tree)→ 列表骨架;真没库才提示「打开 Vault」。 */}
              {!vaultRoot && (vaultLoading ? <Skeleton variant="list" /> : <div className="t2s-hint">打开一个 Vault 文件夹开始。</div>)}
              {(() => {
                // 分区节点表:顺序由 orderedSecIds(持久化)决定,包装层提供拖拽排序。
                const secNodes: Record<string, ReactNode> = {
                  pinned: <PinnedSection row={row} dragPath={dragPath} />,
                  cloudsync: vaultSide === 'local' ? <CloudSyncSection dragPath={dragPath} /> : null,
                  shared: <SharedWithMeSection />,
                  prefs: <PrefsSections row={row} pages={pages} />,
                  tree: secTreeNode,
                }
                return orderedSecIds.map((sid) => (secNodes[sid] == null ? null : secWrap(sid, secNodes[sid])))
              })()}
            </>
          )}
        </div>
        {/* 回收站 + Vault 常驻侧栏底部(sticky footer),不随笔记树滚走;Vault 在回收站下方最底。 */}
        <div className="t2s-foot">
          <TrashSection />
          <button
            className="t2s-special"
            onClick={() => (cloudLib ? setCloudPanel(true) : void ps().openVault())}
            title={cloudLib ? '云端笔记库(切换 / 成员 / 分享)' : vaultRoot || undefined}
          >
            <span className="t2s-special-ic"><FolderOpen /></span>
            <span className="t2s-special-title">{cloudLib ? '云端笔记库' : vaultRoot ? `Vault：${baseName(vaultRoot)}` : '打开 Vault'}</span>
          </button>
        </div>
      </aside>

      {/* 多选菜单:只放对整批说得通的两件事。删除逐个走各自的既有流程(笔记要问独占附件,
          附件/其它文件是直接删)—— 别在这儿另写一套删除,那是毁档最容易出事的地方。 */}
      {menu?.kind === 'multi' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => {
            const ps0 = menu.paths ?? []
            setMenu(null)
            for (const p of ps0) openEntry(p, { newTab: true })
          }}><Plus size={13} /> 在新标签页打开 {menu.paths?.length} 项</button>
          <button className="danger" onClick={() => {
            const ps0 = menu.paths ?? []
            setMenu(null)
            if (!window.confirm(`删除选中的 ${ps0.length} 项?`)) return
            void (async () => {
              for (const p of ps0) {
                if (isNotePath(p) && !isDrawingPath(p)) await deleteNoteFlow(p)
                else await ps().deletePage(p)
              }
              sel.clear()
            })()
          }}><Trash2 size={13} /> 删除 {menu.paths?.length} 项</button>
        </OverlayAt>
      )}

      {menu?.kind === 'page' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { void openNote(menu.path, { newTab: true }); setMenu(null) }}><Plus size={13} /> 在新标签页打开</button>
          <button onClick={() => { const p = menu.path; setMenu(null); newChild(p) }}><SquarePen size={13} /> 新建子笔记</button>
          <button onClick={() => startRename(menu.path)}><Pencil size={13} /> 重命名</button>
          <button onClick={() => { useAmadeusPrefs.getState().toggleStar(menu.path); setMenu(null) }}>
            <Star size={13} /> {useAmadeusPrefs.getState().starred.includes(menu.path) ? '取消收藏' : '收藏'}
          </button>
          {window.amadeusSync?.entrySyncEnable && vaultSide === 'local' && (
            isSyncedEntry(vaultRoot, menu.path) ? (
              <button onClick={() => { const p = menu.path; setMenu(null); void window.amadeusSync!.entrySyncDisable!(p) }}><CloudOff size={13} /> 关闭云同步</button>
            ) : (
              <button onClick={() => { const p = menu.path; setMenu(null); openCloudSyncDialog(p, 'page') }}><Cloud size={13} /> 开启云同步</button>
            )
          )}
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); void deleteNoteFlow(p) }}><Trash2 size={13} /> 删除</button>
        </OverlayAt>
      )}
      {menu?.kind === 'asset' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          {isDbPath(menu.path) ? (
            <>
              <button onClick={() => { openDb(menu.path); setMenu(null) }}><Eye size={13} /> 打开</button>
              <button onClick={() => startRename(menu.path)}><Pencil size={13} /> 重命名</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> 用系统程序打开</button>
            </>
          ) : isPdfPath(menu.path) ? (
            <>
              <button onClick={() => { openPdf(menu.path); setMenu(null) }}><Eye size={13} /> 打开(可批注)</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> 用系统程序打开</button>
            </>
          ) : isImagePath(menu.path) ? (
            <>
              <button onClick={() => { openImage(menu.path); setMenu(null) }}><Eye size={13} /> 打开</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> 用系统程序打开</button>
            </>
          ) : isDrawingPath(menu.path) ? (
            <>
              <button onClick={() => { openDrawing(menu.path); setMenu(null) }}><Eye size={13} /> 打开白板</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> 用系统程序打开</button>
            </>
          ) : findFileType(pluginFileTypes, menu.path) ? (
            // 插件声明的文件类型(如 .mindmap.md):在应用内开它自己的视图。掉到下面的兜底就等于
            // 「用系统默认程序打开」——拿 TextEdit 打开一张思维导图。
            <>
              <button onClick={() => { openFile(menu.path); setMenu(null) }}><Eye size={13} /> 打开</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> 用系统程序打开</button>
            </>
          ) : (
            <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><Eye size={13} /> 打开</button>
          )}
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); if (confirmedDelete('file', p)) void ps().deletePage(p) }}><Trash2 size={13} /> 删除</button>
        </OverlayAt>
      )}
      {menu?.kind === 'folder' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setExpanded((prev) => new Set([...prev, ...prefixesOf(menu.path)])); void ps().createPageInFolder(menu.path); setMenu(null) }}><SquarePen size={13} /> 新建笔记</button>
          <button onClick={() => newFolder(menu.path)}><FolderPlus size={13} /> 新建子文件夹</button>
          <button onClick={() => newBase(menu.path)}><Database size={13} /> 新建 Base</button>
          <button onClick={() => newDrawing(menu.path)}><PenTool size={13} /> 新建白板</button>
          <button onClick={() => newDashboard(menu.path)}><LayoutDashboard size={13} /> 新建仪表盘</button>
          {pluginFileCreators.map((o) => (
            <button key={o.item.id} onClick={() => runFileCreator(menu.path, o.item.label, o.item.run)}>
              <span style={{ display: 'inline-flex', width: 13, justifyContent: 'center', fontSize: 13 }}>{resolveIcon(o.item.icon, '📄')}</span> {o.item.label}
            </button>
          ))}
          <button onClick={() => { const f = menu.path; setMenu(null); void askString('重命名文件夹', folderName(f)).then((name) => { const n = name?.trim(); if (n) void ps().renameFolder(f, n) }) }}><Pencil size={13} /> 重命名</button>
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          {window.amadeusSync?.entrySyncEnable && vaultSide === 'local' && (
            isSyncedEntry(vaultRoot, menu.path) ? (
              <button onClick={() => { const f = menu.path; setMenu(null); void window.amadeusSync!.entrySyncDisable!(f) }}><CloudOff size={13} /> 关闭云同步</button>
            ) : (
              <button onClick={() => { const f = menu.path; setMenu(null); openCloudSyncDialog(f, 'folder') }}><Cloud size={13} /> 开启云同步</button>
            )
          )}
          {window.amadeusCollab && (
            <button onClick={() => {
              const f = menu.path
              setMenu(null)
              void window.amadeusCollab!.createPublish('subtree', f)
                .then((s) => navigator.clipboard.writeText(s.url).then(() => useApp.getState().toast('文件夹已发布,公开链接已复制(任何人可只读浏览)')))
                .catch((e) => useApp.getState().toast((e as any)?.code === 'QUOTA' ? ((e as Error).message || '发布页数已达套餐上限') : (e as any)?.status === 404 ? '只有库所有者能发布' : '发布失败', true))
            }}><Share2 size={13} /> 发布此文件夹(公开链接)</button>
          )}
          <button className="danger" onClick={() => { const f = menu.path; setMenu(null); if (confirmedDelete('folder', f)) void ps().deleteFolder(f) }}><Trash2 size={13} /> 删除</button>
        </OverlayAt>
      )}
      {menu?.kind === 'root' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { void ps().createPage(); setMenu(null) }}><SquarePen size={13} /> 新建笔记</button>
          <button onClick={() => newFolder('')}><FolderPlus size={13} /> 新建文件夹</button>
          <button onClick={() => newBase('')}><Database size={13} /> 新建 Base</button>
          <button onClick={() => newDrawing('')}><PenTool size={13} /> 新建白板</button>
          <button onClick={() => newDashboard('')}><LayoutDashboard size={13} /> 新建仪表盘</button>
          {pluginFileCreators.map((o) => (
            <button key={o.item.id} onClick={() => runFileCreator('', o.item.label, o.item.run)}>
              <span style={{ display: 'inline-flex', width: 13, justifyContent: 'center', fontSize: 13 }}>{resolveIcon(o.item.icon, '📄')}</span> {o.item.label}
            </button>
          ))}
        </OverlayAt>
      )}

      {cloudPanel && <CloudVaultPanel onClose={() => setCloudPanel(false)} />}
    </div>
  )
}

// ─────────────────────────────── 主:编辑器(Amadeus 内核 + Tangu 排版) ───────────────────────────────

/** 编辑器需 Amadeus 契约 token → 包 .am-app.tangu-lovable + 镜像 Tangu mode/flat,经 bridge 取色。 */
/** 底部 sheet 里的一条动作(移动端把原顶栏那排 + 「更多操作」菜单全并到这里)。 */
interface AmxAction { id: string; icon: ReactNode; label: string; on?: boolean; danger?: boolean; run: () => void }

/** 软键盘度量:`lift` = 浏览器里被键盘压掉的 visual viewport 高度;`kbHeight()` = 最近一次量到的
 *  键盘高度(键盘收起后仍记着,块面板按它开高,才能「占住键盘的位置」)。
 *  两种环境的键盘表现不同,必须都认:
 *   · 手机浏览器:布局视口不变,只有 visualViewport 变矮 → 差值就是键盘高;
 *   · 安卓 APK(adjustResize):WebView 布局自己变矮,visualViewport 差值≈0 → 只能拿 innerHeight 的
 *     回落量。基线按**屏宽**记,旋转换向时重置,免得横屏被当成「键盘弹起」。 */
function useKeyboardMetrics(): { lift: number; kbHeight: () => number } {
  const [lift, setLift] = useState(0)
  const kbRef = useRef(0)
  const baseRef = useRef({ w: 0, h: 0 })
  useEffect(() => {
    const on = (): void => {
      const b = baseRef.current
      if (b.w !== window.innerWidth) baseRef.current = { w: window.innerWidth, h: window.innerHeight }
      else if (window.innerHeight > b.h) b.h = window.innerHeight
      const vv = window.visualViewport
      const vvLift = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
      const kb = Math.max(vvLift, Math.max(0, baseRef.current.h - window.innerHeight))
      if (kb > 120) kbRef.current = kb // 120 以下是地址栏/手势条之类的抖动,不是键盘
      setLift(vvLift)
    }
    on()
    window.visualViewport?.addEventListener('resize', on)
    window.visualViewport?.addEventListener('scroll', on)
    window.addEventListener('resize', on)
    return () => {
      window.visualViewport?.removeEventListener('resize', on)
      window.visualViewport?.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
    }
  }, [])
  // 从没弹过键盘(一进来就点「+」)→ 按屏高估一个,夹在常见键盘高度区间内。
  const kbHeight = (): number => kbRef.current || Math.min(380, Math.max(240, Math.round(window.innerHeight * 0.42)))
  return { lift, kbHeight }
}

/** 双列块面板:占掉软键盘的位置(Notion 式)。清单 = useAllSlashItems(),与桌面 slash 菜单同一份真源,
 *  插件注册的项自动出现在这里。选中不走「往正文打 /」,直接调最后聚焦那个块的 applySlash —— 因此
 *  模板/图片/数据库/画板那些 sentinel 分支、插件 run() 的返回值校验全都照旧生效。 */
function AmxBlockPicker({ height, onClose }: { height: number; onClose: () => void }) {
  const items = useAllSlashItems()
  const groups = useMemo(() => {
    const m = new Map<string, SlashItem[]>()
    for (const it of items) (m.get(it.group) ?? m.set(it.group, []).get(it.group)!).push(it)
    return [...m]
  }, [items])
  return (
    <div className="amx-bpick" style={{ height }}>
      <div className="amx-bpick-scroll">
        {groups.map(([g, list]) => (
          <Fragment key={g}>
            <div className="amx-bpick-label">{g}</div>
            <div className="amx-bpick-grid">
              {list.map((it) => (
                <button
                  key={it.key}
                  className="amx-bpick-item"
                  onClick={() => { getFocusedBlockApply()?.(it); onClose() }}
                >
                  <span className="amx-bpick-icon">{it.icon}</span>
                  <span className="amx-bpick-name">{it.label}</span>
                </button>
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** 移动端编辑工具栏(触屏才渲染)—— 悬浮胶囊(2026-08-13 用户拍板,Obsidian 式),不再是贴底整条。
 *  - 贴键盘:APK 的 WebView 会自己变矮,胶囊 bottom 天然落在键盘上方;浏览器只压 visual viewport,
 *    故用差值 translateY 顶上去。差值是视口 px,元素在 body zoom 里 → 除以 zoomOf 反补偿(老坑)。
 *  - 按钮一律 onPointerDown preventDefault:不抢编辑器焦点,点工具栏软键盘不塌。
 *  - 「+」:先记下键盘高度再收键盘,块面板正好补上键盘让出的那块地。 */
function AmxMobileBar({ actions, onUpload, undo, redo, sourceMode, onNeedFocus }: {
  actions: AmxAction[]
  onUpload: () => void
  undo: () => void
  redo: () => void
  sourceMode: boolean
  onNeedFocus: () => void
}) {
  const { lift, kbHeight } = useKeyboardMetrics()
  const [sheet, setSheet] = useState(false)
  const [pick, setPick] = useState(0) // 0 = 关;>0 = 面板高度(= 收键盘前量到的键盘高度)
  const barRef = useRef<HTMLDivElement>(null)
  const keep = (e: React.PointerEvent): void => e.preventDefault()
  // lift / pick 都是**视口 px**,而元素活在 body zoom(触屏 1.15)里,写回样式前一律除以 zoom 反补偿。
  const z = barRef.current ? zoomOf(barRef.current) : 1
  const pickLocal = pick ? Math.round(pick / z) : 0
  // 面板开着时键盘已收(lift=0),胶囊改为坐在面板上沿。
  const shift = pickLocal || Math.round(lift / z)
  const openPick = (): void => {
    if (!getFocusedBlockApply()) onNeedFocus() // 还没点进正文过 → 先给个落点,否则选中无处可插
    const h = kbHeight()
    ;(document.activeElement as HTMLElement | null)?.blur?.() // 收键盘,把位置让给面板
    setPick(h)
  }
  return (
    <>
      <div ref={barRef} className="amx-mbar" style={shift ? { transform: `translateY(-${shift}px)` } : undefined}>
        {!sourceMode && (
          <button onPointerDown={keep} onClick={() => (pick ? setPick(0) : openPick())} className={pick ? 'on' : undefined} title="插入块"><Plus size={19} /></button>
        )}
        {!sourceMode && <button onPointerDown={keep} onClick={onUpload} title="上传文件到本页"><Upload size={19} /></button>}
        {!sourceMode && <button onPointerDown={keep} onClick={undo} title="撤销"><Undo2 size={19} /></button>}
        {!sourceMode && <button onPointerDown={keep} onClick={redo} title="重做"><Redo2 size={19} /></button>}
        <button onPointerDown={keep} onClick={() => setSheet(true)} title="更多操作"><MoreHorizontal size={19} /></button>
        <button onClick={() => { setPick(0); (document.activeElement as HTMLElement | null)?.blur?.() }} title="收起键盘"><ChevronsDown size={19} /></button>
      </div>
      {pickLocal > 0 && <AmxBlockPicker height={pickLocal} onClose={() => setPick(0)} />}
      {sheet && (
        <div className="mb-sheet-scrim" onClick={() => setSheet(false)}>
          <div className="mb-sheet" onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div className="mb-sheet-grip" />
            {actions.map((a) => (
              <button
                key={a.id}
                className={`mb-sheet-row${a.danger ? ' danger' : ''}${a.on ? ' on' : ''}`}
                onClick={() => { setSheet(false); a.run() }}
              >
                {a.icon}
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function EditorScope({
  children, dragging, rootRef, onDrop, onDragOver, onDragLeave, onClick, onPaste,
}: {
  children: ReactNode
  dragging?: boolean
  /** 导出 PDF 要克隆的宿主。**必须是真 ref**:此前靠「更多」按钮 onClick 里 `closest('.amx-editor')`
   *  现取,一旦按钮搬出编辑器(移动端底栏胶囊就是),closest 返回 null → exportPdf 静默不干活。 */
  rootRef?: RefObject<HTMLElement | null>
  onDrop?: (e: RDragEvent<HTMLDivElement>) => void
  onDragOver?: (e: RDragEvent<HTMLDivElement>) => void
  onDragLeave?: (e: RDragEvent<HTMLDivElement>) => void
  onClick?: (e: RMouseEvent<HTMLDivElement>) => void
  onPaste?: (e: RClipboardEvent<HTMLDivElement>) => void
}) {
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  return (
    <div
      ref={(el) => { if (rootRef) rootRef.current = el }}
      className={`am-app tangu-lovable amx-pane amx-editor${dragging ? ' amx-dragover' : ''}`}
      data-mode={mode}
      data-flat={flat ? '1' : '0'}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={onClick}
      onPaste={onPaste}
    >
      {children}
    </div>
  )
}

/** 未命名笔记的文件名 sentinel(createPageInFolder=untitled[-N] / createChildNote=未命名[-N]):
 *  标题栏对这些显示为空 + 「New Page」占位(Notion 式),不显示字面「未命名」。 */
/** 可编辑笔记标题 = 文件名(manifest.title 恒取 basename),提交即 renamePage。在编辑器内联改标题。
 *  (封面/图标 chrome 组件 2026-08-13 搬去 @amadeus/chrome/pageChrome:UnifiedPage 也要用,留此即模块环。) */
function NoteTitle() {
  const store = useScopedPageStore() // 改名/设图标要作用在本面板这篇
  const sps = (): ReturnType<typeof store.getState> => store.getState()
  const activePage = usePageStore((s) => s.activePage)
  const manifest = usePageStore((s) => s.manifest)
  const icon = usePageStore((s) => (activePage ? s.icons[activePage] ?? null : null))
  const current = manifest?.title || (activePage ? baseName(activePage) : '')
  const shown = UNTITLED_RE.test(current) ? '' : current // 未命名 → 空,露出 New Page 占位
  const [val, setVal] = useState(shown)
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  // 切换笔记 / 改名后(activePage=newPath)把输入重置为最新标题。
  useEffect(() => { setVal(shown) }, [activePage]) // eslint-disable-line react-hooks/exhaustive-deps
  // 新建笔记:光标落标题栏(Notion 式先命名)。一次性,消费即清。
  // 不再全选文本:整行蓝色选区看着像标题被框了一圈(实报),改为光标落行尾。
  useEffect(() => {
    const target = sps().focusTitleFor
    if (!target) return
    if (target === activePage) {
      const el = ref.current
      if (el) {
        el.focus()
        const n = el.value.length
        el.setSelectionRange(n, n)
      }
    }
    sps().consumeTitleFocus()
  }, [activePage])
  const commit = (): void => {
    const next = val.trim()
    if (next && next !== current) void sps().renamePage(next)
    else setVal(shown)
  }
  const cover = useActiveCover()
  const [coverPick, setCoverPick] = useState<{ x: number; y: number } | null>(null)
  return (
    <div className="amx-title-wrap">
      {icon && (
        <button
          className="amx-title-bigicon"
          title="更换/移除页面图标"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setPick({ x: r.left, y: r.bottom + 6 })
          }}
        >
          {icon}
        </button>
      )}
      {activePage && (!icon || !cover) && (
        <div className="amx-title-actions">
          {!icon && (
            <button onClick={() => void sps().setPageIcon(activePage, randomEmoji())}>☺ 添加图标</button>
          )}
          {!cover && (
            <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCoverPick({ x: r.right, y: r.bottom + 6 }) }}>🖼 添加封面</button>
          )}
        </div>
      )}
      <div className="amx-title-row">
        <input
          ref={ref}
          className="amx-title-input"
          value={val}
          placeholder="New Page"
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // 标题 → 正文:回车 / 光标已在末尾再按 →↓ 都进正文(blur 触发 commit 改名;空正文则建首块)。
            const el = e.currentTarget
            const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
            if (e.key === 'Enter' || ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && atEnd)) {
              // 必须先 focusBody 再 blur:blur→commit→renamePage 会同步快照 manifest 并在返回时回填,
              // 顺序反了则空正文刚建的首块会被这次回填冲掉(光标也就无处可落)。
              e.preventDefault(); focusBody(store); el.blur()
            }
            if (e.key === 'Escape') { setVal(shown); el.blur() }
          }}
        />
      </div>
      {pick && activePage && (
        <IconPicker
          x={pick.x}
          y={pick.y}
          current={icon}
          onPick={(em) => {
            void sps().setPageIcon(activePage, em)
            setPick(null)
          }}
          onClose={() => setPick(null)}
        />
      )}
      {coverPick && activePage && <CoverPicker page={activePage} x={coverPick.x} y={coverPick.y} onClose={() => setCoverPick(null)} />}
    </div>
  )
}

/** 最近的可滚动祖先(源码模式的 textarea 自己撑全高,滚的是外层容器)。 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

/** 源码模式 = 真实 .md 文件:frontmatter(amadeus_page/schema/layout)+ `<!-- a id -->` 块标记 + 内容,
 *  经 compile() 呈现、parsePageSource() 往返(保留块与 2D 布局;标记只由 <!-- a id --> 切分)。
 *  失焦提交(仅在真正改动时);破坏 frontmatter 则退化为外部单块(优雅降级,不丢内容)。 */
function SourceEditor() {
  // 本面板那份 store。⚠️ commit() 挂在失焦上,而失焦最常见的原因就是**用户点了另一半屏** ——
  // 用 usePageStore.getState()(=活动面板)会把源码模式的内容 _commit 进隔壁那篇笔记。
  const store = useScopedPageStore()
  const scope = usePageScope()
  const sps = (): ReturnType<typeof store.getState> => store.getState()
  const readSrc = (): string => {
    const m = sps().manifest
    if (!m) return ''
    const contents: Record<string, string> = {}
    for (const [id, b] of Object.entries(sps().blocks)) contents[id] = b.content
    return compile(m, contents)
  }
  const [src, setSrc] = useState(readSrc)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const grow = (): void => { const el = taRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }
  useEffect(grow, [src])

  // 光标接力(见 amadeus/lib/modeCursor):
  //  · 进来:把可视端交接的「块 + 锚点」翻译成本文本域的字符下标,落焦并滚到视野内;
  //  · 出去:反向登记一份,PageView 挂载时把光标送回对应的块。
  //  ⚠️ 登记写在卸载清理里,读的是 ref 里的最新值 —— 不能依赖 state 闭包(切换时那份已经过期)。
  const srcRef = useRef(src)
  srcRef.current = src
  // 卸载时 taRef 可能已被 React 置空,拿不到选区 → 随手记一份最新的,清理函数只读这个 ref。
  const caretRef = useRef(0)
  useEffect(() => {
    const el = taRef.current
    const cur = takeModeCursor(scope)
    if (el && cur) {
      const at = sourceOffsetFor(srcRef.current, cur)
      if (at >= 0) {
        el.focus()
        el.setSelectionRange(at, at)
        caretRef.current = at
        // textarea 被 grow() 撑成全高,真正滚动的是外层容器 → 按行号估 y,把那行带到视野中间。
        const line = srcRef.current.slice(0, at).split('\n').length - 1
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
        const sc = scrollParent(el)
        if (sc) sc.scrollTop = Math.max(0, el.offsetTop + line * lh - sc.clientHeight / 2)
      }
    }
    return () => setModeCursor(cursorFromSource(srcRef.current, caretRef.current), scope)
  }, [])
  const commit = (): void => {
    const page = sps().activePage
    if (!page || src === readSrc()) return
    const parsed = parsePageSource(page, src, new Date().toISOString())
    sps()._commit(parsed.manifest, parsed.blocks)
  }
  return (
    <textarea
      ref={taRef}
      className="amx-source"
      value={src}
      spellCheck={false}
      onChange={(e) => { caretRef.current = e.target.selectionStart; setSrc(e.target.value) }}
      onSelect={(e) => { caretRef.current = e.currentTarget.selectionStart }}
      onBlur={commit}
    />
  )
}

// 插件状态条项:2026-07-23 起渲染进全局状态栏(pluginStatusBridge)——engine 有全局状态栏了,
// 原「就近呈现在编辑器工具条」的 PluginStatusItems shim 退役。

// (原 lastActiveEditorLeafId 已随「单活文档」一起退役:现在「哪个面板认领这次导航」
//  由 pageStore 的活动作用域决定,见 setActivePageScope。)

/**
 * 分屏的地基:每个编辑器面板挂自己的文档作用域(scope = leaf id),里面所有 usePageStore(...)
 * 都解析到**本面板**那份 store。此前是全局单例,两个面板并排必然显示同一篇,非活动的那个只能
 * 渲染占位("stale") —— 那就是用户报的「不能分屏」。
 * 拆成外壳 + Inner 是必须的:Provider 只影响**后代**,组件自己的 hook 调用在 Provider 之外。
 */
export function AmadeusEditorView(props: ViewProps) {
  return (
    <PageScopeCtx.Provider value={props.leaf.id}>
      <AmadeusEditorViewInner {...props} />
    </PageScopeCtx.Provider>
  )
}

function AmadeusEditorViewInner({ leaf }: ViewProps) {
  // 本面板自己的 store(静态取值用;hook 取值经 Provider 自动解析)。
  const myStore = useScopedPageStore()
  const myPs = (): ReturnType<typeof myStore.getState> => myStore.getState()
  const activePage = usePageStore((s) => s.activePage)
  const vaultRoot = usePageStore((s) => s.vaultRoot) // 无笔记时的空态引导据此二态(未开 Vault / 已开待新建)
  const pendingPage = usePageStore((s) => s.pendingPage)
  const loadError = usePageStore((s) => s.error)
  // 插件文件类型也占用全局 activePage(单活页模型)→ 认领时须能认出「这不是笔记」,见下面的 useEffect。
  const pluginFileTypes = usePluginStore((s) => s.fileTypes)
  // 模式在 uiOverlayStore(供命令面板「切换 源码/可视」),不再是组件内 state。
  const mode = useUiOverlay((s) => s.editorMode)
  const [dragging, setDragging] = useState(false)
  // 兜底收虚线框:拖拽在别处松手 / Esc 取消 / 拖出窗口,本容器的 dragleave 未必来得及。
  useEffect(() => {
    if (!dragging) return
    const clear = (): void => setDragging(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [dragging])
  // 笔记多功能菜单(Obsidian 式右上角 ⋮):导出/收藏/定位/删除。
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null)
  const [shareCard, setShareCard] = useState<{ x: number; y: number } | null>(null) // 共享/发布卡片(web/桌面 collab)
  const [shareVer, setShareVer] = useState(0) // ShareCard 关闭后 bump → 状态指示重新拉取
  const printHostRef = useRef<HTMLElement | null>(null) // 本编辑器实例的 EditorScope 根(分屏下导出各自的)
  const uploadInputRef = useRef<HTMLInputElement>(null) // 「上传文件」按钮的隐藏 <input type=file>
  // 订阅整个数组:star/pin 的判定路径要等 barPath(unified 笔记不设 activePage)在下面算出来。
  const starredArr = useAmadeusPrefs((s) => s.starred)
  const pinsArr = useAmadeusPrefs((s) => s.pins)
  // 云同步按钮(图钉右侧,仅桌面本地侧):点亮=本笔记已是显式同步条目;点击开启走关联勾选弹窗,再点关闭。
  const vaultSide = usePageStore((s) => s.vaultSide)
  useEntrySync((s) => s.vaults) // 订阅注册表变更驱动重渲(isSyncedEntry 读 getState)
  useEffect(() => { ensureEntrySyncSubscribed() }, [])
  const canEntrySync = !!window.amadeusSync?.entrySyncEnable && vaultSide === 'local'
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
    const page = myPs().activePage ?? barPath // unified 笔记 activePage 恒空,文件名取 barPath
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
  // 先跳转后加载:面板已认领笔记但内容未就绪(pendingPage 在途,或挂载首帧 effect① 还没发起加载)
  // → 文档骨架屏。此前这个窗口期亮的是「欢迎页」(fresh 面板)或旧笔记,云端慢网下就是「点了没反应」。
  const loadingNote = (!!pendingPage && pendingPage !== activePage) || (!!notePath && !loadError && notePath !== activePage)

  // ── v4 绞杀者路由(spec §9 step 3 Phase A):先读原文按 fm 分类,素文件/外来 md/v4 →
  // UnifiedPage(统一实例),v3 标记文件 → 下面的 PageView 老路。分类必须**先于** effect ①:
  // 外来 md 一旦进了 pageStore,首次防抖保存就会把它改写成 v3(注 amadeus_page+标记)= 毁档类。
  // route 以 forPath 配对防陈旧:快速切换笔记时,旧文件的分类绝不套在新路径上。
  const [route, setRoute] = useState<{ forPath: string; decision: RouteDecision } | null>(null)
  useEffect(() => {
    if (!notePath) {
      setRoute(null)
      return
    }
    let alive = true
    void (async () => {
      const raw = await amadeus.readTextFile(notePath).catch(() => null)
      if (!alive) return
      setRoute({ forPath: notePath, decision: routeNote(notePath, raw, upgradeV4Enabled(), new Date().toISOString()) })
    })()
    return () => { alive = false }
  }, [notePath])
  const routed = route && route.forPath === notePath ? route.decision : null
  const unifiedRoute = routed?.editor === 'unified' ? routed : null

  // 顶栏/菜单/移动端胶囊的「当前笔记」:v3 = activePage;unified 不设 activePage,用 leaf 认领的路径。
  const barPath = activePage ?? (unifiedRoute && notePath ? notePath : null)
  const starred = !!barPath && starredArr.includes(barPath)
  const pinned = !!barPath && pinsArr.includes(barPath)
  const synced = canEntrySync && !!barPath && isSyncedEntry(myPs().vaultRoot, barPath)

  // unified 接管 → 让 pageStore 交出本文件的快照(新建流/装载残留):陈旧快照×reconcile 回写
  // =延时毁档链,见 pageStore.releasePage 注释。
  useEffect(() => {
    if (unifiedRoute && notePath) void myPs().releasePage(notePath)
  }, [unifiedRoute, notePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // 恢复的 tab 一挂载就有笔记名(不必等激活)。
  useEffect(() => { if (notePath) leaf.setTitle(baseName(notePath)) }, [notePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // ⓪ 移动端「Space 记住上次打开的页面」:单列壳切 Space 走 resetLayout 重建(无布局持久化),
  //    notePath 随布局一起被清 → 用下面 useEffect 落的「每库最后一次打开的笔记」回填。
  //    桌面端 dockview 布局自带 notePath 还原,不掺和(空参编辑器 = 刻意的欢迎页)。
  useEffect(() => {
    if (UI_MODE !== 'mobile' || notePath) return
    const tryRestore = (): boolean => {
      const st = myPs()
      if (!st.vaultRoot) return false // vault 未就绪(启动预热在途)→ 订阅等它
      let last: string | null = null
      try { last = localStorage.getItem(`amx.lastNote:${st.vaultRoot}`) } catch { /* ignore */ }
      if (last && st.pages.includes(last)) leaf.setParams({ ...leaf.params, notePath: last })
      return true // vault 就绪即完结(没有可还原目标也算完,停在欢迎页)
    }
    if (tryRestore()) return
    const unsub = myStore.subscribe((s) => { if (s.vaultRoot && tryRestore()) unsub() })
    return unsub
  }, [notePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // 记住每库最后打开的笔记(移动端 Space 重建后回填的数据源;桌面端只写不读)。
  useEffect(() => {
    if (!notePath) return
    const vr = myPs().vaultRoot
    if (vr) { try { localStorage.setItem(`amx.lastNote:${vr}`, notePath) } catch { /* ignore */ } }
  }, [notePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // ① 本面板认领的笔记 ≠ 本面板 store 里的笔记 → 装载它。**与是否活动无关** —— 这正是分屏的关键:
  //    并排的两个面板各装各的,不再互相覆盖。
  //    ⚠️ 严格等分类落定且判为 'block' 才装(routed 为 null=分类在途也不装):unified 文件
  //    绝不进 v3 编译管线,分类不明时宁可多等一帧骨架屏(数据安全>首帧)。
  useEffect(() => {
    if (notePath && routed?.editor === 'block' && notePath !== myPs().activePage) void myPs().loadPage(notePath)
  }, [notePath, routed]) // eslint-disable-line react-hooks/exhaustive-deps

  // ② 活动面板跟随激活:侧栏/命令面板/快切这些编辑器**之外**的入口读的是「活动面板」那份 store,
  //    所以点开一篇笔记会落进当前聚焦的这个面板,而不是隔壁。
  useEffect(() => {
    if (isActiveLeaf) setActivePageScope(leaf.id)
    prevActiveRef.current = isActiveLeaf
  }, [isActiveLeaf, leaf.id])

  // ③ 本面板内发生导航(在活动状态下被 openNote 装了新笔记)→ 认领它(写回 params + 标题)。
  //    插件文件类型(如 .mindmap.md)也会占用 activePage,但它绝不是笔记 → 不认领,
  //    否则本 leaf 的 notePath 被改写成它,再激活就把导图当笔记用 PageView 渲染/编辑(Codex)。
  useEffect(() => {
    if (!activePage || activePage === notePath) return
    if (findFileType(pluginFileTypes, activePage) || isDashboardPath(activePage)) return
    leaf.setParams({ ...leaf.params, notePath: activePage })
    leaf.setTitle(baseName(activePage))
  }, [activePage]) // eslint-disable-line react-hooks/exhaustive-deps

  // ④ 面板关掉 → 回收它那份 store(内部先 flush 落盘,不带走没写完的改动)。
  useEffect(() => () => disposePageScope(leaf.id), [leaf.id])

  // 侧栏笔记行拖进编辑器 → 追加 [[链接]] 块。链接一律路径限定形态([[dir/Name|Name]]):
  // resolvePageName 对带路径名不做同名回退,重名笔记也指向唯一目标;根目录笔记只能裸名(天花板:
  // 与当前页同夹的同名笔记会优先命中,极罕见)。会话/工作区文件引用与笔记语义不兼容,编辑器不收。
  const noteWikiInner = (rel: string): string => {
    const link = rel.replace(/\.md$/i, '')
    const base = link.split(/[\\/]/).pop() || link
    return link === base ? link : `${link}|${base}`
  }
  // 拖入文件 → 按 Tangu 笔记设置存放(attachments/同目录/固定夹)→ 预览开则插 ![[base]],否则插 [名](相对路径)。
  const onDrop = async (e: RDragEvent<HTMLDivElement>): Promise<void> => {
    setDragging(false) // ⚠️必须在任何 early return 之前:落个不认识的东西也得把虚线框收掉
    // 树行拖源对一切叶子(含图片/PDF/.db 附件)都打 kind:'note' —— 按真实类型分流:
    // .md → [[链接]];非笔记 → ![[嵌入]](与 OS 文件拖入 importToPage 的语义一致,评审 P1)。
    const treeRefs = readChatRefs(e.dataTransfer).filter((r) => r.kind === 'note')
    if (treeRefs.length) {
      e.preventDefault()
      const ps = myPs()
      if (!ps.activePage) return
      ps.insertBlocksAfter(null, treeRefs.map((r) => (isNotePath(r.path) ? `[[${noteWikiInner(r.path)}]]` : `![[${r.path}]]`)))
      return
    }
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    // unified 笔记不走 pageStore:文件经 lifecycle 递给 UnifiedPage(存附件+光标处插 ![[base]];
    // 此前事件被 preventDefault 后静默吞掉,Codex 终审 P1)。
    if (unifiedRoute && notePath && insertFilesForPath(notePath, files)) return
    const page = myPs().activePage
    if (!page) return
    await importToPage(files, page) // 存到配置的附件位置 + 插入嵌入/链接(本地/云端/web 统一;失败与超限走 toast)
  }
  const onDragOver = (e: RDragEvent<HTMLDivElement>): void => {
    const types = Array.from(e.dataTransfer?.types ?? [])
    // 只认 REF_MIME(笔记/会话引用),不吃 PATHS_MIME:工作区文件的绝对路径写进笔记没有意义。
    const refDrag = types.includes(REF_MIME)
    if (!types.includes('Files') && !refDrag) return
    e.preventDefault()
    if (refDrag && e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    if (!dragging) setDragging(true)
  }
  /** ⚠️ 判据必须是「指针去了本容器之外」而不是「事件打在容器本身」:后者在指针从子元素
   *  (块、图片、表格)离开时压根不触发 → 虚线框留在屏幕上不走,就是用户报的「莫名其妙的一圈虚线」。 */
  const onDragLeave = (e: RDragEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }
  // 关预览的附件是 [名](相对路径);点击其渲染的 <a>(href=原始相对路径)在系统默认程序打开。
  const onClick = (e: RMouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a || a.classList.contains('wikilink')) return
    const href = a.getAttribute('href') || ''
    if (!href || /^(https?:|mailto:|amadeus-asset:|#)/i.test(href)) return
    e.preventDefault()
    const page = myPs().activePage ?? barPath // unified 笔记 activePage 恒空(审计:附件点击死路)
    if (page) void amadeus.openAttachment(page, href)
  }
  // 粘贴图片(Cmd/Ctrl+V 截图)→ 存 .amadeus/ 并按页相对路径嵌入。标题/重命名输入框放行,
  // 某块已自行处理(defaultPrevented)也放行;正文块粘贴图片才拦。
  const onPaste = (e: RClipboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented) return
    if ((e.target as HTMLElement).closest('input, textarea, .t2s-rename')) return
    const imgs = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (!imgs.length) return
    e.preventDefault()
    const page = myPs().activePage
    if (page) void pasteImagesToPage(imgs, page)
  }

  // 原来这里有个 `stale` 分支:非活动的分屏面板渲染一个「点击加载」占位,因为全局只有一份文档。
  // 每个面板自持一份之后没有这个概念了 —— 两边都是真的、都能编辑。

  return (
    <>
    <EditorScope rootRef={printHostRef} dragging={dragging} onDrop={(e) => void onDrop(e)} onDragOver={onDragOver} onDragLeave={onDragLeave} onClick={onClick} onPaste={onPaste}>
      {/* ⚠️ 上传用的隐藏 input **必须住在顶栏外面**:移动端整条顶栏不渲染,而底栏胶囊的「上传」
          仍旧 uploadInputRef.current?.click() —— 留在顶栏里 = 手机上 ref 恒 null,上传静默失效。 */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = ''
          if (!files.length) return
          if (unifiedRoute && notePath && insertFilesForPath(notePath, files)) return // unified:经 lifecycle 递入
          const page = myPs().activePage
          if (page) void importToPage(files, page)
        }}
      />
      {/* 顶栏(路径 + 右侧动作)只在桌面渲染。移动端整行隐去,动作全并进底栏胶囊的「⋯」
          (用户拍板 2026-08-13)。这里用 JSX 门而不是 CSS media:`.amx-toolbar` 还被
          AmadeusDashboardView 用着,CSS 一刀切会连仪表盘的顶栏(含「解锁编辑」)一起藏掉。 */}
      {barPath && !isCoarsePointer() && (
        // 顶栏与编辑器融为一体:实色纸面底(var(--bg)),滚动时正文从其后穿过被遮住(见 CSS)。
        <div className="amx-toolbar">
          <Breadcrumb path={barPath} />
          {window.amadeusCollab && <ShareStatus path={barPath} refreshKey={shareVer} onOpen={(x, y) => setShareCard({ x, y })} />}
          {/* 置顶图钉:写 amadeusPrefs(每 vault localStorage),侧边栏「置顶」分区同步点亮。 */}
          <button
            className={`amx-mode-btn amx-pin-btn${pinned ? ' amx-pin-on' : ''}`}
            title={pinned ? '取消置顶' : '置顶'}
            onClick={() => useAmadeusPrefs.getState().togglePin(barPath)}
          >
            <Pin size={14} />
          </button>
          {canEntrySync && (
            <button
              className={`amx-mode-btn amx-pin-btn${synced ? ' amx-pin-on' : ''}`}
              title={synced ? '关闭云同步(云端副本保留)' : '开启云同步'}
              onClick={() => {
                if (synced) void window.amadeusSync?.entrySyncDisable?.(barPath)
                else openCloudSyncDialog(barPath, 'page')
              }}
            >
              <Cloud size={14} />
            </button>
          )}
          {window.amadeusCollab && <PresenceDots />}
          {window.amadeusCollab && (
            <button
              className="amx-mode-btn"
              title="共享 / 发布"
              onClick={(e) => {
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                setShareCard({ x: r.right, y: r.bottom })
              }}
            >
              <Share2 size={14} />
            </button>
          )}
          <button
            className="amx-mode-btn"
            onClick={() => useUiOverlay.getState().toggleEditorMode()}
            title={mode === 'source' ? '切换到可视编辑(所见即所得)' : '切换到源码 Markdown'}
          >
            {mode === 'source' ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          {activePage && (
            <button
              className="amx-mode-btn"
              title="上传文件到本页"
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload size={14} />
            </button>
          )}
          <button
            className="amx-mode-btn amx-more-btn"
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setNoteMenu({ x: Math.max(8, Math.min(r.right - 180, window.innerWidth - 196)), y: r.bottom + 4 })
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      )}
      {noteMenu && barPath && (
        <OverlayAt className="ctx-menu" x={noteMenu.x} y={noteMenu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setNoteMenu(null); void exportPdf() }}><FileDown size={13} /> 导出为 PDF</button>
          <button onClick={() => { useAmadeusPrefs.getState().toggleStar(barPath); setNoteMenu(null) }}>
            <Star size={13} /> {starred ? '取消收藏' : '收藏'}
          </button>
          <button onClick={() => { void amadeus.revealInFileManager(barPath); setNoteMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const p = barPath; setNoteMenu(null); void deleteNoteFlow(p, myPs) }}>
            <Trash2 size={13} /> 删除笔记
          </button>
        </OverlayAt>
      )}
      {shareCard && barPath && (
        <ShareCard path={barPath} anchor={shareCard} onClose={() => { setShareCard(null); setShareVer((v) => v + 1) }} />
      )}
      {unifiedRoute && notePath ? (
        /* v4 统一实例编辑器:不碰 pageStore(activePage 不设),故必须排在骨架屏判定之前。
           页面 chrome(封面/图标/标题/属性)在 UnifiedPage 内部;顶栏/菜单走上面的 barPath 门。 */
        <UnifiedPage
          key={notePath}
          path={notePath}
          initial={unifiedRoute.initial}
          diskRaw={unifiedRoute.diskRaw}
          onRenamed={(np) => {
            leaf.setParams({ ...leaf.params, notePath: np })
            leaf.setTitle(baseName(np))
            retargetEditorLeaves(notePath, np) // 其他标签开着同一篇:一并换参(它们的实例已被退休)
          }}
        />
      ) : loadingNote ? (
        <Skeleton variant="document" />
      ) : !activePage ? (
        notePath && loadError ? (
          <div className="amx-welcome">
            <div className="amx-welcome-title">📓 笔记加载失败</div>
            <p className="amx-welcome-sub">{loadError}</p>
            <div className="amx-welcome-actions">
              <button className="amx-welcome-btn" onClick={() => { if (notePath) void myPs().loadPage(notePath) }}>重试</button>
            </div>
          </div>
        ) : (
        <div className="amx-welcome">
          <div className="amx-welcome-title">📓 Amadeus 笔记</div>
          <p className="amx-welcome-sub">
            {vaultRoot
              ? '从左栏选一篇笔记开始,或新建一篇。'
              : '把任意文件夹选作你的笔记库(Vault)就能开写 —— 所见即所得,像 Obsidian 一样用双链把想法连起来。'}
          </p>
          <div className="amx-welcome-actions">
            {vaultRoot ? (
              <button className="amx-welcome-btn" onClick={() => void myPs().createPage()}><SquarePen size={16} /> 新建笔记</button>
            ) : (
              <button className="amx-welcome-btn" onClick={() => void myPs().openVault()}><FolderOpen size={16} /> 打开 Vault 文件夹</button>
            )}
          </div>
          <ul className="amx-welcome-tips">
            <li><span className="amx-kbd">[[</span> 引用其它笔记,自动生成反向链接</li>
            <li><Paperclip size={13} /> 拖入图片 / 文件直接插入;支持数据库块、LaTeX、代码高亮</li>
            <li><Code2 size={13} /> 顶栏切「可视 / 源码」,右上角 ⋮ 可导出 PDF</li>
          </ul>
        </div>
        )
      ) : mode === 'source' ? (
        <SourceEditor key={activePage} />
      ) : (
        <>
          <NoteCover />
          <div className="amx-doc"><NoteTitle /><AmadeusPropertiesPanel /></div>
          <PageView bare />
        </>
      )}
    </EditorScope>
    {/* 移动端底部编辑胶囊 + 块面板 + 动作 sheet:EditorScope(.amx-pane)自身是滚动容器,
        这些必须做它的**兄弟**(mb-view 是 flex 列)才不会跟着正文滚。
        ⚠️ 门里**没有** `mode !== 'source'`:顶栏在移动端整行隐掉后,「切回可视编辑」只剩这条胶囊
        的「⋯」一个出口,源码模式下再把胶囊也撤了 = 用户永远回不去(只能靠命令面板)。 */}
    {isCoarsePointer() && barPath && !loadingNote && (
      <AmxMobileBar
        sourceMode={mode === 'source'}
        onUpload={() => uploadInputRef.current?.click()}
        undo={() => { if (activePage) myPs().undo() }}
        redo={() => { if (activePage) myPs().redo() }}
        onNeedFocus={() => { if (activePage) focusBody(myStore) }}
        actions={[
          { id: 'mode', icon: mode === 'source' ? <Eye size={16} /> : <Code2 size={16} />, label: mode === 'source' ? '切换到可视编辑' : '切换到源码 Markdown', run: () => useUiOverlay.getState().toggleEditorMode() },
          ...(activePage ? [{ id: 'upload', icon: <Upload size={16} />, label: '上传文件到本页', run: () => uploadInputRef.current?.click() }] : []),
          { id: 'pin', icon: <Pin size={16} />, label: pinned ? '取消置顶' : '置顶', on: pinned, run: () => useAmadeusPrefs.getState().togglePin(barPath!) },
          { id: 'star', icon: <Star size={16} />, label: starred ? '取消收藏' : '收藏', on: starred, run: () => useAmadeusPrefs.getState().toggleStar(barPath!) },
          ...(canEntrySync ? [{ id: 'sync', icon: <Cloud size={16} />, label: synced ? '关闭云同步(云端副本保留)' : '开启云同步', on: synced, run: () => { if (synced) void window.amadeusSync?.entrySyncDisable?.(barPath!); else openCloudSyncDialog(barPath!, 'page') } }] : []),
          ...(window.amadeusCollab ? [{ id: 'share', icon: <Share2 size={16} />, label: '共享 / 发布', run: () => setShareCard({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) }] : []),
          { id: 'pdf', icon: <FileDown size={16} />, label: '导出为 PDF', run: () => void exportPdf() },
          { id: 'reveal', icon: <FolderOpen size={16} />, label: '在文件管理器中显示', run: () => void amadeus.revealInFileManager(barPath!) },
          { id: 'delete', icon: <Trash2 size={16} />, label: '删除笔记', danger: true, run: () => void deleteNoteFlow(barPath!, myPs) },
        ]}
      />
    )}
    </>
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
