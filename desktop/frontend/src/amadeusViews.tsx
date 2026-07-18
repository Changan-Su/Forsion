/** Amadeus Space 的引擎视图 —— 外壳用 Tangu 原生 UI 重建(复刻侧栏 t2s- 视觉 + base.css 的 .ctx-menu),
 *  只复用 Amadeus 的数据层(pageStore)与块编辑器内核(PageView/Milkdown)。
 *  左 笔记库 / 主 编辑器 / 右 大纲·反链。除编辑器(块组件用 Amadeus 契约 token,需 .am-app+bridge)外,
 *  外壳直接用 Tangu token/类 → 与 Tangu Desktop 一致,并随其换肤/明暗同步。 */
import { type ReactNode, type CSSProperties, type DragEvent as RDragEvent, type MouseEvent as RMouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  SquarePen, FolderOpen, Folder, FolderPlus, Plus, MoreHorizontal, Pencil, Trash2,
  ChevronRight, Search, Code2, Eye, Star, Paperclip, FileDown,
  Database, ExternalLink, FileText, Share2, Cloud, CloudOff, Pin, PenTool,
} from 'lucide-react'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { useUiOverlay } from './amadeusOverlayStore'
import { amadeus } from '@amadeus/api'
import { getAttachmentPrefs } from '@amadeus/lib/attachments'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { ensureAmadeusReady } from './amadeusPlugins'
import { AmadeusPropertiesPanel } from './amadeusProperties'
import { useAmadeusPrefs } from './amadeusPrefs'
import type { TrashEntry } from '@amadeus-shared/ipc'
import type { AmadeusSyncStatus } from './types'
import { openNote, openDb, openPdf, openDrawing, createDrawing, openSearch } from './amadeusNav'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { useSearchSeed } from './amadeusPanels'
import { askString } from '@amadeus/components/askString'
import { parseFmObject } from '@amadeus-shared/db/pageFrontmatter'
import { joinRel, toAssetUrl } from '@amadeus-shared/assets'
import { renameDb } from '@amadeus/lib/dbFileOps'
import { emptyDb, serializeDb } from '@amadeus-shared/db/schema'
import { useRecentViews } from './recentViews'
import { buildTree, mergeFdNotes, type TreeNode } from '@amadeus/lib/pageTree'
import { fdDirOf, isNoteMd } from '@amadeus/lib/fd'
import { useSectionOpen } from '@amadeus/lib/sectionOpen'
import { folderPadLeft, rowPadLeft } from '@amadeus/lib/treeIndent'
import { compile, parsePageSource } from '@amadeus-shared/compiler'
import { recordNav, useWorkspace, activeMainPanel } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { PageView, focusBody } from '@amadeus/components/PageView'
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

interface Ctx { kind: 'page' | 'folder' | 'asset' | 'root'; path: string; x: number; y: number }

const isNotePath = (p: string): boolean => /\.md$/i.test(p)
const isDbPath = (p: string): boolean => /\.db$/i.test(p)
const isPdfPath = (p: string): boolean => /\.pdf$/i.test(p)
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
        <button className="t2s-group-toggle" onClick={toggle}>
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
          <button className="t2s-group-toggle" onClick={toggleColl}>
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
      <div className="t2s-hint" style={{ padding: '2px 10px 2px', fontSize: 11.5 }}>与我共享</div>
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
      <button className="t2s-group-toggle" onClick={toggle}>
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
  // 云端笔记库入口:web(无 amadeusSync)恒显示;桌面仅云端模式显示,本地模式给本地 Vault 选择器。
  const cloudLib = !window.amadeusSync || vaultSide === 'cloud'

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set()) // 文件夹默认全折叠
  const [cloudPanel, setCloudPanel] = useState(false) // web:云端库面板(切换/成员/分享)
  const [dragPath, setDragPath] = useState<string | null>(null) // 正在拖动的笔记
  const [dragOver, setDragOver] = useState<string | null>(null) // 悬停的目标文件夹('' = 根)
  const [menu, setMenu] = useState<Ctx | null>(null)
  // 本地侧 <Vault名> 分区:树就在里面 → **唯一默认展开**的分区(用户点名);手动折叠仍会被记住。
  const [vaultOpen, toggleVault] = useSectionOpen('vault', true)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const nav = useAmadeusNav((s) => s.locate)
  const [flash, setFlash] = useState<string | null>(null)
  const flashRef = useRef<HTMLElement | null>(null)

  // 首次挂载装插件(builtins 子集 + 外部插件)+ 恢复上次 Vault + 订阅外部文件变更。
  useEffect(() => {
    ensureAmadeusReady()
    const offExt = amadeus.onExternalChange?.((p) => void ps().reconcileExternal(p))
    const offStruct = amadeus.onStructureChange?.(() => void ps().refreshStructure())
    return () => { offExt?.(); offStruct?.() }
  }, [])
  // 按条目云同步注册表:订阅一次 + 切库时重取(activeRoot 跟随主进程活动 vault)。
  useEffect(() => {
    ensureEntrySyncSubscribed()
    void useEntrySync.getState().refresh()
  }, [vaultRoot])
  const entryVaults = useEntrySync((s) => s.vaults)
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
  // 显示等待文案);web=标记推导。其余节点归「Cloud工作区」。
  const cloudSections = useMemo(() => {
    const isDesktopCloud = !!window.amadeusSync && vaultSide === 'cloud'
    // web(库本身在云端)恒走云端样式——落进下面的本地分支会把 vault UUID 当 <Vault名> 显示。
    const isWebCloud = !window.amadeusSync && !!(window as { amadeusCloudVaults?: unknown }).amadeusCloudVaults
    if (!isDesktopCloud && !isWebCloud) return null
    const names = isDesktopCloud ? [...new Set(entryVaults.map((v) => v.cloudName))].sort() : webVaultNames
    const nodeOf = new Map(tree.children.filter((n) => n.kind === 'folder').map((n) => [n.path, n]))
    const vaultSecs = names.map((name) => ({ name, node: nodeOf.get(name) ?? null }))
    const nameSet = new Set(names)
    const rest = tree.children.filter((n) => !(n.kind === 'folder' && nameSet.has(n.path)))
    return { vaultSecs, rest }
  }, [tree, entryVaults, vaultSide, webVaultNames])

  // 白板/PDF/.db 开在各自的独立视图、不写 activePage → 树行永远不亮。聚焦主 tab 是这类视图时
  // 按其文件参数点亮对应行(编辑器/其他视图聚焦时回落 activePage,原行为)。mainTabs 随激活变化刷新。
  const mainTabs = useWorkspace((s) => s.mainTabs)
  const activeViewFile = useMemo(() => {
    const t = mainTabs.find((x) => x.active)
    const key = t && ({ 'amadeus-drawing': 'drawingPath', 'amadeus-pdf': 'pdfPath', 'amadeus-db': 'dbPath' } as Record<string, string>)[t.type]
    // leafById 两壳皆有;移动单列壳 api 恒 null(getPanel 读法在手机上恒 null→白板/PDF 树行不亮)。
    const v = key ? (useWorkspace.getState().leafById(t!.id)?.params as Record<string, unknown> | undefined)?.[key] : null
    return typeof v === 'string' ? v : null
  }, [mainTabs])

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

  /** 拖拽悬停在「合并笔记节点」上 = 拖进它的 .fd(Notion 语义);守卫拖自己/拖回原处/拖进自己子树。 */
  const mergedDragOver = (e: RDragEvent<HTMLElement>, notePath: string, fd: string): void => {
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

  const row = (path: string, depth = 0, merged?: { fd: string; open: boolean; count: number }): ReactNode => {
    // 白板(.excalidraw.md)磁盘上也是 .md,必须先于「笔记」判定:进了 openNote 会被 compiler 当页面改写=毁档。
    const isDraw = isDrawingPath(path)
    const isNote = !isDraw && isNotePath(path)
    const ctxKind = isNote ? 'page' : 'asset'
    // 无 emoji 时的类型兜底图标(md 笔记也有 —— 用户要求)。尺寸由 CSS .t2s-lead-icon 定,勿传 size。
    const LeadIcon = isDbPath(path) ? Database : isDraw ? PenTool : isNote ? FileText : Paperclip
    return (
    <button
      key={path}
      ref={(el) => { if (path === flash) flashRef.current = el }}
      className={`t2s-srow${path === (activeViewFile ?? activePage) ? ' active' : ''}${path === flash ? ' amx-flash' : ''}${path === dragPath ? ' dragging' : ''}${merged && dragPath && dragOver === merged.fd ? ' amx-drop-into' : ''}`}
      style={{ paddingLeft: rowPadLeft(depth) }}
      onClick={(e) => { isNote ? void openNote(path, { newTab: e.metaKey || e.ctrlKey }) : isDraw ? openDrawing(path) : isDbPath(path) ? openDb(path) : isPdfPath(path) ? openPdf(path) : void amadeus.openVaultFile(path).catch(() => {}) }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ kind: ctxKind, path, x: e.clientX, y: e.clientY }) }}
      draggable={renaming !== path}
      onDragStart={(e) => {
        // 用元素自身作拖影并按抓取点对齐光标(同会话列表:默认拖影/setState 重渲会让内容与光标错位)。
        const r = e.currentTarget.getBoundingClientRect()
        e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
        e.dataTransfer.effectAllowed = 'move'
        setDragPath(path)
      }}
      onDragEnd={() => { setDragPath(null); setDragOver(null) }}
      onDragOver={merged ? (e) => mergedDragOver(e, path, merged.fd) : undefined}
      onDragLeave={merged ? () => { if (dragOver === merged.fd) setDragOver(null) } : undefined}
      onDrop={merged ? (e) => { e.preventDefault(); e.stopPropagation(); dropTo(merged.fd) } : undefined}
      {...tipProps(rowTip(path))}
    >
      {/* 前导槽:**每行都有**(含文件夹行),故所有图标左边缘对齐、尺寸也一致(见 .t2s-lead)。
          槽内恒显图标(emoji 优先,否则类型兜底图标);**可展开的行 hover 才把图标换成箭头**(用户拍板)。 */}
      <span className="t2s-lead">
        {icons[path]
          ? <span className="amx-page-emoji">{icons[path]}</span>
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
          {isNote || isDraw ? baseName(path) : path.split(/[\\/]/).pop()}
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
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropTo(fd) }}
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
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropTo(folder) }}
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
          onContextMenu={(e) => {
            // 空白处右键 = 根目录新建。行/文件夹头/顶部特殊按钮各有自己的右键菜单(已 stopPropagation),这里只兜真空白。
            if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group, .t2s-special-group')) return
            if (!vaultRoot) return
            e.preventDefault()
            e.stopPropagation()
            setMenu({ kind: 'root', path: '', x: e.clientX, y: e.clientY })
          }}
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
                  <span className="t2s-special-ic"><SquarePen /></span>
                  <span className="t2s-special-title">新建笔记</span>
                </button>
                <button className="t2s-special" onClick={() => newDrawing('')}>
                  <span className="t2s-special-ic"><PenTool /></span>
                  <span className="t2s-special-title">新建白板</span>
                </button>
                {/* 「今天」已移除;「Vault」入口移到底部 footer(回收站下方)。 */}
              </div>

              {!vaultRoot && <div className="t2s-hint">打开一个 Vault 文件夹开始。</div>}
              <PinnedSection row={row} dragPath={dragPath} />
              {vaultSide === 'local' && <CloudSyncSection dragPath={dragPath} />}
              <SharedWithMeSection />
              <PrefsSections row={row} pages={pages} />
              {cloudSections ? (
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
                  <button className="t2s-group-toggle" onClick={toggleVault}>
                    <span className="t2s-group-name amx-sec-head">
                      <span className="t2s-group-label">{baseName(vaultRoot)}</span>
                      <span className={`t2s-chev${vaultOpen ? ' open' : ''}`}><ChevronRight size={12} /></span>
                    </span>
                  </button>
                  {vaultOpen && (
                    <div
                      className={`t2s-group-sessions${dragPath && dragOver === '' ? ' amx-drop-root' : ''}`}
                      onDragOver={(e) => {
                        // 根目录落点:分区内真空白(行/文件夹自己的 handler 已 stopPropagation)。
                        if (!dragPath || parentOf(dragPath) === '' || q) return
                        if ((e.target as HTMLElement).closest('.t2s-srow, .t2s-group')) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (dragOver !== '') setDragOver('')
                      }}
                      onDragLeave={() => { if (dragOver === '') setDragOver(null) }}
                      onDrop={(e) => {
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
                tree.children.map((n) => renderNode(n, 0))
              )}
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

      {menu?.kind === 'page' && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
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
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); if (confirmedDelete('note', p)) { useRecentViews.getState().remove(`note:${p}`); void ps().deletePage(p) } }}><Trash2 size={13} /> 删除</button>
        </div>
      )}
      {menu?.kind === 'asset' && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
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
          ) : isDrawingPath(menu.path) ? (
            <>
              <button onClick={() => { openDrawing(menu.path); setMenu(null) }}><Eye size={13} /> 打开白板</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> 用系统程序打开</button>
            </>
          ) : (
            <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><Eye size={13} /> 打开</button>
          )}
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> 在文件管理器中显示</button>
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); if (confirmedDelete('file', p)) void ps().deletePage(p) }}><Trash2 size={13} /> 删除</button>
        </div>
      )}
      {menu?.kind === 'folder' && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setExpanded((prev) => new Set([...prev, ...prefixesOf(menu.path)])); void ps().createPageInFolder(menu.path); setMenu(null) }}><SquarePen size={13} /> 新建笔记</button>
          <button onClick={() => newFolder(menu.path)}><FolderPlus size={13} /> 新建子文件夹</button>
          <button onClick={() => newBase(menu.path)}><Database size={13} /> 新建 Base</button>
          <button onClick={() => newDrawing(menu.path)}><PenTool size={13} /> 新建白板</button>
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
        </div>
      )}
      {menu?.kind === 'root' && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { void ps().createPage(); setMenu(null) }}><SquarePen size={13} /> 新建笔记</button>
          <button onClick={() => newFolder('')}><FolderPlus size={13} /> 新建文件夹</button>
          <button onClick={() => newBase('')}><Database size={13} /> 新建 Base</button>
          <button onClick={() => newDrawing('')}><PenTool size={13} /> 新建白板</button>
        </div>
      )}

      {cloudPanel && <CloudVaultPanel onClose={() => setCloudPanel(false)} />}
    </div>
  )
}

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

/** 未命名笔记的文件名 sentinel(createPageInFolder=untitled[-N] / createChildNote=未命名[-N]):
 *  标题栏对这些显示为空 + 「New Page」占位(Notion 式),不显示字面「未命名」。 */
const UNTITLED_RE = /^(未命名|untitled)(-\d+)?$/i

/** 可编辑笔记标题 = 文件名(manifest.title 恒取 basename),提交即 renamePage。在编辑器内联改标题。 */
/** 活动页 fm 的 cover 值(http URL 或 vault 相对路径);无 = null。 */
function useActiveCover(): string | null {
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  return useMemo(() => {
    const v = parseFmObject(fmExtra).cover
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }, [fmExtra])
}

/** 活动页封面纵向焦点(fm cover_y,0-100);缺省 50(居中)。 */
function useActiveCoverY(): number {
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  return useMemo(() => {
    const v = parseFmObject(fmExtra).cover_y
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50
  }, [fmExtra])
}

/** Notion/pixel-banner 式封面横幅:收进正文区、四角圆角裁切;上下拖动图片调纵向焦点(存 fm cover_y);
 *  底部柔和渐变逐渐融入页面背景色,与正文自然过渡;悬停出「更换/移除」。 */
function NoteCover() {
  const activePage = usePageStore((s) => s.activePage)
  const cover = useActiveCover()
  const savedY = useActiveCoverY()
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null)
  const [dragY, setDragY] = useState<number | null>(null)
  const [reposition, setReposition] = useState(false) // 「调整位置」模式:默认图片锁定,点按钮才解锁可拖
  const posY = dragY ?? savedY
  if (!activePage || !cover) return null
  const src = /^https?:\/\//i.test(cover) ? cover : toAssetUrl(cover)
  return (
    <div className={`amx-cover${reposition ? ' amx-cover-repo' : ''}`}>
      <img
        src={src}
        alt=""
        draggable={false}
        style={{ objectPosition: `50% ${posY}%` }}
        onMouseDown={(e) => {
          // 仅「调整位置」模式解锁拖拽:鼠标下移 → object-position Y 增大;松手落 fm cover_y。
          if (!reposition || e.button !== 0) return
          e.preventDefault()
          const startClientY = e.clientY
          const h = (e.currentTarget as HTMLElement).offsetHeight || 210
          const base = posY
          const onMove = (ev: MouseEvent): void => setDragY(Math.max(0, Math.min(100, base + ((ev.clientY - startClientY) / h) * 100)))
          const onUp = (): void => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            setDragY((cur) => { if (cur != null) void ps().setPageCoverY(activePage, Math.round(cur)); return null })
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
        onError={(e) => { (e.target as HTMLElement).style.opacity = '0.15' }}
      />
      <div className="amx-cover-grad" />
      {reposition && <div className="amx-cover-hint">上下拖动图片调整位置</div>}
      <div className="amx-cover-tools">
        {reposition ? (
          <button onClick={() => setReposition(false)}>完成</button>
        ) : (
          <>
            <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick({ x: r.right, y: r.bottom + 6 }) }}>更换封面</button>
            <button onClick={() => setReposition(true)}>调整位置</button>
            <button onClick={() => void ps().setPageCover(activePage, null)}>移除</button>
          </>
        )}
      </div>
      {pick && <CoverPicker page={activePage} x={pick.x} y={pick.y} onClose={() => setPick(null)} />}
    </div>
  )
}

/** 无关键词时的默认精选封面(Notion 式):picsum 固定 seed 免 key、图随 seed 稳定,
 *  纯 <img> 直载不走主进程(须 index.html CSP img-src 放行 https:),故三端(含 web)都可用。 */
const FEATURED_COVERS: Array<{ thumb: string; full: string; author?: string; source?: string }> = [
  'aurora', 'forest', 'ocean', 'alpine', 'metro', 'night', 'coast', 'mist', 'valley', 'dune', 'lake', 'bloom',
].map((s) => ({ thumb: `https://picsum.photos/seed/${s}/320/180`, full: `https://picsum.photos/seed/${s}/1600/900`, source: 'Picsum' }))

/** 封面选择器:锚定 popover(骑 amx-db-pop 壳,融入页面非全屏模态)。
 *  tab = 图库(打开即精选,可搜 Openverse)/ 链接 / 上传;点缩略图即换封面但**不关闭**(可连选),点浮层外关闭。 */
function CoverPicker({ page, x, y, onClose }: { page: string; x: number; y: number; onClose: () => void }) {
  const hasSearch = !!amadeus.searchImages
  const [tab, setTab] = useState<'gallery' | 'url' | 'upload'>('gallery')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Array<{ thumb: string; full: string; author?: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  const [url, setUrl] = useState('')
  const apply = (cover: string): void => {
    void ps().setPageCover(page, cover) // 不自动关闭:用户可连选换图,点浮层外才关
  }
  const search = (): void => {
    const query = q.trim()
    if (!query || !amadeus.searchImages) return
    setBusy(true)
    setErr(false)
    void amadeus.searchImages(query)
      .then((r) => { setHits(r); setBusy(false) })
      .catch(() => { setHits(null); setErr(true); setBusy(false) }) // 失败显式提示,不静默
  }
  const upload = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      void (async () => {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer())
          const { opts } = await getAttachmentPrefs()
          const { pageRel } = await amadeus.saveAttachment(page, f.name || 'cover.png', bytes, opts)
          apply(joinRel(page.split('/').slice(0, -1).join('/'), pageRel))
        } catch { /* 保存失败静默 */ }
      })()
    }
    input.click()
  }
  // 缩略图网格:统一 3:2 比例 + 小圆角,图下方一行作者/来源;点击即用即关。
  const grid = (items: Array<{ thumb: string; full: string; author?: string; source?: string }>) => (
    <div className="amx-coverpick-grid">
      {items.map((h) => (
        <button key={h.full} className="amx-coverpick-item" onClick={() => apply(h.full)}>
          <span className="amx-coverpick-thumb">
            <img src={h.thumb} alt="" loading="lazy" onError={(e) => { const b = e.currentTarget.closest('.amx-coverpick-item') as HTMLElement | null; if (b) b.style.display = 'none' }} />
          </span>
          <span className="amx-coverpick-cap">{h.author ? `by ${h.author}` : (h.source ?? '')}</span>
        </button>
      ))}
    </div>
  )
  return (
    <div className="amx-db-popwrap am-app" onMouseDown={onClose}>
      <div
        className="amx-db-pop amx-coverpick"
        style={{ left: Math.max(8, Math.min(x - 420, window.innerWidth - 428)), top: Math.max(8, Math.min(y, window.innerHeight - 308)) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="amx-coverpick-tabs">
          <button data-on={tab === 'gallery' || undefined} onClick={() => setTab('gallery')}>图库</button>
          <button data-on={tab === 'url' || undefined} onClick={() => setTab('url')}>链接</button>
          <button data-on={tab === 'upload' || undefined} onClick={() => setTab('upload')}>上传</button>
        </div>
        {tab === 'gallery' && (
          <div className="amx-coverpick-body">
            {hasSearch && (
              <div className="amx-coverpick-search">
                <Search size={13} className="t2s-dim" />
                <input autoFocus placeholder="搜索在线图库(Openverse),或从下方精选挑…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search() }} />
                <button className="amx-coverpick-go" onClick={search}>{busy ? '…' : '搜索'}</button>
              </div>
            )}
            {grid(hits && hits.length > 0 ? hits : FEATURED_COVERS)}
            {!busy && err && <div className="amx-coverpick-hint">图库接口暂不可达,可从上方精选挑,或用「链接/上传」。</div>}
            {!busy && !err && hits?.length === 0 && <div className="amx-coverpick-hint">没搜到结果,上方为精选封面。</div>}
          </div>
        )}
        {tab === 'url' && (
          <div className="amx-coverpick-body amx-coverpick-url">
            <input autoFocus placeholder="粘贴图片地址(https://…)" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && /^https?:\/\//i.test(url.trim())) apply(url.trim()) }} />
            <button className="amx-coverpick-go" onClick={() => { if (/^https?:\/\//i.test(url.trim())) apply(url.trim()) }}>设为封面</button>
          </div>
        )}
        {tab === 'upload' && (
          <div className="amx-coverpick-body">
            <button className="amx-coverpick-go amx-coverpick-upload" onClick={upload}>选择本地图片…</button>
            <div className="amx-coverpick-hint">按「设置 → 笔记」的附件位置存入 vault。</div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 页面图标 picker:精选 emoji 网格 + 任意输入(系统 emoji 面板贴进来也行)。 */
const EMOJI_SET =
  '📄📝📚📖✏️🗂️📌📅🗓️✅☑️⭐🌟💡🔥🎯🎨🎵🎬📷🍀🌲🌸🌊☀️🌙⚡🧠💭💬🗨️❤️🧩🔧🔨⚙️🧪🔬💻🖥️📱🗄️📊📈📉💰🛒✈️🏠🏢🎁🎉🏃🧘🍎🍜☕🍵🚀🔭🧭🗺️🔒🔑🐞🌈'
const EMOJI_LIST = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(EMOJI_SET)].map((x) => x.segment)
/** Notion 行为:「添加图标」先随机给一个,再点可换。 */
const randomEmoji = (): string => EMOJI_LIST[Math.floor(Math.random() * EMOJI_LIST.length)]
function IconPicker({ x, y, current, onPick, onClose }: {
  x: number
  y: number
  current: string | null
  onPick: (icon: string | null) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const emojis = EMOJI_LIST
  return (
    <div className="amx-db-popwrap" onMouseDown={onClose}>
      <div className="amx-db-pop amx-iconpick" style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 320) }} onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="amx-db-pop-input"
          autoFocus
          placeholder="输入/粘贴任意 emoji 后回车…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) onPick(draft.trim())
            else if (e.key === 'Escape') onClose()
          }}
        />
        <div className="amx-iconpick-grid">
          {emojis.map((em) => (
            <button key={em} className={`amx-iconpick-item${current === em ? ' active' : ''}`} onClick={() => onPick(em)}>
              {em}
            </button>
          ))}
        </div>
        {current && (
          <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPick(null)}>移除图标</button>
        )}
      </div>
    </div>
  )
}

function NoteTitle() {
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
    const target = usePageStore.getState().focusTitleFor
    if (!target) return
    if (target === activePage) {
      const el = ref.current
      if (el) {
        el.focus()
        const n = el.value.length
        el.setSelectionRange(n, n)
      }
    }
    usePageStore.getState().consumeTitleFocus()
  }, [activePage])
  const commit = (): void => {
    const next = val.trim()
    if (next && next !== current) void ps().renamePage(next)
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
            <button onClick={() => void ps().setPageIcon(activePage, randomEmoji())}>☺ 添加图标</button>
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
              e.preventDefault(); focusBody(); el.blur()
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
            void ps().setPageIcon(activePage, em)
            setPick(null)
          }}
          onClose={() => setPick(null)}
        />
      )}
      {coverPick && activePage && <CoverPicker page={activePage} x={coverPick.x} y={coverPick.y} onClose={() => setCoverPick(null)} />}
    </div>
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
  const vaultRoot = usePageStore((s) => s.vaultRoot) // 无笔记时的空态引导据此二态(未开 Vault / 已开待新建)
  // 模式在 uiOverlayStore(供命令面板「切换 源码/可视」),不再是组件内 state。
  const mode = useUiOverlay((s) => s.editorMode)
  const [dragging, setDragging] = useState(false)
  // 笔记多功能菜单(Obsidian 式右上角 ⋮):导出/收藏/定位/删除。
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null)
  const [shareCard, setShareCard] = useState<{ x: number; y: number } | null>(null) // 共享/发布卡片(web/桌面 collab)
  const [shareVer, setShareVer] = useState(0) // ShareCard 关闭后 bump → 状态指示重新拉取
  const printHostRef = useRef<HTMLElement | null>(null) // 本编辑器实例的 EditorScope 根(分屏下导出各自的)
  const starred = useAmadeusPrefs((s) => !!activePage && s.starred.includes(activePage))
  const pinned = useAmadeusPrefs((s) => !!activePage && s.pins.includes(activePage))
  // 云同步按钮(图钉右侧,仅桌面本地侧):点亮=本笔记已是显式同步条目;点击开启走关联勾选弹窗,再点关闭。
  const vaultSide = usePageStore((s) => s.vaultSide)
  useEntrySync((s) => s.vaults) // 订阅注册表变更驱动重渲(isSyncedEntry 读 getState)
  useEffect(() => { ensureEntrySyncSubscribed() }, [])
  const canEntrySync = !!window.amadeusSync?.entrySyncEnable && vaultSide === 'local'
  const synced = canEntrySync && !!activePage && isSyncedEntry(ps().vaultRoot, activePage)
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
          {window.amadeusCollab && <ShareStatus path={activePage} refreshKey={shareVer} onOpen={(x, y) => setShareCard({ x, y })} />}
          <PluginStatusItems />
          {/* 置顶图钉(字数统计右侧):写 amadeusPrefs(每 vault localStorage),侧边栏「置顶」分区同步点亮。 */}
          <button
            className={`amx-mode-btn amx-pin-btn${pinned ? ' amx-pin-on' : ''}`}
            title={pinned ? '取消置顶' : '置顶'}
            onClick={() => useAmadeusPrefs.getState().togglePin(activePage)}
          >
            <Pin size={14} />
          </button>
          {canEntrySync && (
            <button
              className={`amx-mode-btn amx-pin-btn${synced ? ' amx-pin-on' : ''}`}
              title={synced ? '关闭云同步(云端副本保留)' : '开启云同步'}
              onClick={() => {
                if (synced) void window.amadeusSync?.entrySyncDisable?.(activePage)
                else openCloudSyncDialog(activePage, 'page')
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
          <button className="danger" onClick={() => { const p = activePage; setNoteMenu(null); if (confirmedDelete('note', p)) { useRecentViews.getState().remove(`note:${p}`); void ps().deletePage(p) } }}>
            <Trash2 size={13} /> 删除笔记
          </button>
        </div>
      )}
      {shareCard && activePage && (
        <ShareCard path={activePage} anchor={shareCard} onClose={() => { setShareCard(null); setShareVer((v) => v + 1) }} />
      )}
      {!activePage ? (
        <div className="amx-welcome">
          <div className="amx-welcome-title">📓 Amadeus 笔记</div>
          <p className="amx-welcome-sub">
            {vaultRoot
              ? '从左栏选一篇笔记开始,或新建一篇。'
              : '把任意文件夹选作你的笔记库(Vault)就能开写 —— 所见即所得,像 Obsidian 一样用双链把想法连起来。'}
          </p>
          <div className="amx-welcome-actions">
            {vaultRoot ? (
              <button className="amx-welcome-btn" onClick={() => void ps().createPage()}><SquarePen size={16} /> 新建笔记</button>
            ) : (
              <button className="amx-welcome-btn" onClick={() => void ps().openVault()}><FolderOpen size={16} /> 打开 Vault 文件夹</button>
            )}
          </div>
          <ul className="amx-welcome-tips">
            <li><span className="amx-kbd">[[</span> 引用其它笔记,自动生成反向链接</li>
            <li><Paperclip size={13} /> 拖入图片 / 文件直接插入;支持数据库块、LaTeX、代码高亮</li>
            <li><Code2 size={13} /> 顶栏切「可视 / 源码」,右上角 ⋮ 可导出 PDF</li>
          </ul>
        </div>
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
