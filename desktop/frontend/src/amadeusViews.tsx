/** Amadeus Space 的引擎视图 —— 外壳用 Tangu 原生 UI 重建(复刻侧栏 t2s- 视觉 + base.css 的 .ctx-menu),
 *  只复用 Amadeus 的数据层(pageStore)与块编辑器内核(PageView/Milkdown)。
 *  左 笔记库 / 主 编辑器 / 右 大纲·反链。除编辑器(块组件用 Amadeus 契约 token,需 .am-app+bridge)外,
 *  外壳直接用 Tangu token/类 → 与 Tangu Desktop 一致,并随其换肤/明暗同步。 */
import { Fragment, type ReactNode, type CSSProperties, type RefObject, type DragEvent as RDragEvent, type MouseEvent as RMouseEvent, type ClipboardEvent as RClipboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  SquarePen, FolderOpen, Folder, FolderPlus, Plus, MoreHorizontal, Pencil, Trash2, BookOpen,
  ChevronRight, Search, Code2, Eye, Star, Paperclip, FileDown, FileImage,
  Database, ExternalLink, FileText, Share2, Cloud, CloudOff, Pin, PenTool, Upload, LayoutDashboard,
  Undo2, Redo2, ChevronsDown, Frame,
} from 'lucide-react'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { activePageScope, cascadeFdAfterRename, claimTitleFocus, disposePageScope, flushAllScopes, onNotePathGone, pageStoreFor, PageScopeCtx, remapScopePaths, setActivePageScope, usePageScope, usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { retireUnifiedPath, insertFilesForPath } from '@amadeus/unified/lifecycle'
import { useUiOverlay } from './amadeusOverlayStore'
import { useUiStore } from '@amadeus/store/uiStore'
import { amadeus } from '@amadeus/api'
import { UnifiedPage } from '@amadeus/unified/UnifiedPage'
import { SEG_SLOT } from '@amadeus/unified/CanvasModeSeg'
import { NoteCover, CoverPicker, IconPicker, randomEmoji, useActiveCover, UNTITLED_RE } from '@amadeus/chrome/pageChrome'
import { routeNote, type RouteDecision } from '@amadeus/unified/router'
import { upgradeV4Enabled } from '@amadeus/lib/upgradeV4'
import { cursorFromSource, setModeCursor, sourceOffsetFor, takeModeCursor } from '@amadeus/lib/modeCursor'
import { importToPage, importToFolder, pasteImagesToPage, filesFromHostPaths } from './amadeusImport'
import { usePluginStore, findFileType, matchFileType, fileTypeBaseName } from '@amadeus/plugins/pluginStore'
import { normalizePluginRename } from '@amadeus/plugins/pluginExt'
import { resolveIcon } from '@amadeus/components/icons'
import { ensureAmadeusReady } from './amadeusPlugins'
import { AmadeusPropertiesPanel } from './amadeusProperties'
import { useAmadeusPrefs } from './amadeusPrefs'
import type { TrashEntry } from '@amadeus-shared/ipc'
import type { AmadeusSyncStatus } from './types'
import { openNote, openDb, openPdf, openImage, openDrawing, openDashboard, openFile, createDrawing, createDashboard, openSearch } from './amadeusNav'
import { openTutorial } from './amadeusTutorial'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { isDashboardPath } from '@amadeus-shared/dashboard'
import { REF_MIME, PATHS_MIME, readChatRefs, setChatRefDrag } from './views/chat2/chatDragRef'
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
import { useNoteOutline } from '@amadeus/lib/activeNote'
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
import { SidebarRow } from './components/SidebarRow'
import { parentOf, rowDropTarget, dropKeyOf, takesHostPaths } from './views/treeDrop'
import { registerMessages, translate, useI18n } from './i18n'

registerMessages({
  'amxv.renameFailed': { zh: '重命名失败:{e}', en: 'Rename failed: {e}' },
  'amxv.newBaseFailed': { zh: '新建 Base 失败:{e}', en: 'Could not create the base: {e}' },
  'amxv.copyFailed': { zh: '复制失败:{e}', en: 'Copy failed: {e}' },
  'amxv.fileCreatorFailed': { zh: '「{label}」失败:{e}', en: '“{label}” failed: {e}' },
  'amxv.confirm.deleteNote': { zh: '删除笔记「{name}」?此操作不可撤销。', en: 'Delete the note “{name}”? This cannot be undone.' },
  'amxv.confirm.deleteNoteWithChildren': { zh: '删除笔记「{name}」?其中包含 {n} 个子文件,将一并删除。此操作不可撤销。', en: 'Delete the note “{name}”? It contains {n} sub-file(s) that will be deleted with it. This cannot be undone.' },
  'amxv.confirm.deleteFile': { zh: '删除文件「{name}」?此操作不可撤销。', en: 'Delete the file “{name}”? This cannot be undone.' },
  'amxv.confirm.deleteFolder': { zh: '删除文件夹「{name}」及其全部内容?不可撤销。', en: 'Delete the folder “{name}” and everything in it? This cannot be undone.' },
  'amxv.confirm.deleteSelected': { zh: '删除选中的 {n} 项?', en: 'Delete the {n} selected items?' },

  'amxv.trash.title': { zh: '回收站', en: 'Trash' },
  'amxv.trash.entryTip': { zh: '查看回收站(删除的笔记/文件可恢复)', en: 'Open the trash (deleted notes and files can be restored)' },
  'amxv.trash.confirmEmpty': { zh: '清空回收站?其中内容将永久删除。', en: 'Empty the trash? Everything in it is deleted permanently.' },
  'amxv.trash.emptyAction': { zh: '清空', en: 'Empty' },
  'amxv.trash.origin': { zh: '原位置:{path}', en: 'Original location: {path}' },
  'amxv.trash.restore': { zh: '恢复', en: 'Restore' },
  'amxv.trash.confirmDelete': { zh: '彻底删除「{name}」?不可恢复。', en: 'Permanently delete “{name}”? This cannot be undone.' },
  'amxv.trash.emptyHint': { zh: '回收站是空的。', en: 'The trash is empty.' },

  'amxv.sec.starred': { zh: '收藏', en: 'Starred' },
  'amxv.sec.collections': { zh: '集合', en: 'Collections' },
  'amxv.sec.searchTip': { zh: '搜索:{q}', en: 'Search: {q}' },
  'amxv.sec.removeCollection': { zh: '移除集合', en: 'Remove collection' },
  'amxv.sec.sharedWithMe': { zh: '与我共享', en: 'Shared with me' },
  'amxv.sec.pinned': { zh: '置顶', en: 'Pinned' },
  'amxv.sec.cloudSync': { zh: '云同步', en: 'Cloud sync' },
  'amxv.sec.cloudWorkspace': { zh: 'Cloud工作区', en: 'Cloud workspace' },
  'amxv.role.viewer': { zh: '只读', en: 'Read-only' },
  'amxv.role.editor': { zh: '可编辑', en: 'Can edit' },
  'amxv.pinned.hint': { zh: '拖入笔记置顶,或点编辑器右上角的图钉', en: 'Drag a note here to pin it, or use the pin button at the top right of the editor' },
  'amxv.cloudsync.hint': { zh: '拖入笔记/文件,或右键条目「开启云同步」', en: 'Drag notes or files here, or right-click an item and choose “Turn on cloud sync”' },

  'amxv.skip.tooLarge': { zh: '超过 5MB,云端不收', en: 'Over 5 MB — the cloud will not accept it' },
  'amxv.skip.assetMissing': { zh: '云端缺失', en: 'Missing in the cloud' },
  'amxv.skip.summary': { zh: '⚠ {n} 项未同步{extra},悬停看明细', en: '⚠ {n} item(s) not synced{extra} — hover for details' },
  'amxv.skip.tooLargeNote': { zh: '(有文件超过 5MB,云端单文件上限)', en: ' (some files are over the 5 MB per-file cloud limit)' },
  'amxv.cloud.dotTitle': { zh: '云端「{name}」', en: 'Cloud “{name}”' },
  'amxv.cloud.skippedCount': { zh: '{n} 项跳过', en: '{n} skipped' },
  'amxv.cloud.notEnabled': { zh: '尚未开启云同步', en: 'Cloud sync is not on yet' },
  'amxv.cloud.missing': { zh: '{path}(已不存在)', en: '{path} (no longer exists)' },
  'amxv.cloud.disableTip': { zh: '关闭云同步(云端副本保留)', en: 'Turn off cloud sync (the cloud copy is kept)' },

  'amxv.empty': { zh: '空', en: 'Empty' },
  'amxv.syncNotArrived': { zh: '同步内容尚未到达', en: 'Synced content has not arrived yet' },
  'amxv.searchNotes': { zh: '搜索笔记', en: 'Search notes' },
  'amxv.noMatches': { zh: '没有匹配的笔记', en: 'No matching notes' },
  'amxv.openVaultHint': { zh: '打开一个 Vault 文件夹开始。', en: 'Open a vault folder to get started.' },
  'amxv.cloudVault': { zh: '云端笔记库', en: 'Cloud vault' },
  'amxv.cloudVaultTip': { zh: '云端笔记库(切换 / 成员 / 分享)', en: 'Cloud vault (switch / members / sharing)' },
  'amxv.vaultNamed': { zh: 'Vault：{name}', en: 'Vault: {name}' },
  'amxv.openVault': { zh: '打开 Vault', en: 'Open vault' },
  'amxv.folder.actions': { zh: '文件夹操作', en: 'Folder actions' },
  'amxv.folder.newNoteHere': { zh: '在此文件夹新建笔记', en: 'New note in this folder' },
  'amxv.renameFolder': { zh: '重命名文件夹', en: 'Rename folder' },

  'amxv.menu.openInNewTab': { zh: '在新标签页打开', en: 'Open in new tab' },
  'amxv.menu.openNInNewTabs': { zh: '在新标签页打开 {n} 项', en: 'Open {n} items in new tabs' },
  'amxv.menu.deleteN': { zh: '删除 {n} 项', en: 'Delete {n} items' },
  'amxv.menu.rename': { zh: '重命名', en: 'Rename' },
  'amxv.menu.star': { zh: '收藏', en: 'Star' },
  'amxv.menu.unstar': { zh: '取消收藏', en: 'Unstar' },
  'amxv.menu.cloudSyncOff': { zh: '关闭云同步', en: 'Turn off cloud sync' },
  'amxv.menu.cloudSyncOn': { zh: '开启云同步', en: 'Turn on cloud sync' },
  'amxv.menu.reveal': { zh: '在文件管理器中显示', en: 'Show in file manager' },
  'amxv.menu.delete': { zh: '删除', en: 'Delete' },
  'amxv.menu.open': { zh: '打开', en: 'Open' },
  'amxv.menu.openWithSystem': { zh: '用系统程序打开', en: 'Open with the system app' },
  'amxv.menu.openAnnotate': { zh: '打开(可批注)', en: 'Open (annotatable)' },
  'amxv.menu.openDrawing': { zh: '打开白板', en: 'Open whiteboard' },
  'amxv.menu.newSubfolder': { zh: '新建子文件夹', en: 'New subfolder' },
  'amxv.menu.publishFolder': { zh: '发布此文件夹(公开链接)', en: 'Publish this folder (public link)' },
  'amxv.menu.exportPdf': { zh: '导出为 PDF', en: 'Export as PDF' },
  'amxv.menu.deleteNote': { zh: '删除笔记', en: 'Delete note' },

  'amxv.publish.done': { zh: '文件夹已发布,公开链接已复制(任何人可只读浏览)', en: 'Folder published — the public link is copied (anyone can read it)' },
  'amxv.publish.quota': { zh: '发布页数已达套餐上限', en: 'You have reached your plan limit for published pages' },
  'amxv.publish.ownerOnly': { zh: '只有库所有者能发布', en: 'Only the vault owner can publish' },
  'amxv.publish.failed': { zh: '发布失败', en: 'Publishing failed' },

  'amxv.mbar.insertBlock': { zh: '插入块', en: 'Insert block' },
  'amxv.uploadToPage': { zh: '上传文件到本页', en: 'Upload files to this note' },
  'amxv.mbar.toDocument': { zh: '切换到文档', en: 'Switch to document' },
  'amxv.mbar.toCanvas': { zh: '切换到画布', en: 'Switch to canvas' },
  'amxv.mbar.undo': { zh: '撤销', en: 'Undo' },
  'amxv.mbar.redo': { zh: '重做', en: 'Redo' },
  'amxv.moreActions': { zh: '更多操作', en: 'More actions' },
  'amxv.mbar.hideKeyboard': { zh: '收起键盘', en: 'Hide keyboard' },

  'amxv.title.changeIcon': { zh: '更换/移除页面图标', en: 'Change or remove the page icon' },
  'amxv.title.addIcon': { zh: '☺ 添加图标', en: '☺ Add icon' },
  'amxv.title.addCover': { zh: '🖼 添加封面', en: '🖼 Add cover' },

  'amxv.pdf.exported': { zh: '已导出 PDF:{path}', en: 'PDF exported: {path}' },
  'amxv.pdf.exportFailed': { zh: '导出 PDF 失败:{e}', en: 'PDF export failed: {e}' },
  'amxv.pin': { zh: '置顶', en: 'Pin' },
  'amxv.unpin': { zh: '取消置顶', en: 'Unpin' },
  'amxv.shareOrPublish': { zh: '共享 / 发布', en: 'Share / publish' },
  'amxv.toVisualLong': { zh: '切换到可视编辑(所见即所得)', en: 'Switch to visual editing (WYSIWYG)' },
  'amxv.toVisual': { zh: '切换到可视编辑', en: 'Switch to visual editing' },
  'amxv.toSource': { zh: '切换到源码 Markdown', en: 'Switch to Markdown source' },
  'amxv.retry': { zh: '重试', en: 'Retry' },
  'amxv.welcome.loadFailed': { zh: '📓 笔记加载失败', en: '📓 Could not load the note' },
  'amxv.welcome.title': { zh: '📓 Amadeus 笔记', en: '📓 Amadeus notes' },
  'amxv.welcome.pickNote': { zh: '从左栏选一篇笔记开始,或新建一篇。', en: 'Pick a note in the sidebar to get started, or create a new one.' },
  'amxv.welcome.noVault': { zh: '把任意文件夹选作你的笔记库(Vault)就能开写 —— 所见即所得,像 Obsidian 一样用双链把想法连起来。', en: 'Choose any folder as your vault and start writing — WYSIWYG editing, with Obsidian-style wikilinks to connect your ideas.' },
  'amxv.welcome.tutorial': { zh: '使用教程', en: 'Tutorial' },
  'amxv.welcome.openVaultFolder': { zh: '打开 Vault 文件夹', en: 'Open a vault folder' },
  'amxv.welcome.tip1': { zh: '引用其它笔记,自动生成反向链接', en: 'links to another note, and backlinks are generated automatically' },
  'amxv.welcome.tip2': { zh: '拖入图片 / 文件直接插入;支持数据库块、LaTeX、代码高亮', en: 'Drop in images or files to insert them; database blocks, LaTeX and syntax highlighting are all supported' },
  'amxv.welcome.tip3': { zh: '顶栏切「可视 / 源码」,右上角 ⋮ 可导出 PDF', en: 'Toggle visual / source mode in the top bar; export to PDF from the ⋮ menu' },

  'amxv.outline.empty': { zh: '没有标题', en: 'No headings' },
  'amxv.outline.noNote': { zh: '未指定笔记', en: 'No note specified' },
  'amxv.backlinks.noNote': { zh: '未打开笔记', en: 'No note open' },
  'amxv.backlinks.empty': { zh: '还没有其它笔记链接到这里', en: 'No other notes link here yet' },
})

const ps = () => usePageStore.getState()
const baseName = (p: string): string => p.split(/[\\/]/).pop()!.replace(/\.md$/, '')
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
    window.alert(translate('amxv.renameFailed', { e: e instanceof Error ? e.message : String(e) }))
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
    ? translate('amxv.confirm.deleteNoteWithChildren', { name: baseName(p), n })
    : translate('amxv.confirm.deleteNote', { name: baseName(p) })
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
  if (kind === 'file') return window.confirm(translate('amxv.confirm.deleteFile', { name: path.split(/[\\/]/).pop() }))
  return window.confirm(translate('amxv.confirm.deleteFolder', { name: path.split(/[\\/]/).pop() }))
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
  // 插件复合后缀文件与标题栏同口径:剥全后缀('Foo.canvas.md' → 'Foo'),别露 '.canvas' 残段。
  const ft = matchFileType(activePage)
  const leaf = ft ? fileTypeBaseName(activePage, ft.extensions) : segs[segs.length - 1]
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
  const { t } = useI18n()
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
      <button className="t2s-special amx-trash-entry" onClick={() => { refresh(); setOpen(true) }} title={t('amxv.trash.entryTip')}>
        <span className="t2s-special-ic"><Trash2 /></span>
        <span className="t2s-special-title">{t('amxv.trash.title')}{n > 0 ? ` (${n})` : ''}</span>
      </button>
      {open && (
        <div className="amx-trash-wrap" onMouseDown={() => setOpen(false)}>
          <div className="amx-trash-pop" onMouseDown={(e) => e.stopPropagation()}>
            <div className="amx-trash-head">
              <span>{t('amxv.trash.title')}</span>
              {n > 0 && (
                <button
                  className="amx-trash-clear"
                  onClick={() => {
                    if (window.confirm(t('amxv.trash.confirmEmpty'))) void amadeus.emptyTrash?.().then(refresh)
                  }}
                >
                  {t('amxv.trash.emptyAction')}
                </button>
              )}
            </div>
            <div className="amx-trash-list">
              {(items ?? []).map((it) => (
                <div key={it.name} className="amx-trash-row">
                  <span className="amx-trash-ic">{it.dir ? <Folder /> : <FileText />}</span>
                  <span className="amx-trash-name" title={t('amxv.trash.origin', { path: it.original })}>
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
                    {t('amxv.trash.restore')}
                  </button>
                  <button
                    className="amx-trash-act amx-trash-danger"
                    onClick={() => {
                      if (window.confirm(t('amxv.trash.confirmDelete', { name: it.name }))) void amadeus.deleteTrashEntry?.(it.name).then(refresh)
                    }}
                    aria-label="delete forever"
                  >
                    {t('amxv.menu.delete')}
                  </button>
                </div>
              ))}
              {n === 0 && <div className="t2s-hint">{t('amxv.trash.emptyHint')}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** 收藏⭐ / 最近🕘 分区(顶部,可折叠):渲染对 pages 过滤 → 已删除的自然消失。 */
function PrefsSections({ row, pages }: { row: (path: string) => ReactNode; pages: string[] }) {
  const { t } = useI18n()
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
      {section(t('amxv.sec.starred'), starred, openStar, toggleStar)}
      {/* 「最近」分区已按用户要求移除(收藏/集合保留)。 */}
      {collections.length > 0 && (
        <div className="amx-prefs-group">
          <button className="t2s-group-toggle amx-sec-grab" onClick={toggleColl}>
            <span className="t2s-group-name amx-sec-head">
              <span className="t2s-group-label">{t('amxv.sec.collections')}</span>
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
                  title={t('amxv.sec.searchTip', { q: c.query })}
                  onClick={() => { openSearch(); useSearchSeed.getState().request(c.query) }}
                >
                  <span className="amx-coll-ic"><Search /></span>
                  <span className="amx-coll-name">{c.name}</span>
                  <button
                    className="amx-coll-del"
                    title={t('amxv.sec.removeCollection')}
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
  const { t } = useI18n()
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
      <div className="t2s-hint amx-sec-grab" style={{ padding: '2px 10px 2px', fontSize: 11.5 }}>{t('amxv.sec.sharedWithMe')}</div>
      {items.map((s) => (
        <button
          key={`${s.vaultId}:${s.path}`}
          className="t2s-special"
          title={`${s.ownerName ?? ''} · ${s.role === 'viewer' ? t('amxv.role.viewer') : t('amxv.role.editor')}`}
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
  const { t } = useI18n()
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
      label={t('amxv.sec.pinned')}
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
      {items.length ? items.map((p) => row(p)) : <div className="t2s-hint amx-sec-hint">{t('amxv.pinned.hint')}</div>}
    </SideSection>
  )
}

/** 引擎跳过原因 → 人话(engine.ts 的 skipped reason;上限与服务端 MAX_TEXT/BINARY_BYTES=5MB 一致)。 */
const skipLabel = (r: string): string => (r === 'TOO_LARGE' ? translate('amxv.skip.tooLarge') : r === 'ASSET_404' ? translate('amxv.skip.assetMissing') : r)

const skipWarnRow = (skipped: Array<{ path: string; reason: string }>): ReactNode => (
  <div
    className="t2s-hint amx-sec-hint amx-cs-warn"
    title={skipped.map((s) => `${s.path} — ${skipLabel(s.reason)}`).join('\n')}
  >
    {translate('amxv.skip.summary', {
      n: skipped.length,
      extra: skipped.some((s) => s.reason === 'TOO_LARGE') ? translate('amxv.skip.tooLargeNote') : '',
    })}
  </div>
)

/** 云端侧镜像引擎的跳过警示(如 >5MB 拒收):amadeusSync.onStatus 推送。此前这些跳过只藏在
 *  设置页与状态点 tooltip 里,用户放个大文件进云端文件夹毫无反馈 —— 在云端树顶明示。 */
function CloudSkipWarn() {
  useI18n() // 订阅语言变更:下面的 skipWarnRow 走模块级 translate()
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
  const { t } = useI18n()
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
  const dotTitle = rec ? `${t('amxv.cloud.dotTitle', { name: rec.cloudName })}${status ? ` · ${status.state}${status.skipped.length ? ` · ${t('amxv.cloud.skippedCount', { n: status.skipped.length })}` : ''}` : ''}` : t('amxv.cloud.notEnabled')
  const accepts = !!dragPath && !isSyncedEntry(vaultRoot, dragPath)
  return (
    <SideSection
      id="cloudsync"
      label={t('amxv.sec.cloudSync')}
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
      {!entries.length && <div className="t2s-hint amx-sec-hint">{t('amxv.cloudsync.hint')}</div>}
      {!!status?.skipped.length && skipWarnRow(status.skipped)}
      {entries.map((e) => {
        const ok = exists(e)
        return (
          <div
            key={e.path}
            className={`t2s-srow amx-cs-row${ok ? '' : ' amx-cs-ghost'}`}
            role="button"
            tabIndex={0}
            title={ok ? e.path : t('amxv.cloud.missing', { path: e.path })}
            onClick={() => {
              if (!ok) return
              if (e.kind === 'page') void openNote(e.path)
              else if (e.kind === 'asset' && isDbPath(e.path)) openDb(e.path)
            }}
          >
            <span className="amx-cs-ic">{e.kind === 'folder' ? <Folder /> : e.kind === 'page' ? <FileText /> : <Paperclip />}</span>
            <span className="t2s-srow-title">{e.kind === 'page' ? baseName(e.path) : e.path.split(/[\\/]/).pop()}</span>
            <button className="amx-coll-del" title={t('amxv.cloud.disableTip')} onClick={(ev) => { ev.stopPropagation(); void window.amadeusSync?.entrySyncDisable?.(e.path) }}>✕</button>
          </div>
        )
      })}
    </SideSection>
  )
}

export function AmadeusPagesView() {
  const { t } = useI18n()
  const pages = usePageStore((s) => s.pages)
  const folders = usePageStore((s) => s.folders)
  const files = usePageStore((s) => s.files)
  const icons = usePageStore((s) => s.icons)
  // pendingPage 先行:点击瞬间高亮就位,不等云端 GET 回来(activePage 那时才更新)。
  // 末位 activeNotePath 兜 v4(它不设 activePage,否则树上高亮不到当前这篇)。
  const activePage = usePageStore((s) => s.pendingPage ?? s.activePage ?? s.activeNotePath)
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
    const timer = setTimeout(() => setFlash(null), 1200)
    return () => clearTimeout(timer)
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
    const tab = mainTabs.find((x) => x.active)
    const key = tab && ({ 'amadeus-drawing': 'drawingPath', 'amadeus-pdf': 'pdfPath', 'amadeus-db': 'dbPath', 'amadeus-plugin-file': 'filePath' } as Record<string, string>)[tab.type]
    // leafById 两壳皆有;移动单列壳 api 恒 null(getPanel 读法在手机上恒 null→白板/PDF 树行不亮)。
    const v = key ? (useWorkspace.getState().leafById(tab!.id)?.params as Record<string, unknown> | undefined)?.[key] : null
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
        useApp.getState().toast(translate('amxv.fileCreatorFailed', { label, e: e instanceof Error ? e.message : String(e) }), true)
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
  /** 应用内的路径拖拽(文件面板 / 工作区文件视图的行,载荷是主机绝对路径)。
   *  ⚠️ 只认 PATHS_MIME:树内搬笔记走的是 REF_MIME(setChatRefDrag 只写这一种)+ 本地态 dragPath,
   *  两者不重叠 —— 否则这条分支会抢在 dropTo 之前吃掉事件,把「拖笔记进文件夹」搞坏,
   *  且拿到的是 vault 相对路径喂给 copyHostFiles(主机绝对路径)= 乱复制。
   *  只在**本地库**接:copyHostFiles 是主进程 fs,云侧库根本没有可写的本地目录。
   *  落点与 OS 文件同一套:进文件夹走 copyHostFiles;进笔记正文先经 filesFromHostPaths
   *  (fs:readFile → File)再汇入同一条插入链。 */
  const hasHostPaths = (e: RDragEvent<HTMLElement>): boolean =>
    takesHostPaths(
      Array.from(e.dataTransfer?.types ?? []),
      !!vaultRoot && !!window.tangu?.copyHostFiles && !(window.amadeusSync && vaultSide === 'cloud'),
      { paths: PATHS_MIME, ref: REF_MIME },
    )
  const readHostPaths = (e: RDragEvent<HTMLElement>): string[] => {
    if (!hasHostPaths(e)) return []
    try {
      const v: unknown = JSON.parse(e.dataTransfer?.getData(PATHS_MIME) || 'null')
      return Array.isArray(v) ? (v as string[]) : []
    } catch { return [] /* 不是本家载荷 */ }
  }
  const hostPathsDrop = (e: RDragEvent<HTMLElement>, folder: string): boolean => {
    const paths = readHostPaths(e)
    if (!paths.length) return false
    e.preventDefault(); e.stopPropagation()
    setDragOver(null)
    void window.tangu!.copyHostFiles!(paths, folder ? `${vaultRoot}/${folder}` : vaultRoot!)
      .catch((err: unknown) => useUiStore.getState().notify(translate('amxv.copyFailed', { e: err instanceof Error ? err.message : String(err) })))
      // ⚠️ 刷树放 finally:主进程是逐件复制,中途失败时**前面几件已经落盘了**,只在成功时刷 = 树停在旧
      // 状态,用户照提示重试 → 已复制的那些又被复制一遍(重名副本)。(codex 评审 2026-08-25)
      .finally(() => { void ps().refreshStructure() })
    return true
  }
  /** 路径拖拽落到**笔记行**:先把主机文件读成 File,再走与 OS 文件完全同一条 importToPage。 */
  const hostPathsToPage = (e: RDragEvent<HTMLElement>, page: string): boolean => {
    const paths = readHostPaths(e)
    if (!paths.length) return false
    e.preventDefault(); e.stopPropagation()
    setDragOver(null)
    void openNote(page)
      .then(() => filesFromHostPaths(paths))
      .then((files) => { if (files.length) insertIntoPage(files, page) })
    return true
  }
  /** 悬停:OS 文件(无内部 dragPath)也点亮目标落区并允许 copy。返回 true=已按 Files 处理。 */
  const filesDragOver = (e: RDragEvent<HTMLElement>, target: string): boolean => {
    if (!hasFilesType(e) && !hasHostPaths(e)) return false
    e.preventDefault(); e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    if (dragOver !== target) setDragOver(target)
    return true
  }
  /** 落下:OS 文件 / 应用内路径 → 导入到 target 文件夹(空串=库根);都不是则返回 false 交内部搬动。 */
  const filesDrop = (e: RDragEvent<HTMLElement>, target: string): boolean => {
    if (hostPathsDrop(e, target)) return true
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return false
    e.preventDefault(); e.stopPropagation()
    setDragOver(null)
    void importToFolder(files, target)
    return true
  }
  /** 一行的落点(用户口径「拖到准确的文件夹或文件里面」):普通笔记 = **进这篇笔记**(打开它 + 走
   *  编辑器同一条导入链:存附件并插入嵌入/链接);白板 / 仪表盘 / 插件文件类型收不了正文,与附件行
   *  一样归**它所在的文件夹**。合并笔记(.fd)保持既有语义:落进它的 .fd(Notion「笔记即文件夹」)。
   *  此前普通行根本不是落区(被 rootFilesOver 的 skip 选择器当取消),拖上去毫无反应。
   *  ponytail: 不按文件类型再细分,要「附件挂到某个 PDF 上」这种再说。 */
  const rowTarget = (path: string, mergedFd?: string) =>
    rowDropTarget(path, { mergedFd, pluginFile: !!findFileType(pluginFileTypes, path) })
  /** 插进某篇笔记的正文:v4(unified 实例已挂载)经 lifecycle 递入,v3 才走 importToPage ——
   *  ⚠️ v4 面板的 `activePage` 恒 null(真源是 activeNotePath),而 importToPage 的正文占位正是按
   *  `activePage === page` 判活,直接调它会「附件存进去了、正文一个字没变」(e2e 2b 实证)。 */
  const insertIntoPage = (files: File[], page: string): void => {
    if (!insertFilesForPath(page, files)) void importToPage(files, page)
  }
  const rowFilesOver = (e: RDragEvent<HTMLElement>, path: string, mergedFd?: string): boolean =>
    filesDragOver(e, dropKeyOf(rowTarget(path, mergedFd)))
  const rowFilesDrop = (e: RDragEvent<HTMLElement>, path: string, mergedFd?: string): boolean => {
    const tgt = rowTarget(path, mergedFd)
    // 应用内路径拖拽:落点与 OS 文件同一套(笔记进正文,其余进文件夹)。
    if ('page' in tgt ? hostPathsToPage(e, tgt.page) : hostPathsDrop(e, tgt.folder)) return true
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return false
    e.preventDefault(); e.stopPropagation()
    setDragOver(null)
    const dest = rowTarget(path, mergedFd)
    // 笔记:先打开(openNote 内含白板/仪表盘/插件类型的毁档防线,且 await 到该页真正装载),再插进正文。
    if ('page' in dest) void openNote(dest.page).then(() => insertIntoPage(files, dest.page))
    else void importToFolder(files, dest.folder)
    return true
  }
  // 根/分区空白落区:仅真空白才导入到库根;落在行/组(skip 选择器)上=取消(与内部拖拽语义一致)。
  // skip 因区而异:外层 t2s-scroll 要排掉分区体 .t2s-group-sessions,而 Vault 段体本身就是
  // .t2s-group-sessions(它是落区容器,排自己会使自身空白无法接收),故各传各的选择器。
  const rootFilesOver = (e: RDragEvent<HTMLElement>, skipSel: string): boolean => {
    if (!hasFilesType(e) && !hasHostPaths(e)) return false
    if (!(e.target as HTMLElement).closest(skipSel)) filesDragOver(e, '')
    return true
  }
  const rootFilesDrop = (e: RDragEvent<HTMLElement>, skipSel: string): boolean => {
    if (!hasFilesType(e) && !hasHostPaths(e)) return false
    if (!(e.target as HTMLElement).closest(skipSel)) filesDrop(e, '')
    return true
  }
  const commitRename = (): void => {
    const path = renaming
    setRenaming(null)
    const name = draft.trim()
    if (!path || !name) return
    // 插件复合后缀文件(.canvas.md):树上改名框给的是剥全后缀的基名,提交前把 `.canvas` 段
    // 补回去(renamePageFile IPC 只补 .md)。归一化与标题入口共用 normalizePluginRename。
    const ft = findFileType(pluginFileTypes, path)
    if (ft) {
      const ext = ft.extensions.find((e) => path.toLowerCase().endsWith(e.toLowerCase()))
      if (!ext || !/\.md$/i.test(ext)) return // 非 .md 插件后缀:renamePageFile 恒补 .md,走不了
      const withStem = normalizePluginRename(name, ext)
      if (withStem !== fileTypeBaseName(path, ft.extensions) + ext.replace(/\.md$/i, '')) void renameAt(path, withStem)
      return
    }
    if (isNotePath(path)) {
      if (name !== baseName(path)) void renameAt(path, name)
    } else if (isDbPath(path)) {
      // .db 改名走 renameDb 编排器:文件+内部 name+全库引用一起动
      if (name.replace(/\.db$/i, '') !== dbBaseName(path)) {
        renameDb(path, name).catch((e: unknown) => window.alert(translate('amxv.renameFailed', { e: e instanceof Error ? e.message : String(e) })))
      }
    }
  }
  const startRename = (path: string): void => {
    const ft = findFileType(pluginFileTypes, path) // 插件复合后缀:草稿剥全后缀,提交时补回
    setDraft(ft ? fileTypeBaseName(path, ft.extensions) : isDbPath(path) ? dbBaseName(path) : baseName(path))
    setRenaming(path); setMenu(null)
  }
  const newFolder = async (parent: string): Promise<void> => {
    const name = (await askString(
      parent ? translate('amadeus.new.folderIn', { folder: folderName(parent) }) : translate('amadeus.new.folder'),
      translate('amadeus.default.folder'),
    ))?.trim()
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
    const name = (await askString(
      parent ? translate('amadeus.new.databaseIn', { folder: folderName(parent) }) : translate('amadeus.new.database'),
      translate('amadeus.default.database'),
    ))?.trim().replace(/[\\/]/g, '')
    if (!name) return
    const rel = parent ? `${parent}/${name}.db` : `${name}.db`
    if (ps().files.some((f) => f.replace(/\\/g, '/') === rel)) {
      window.alert(translate('amadeus.exists', { name: `${name}.db` }))
      return
    }
    void (async () => {
      const bytes = new TextEncoder().encode(serializeDb(emptyDb(name)))
      await amadeus.saveAttachment('', `${name}.db`, bytes, { mode: 'vault', folder: parent })
      track('base.create'); act('base.create', { f: rel })
      await ps().refreshStructure()
      if (parent) setExpanded((prev) => new Set([...prev, ...prefixesOf(parent)]))
      openDb(rel)
    })().catch((e: unknown) => window.alert(translate('amxv.newBaseFailed', { e: e instanceof Error ? e.message : String(e) })))
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

  /** 落区高亮一律只看 `dragOver`(它只在「这儿可落」时才被置上)。**别再加 `dragPath &&` 的闸** ——
   *  dragPath 只有树内搬动才有,OS 文件 / 文件面板拖来的东西一律为空,加了闸 = 拖着文件在树上走
   *  完全没有落点反馈(e2e sidebar-drop 1b 实证)。 */
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
    void ps().createChildNote(p, translate('amadeus.default.note')).then((np) => {
      setExpanded((prev) => new Set([...prev, ...prefixesOf(fdDirOf(p))]))
      void openNote(np) // 勿直调 loadPage:那装的是活动 scope,站在主页/聊天上建子笔记同样不跳(见 createPageInFolder 注)
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
    <SidebarRow
      key={path}
      as="button"
      elRef={(el) => { if (path === flash) flashRef.current = el as HTMLButtonElement | null }}
      className={`${path === (activeViewFile ?? activePage) ? 'active' : ''}${sel.has(path) ? ' sel' : ''}${path === flash ? ' amx-flash' : ''}${path === dragPath ? ' dragging' : ''}${dragOver === dropKeyOf(rowTarget(path, merged?.fd)) ? ' amx-drop-into' : ''}`.trim() || undefined}
      selId={path}
      depth={depth}
      // 前导槽:**每行都有**(含文件夹行),故所有图标左边缘对齐、尺寸也一致(见 .t2s-lead)。
      // 槽内恒显图标(emoji 优先,否则类型兜底图标);**可展开的行 hover 才把图标换成箭头**(用户拍板)。
      lead={<>
        {icons[path]
          ? <span className="amx-page-emoji">{icons[path]}</span>
          : ft?.icon
          // 兜底必须给:`resolveIcon` 对**没命中词表的键名**返回兜底(见 components/icons 的三分流)
          // —— 不给的话,插件写了个本宿主还不认识的新键,这个槽会**整个空掉**。
          ? <span className="amx-page-emoji">{resolveIcon(ft.icon, <LeadIcon className="t2s-lead-icon t2s-dim" />)}</span>
          : <LeadIcon className="t2s-lead-icon t2s-dim" />}
        {merged && (
          <span
            className={`t2s-chev t2s-lead-chev${merged.open ? ' open' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggle(merged.fd) }}
          >
            <ChevronRight size={12} />
          </span>
        )}
      </>}
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
        // ⚠️ copyMove:树内是移动,拖去文件面板是**复制** —— 源只声明 move 而目标声明 copy,
        // 浏览器按交集协商会把整个投放判成不允许(codex 评审 2026-08-25)。
        e.dataTransfer.effectAllowed = 'copyMove'
        // 拖到聊天区 = 插入 [[笔记]] 引用(树内移动仍靠 dragPath 本地态,多带一个 MIME 不影响)。
        // 拖已选中的行 = 整批(引用与树内移动都按整批走,见 dropTo)。
        const batch = sel.batch(path)
        setChatRefDrag(e.dataTransfer, batch.map((p) => ({ kind: 'note' as const, path: p })))
        // 反向拖(库 → 文件面板):那边按**主机绝对路径**认,故本地库再带一份 PATHS_MIME;
        // 合并笔记连它的 .fd 一起带走,否则子笔记会被落下。云侧库没有本机路径,不带。
        if (vaultRoot && !(window.amadeusSync && vaultSide === 'cloud')) {
          const abs = batch.flatMap((p) => {
            const fd = isNoteMd(p) ? fdDirOf(p) : ''
            return [`${vaultRoot}/${p}`, ...(fd && folders.includes(fd) ? [`${vaultRoot}/${fd}`] : [])]
          })
          try { e.dataTransfer.setData(PATHS_MIME, JSON.stringify(abs)) } catch { /* 降级:这次拖不出去 */ }
        }
        setDragPath(path)
      }}
      onDragEnd={() => { setDragPath(null); setDragOver(null) }}
      // OS 文件对**每一行**都成立(落点见 rowFilesTarget);内部搬动仍只认合并笔记行(.fd)。
      onDragOver={(e) => { if (rowFilesOver(e, path, merged?.fd)) return; if (merged) mergedDragOver(e, path, merged.fd) }}
      onDragLeave={() => { if (dragOver === dropKeyOf(rowTarget(path, merged?.fd))) setDragOver(null) }}
      onDrop={(e) => { if (rowFilesDrop(e, path, merged?.fd)) return; if (!merged) return; e.preventDefault(); e.stopPropagation(); dropTo(merged.fd) }}
      {...tipProps(rowTip(path))}
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
          {ft ? fileTypeBaseName(path, ft.extensions) : isNote || isDraw ? baseName(path) : path.split(/[\\/]/).pop()}
        </span>
      )}
      {/* 行尾顺序:… 在左、+ 在右(同文件夹头);+ 仅笔记有(附件/.db 没有 .fd)。 */}
      <span className="t2s-srow-menu" onClick={(e) => { e.stopPropagation(); setMenu({ kind: ctxKind, path, x: e.clientX, y: e.clientY }) }}>
        <MoreHorizontal size={14} />
      </span>
      {isNote && (
        <span className="t2s-srow-menu" title={t('amadeus.new.childNote')} onClick={(e) => { e.stopPropagation(); newChild(path) }}>
          <Plus size={14} />
        </span>
      )}
    </SidebarRow>
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
              className={`t2s-group-sessions${dragOver === fd ? ' amx-drop-into' : ''}`}
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
          className={`t2s-group${folder === flash ? ' amx-flash' : ''}${dragOver === folder ? ' amx-drop-into' : ''}`}
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
          <button className="t2s-group-add" title={t('amxv.folder.actions')} onClick={(e) => { e.stopPropagation(); setMenu({ kind: 'folder', path: folder, x: e.clientX, y: e.clientY }) }}><MoreHorizontal size={14} /></button>
          <button className="t2s-group-add" title={t('amxv.folder.newNoteHere')} onClick={() => { setExpanded((prev) => new Set([...prev, ...prefixesOf(folder)])); void ps().createPageInFolder(folder) }}><Plus size={14} /></button>
        </div>
        {/* 展开的文件夹内部(含其中的笔记行)也是该文件夹的落点——与文件管理器语义一致。 */}
        {!isCol && (
          <div
            className={`t2s-group-sessions${dragOver === folder ? ' amx-drop-into' : ''}`}
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
      <SideSection id="cloud-ws" defaultOpen label={t('amxv.sec.cloudWorkspace')}>
        {cloudSections.rest.length ? cloudSections.rest.map((n) => renderNode(n, 0)) : <div className="t2s-hint amx-sec-hint">{t('amxv.empty')}</div>}
      </SideSection>
      {cloudSections.vaultSecs.map(({ name, node }) => (
        <SideSection key={name} id={`vault:${name}`} defaultOpen label={name}>
          {node && node.children.length
            ? node.children.map((c) => renderNode(c, 0))
            : <div className="t2s-hint amx-sec-hint">{node ? t('amxv.empty') : t('amxv.syncNotArrived')}</div>}
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
          className={`t2s-group-sessions${dragOver === '' ? ' amx-drop-root' : ''}`}
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
          <input value={query} placeholder={t('amxv.searchNotes')} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div
          ref={scrollRef}
          className={`t2s-scroll${dragOver === '' ? ' amx-drop-root' : ''}`}
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
            matches.length ? matches.map((p) => row(p)) : <div className="t2s-hint">{t('amxv.noMatches')}</div>
          ) : (
            <>
              <div className="t2s-special-group">
                <button className="t2s-special" onClick={() => void ps().createPage()}>
                  <span className="t2s-special-ic"><SquarePen /></span>
                  <span className="t2s-special-title">{t('amadeus.new.note')}</span>
                </button>
                <button className="t2s-special" onClick={() => newDrawing('')}>
                  <span className="t2s-special-ic"><PenTool /></span>
                  <span className="t2s-special-title">{t('amadeus.new.drawing')}</span>
                </button>
                {/* 「今天」已移除;「Vault」入口移到底部 footer(回收站下方)。 */}
              </div>

              {/* 恢复 Vault 在途(云端首开 GET /vaults+/tree)→ 列表骨架;真没库才提示「打开 Vault」。 */}
              {!vaultRoot && (vaultLoading ? <Skeleton variant="list" /> : <div className="t2s-hint">{t('amxv.openVaultHint')}</div>)}
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
            title={cloudLib ? t('amxv.cloudVaultTip') : vaultRoot || undefined}
          >
            <span className="t2s-special-ic"><FolderOpen /></span>
            <span className="t2s-special-title">{cloudLib ? t('amxv.cloudVault') : vaultRoot ? t('amxv.vaultNamed', { name: baseName(vaultRoot) }) : t('amxv.openVault')}</span>
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
          }}><Plus size={13} /> {t('amxv.menu.openNInNewTabs', { n: menu.paths?.length ?? 0 })}</button>
          <button className="danger" onClick={() => {
            const ps0 = menu.paths ?? []
            setMenu(null)
            if (!window.confirm(t('amxv.confirm.deleteSelected', { n: ps0.length }))) return
            void (async () => {
              for (const p of ps0) {
                if (isNotePath(p) && !isDrawingPath(p)) await deleteNoteFlow(p)
                else await ps().deletePage(p)
              }
              sel.clear()
            })()
          }}><Trash2 size={13} /> {t('amxv.menu.deleteN', { n: menu.paths?.length ?? 0 })}</button>
        </OverlayAt>
      )}

      {menu?.kind === 'page' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { void openNote(menu.path, { newTab: true }); setMenu(null) }}><Plus size={13} /> {t('amxv.menu.openInNewTab')}</button>
          <button onClick={() => { const p = menu.path; setMenu(null); newChild(p) }}><SquarePen size={13} /> {t('amadeus.new.childNote')}</button>
          <button onClick={() => startRename(menu.path)}><Pencil size={13} /> {t('amxv.menu.rename')}</button>
          <button onClick={() => { useAmadeusPrefs.getState().toggleStar(menu.path); setMenu(null) }}>
            <Star size={13} /> {useAmadeusPrefs.getState().starred.includes(menu.path) ? t('amxv.menu.unstar') : t('amxv.menu.star')}
          </button>
          {window.amadeusSync?.entrySyncEnable && vaultSide === 'local' && (
            isSyncedEntry(vaultRoot, menu.path) ? (
              <button onClick={() => { const p = menu.path; setMenu(null); void window.amadeusSync!.entrySyncDisable!(p) }}><CloudOff size={13} /> {t('amxv.menu.cloudSyncOff')}</button>
            ) : (
              <button onClick={() => { const p = menu.path; setMenu(null); openCloudSyncDialog(p, 'page') }}><Cloud size={13} /> {t('amxv.menu.cloudSyncOn')}</button>
            )
          )}
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> {t('amxv.menu.reveal')}</button>
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); void deleteNoteFlow(p) }}><Trash2 size={13} /> {t('amxv.menu.delete')}</button>
        </OverlayAt>
      )}
      {menu?.kind === 'asset' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          {isDbPath(menu.path) ? (
            <>
              <button onClick={() => { openDb(menu.path); setMenu(null) }}><Eye size={13} /> {t('amxv.menu.open')}</button>
              <button onClick={() => startRename(menu.path)}><Pencil size={13} /> {t('amxv.menu.rename')}</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> {t('amxv.menu.openWithSystem')}</button>
            </>
          ) : isPdfPath(menu.path) ? (
            <>
              <button onClick={() => { openPdf(menu.path); setMenu(null) }}><Eye size={13} /> {t('amxv.menu.openAnnotate')}</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> {t('amxv.menu.openWithSystem')}</button>
            </>
          ) : isImagePath(menu.path) ? (
            <>
              <button onClick={() => { openImage(menu.path); setMenu(null) }}><Eye size={13} /> {t('amxv.menu.open')}</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> {t('amxv.menu.openWithSystem')}</button>
            </>
          ) : isDrawingPath(menu.path) ? (
            <>
              <button onClick={() => { openDrawing(menu.path); setMenu(null) }}><Eye size={13} /> {t('amxv.menu.openDrawing')}</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> {t('amxv.menu.openWithSystem')}</button>
            </>
          ) : findFileType(pluginFileTypes, menu.path) ? (
            // 插件声明的文件类型(如 .mindmap.md):在应用内开它自己的视图。掉到下面的兜底就等于
            // 「用系统默认程序打开」——拿 TextEdit 打开一张思维导图。
            <>
              <button onClick={() => { openFile(menu.path); setMenu(null) }}><Eye size={13} /> {t('amxv.menu.open')}</button>
              <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><ExternalLink size={13} /> {t('amxv.menu.openWithSystem')}</button>
            </>
          ) : (
            <button onClick={() => { void amadeus.openVaultFile(menu.path).catch(() => {}); setMenu(null) }}><Eye size={13} /> {t('amxv.menu.open')}</button>
          )}
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> {t('amxv.menu.reveal')}</button>
          <button className="danger" onClick={() => { const p = menu.path; setMenu(null); if (confirmedDelete('file', p)) void ps().deletePage(p) }}><Trash2 size={13} /> {t('amxv.menu.delete')}</button>
        </OverlayAt>
      )}
      {menu?.kind === 'folder' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setExpanded((prev) => new Set([...prev, ...prefixesOf(menu.path)])); void ps().createPageInFolder(menu.path); setMenu(null) }}><SquarePen size={13} /> {t('amadeus.new.note')}</button>
          <button onClick={() => newFolder(menu.path)}><FolderPlus size={13} /> {t('amxv.menu.newSubfolder')}</button>
          <button onClick={() => newBase(menu.path)}><Database size={13} /> {t('amadeus.new.database')}</button>
          <button onClick={() => newDrawing(menu.path)}><PenTool size={13} /> {t('amadeus.new.drawing')}</button>
          <button onClick={() => newDashboard(menu.path)}><LayoutDashboard size={13} /> {t('amadeus.new.dashboard')}</button>
          {pluginFileCreators.map((o) => (
            <button key={o.item.id} onClick={() => runFileCreator(menu.path, o.item.label, o.item.run)}>
              <span style={{ display: 'inline-flex', width: 13, justifyContent: 'center', fontSize: 13 }}>{resolveIcon(o.item.icon, '📄')}</span> {o.item.label}
            </button>
          ))}
          <button onClick={() => { const f = menu.path; setMenu(null); void askString(t('amxv.renameFolder'), folderName(f)).then((name) => { const n = name?.trim(); if (n) void ps().renameFolder(f, n) }) }}><Pencil size={13} /> {t('amxv.menu.rename')}</button>
          <button onClick={() => { void amadeus.revealInFileManager(menu.path); setMenu(null) }}><FolderOpen size={13} /> {t('amxv.menu.reveal')}</button>
          {window.amadeusSync?.entrySyncEnable && vaultSide === 'local' && (
            isSyncedEntry(vaultRoot, menu.path) ? (
              <button onClick={() => { const f = menu.path; setMenu(null); void window.amadeusSync!.entrySyncDisable!(f) }}><CloudOff size={13} /> {t('amxv.menu.cloudSyncOff')}</button>
            ) : (
              <button onClick={() => { const f = menu.path; setMenu(null); openCloudSyncDialog(f, 'folder') }}><Cloud size={13} /> {t('amxv.menu.cloudSyncOn')}</button>
            )
          )}
          {window.amadeusCollab && (
            <button onClick={() => {
              const f = menu.path
              setMenu(null)
              void window.amadeusCollab!.createPublish('subtree', f)
                .then((s) => navigator.clipboard.writeText(s.url).then(() => useApp.getState().toast(t('amxv.publish.done'))))
                .catch((e) => useApp.getState().toast((e as any)?.code === 'QUOTA' ? ((e as Error).message || t('amxv.publish.quota')) : (e as any)?.status === 404 ? t('amxv.publish.ownerOnly') : t('amxv.publish.failed'), true))
            }}><Share2 size={13} /> {t('amxv.menu.publishFolder')}</button>
          )}
          <button className="danger" onClick={() => { const f = menu.path; setMenu(null); if (confirmedDelete('folder', f)) void ps().deleteFolder(f) }}><Trash2 size={13} /> {t('amxv.menu.delete')}</button>
        </OverlayAt>
      )}
      {menu?.kind === 'root' && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { void ps().createPage(); setMenu(null) }}><SquarePen size={13} /> {t('amadeus.new.note')}</button>
          <button onClick={() => newFolder('')}><FolderPlus size={13} /> {t('amadeus.new.folder')}</button>
          <button onClick={() => newBase('')}><Database size={13} /> {t('amadeus.new.database')}</button>
          <button onClick={() => newDrawing('')}><PenTool size={13} /> {t('amadeus.new.drawing')}</button>
          <button onClick={() => newDashboard('')}><LayoutDashboard size={13} /> {t('amadeus.new.dashboard')}</button>
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
function AmxMobileBar({ actions, onUpload, undo, redo, sourceMode, onNeedFocus, canvas }: {
  actions: AmxAction[]
  onUpload: () => void
  undo: () => void
  redo: () => void
  sourceMode: boolean
  onNeedFocus: () => void
  /** v4 统一页交出来的画布模式(用户 2026-08-20 拍板:常驻在胶囊里、排上传后面,不进「⋯」)。 */
  canvas: { on: boolean; toggle: () => void } | null
}) {
  const { t } = useI18n()
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
          <button onPointerDown={keep} onClick={() => (pick ? setPick(0) : openPick())} className={pick ? 'on' : undefined} title={t('amxv.mbar.insertBlock')}><Plus size={19} /></button>
        )}
        {!sourceMode && <button onPointerDown={keep} onClick={onUpload} title={t('amxv.uploadToPage')}><Upload size={19} /></button>}
        {/* 画布模式。源码模式下跟其他键一起隐:fullCanvas 本来就要求 mode !== 'source',留着是颗死键。
            v3 笔记(canvas === null)也不出 —— 那边压根没有画布这回事。 */}
        {!sourceMode && canvas && (
          <button onPointerDown={keep} onClick={canvas.toggle} className={canvas.on ? 'on' : undefined}
            title={canvas.on ? t('amxv.mbar.toDocument') : t('amxv.mbar.toCanvas')}><Frame size={19} /></button>
        )}
        {!sourceMode && <button onPointerDown={keep} onClick={undo} title={t('amxv.mbar.undo')}><Undo2 size={19} /></button>}
        {!sourceMode && <button onPointerDown={keep} onClick={redo} title={t('amxv.mbar.redo')}><Redo2 size={19} /></button>}
        <button onPointerDown={keep} onClick={() => setSheet(true)} title={t('amxv.moreActions')}><MoreHorizontal size={19} /></button>
        <button onClick={() => { setPick(0); (document.activeElement as HTMLElement | null)?.blur?.() }} title={t('amxv.mbar.hideKeyboard')}><ChevronsDown size={19} /></button>
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
/** 笔记 tab 上的图标:用户给这篇设过 emoji 就显示 emoji,否则回退成通用文件图标。
 *  ⚠️ 必须是**组件**(不是取值函数):emoji 的真源是 pageStore 的 icons 表,只有订阅了它,
 *     改完图标 tab 才会自己跟上(引擎那边只负责把 params 交过来,见 ViewDefinition.TabIcon)。
 *  icons 表本身的新鲜度由两处保证:主进程写盘即更索引(fs/pageWrite.ts)、setFm 后 refreshIcons。 */
export function NoteTabIcon({ params, size }: { params: Record<string, unknown>; size: number }): React.ReactElement {
  const notePath = typeof params.notePath === 'string' ? params.notePath : ''
  const emoji = usePageStore((s) => (notePath ? s.icons[notePath] ?? null : null))
  if (!emoji) return <FileText size={size} className="wb-tab-ic" />
  // 字号跟着 size 走:tab 高度是固定的,emoji 用 SVG 那套尺寸才不会把行撑高。
  return <span className="wb-tab-ic amx-tab-emoji" style={{ fontSize: size }} aria-hidden>{emoji}</span>
}

export function NoteTitle() {
  const { t } = useI18n()
  const store = useScopedPageStore() // 改名/设图标要作用在本面板这篇
  const sps = (): ReturnType<typeof store.getState> => store.getState()
  const activePage = usePageStore((s) => s.activePage)
  const manifest = usePageStore((s) => s.manifest)
  const icon = usePageStore((s) => (activePage ? s.icons[activePage] ?? null : null))
  // 插件复合后缀文件(.canvas.md):标题**无条件**取剥全后缀的文件基名,不看 manifest.title ——
  // 这类文件的 title 多为导入时的 'Foo.canvas' 形态,manifest?.title 短路在前会把口径修正整个
  // 架空(评审 P1:显示仍带 .canvas,且与 commit 比较口径打架=失焦假改名)。renamePage 入口补回后缀。
  const pageFt = activePage ? matchFileType(activePage) : undefined
  const current = pageFt && activePage
    ? fileTypeBaseName(activePage, pageFt.extensions)
    : manifest?.title || (activePage ? baseName(activePage) : '')
  const shown = UNTITLED_RE.test(current) ? '' : current // 未命名 → 空,露出 New Page 占位
  const [val, setVal] = useState(shown)
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  // 切换笔记 / 改名后(activePage=newPath)把输入重置为最新标题。
  useEffect(() => { setVal(shown) }, [activePage]) // eslint-disable-line react-hooks/exhaustive-deps
  // 新建笔记:光标落标题栏(Notion 式先命名)。一次性,消费即清。
  // 不再全选文本:整行蓝色选区看着像标题被框了一圈(实报),改为光标落行尾。
  useEffect(() => {
    if (!claimTitleFocus(activePage)) return
    const el = ref.current
    if (!el) return
    el.focus()
    const n = el.value.length
    el.setSelectionRange(n, n)
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
          title={t('amxv.title.changeIcon')}
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
            <button onClick={() => void sps().setPageIcon(activePage, randomEmoji())}>{t('amxv.title.addIcon')}</button>
          )}
          {!cover && (
            <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCoverPick({ x: r.right, y: r.bottom + 6 }) }}>{t('amxv.title.addCover')}</button>
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
  const { t } = useI18n()
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
  /** v4 统一页交出来的画布模式(移动端专用:顶栏不渲染 = 那颗「文档 | 画布」胶囊没插槽可投)。
   *  v3 笔记不挂 UnifiedPage → 恒 null → 底栏「⋯」里自然没有这一项。 */
  const [canvasSeg, setCanvasSeg] = useState<{ on: boolean; toggle: () => void } | null>(null)
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
      if (saved) useApp.getState().toast(t('amxv.pdf.exported', { path: saved }))
    } catch (err) {
      useApp.getState().toast(t('amxv.pdf.exportFailed', { e: String(err) }), true)
    } finally {
      wrap.remove()
    }
  }
  const isActiveLeaf = useWorkspace((s) => s.mainTabs.find((t) => t.id === leaf.id)?.active ?? false)
  const notePath = typeof leaf.params.notePath === 'string' ? leaf.params.notePath : null
  const prevActiveRef = useRef(false)
  // ── v4 绞杀者路由(spec §9 step 3 Phase A):先读原文按 fm 分类,素文件/外来 md/v4 →
  // UnifiedPage(统一实例),v3 标记文件 → 下面的 PageView 老路。分类必须**先于** effect ①:
  // 外来 md 一旦进了 pageStore,首次防抖保存就会把它改写成 v3(注 amadeus_page+标记)= 毁档类。
  // route 以 forPath 配对防陈旧:快速切换笔记时,旧文件的分类绝不套在新路径上。
  const [route, setRoute] = useState<{ forPath: string; decision: RouteDecision } | null>(null)
  /** 已按真实内容(读到了字节)定过案的路径。库根回填触发重跑时靠它挡住二次读,免得重挂编辑器。 */
  const routedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!notePath) {
      setRoute(null)
      return
    }
    // 已经按**真实内容**给这篇定过案 → 不再重读:库根变动(切库/回填)不该把活着的编辑器重挂。
    if (routedFor.current === notePath) return
    let alive = true
    void (async () => {
      let raw = await amadeus.readTextFile(notePath).catch(() => null)
      // ⚠️ 冷启动竞态:主进程库根还没就位时 readTextFile **一律返回 null**
      //    (electron/amadeus/ipc.ts 的 `if (!vault.getRoot()) return null`),而 routeNote 把
      //    raw==null 读成「文件不存在 → 新建流 → v3 块编辑器」—— 于是「刚打开 Forsion 恰好停在
      //    Amadeus 笔记上,整篇按 v3 渲染,重开这篇才正常」(用户 2026-08-20 实报)。
      //    两道保险,缺一不可:
      //    ① 本 effect 依赖 vaultRoot —— 库根一落地就**重跑重判**。这条才是根治:光靠等待,
      //       库根初始化超过等待窗就又变回永久误判(Codex 2026-08-20 high)。
      //    ② 库根未就位时先原地等一会儿 —— 纯兜底,免得先闪一下 v3 再跳回 v4;
      //       库根本来就在(常态)则一次都不等,真·新建笔记零额外延迟。
      for (let i = 0; raw == null && !myPs().vaultRoot && i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (!alive) return
        raw = await amadeus.readTextFile(notePath).catch(() => null)
      }
      if (!alive) return
      if (raw != null) routedFor.current = notePath
      setRoute({ forPath: notePath, decision: routeNote(notePath, raw, upgradeV4Enabled(), new Date().toISOString()) })
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath, vaultRoot])
  const routed = route && route.forPath === notePath ? route.decision : null
  const unifiedRoute = routed?.editor === 'unified' ? routed : null

  // 先跳转后加载:面板已认领笔记但内容未就绪(pendingPage 在途,或挂载首帧 effect① 还没发起加载)
  // → 文档骨架屏。此前这个窗口期亮的是「欢迎页」(fresh 面板)或旧笔记,云端慢网下就是「点了没反应」。
  // ⚠️ 必须先排掉 unified:v4 走 UnifiedPage,**根本不设 activePage**(见下面 barPath 的注释),
  //    于是 `notePath !== activePage` 对每一篇 v4 笔记恒真 = loadingNote 永远卡在 true。
  //    骨架屏那支排在 unified 之后看不出来,而**移动端底栏胶囊的门里带着 `!loadingNote`** ——
  //    v4 自 2026-08-14 起是缺省路由,等于手机上从那天起就没有底栏了(没有「+」/撤销/上传/「⋯」,
  //    自然也没有画布入口)。2026-08-20 用户实报「移动端没有画布」时查出。
  //    (声明也随之从 route 之前挪到了这里 —— 它只被下面的 JSX 用,没有前移的必要。)
  const loadingNote = !unifiedRoute
    && ((!!pendingPage && pendingPage !== activePage) || (!!notePath && !loadError && notePath !== activePage))

  // 顶栏/菜单/移动端胶囊的「当前笔记」:v3 = activePage;unified 不设 activePage,用 leaf 认领的路径。
  const barPath = activePage ?? (unifiedRoute && notePath ? notePath : null)
  const starred = !!barPath && starredArr.includes(barPath)
  const pinned = !!barPath && pinsArr.includes(barPath)
  const synced = canEntrySync && !!barPath && isSyncedEntry(myPs().vaultRoot, barPath)

  // unified 接管 → 让 pageStore 交出本文件的快照(新建流/装载残留):陈旧快照×reconcile 回写
  // =延时毁档链,见 pageStore.releasePage 注释。
  useEffect(() => {
    if (!unifiedRoute || !notePath) return
    // 交出的是**本面板此刻还占着的那一篇**,不是「这一篇」—— releasePage(notePath) 在 activePage
    // 停在上一篇 v3 时会 `activePage !== path` 早退,activePage 就一直留着上一篇,于是
    // `activePage ?? activeNotePath` 全线取到上一篇(A=v3 → B=v4 直接切、或后退再前进都能复现;
    // Codex 评审 high)。占着谁交谁,releasePage 内部照旧先 flush 再清。
    const held = myPs().activePage
    void myPs().releasePage(held ?? notePath)
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

  // 本面板在看哪篇 —— 反链/图谱等只读面板的路径真源(v4 不设 activePage,见 pageStore.activeNotePath)。
  useEffect(() => { myPs().setActiveNotePath(notePath) }, [notePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // v4 的导航历史(前进/后退箭头)与「最近访问」:上面那条 pageStore 订阅按 activePage 喂,
  // unified 永不设它 → v4 笔记整个不进历史。这里按 **本 leaf** 直记,归属比订阅那条的
  // activeMainPanel 推断还准(那条要防「手快切到另一半屏,历史记到隔壁」)。
  // 只在判为 unified 后记:分类在途(routed=null)时不记,免得记成一条打不开的空历史。
  useEffect(() => {
    if (!unifiedRoute || !notePath) return
    recordNav(leaf.id, `amadeus:${notePath}`, () => {
      // 恢复 = 把本 leaf 切回编辑器并指到这篇;v4 不经 loadPage(那是 v3 的装载管线)。
      // params 在**恢复那一刻**现取(同 v3 那条用 leafById):闭包里捕获的是记这条历史时的快照,
      // 拿它回写会把此后改过的其它参数一并退回去;leaf 已关掉则直接放弃。
      const w = useWorkspace.getState()
      const cur = w.leafById(leaf.id)
      if (!cur) return
      w.navigateLeaf(leaf.id, 'amadeus-editor', { ...cur.params, notePath })
    })
    useRecentViews.getState().record({ key: `note:${notePath}`, kind: 'note', id: notePath, title: baseName(notePath) })
  }, [unifiedRoute, notePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // 本 leaf 攥着的笔记被删掉 / 挪走了 → 改指,别停在一个不存在的路径上。
  // v3 靠效果③(store 导航 → activePage 变 → 认领)自愈;**v4 的 activePage 恒 null,效果③ 永不触发**
  // —— 不接这条广播,v4 标签会一直显示一个已退休(打字静默不落盘)的编辑器(Codex #1 的另一半)。
  useEffect(() => {
    if (!notePath) return
    return onNotePathGone((from, kind, to) => {
      const dead = (x: string): boolean => (kind === 'file' ? x === from : x === from || x.startsWith(`${from}/`))
      if (!dead(notePath)) return
      if (to) { // 挪走/改名:同 remap 规则算出本篇的新路径
        leaf.setParams({ ...leaf.params, notePath: kind === 'file' ? to : to + notePath.slice(from.length) })
        return
      }
      // 删除:优先跟随本面板 store 的活动页(v3 已被导航到下一篇),否则库里第一篇还活着的,再否则回欢迎页
      const st = myPs()
      const a = st.activePage
      leaf.setParams({ ...leaf.params, notePath: (a && !dead(a) ? a : st.pages.find((x) => !dead(x))) ?? undefined })
    })
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
          {/* 「文档 | 画布」胶囊(用户 2026-08-17 拍板:跟路径/分享/置顶同一行)。状态在 UnifiedPage,
              经 uiOverlay 交出来 —— 与旁边那颗可视/源码的路子一致。标记在 CanvasModeSeg(harness 共用)。 */}
          <span className={SEG_SLOT} />
          {window.amadeusCollab && <ShareStatus path={barPath} refreshKey={shareVer} onOpen={(x, y) => setShareCard({ x, y })} />}
          {/* 置顶图钉:写 amadeusPrefs(每 vault localStorage),侧边栏「置顶」分区同步点亮。 */}
          <button
            className={`amx-mode-btn amx-pin-btn${pinned ? ' amx-pin-on' : ''}`}
            title={pinned ? t('amxv.unpin') : t('amxv.pin')}
            onClick={() => useAmadeusPrefs.getState().togglePin(barPath)}
          >
            <Pin size={14} />
          </button>
          {canEntrySync && (
            <button
              className={`amx-mode-btn amx-pin-btn${synced ? ' amx-pin-on' : ''}`}
              title={synced ? t('amxv.cloud.disableTip') : t('amxv.menu.cloudSyncOn')}
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
              title={t('amxv.shareOrPublish')}
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
            title={mode === 'source' ? t('amxv.toVisualLong') : t('amxv.toSource')}
          >
            {mode === 'source' ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          {activePage && (
            <button
              className="amx-mode-btn"
              title={t('amxv.uploadToPage')}
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload size={14} />
            </button>
          )}
          <button
            className="amx-mode-btn amx-more-btn"
            title={t('amxv.moreActions')}
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
          <button onClick={() => { setNoteMenu(null); void exportPdf() }}><FileDown size={13} /> {t('amxv.menu.exportPdf')}</button>
          <button onClick={() => { useAmadeusPrefs.getState().toggleStar(barPath); setNoteMenu(null) }}>
            <Star size={13} /> {starred ? t('amxv.menu.unstar') : t('amxv.menu.star')}
          </button>
          <button onClick={() => { void amadeus.revealInFileManager(barPath); setNoteMenu(null) }}><FolderOpen size={13} /> {t('amxv.menu.reveal')}</button>
          <button className="danger" onClick={() => { const p = barPath; setNoteMenu(null); void deleteNoteFlow(p, myPs) }}>
            <Trash2 size={13} /> {t('amxv.menu.deleteNote')}
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
          onCanvasMode={setCanvasSeg}
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
            <div className="amx-welcome-title">{t('amxv.welcome.loadFailed')}</div>
            <p className="amx-welcome-sub">{loadError}</p>
            <div className="amx-welcome-actions">
              <button className="amx-welcome-btn" onClick={() => { if (notePath) void myPs().loadPage(notePath) }}>{t('amxv.retry')}</button>
            </div>
          </div>
        ) : (
        <div className="amx-welcome">
          <div className="amx-welcome-title">{t('amxv.welcome.title')}</div>
          <p className="amx-welcome-sub">
            {vaultRoot
              ? t('amxv.welcome.pickNote')
              : t('amxv.welcome.noVault')}
          </p>
          <div className="amx-welcome-actions">
            {vaultRoot ? (
              <>
                <button className="amx-welcome-btn" onClick={() => void myPs().createPage()}><SquarePen size={16} /> {t('amadeus.new.note')}</button>
                {/* 新手的第一站:教程本身是一篇可改的笔记(生成到 vault),文档/画布两种模式都讲。 */}
                <button className="amx-welcome-btn ghost" onClick={() => void openTutorial()}><BookOpen size={16} /> {t('amxv.welcome.tutorial')}</button>
              </>
            ) : (
              <button className="amx-welcome-btn" onClick={() => void myPs().openVault()}><FolderOpen size={16} /> {t('amxv.welcome.openVaultFolder')}</button>
            )}
          </div>
          <ul className="amx-welcome-tips">
            <li><span className="amx-kbd">[[</span> {t('amxv.welcome.tip1')}</li>
            <li><Paperclip size={13} /> {t('amxv.welcome.tip2')}</li>
            <li><Code2 size={13} /> {t('amxv.welcome.tip3')}</li>
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
        canvas={canvasSeg}
        onUpload={() => uploadInputRef.current?.click()}
        undo={() => { if (activePage) myPs().undo() }}
        redo={() => { if (activePage) myPs().redo() }}
        onNeedFocus={() => { if (activePage) focusBody(myStore) }}
        actions={[
          { id: 'mode', icon: mode === 'source' ? <Eye size={16} /> : <Code2 size={16} />, label: mode === 'source' ? t('amxv.toVisual') : t('amxv.toSource'), run: () => useUiOverlay.getState().toggleEditorMode() },
          // ⚠️ 门是 barPath 不是 activePage:v4 不设 activePage(见 barPath 注释),按 activePage 判
          // 这一条在每篇 v4 笔记上都会整条消失 —— 而隐藏 input 与它的 onChange 都认 unified 路。
          ...(barPath ? [{ id: 'upload', icon: <Upload size={16} />, label: t('amxv.uploadToPage'), run: () => uploadInputRef.current?.click() }] : []),
          { id: 'pin', icon: <Pin size={16} />, label: pinned ? t('amxv.unpin') : t('amxv.pin'), on: pinned, run: () => useAmadeusPrefs.getState().togglePin(barPath!) },
          { id: 'star', icon: <Star size={16} />, label: starred ? t('amxv.menu.unstar') : t('amxv.menu.star'), on: starred, run: () => useAmadeusPrefs.getState().toggleStar(barPath!) },
          ...(canEntrySync ? [{ id: 'sync', icon: <Cloud size={16} />, label: synced ? t('amxv.cloud.disableTip') : t('amxv.menu.cloudSyncOn'), on: synced, run: () => { if (synced) void window.amadeusSync?.entrySyncDisable?.(barPath!); else openCloudSyncDialog(barPath!, 'page') } }] : []),
          ...(window.amadeusCollab ? [{ id: 'share', icon: <Share2 size={16} />, label: t('amxv.shareOrPublish'), run: () => setShareCard({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) }] : []),
          { id: 'pdf', icon: <FileDown size={16} />, label: t('amxv.menu.exportPdf'), run: () => void exportPdf() },
          { id: 'reveal', icon: <FolderOpen size={16} />, label: t('amxv.menu.reveal'), run: () => void amadeus.revealInFileManager(barPath!) },
          { id: 'delete', icon: <Trash2 size={16} />, label: t('amxv.menu.deleteNote'), danger: true, run: () => void deleteNoteFlow(barPath!, myPs) },
        ]}
      />
    )}
    </>
  )
}

// ─────────────────────────────── 右:大纲 / 反链(原生 Tangu 列表) ───────────────────────────────

export function AmadeusOutlineView() {
  const { t } = useI18n()
  // v3/v4 两条路由的取标题与跳转都封在 useNoteOutline(此前这里只认 v3 的 manifest+blocks,
  // v4 笔记恒显示「没有标题」)。插件版大纲面板与本视图现在共用同一份实现。
  const heads = useNoteOutline()

  return (
    <div className="amx-panel">
      <div className="amx-panel-head">{t('amadeus.outline')}</div>
      {heads.length === 0 ? (
        <div className="amx-panel-empty">{t('amxv.outline.empty')}</div>
      ) : (
        <div className="amx-list">
          {heads.map((h) => (
            <button key={h.key} className="amx-list-item" style={{ paddingLeft: 10 + (h.level - 1) * 12 }} onClick={h.go} title={h.text}>{h.text}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 指定笔记的大纲(仪表盘「大纲卡」用)。
 *
 * ⚠️ **必须自建 PageScope**:嵌卡渲染在仪表盘的 `PageScopeCtx`(value = 仪表盘 leaf id)之下,
 * 直接 `loadPage(path)` 会把**仪表盘那份 store 的 activePage 换掉** —— 屏幕上的表现是「加了一张
 * 大纲卡,整个仪表盘变成了那篇笔记」。同理适用于任何将来进嵌卡白名单、又会 loadPage 的视图。
 */
export function ScopedPageOutline({ path, scope }: { path: string; scope: string }) {
  return (
    <PageScopeCtx.Provider value={scope}>
      <ScopedPageOutlineInner path={path} scope={scope} />
    </PageScopeCtx.Provider>
  )
}

function ScopedPageOutlineInner({ path, scope }: { path: string; scope: string }) {
  const { t } = useI18n()
  const store = useScopedPageStore()
  useEffect(() => {
    if (path && store.getState().activePage !== path) void store.getState().loadPage(path)
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => disposePageScope(scope), [scope])
  if (!path) return <div className="amx-panel"><div className="amx-panel-empty">{t('amxv.outline.noNote')}</div></div>
  return <AmadeusOutlineView />
}

export function AmadeusBacklinksView() {
  const { t } = useI18n()
  // v4 笔记不设 activePage → 回落到 activeNotePath,否则本视图对 v4 恒显示「未打开笔记」。
  const activePage = usePageStore((s) => s.activePage ?? s.activeNotePath)
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
      <div className="amx-panel-head">{t('amadeus.backlinks')} · {refs.length}</div>
      {!activePage ? (
        <div className="amx-panel-empty">{t('amxv.backlinks.noNote')}</div>
      ) : refs.length === 0 ? (
        <div className="amx-panel-empty">{t('amxv.backlinks.empty')}</div>
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
