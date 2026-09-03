import { createContext, useContext } from 'react'
import { create, useStore } from 'zustand'
import type { FocusPlace } from '../blocks/registry'
import { bumpNextId, generateColumnId, generateRowId, nextBlockId, stripPageBasename } from '@amadeus-shared/compiler/names'
import type {
  BlockEntry,
  BlockId,
  ColumnId,
  ColumnNode,
  LoadedPage,
  PageManifest,
  RowId,
  RowNode,
  StackNode,
} from '@amadeus-shared/compiler/types'
import { pageKey, resolvePageName } from '@amadeus-shared/links'
import { parsePdfLinkInner, parseMediaLinkInner } from '@amadeus-shared/pdfLink'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { patchFmExtraText } from '@amadeus-shared/db/pageFrontmatter'
import { amadeus } from '../api'
import { computeFdChildren, fdDirOf, isNoteMd, nearestFd, noteOfFd } from '../lib/fd'
import { resolveFileName, resolveVaultPath } from '../lib/vaultFiles'
import { makeUndoStack, type Snap } from '../lib/undoHistory'
import { useUiStore } from './uiStore'
import { awaitTypingQuiet, installTypingGuard, noteLocalEdit } from './typingGuard'
import { flushUnifiedScopes, retireUnifiedPath } from '../unified/lifecycle'
import { track } from '../../achievements/store'
import { act } from '../../activity/log'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'pagestore.error.renameUnsupportedType': { zh: '该文件类型不支持在标题栏改名', en: 'This file type cannot be renamed from the title bar' },
  'pagestore.error.fdNameTaken': { zh: '目标名称已被同名 .fd 文件夹占用', en: 'That name is already taken by a .fd folder' },
  'pagestore.error.moveIntoOwnSubpage': { zh: '不能移动到该笔记自己的子页面里', en: "A note can't be moved into its own subpages" },
  'pagestore.error.fdExistsAtDest': { zh: '目标位置已存在同名 .fd 文件夹', en: 'A .fd folder with the same name already exists at the destination' },
  'pagestore.error.fdMoveFailed': { zh: '子页面文件夹未跟随移动:{err}', en: "The subpage folder didn't move along with the note: {err}" },
  'pagestore.notify.movedToTrash': { zh: '已移入回收站', en: 'Moved to trash' },
  'pagestore.confirm.deleteEmbeddedBlock': {
    zh: '有 {n} 处笔记嵌入了这个块，删除后那些嵌入会显示「丢失」。仍要删除？',
    en: 'This block is embedded in {n} place(s). Those embeds will show as missing once it is deleted. Delete anyway?',
  },
})

export interface BlockState {
  id: BlockId
  type: string
  content: string
}

interface Loc {
  rowIdx: number
  colIdx: number
  childIdx: number
}

const clone = <T>(x: T): T => structuredClone(x)

// 外部回灌不许打断正在敲的那一下(输入法 + 尚未落进 store 的最新输入),见 typingGuard.ts。
if (typeof document !== 'undefined') installTypingGuard(document)

function locate(root: StackNode, id: BlockId): Loc | null {
  for (let r = 0; r < root.children.length; r++) {
    const row = root.children[r]
    for (let c = 0; c < row.columns.length; c++) {
      const i = row.columns[c].children.findIndex((ref) => ref.ref === id)
      if (i >= 0) return { rowIdx: r, colIdx: c, childIdx: i }
    }
  }
  return null
}

/** 跨块 ↑↓ 的结构化落点(替代 flatOrder 顺序跳块):先同列上/下邻块;到列顶/底则去相邻行中
 *  「goalX 所在列」的末/首块;整页顶/底 → null(留在原地)。两栏时列顶按 ↑ 不会横跳到另一列。 */
function spatialFocusTarget(
  root: StackNode,
  id: BlockId,
  dir: 'prev' | 'next',
  goalX: number | undefined,
): BlockId | null {
  const loc = locate(root, id)
  if (!loc) return null
  const col = root.children[loc.rowIdx].columns[loc.colIdx]
  if (dir === 'prev') {
    if (loc.childIdx > 0) return col.children[loc.childIdx - 1].ref // 同列上一块
    if (loc.rowIdx > 0) {
      const prevRow = root.children[loc.rowIdx - 1]
      const kids = prevRow.columns[columnByGoalX(prevRow, goalX)].children
      return kids.length ? kids[kids.length - 1].ref : null // 上一行、goalX 所在列的末块
    }
    return null // 整页首块
  }
  if (loc.childIdx < col.children.length - 1) return col.children[loc.childIdx + 1].ref // 同列下一块
  if (loc.rowIdx < root.children.length - 1) {
    const nextRow = root.children[loc.rowIdx + 1]
    const kids = nextRow.columns[columnByGoalX(nextRow, goalX)].children
    return kids.length ? kids[0].ref : null // 下一行、goalX 所在列的首块
  }
  return null // 整页末块
}

/** 相邻行里哪一列水平盖住 goalX(取该列各块 DOM 的 union 横跨);单列/无 goalX → 0;都不盖住 → 最近列。
 *  ponytail: 靠已挂载块的 DOM 几何判列。相邻行整行尚未分片挂载(大页 >24 行且恰在挂载前沿)时无几何 → 回退列 0;
 *  极少见,后果仅「偶尔落错栏」。要更准可按 column.width 分数 + 行容器宽推算,但那行容器多半也未挂载,不值当。 */
function columnByGoalX(row: RowNode, goalX: number | undefined): number {
  if (row.columns.length <= 1 || goalX == null) return 0
  let best = 0
  let bestDist = Infinity
  for (let c = 0; c < row.columns.length; c++) {
    let left = Infinity
    let right = -Infinity
    for (const ref of row.columns[c].children) {
      const el = document.querySelector(`.block-host[data-block-id="${CSS.escape(ref.ref)}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      left = Math.min(left, r.left)
      right = Math.max(right, r.right)
    }
    if (right <= left) continue // 该列未挂载/无几何
    if (goalX >= left && goalX <= right) return c
    const d = Math.abs(goalX - (left + right) / 2)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function findColumn(root: StackNode, colId: ColumnId): { row: RowNode; col: ColumnNode } | null {
  for (const row of root.children) {
    for (const col of row.columns) {
      if (col.id === colId) return { row, col }
    }
  }
  return null
}

function normalizeWidths(row: RowNode): void {
  if (row.columns.length === 1) {
    row.columns[0].width = 1
    return
  }
  const sum = row.columns.reduce((s, c) => s + (c.width > 0 ? c.width : 0), 0)
  if (sum <= 0) {
    const w = 1 / row.columns.length
    row.columns.forEach((c) => (c.width = w))
    return
  }
  row.columns.forEach((c) => (c.width = (c.width > 0 ? c.width : 0) / sum))
}

/** Drop empty columns and rows, renormalizing widths of survivors. */
function cleanup(root: StackNode): void {
  for (let r = root.children.length - 1; r >= 0; r--) {
    const row = root.children[r]
    for (let c = row.columns.length - 1; c >= 0; c--) {
      if (row.columns[c].children.length === 0) row.columns.splice(c, 1)
    }
    if (row.columns.length === 0) {
      root.children.splice(r, 1)
      continue
    }
    normalizeWidths(row)
  }
}

function appendToEnd(root: StackNode, id: BlockId): void {
  const lastRow = root.children[root.children.length - 1]
  if (lastRow) {
    lastRow.columns[lastRow.columns.length - 1].children.push({ ref: id })
  } else {
    root.children.push({
      type: 'row',
      id: generateRowId(),
      columns: [{ id: generateColumnId(), width: 1, children: [{ ref: id }] }],
    })
  }
}

/** 把 id 所在的「单列多子」行拆开,让 id 独占一行(前段留原行、后段成新行);
 *  多列行/已独占行原样不动。原地修改 root,返回 id 所在行的下标(找不到块返回 null)。
 *  这是分栏 Notion 化的关键:页面块常年堆在同一行同一列里,行级分栏会把整页劈两半。 */
function isolateBlockRow(root: StackNode, id: BlockId): number | null {
  const loc = locate(root, id)
  if (!loc) return null
  const row = root.children[loc.rowIdx]
  if (row.columns.length !== 1 || row.columns[0].children.length <= 1) return loc.rowIdx
  const col = row.columns[0]
  const before = col.children.slice(0, loc.childIdx)
  const self = col.children[loc.childIdx]
  const after = col.children.slice(loc.childIdx + 1)
  const mkRow = (children: { ref: BlockId }[]): RowNode => ({
    type: 'row',
    id: generateRowId(),
    columns: [{ id: generateColumnId(), width: 1, children }],
  })
  const rows: RowNode[] = []
  let selfRow: RowNode
  if (before.length) {
    col.children = before // 原行(保行/列 id)装前段
    rows.push(row)
    selfRow = mkRow([self])
  } else {
    col.children = [self] // 无前段:原行即本块行
    selfRow = row
  }
  rows.push(selfRow)
  if (after.length) rows.push(mkRow(after))
  root.children.splice(loc.rowIdx, 1, ...rows)
  return root.children.indexOf(selfRow)
}

export type Status = 'idle' | 'loading' | 'ready' | 'saving'
// 单源在 blocks/registry(2026-08-18 加 'body-enter' 档时两份撞车,这里改成转发别再分叉)。
export type { FocusPlace }

interface PageState {
  vaultRoot: string | null
  /** 胶囊滑块所在侧:local=用户自选 vault,cloud=云镜像目录(仅桌面;web/mobile 恒 local)。 */
  vaultSide: 'local' | 'cloud'
  pages: string[]
  folders: string[]
  /** Non-page files (attachments/.db/…), vault-relative — shown in the vault tree. */
  files: string[]
  /** 页面 emoji 图标(fm icon: 键;path → emoji)。桌面索引供给,其余端为空表。 */
  icons: Record<string, string>
  activePage: string | null
  /** 导航乐观反馈:点击即置,加载成败后清。侧边栏高亮用 pendingPage ?? activePage,高延迟(云端)下点击零等待变色。 */
  pendingPage: string | null
  manifest: PageManifest | null
  blocks: Record<BlockId, BlockState>
  /** 整页装载身份:每次整页 hydrate(loadPage/改名/新建/外部回灌)换一个新对象。跨 await 的
   *  破坏性操作(deleteBlock 的反链确认)必须比对它 —— 只比 activePage 路径,A→B→A 往返后
   *  路径相同但块 id 已易主,会删掉新页里的同名块(Codex P0,2026-08-14)。 */
  loadNonce: object
  status: Status
  error: string | null
  /** 启动恢复 Vault 在途(云端首开 GET /vaults+/tree):侧栏树据此显示骨架屏,别把加载态当「未开 Vault」空态。 */
  vaultLoading: boolean
  /** A pending request to move the caret into a specific block (after create/delete/nav). */
  /** anchor:源码↔可视切换带过来的「光标前文本」,块内按它找回落点(见 lib/modeCursor)。 */
  focusRequest: { id: BlockId; place: FocusPlace; goalX?: number; anchor?: string } | null
  /** Transient drag state for drop-target feedback (the block being dragged / hovered). */
  dndActiveId: string | null
  dndOverId: string | null
  /** Bumped whenever on-disk links may have changed (save / external reconcile); backlink & tag panels watch it. */
  linkGraphVersion: number
  /** 本 scope 当前在看的笔记路径 —— **v3 与 v4 通用**。v4/unified 刻意不设 activePage
   *  (那是 v3 块编辑器的装载态,给了它 reconcile 会拿陈旧快照回写=延时毁档,见 releasePage),
   *  于是反链/图谱这些只读面板一律读空。它由编辑器 leaf 的 notePath 驱动,两条路由都写,
   *  面板一律用 `activePage ?? activeNotePath`。releasePage 交出 v3 快照时**不清**它。 */
  activeNotePath: string | null
  setActiveNotePath(path: string | null): void
  /** 盘上链接可能变了(v4 unified 自写账本不走 store 的 save,得自己吱一声)。 */
  bumpLinkGraph(): void

  openVault(): Promise<void>
  restoreVault(): Promise<void>
  /** Local↔Cloud 全局切活动 vault(树/编辑器/聚合全跟随);仅桌面(window.amadeusSync)。 */
  switchVaultSide(side: 'local' | 'cloud'): Promise<void>
  /** 启动时从主进程取当前侧(lastVault 可能落在云镜像)。 */
  initVaultSide(): Promise<void>
  refreshPages(): Promise<void>
  /** 只刷全库页面图标(path → emoji)。⚠️ refreshPages **不碰** icons —— 这张表的真源是主进程索引,
   *  改完 frontmatter 想让侧栏 emoji 跟上就得显式调它(2026-08-31 用户实报的一半症状)。 */
  refreshIcons(): void
  loadPage(path: string): Promise<void>
  createPage(): Promise<void>
  /** Create a new untitled page inside `folder` (vault-relative; '' = vault root) and open it. */
  createPageInFolder(folder: string): Promise<void>
  /** 统一实例编辑器接管 path:flush 后清空本 scope 快照(防陈旧快照经 reconcile 回写)。 */
  releasePage(path: string): Promise<void>
  /** 打开某路径的笔记;不存在则先创建(日记等「打开或新建」语义)。 */
  openOrCreate(path: string): Promise<void>
  renamePage(newName: string): Promise<boolean>
  /** Open the page named by a [[wikilink]];未解析 → 记入 pendingWikiCreate 询问,不再静默创建。 */
  openWikiLink(name: string, sourcePath?: string): void
  /** 未解析 [[链接]] 点击后的待确认创建请求(确认框据此渲染)。 */
  pendingWikiCreate: { name: string; sourcePath: string | null } | null
  /** 确认创建:裸名 → 源笔记 .fd 子笔记;带路径 → 按链接写明的精确路径;无源 → vault 根。 */
  confirmWikiCreate(): Promise<void>
  cancelWikiCreate(): void
  /** 显式创建意图(QuickSwitcher 新建):vault 根、不询问(= 历史 openWikiLink 的创建分支)。 */
  createWikiPage(name: string): Promise<void>
  /** 在 parentPath 的 .fd 里建子笔记(名字对全库 pageKey 与 .fd 内文件双重去重,同步父 children),
   *  返回新 vault 相对路径;不导航。「在笔记内创建文件」的统一落点。 */
  createChildNote(parentPath: string, name: string): Promise<string>
  /** 重算并写回 parent 的 frontmatter children(= .fd 直接子文件清单;父笔记开着时走内存路径)。 */
  syncFdChildren(parentNotePath: string): Promise<void>
  /** 对一批路径,找各自所属 .fd 的父笔记并同步 children(去重)。 */
  syncFdParentsOf(paths: string[]): Promise<void>
  /** 设置/清除页面 emoji 图标(写 fm icon: 键;活动页走内存 fmExtra 防 clobber)。 */
  setPageIcon(pagePath: string, icon: string | null): Promise<void>
  /** 设置/清除页面封面(fm cover: 键 = http URL 或 vault 相对路径;同 icon 双路写)。 */
  setPageCover(pagePath: string, cover: string | null): Promise<void>
  /** 设置封面纵向焦点(fm cover_y: 0-100 百分比,object-position 用;拖拽调焦点落盘)。 */
  setPageCoverY(pagePath: string, y: number | null): Promise<void>

  /** Refresh both the page list and the folder list from disk. */
  refreshStructure(): Promise<void>
  /** Delete a page; if it was active, open another (or clear). */
  deletePage(pagePath: string): Promise<void>
  /** Move a page into another folder ('' = vault root). */
  movePage(pagePath: string, destFolder: string): Promise<void>
  /** Create a folder under `parentFolder` ('' = vault root). */
  createFolder(parentFolder: string, name: string): Promise<void>
  /** Rename a folder; remaps the active page's path if it lived inside. */
  renameFolder(folderPath: string, newName: string): Promise<void>
  /** Delete a folder and its contents; if the active page was inside, open another (or clear). */
  deleteFolder(folderPath: string): Promise<void>

  requestFocus(id: BlockId, place: FocusPlace, goalX?: number): void
  /** 源码模式切回可视时把光标送回原块:落在 anchor 之后,找不到则块首。 */
  requestFocusAt(id: BlockId, anchor: string): void
  consumeFocus(id: BlockId): void
  flatOrder(): BlockId[]
  focusAdjacent(id: BlockId, dir: 'prev' | 'next', goalX?: number): void
  deleteBlockFocusPrev(id: BlockId): void
  /** Merge a block's content into the previous block, then delete it (Backspace at start). */
  mergeWithPrev(id: BlockId): void

  setBlockContent(id: BlockId, content: string): void
  insertBlockAfter(afterId: BlockId | null, colId?: ColumnId, initialContent?: string): BlockId
  /** Insert several blocks after `afterId`(模板插入;单次 _commit,布局依序排在其后)。 */
  insertBlocksAfter(afterId: BlockId | null, contents: string[]): void
  /** Append a cross-note embed cell (`![[target]]`) as a new full-width row. */
  insertEmbed(target: string): void
  duplicateBlock(id: BlockId): void
  deleteBlock(id: BlockId): Promise<void>
  /** Move a block into a column, before `beforeId` (or to the end when null). */
  moveBlock(id: BlockId, toColId: ColumnId, beforeId: BlockId | null): void
  /** Move a block up/down within its column (keyboard reorder). */
  moveBlockDir(id: BlockId, dir: 'up' | 'down'): void
  /** Transient drag feedback. */
  setDnd(activeId: string | null, overId: string | null): void
  /** Split: pull a block into a new column on one side of a row (Notion-style columns). */
  addColumnWithBlock(rowId: RowId, id: BlockId, side: 'left' | 'right'): void
  /** 分栏(Notion 语义):本块独占一行后与新空块并排成两栏;焦点落新栏。 */
  splitToColumn(id: BlockId, side: 'left' | 'right'): void
  /** 拖到某块左/右边缘:仅与那一块并排成行(自动把它从「大杂烩行」里拆出来)。 */
  pairBlocks(dragId: BlockId, targetId: BlockId, side: 'left' | 'right'): void
  /** Pull a block into a brand-new full-width row after the given row index. */
  addRowWithBlock(afterRowIndex: number, id: BlockId): void
  /** Resize the divider between two adjacent columns (leftFraction of their combined width). */
  resizeColumns(rowId: RowId, leftColId: ColumnId, rightColId: ColumnId, leftFraction: number): void

  /** Overwrite the note's foreign frontmatter(属性面板;'' = 清空)。 */
  setFmExtra(text: string): void

  save(): Promise<void>
  /** Force any pending debounced save to disk now, so the main index is fresh before navigating/searching. */
  flushSave(): Promise<void>
  reconcileExternal(path: string): Promise<void>

  /** 文档级撤销/重做(Cmd+Z / Cmd+Shift+Z / Cmd+Y):覆盖块内文字 + 块的增删/合并/移动/斜杠转换。 */
  undo(): void
  redo(): void

  _commit(manifest: PageManifest, blocks?: Record<BlockId, BlockState>): void
}

function hydrate(page: LoadedPage): {
  manifest: PageManifest
  blocks: Record<BlockId, BlockState>
  loadNonce: object
} {
  const blocks: Record<BlockId, BlockState> = {}
  for (const [id, b] of Object.entries(page.blocks)) {
    blocks[id] = { id, type: b.type, content: b.content }
  }
  return { manifest: page.manifest, blocks, loadNonce: {} }
}

/**
 * 一份文档状态 = 一个 store 实例。**每个编辑器面板各持一份**,分屏才能同时编辑两篇不同笔记
 * (此前是模块级单例,两个面板并排显示的必然是同一篇 —— 用户实报「不能分屏」)。
 * ⚠️ 保存定时器 / 载入序号 / 在途写这几个可变量必须住在**实例闭包**里:留在模块级就会被另一个
 * 面板清掉,表现为「一边打字另一边的保存被取消」。
 */
/** 作用域级选项(pageStoreFor 首次建店时传入)。
 *  sink = **内存作用域**:save() 不写库,把编译输入(manifest + 块内容)交给它 —— 插件仪表盘挂载
 *  (dashboardSurface)用它把「渲染仪表盘」与「住在库里」解耦:没有打开的笔记库也能开,手排的布局
 *  由插件自己持久化。有 sink 的作用域**绝不**碰 amadeus.savePage/loadPage。 */
export interface PageStoreOptions {
  sink?: (path: string, manifest: PageManifest, contents: Record<string, string>) => Promise<void> | void
}

function makePageStore(opts: PageStoreOptions = {}) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let loadSeq = 0
  // 在途保存(save() 进行中):loadPage 并行化后,仅当目标 path 与在途写同文件时才需等待。
  // ponytail: 单槽记账——并发 save 罕见(防抖+flush 都走这里),槽被覆盖时最坏退回旧的「读到略旧内容」现状。
  let flushingPath: string | null = null
  let inflightSave: Promise<void> | null = null
  // 外部回灌的合流闸(每面板一份):打字静默期内押后,期间来的事件排进待办集合逐个补做。
  // ⚠️ reconcileGate 不只是记账 —— save() 必须等它,见 save() 顶部那段(评审 P0)。
  const reconcilePending = new Set<string>()
  let reconcileBusy = false
  let reconcileGate: Promise<void> | null = null

  return create<PageState>((set, get) => {
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      // ⚠️ 必须在这里清空:定时器烧掉后 saveTimer 仍留着旧句柄,flushSave() 会误以为「还有待写」
      // 而再发一次 save —— 两次写盘并发,谁后完成谁说了算,先发的旧快照可能盖掉后发的新内容(Codex)。
      saveTimer = null
      void get().save()
    }, 400)
  }

  // 文档级撤销/重做:快照 = {manifest, blocks}。两者恒以不可变替换更新(mutation 一律 spread 出新对象),
  // 故存引用即安全 —— 旧快照不会被后续改动就地篡改。struct(结构变更,经 _commit)每步一快照;
  // edit(打字,setBlockContent)按 ~500ms 同类合并成一步,避免逐字建步。
  // 文档级撤销栈:快照 data = {manifest, blocks}。两者恒以不可变替换更新(mutation 一律 spread 出新对象),
  // 存引用即安全 —— 旧快照不会被后续改动就地篡改。纯栈逻辑(打字合并 + 跨页数据安全守卫)见 undoHistory.ts。
  type Doc = { manifest: PageManifest | null; blocks: Record<BlockId, BlockState> }
  const history = makeUndoStack<Doc>()
  const snapNow = (): Snap<Doc> => {
    const s = get()
    return { page: s.activePage, data: { manifest: s.manifest, blocks: s.blocks } }
  }
  const pushUndo = (kind: 'edit' | 'struct'): void => history.push(snapNow(), kind, Date.now())

  /** 拉全库页面 emoji 图标(带重试)。此前失败被 `.catch(() => {})` 静默吞掉 → icons 永远空表:
   *  列表 emoji 与笔记标题大图标(都读这张表)一起消失,要手动刷新/切库才恢复(2026-08-05 用户实报
   *  「图标莫名不显示」)。移动端弱网/后台唤醒期一次失败很常见 → 3s/12s 各补一枪;
   *  root 已变(切库)立即放弃,由新根自己的流程拉,同原 root 守卫语义。 */
  const fetchIcons = (root: string | null, attempt = 0): void => {
    void amadeus.pageIcons?.()
      .then((icons) => { if (get().vaultRoot === root) set({ icons }) })
      .catch(() => {
        if (attempt < 2 && get().vaultRoot === root) setTimeout(() => fetchIcons(root, attempt + 1), attempt === 0 ? 3000 : 12_000)
      })
  }

  return {
    vaultRoot: null,
    vaultSide: 'local',
    pages: [],
    folders: [],
    files: [],
    icons: {},
    activePage: null,
    pendingPage: null,
    manifest: null,
    blocks: {},
    loadNonce: {},
    status: 'idle',
    error: null,
    vaultLoading: false,
    focusRequest: null,
    dndActiveId: null,
    dndOverId: null,
    linkGraphVersion: 0,
    activeNotePath: null,
    pendingWikiCreate: null,

    setActiveNotePath(path) {
      if (get().activeNotePath !== path) set({ activeNotePath: path })
    },
    bumpLinkGraph() {
      set((s) => ({ linkGraphVersion: s.linkGraphVersion + 1 }))
    },

    setDnd(activeId, overId) {
      set({ dndActiveId: activeId, dndOverId: overId })
    },

    requestFocus(id, place, goalX) {
      set({ focusRequest: { id, place, goalX } })
    },
    requestFocusAt(id, anchor) {
      set({ focusRequest: { id, place: 'start', anchor } })
    },
    consumeFocus(id) {
      const fr = get().focusRequest
      if (fr && fr.id === id) set({ focusRequest: null })
    },
    flatOrder() {
      const m = get().manifest
      if (!m) return []
      const out: BlockId[] = []
      for (const row of m.root.children)
        for (const col of row.columns) for (const ref of col.children) out.push(ref.ref)
      return out
    },
    focusAdjacent(id, dir, goalX) {
      const m = get().manifest
      if (!m) return
      const target = spatialFocusTarget(m.root, id, dir, goalX)
      if (!target) return // 真·顶/底边界 → 留在原地(列顶按 ↑ 不横跳邻列 = 直觉)
      get().requestFocus(target, dir === 'prev' ? 'end' : 'start', goalX)
    },
    deleteBlockFocusPrev(id) {
      const order = get().flatOrder()
      const i = order.indexOf(id)
      const prev = i > 0 ? order[i - 1] : null
      const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null
      get().deleteBlock(id)
      const target = prev ?? next
      if (target) get().requestFocus(target, prev ? 'end' : 'start')
    },

    mergeWithPrev(id) {
      const order = get().flatOrder()
      const i = order.indexOf(id)
      if (i <= 0) return // no previous block
      const prevId = order[i - 1]
      const blocks = get().blocks
      const prevContent = blocks[prevId]?.content ?? ''
      const curContent = blocks[id]?.content ?? ''
      // 合并进同一个块 = 变成相邻两行(单个 '\n' 就是一次换行,见 softBreak.ts)。空行是用户敲出来的
      // 东西,合并不该凭空造一个 —— 从前用 '\n\n' 无妨(读端会把空段落吃掉),现在空行会如实还原。
      // ⚠️ 前块末行是列表/引用/表格时仍留空行:markdown 的 lazy continuation 会把后文吸进那个列表项。
      const lastLine = prevContent.split('\n').pop() ?? ''
      const lazyRisk = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\||#{1,6}\s|```|~~~)/.test(lastLine)
      const sep = lazyRisk ? '\n\n' : '\n'
      const merged = prevContent && curContent ? `${prevContent}${sep}${curContent}` : prevContent + curContent
      pushUndo('struct') // 快照清白的合并前状态;下面 deleteBlock→_commit 的 struct 快照会被 500ms 同类合并掉
      set((s) => ({ blocks: { ...s.blocks, [prevId]: { ...s.blocks[prevId], content: merged } } }))
      get().deleteBlock(id) // commits manifest + schedules a save that persists merged content
      // 光标落**接缝处**(= 前块原内容之后),不是合并后整块的末尾:后者会把光标留在被并上来的
      // 那段文字尾巴上,用户看到的就是「内容上去了,光标还留在第二行」(实报)。
      // anchor 匹配纯文本;前块末尾含 markdown 语法时优雅退化到块首(见 lib/modeCursor)。
      if (prevContent && curContent) get().requestFocusAt(prevId, prevContent.slice(-40))
      else get().requestFocus(prevId, 'end')
    },

    async openVault() {
      try {
        // 与 switchVaultSide 同理:换根前先把各面板的待存内容写回【旧根】。
        // 这里的 flush 放在弹目录选择框之前,用户取消了也无害(本来就该落盘)。
        await flushAllScopes()
        const info = await amadeus.openVault()
        if (!info) return
        resetAllScopeDocs()
        // files 先清空再异步补齐;迟到的结果只在 vault 未再切换时落盘(防旧库文件列表污染新库的树)。
        // 用户手选文件夹 = 本地侧(主进程同步记 localVault)。
        set({ vaultRoot: info.root, vaultSide: 'local', pages: info.pages, folders: info.folders ?? [], files: [], error: null })
        void amadeus.listFiles?.().then((files) => { if (get().vaultRoot === info.root) set({ files }) }).catch(() => {})
        fetchIcons(info.root)
        if (info.pages.length > 0) await get().loadPage(info.pages[0])
      } catch (e) {
        set({ error: String(e) })
      }
    },

    async restoreVault() {
      set({ vaultLoading: true })
      try {
        const info = await amadeus.restoreVault()
        if (!info) return
        set({ vaultRoot: info.root, pages: info.pages, folders: info.folders ?? [], files: [], error: null })
        void amadeus.listFiles?.().then((files) => { if (get().vaultRoot === info.root) set({ files }) }).catch(() => {})
        fetchIcons(info.root)
        const target =
          info.lastPage && info.pages.includes(info.lastPage) ? info.lastPage : info.pages[0]
        if (target) await get().loadPage(target)
      } catch (e) {
        set({ error: String(e) })
      } finally {
        set({ vaultLoading: false })
      }
    },

    async switchVaultSide(side) {
      const api = window.amadeusSync
      if (!api?.switchSide || get().vaultSide === side) return
      try {
        // 切根前必须先把待存内容在【旧根】落盘并等掉在途写:保存走「相对路径 + 当前根」,
        // 根先换会把旧库活动页原样写进新库(本地页凭空复制进云端库、再被在线同步推上服务器)。
        // **所有面板**都要 flush —— 分屏后隔壁面板各有一份 store 和一个防抖定时器。
        await flushAllScopes()
        await inflightSave?.catch(() => {})
        const info = await api.switchSide(side)
        if (!info) return
        set({
          vaultSide: side,
          vaultRoot: info.root,
          pages: info.pages,
          folders: info.folders ?? [],
          files: [],
          icons: {}, // 换库必清:图标是 path 键,跨库残留会张冠李戴
          error: null,
          // 旧库编辑器状态即刻作废:switchSide 往返窗口里的输入不得再借任何 flush 写进新根
          activePage: null,
          pendingPage: null,
          manifest: null,
          blocks: {},
        })
        resetAllScopeDocs() // 隔壁面板也一起作废,否则它那份旧库笔记随时会写进新根
        void amadeus.listFiles?.().then((files) => { if (get().vaultRoot === info.root) set({ files }) }).catch(() => {})
        fetchIcons(info.root)
        const target = info.lastPage && info.pages.includes(info.lastPage) ? info.lastPage : info.pages[0]
        if (target) await get().loadPage(target)
        else set({ activePage: null, pendingPage: null, manifest: null, blocks: {}, activeNotePath: null }) // 空库(如未登录的云侧):清编辑器,防旧库笔记误存新根
      } catch (e) {
        set({ error: String(e) })
      }
    },

    async initVaultSide() {
      const api = window.amadeusSync
      if (!api?.get) return
      try {
        const st = await api.get()
        const side = (st as { side?: 'local' | 'cloud' } | null)?.side
        if (side) set({ vaultSide: side })
      } catch {
        /* 旧主进程无此接口:保持 local */
      }
    },

    async refreshPages() {
      const pages = await amadeus.listPages()
      set({ pages })
    },

    refreshIcons() {
      fetchIcons(get().vaultRoot)
    },

    async loadPage(path) {
      const seq = ++loadSeq // last-request-wins:双击/多 tab 竞速时,迟到的结果不得覆盖新导航
      // 乐观反馈先行:点击即高亮/即提示,再谈网络(云端一个往返 ~300ms,反馈不能等它)。
      set({ pendingPage: path, status: 'loading', error: null })
      // 上一页的在途保存与新页加载并行(不同文件互不相干);唯「读写同一文件」
      // (重载当前页/切回正在保存的页)才等写完,防读回旧内容。链接索引在保存侧推进,顺序无关。
      const flush = get().flushSave().catch(() => { /* save() 自己置 error */ })
      if (path === get().activePage || path === flushingPath) {
        await flush
        if (path === flushingPath) await inflightSave?.catch(() => {}) // 更早发起的在途写也要等
      }
      try {
        const page = await amadeus.loadPage(path)
        if (seq !== loadSeq) return // 已被更新的导航取代
        set({ activePage: path, pendingPage: null, ...hydrate(page), status: 'ready' })
      } catch (e) {
        if (seq === loadSeq) set({ status: 'idle', error: String(e), pendingPage: null })
      }
    },

    async createPage() {
      await get().createPageInFolder('')
    },

    async openOrCreate(path) {
      // 一律走 loadPage:主进程 loadPage 本就是「存在则解析、不存在才 newPage」,绝不覆盖已有文件
      // (缓存 pages[] 可能落后于磁盘,直接 newPage 会把已有笔记清空)。
      const known = get().pages.includes(path)
      await get().loadPage(path)
      if (!known) await get().refreshPages()
    },

    async createPageInFolder(folder) {
      await get().flushSave() // 换页前落盘,防 400ms 待存的上一页内容被丢/写错对象
      const norm = folder.replace(/\\/g, '/').replace(/\/+$/, '')
      const existing = new Set(get().pages)
      const join = (base: string): string => (norm ? `${norm}/${base}` : base)
      let base = 'untitled.md'
      let n = 1
      while (existing.has(join(base))) {
        n++
        base = `untitled-${n}.md`
      }
      const path = join(base)
      // v4(2026-08-13):新建笔记以**素文件**出生(空纯 md,零 frontmatter 零标记)——
      // amadeusViews 的绞杀者路由把它送进统一实例编辑器,不再用 newPage 造 v3(amadeus_page+标记)。
      // 素文件对旧端=外来 md(照常可编辑,混装矩阵见 spec §5.2),不受「手机闸」限制。
      await amadeus.writeTextFile(path, '')
      track('note.create'); act('note.create', { f: path })
      await get().refreshPages()
      // 聚焦请求必须先于导航:后设时 UnifiedPage 已经挂载并跑完一次性消费 effect,
      // 信号永远等不到下一次 path 变化,表现成"新笔记偶尔不进标题编辑"。
      requestTitleFocus(path)
      // ⚠️ 导航必须交给宿主的 openNote 门面,别在这里直调 loadPage:loadPage 装的是**活动 scope**,
      // 而活动 scope 只跟着编辑器面板走(amadeusViews effect ②)—— 站在主页/聊天/新标签上新建时,
      // 它指着一个后台的编辑器 tab:笔记静默装进看不见的那份 store(当前 view 不跳),还会被那个 tab
      // 的 effect ③ 认领走(标题+params 被改写)。用户实报:"工作区列表里有新笔记,当前 view 没跳过去"。
      // 无人接管(纯 amadeus 宿主 / 台架 / 单测)→ 照旧就地装载。
      if (navigateToNote(path)) return
      // loadPage 对已存在的素文件走 importForeign(纯读不回写):店内快照一致 + effect③ 认领;
      // 视图层路由判为 unified 后会调 releasePage 把这份快照交出去。
      await get().loadPage(path)
    },

    async releasePage(path) {
      // 统一实例编辑器(UnifiedPage)接管的文件:本 scope 的 v3 快照必须交出去。留着的话,
      // 它订阅的 reconcileExternal 会拿**陈旧内容**跟磁盘做合并回写 —— unified 的保存走
      // 自写账本不进 store,快照只会越来越旧,这条链等于延时毁档。flush 在先防丢待写。
      if (get().activePage !== path) return
      await get().flushSave()
      if (get().activePage !== path) return // flush 间隙已切走
      set({ activePage: null, pendingPage: null, manifest: null, blocks: {} })
    },

    async renamePage(newName) {
      const { manifest: manifest0, activePage } = get()
      if (!manifest0 || !activePage) return false
      // 复合后缀保全(.canvas.md 等插件文件类型):标题栏给的是剥掉全后缀的基名,而主进程
      // IPC 只剥/补 `.md` —— 不在**入口**把 `.canvas` 段补回去,改名一次就把文件类型改丢。
      // 归一化与树上 commitRename 共用 pluginExt.normalizePluginRename(口径分叉=叠床名,评审 P2)。
      // 动态 import 破 pageStore↔pluginStore 静态环(先例:pluginStore.ts:150 注)。
      {
        const { matchFileType } = await import('../plugins/pluginStore')
        const { normalizePluginRename } = await import('../plugins/pluginExt')
        const ext = matchFileType(activePage)?.extensions.find((e) => activePage.toLowerCase().endsWith(e.toLowerCase()))
        if (ext) {
          // 本 IPC 恒产出 .md 路径:非 .md 类插件后缀(注册面允许 '.xyz')走这条必然改坏类型,直接拒。
          if (!/\.md$/i.test(ext)) {
            set({ error: translate('pagestore.error.renameUnsupportedType') })
            return false
          }
          newName = normalizePluginRename(newName, ext)
        }
      }
      // .fd 级联预检:新名对应的 .fd 位置已被占 → 先中止,不做半级联。
      const oldFd = fdDirOf(activePage)
      const hasFd = get().folders.includes(oldFd)
      if (hasFd) {
        let base = newName.trim().replace(/[\\/]/g, '')
        if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
        if (base) {
          const dir = activePage.includes('/') ? activePage.slice(0, activePage.lastIndexOf('/')) : ''
          const newFd = dir ? `${dir}/${base}.fd` : `${base}.fd`
          const { pages, folders, files } = get()
          if (newFd !== oldFd && (folders.includes(newFd) || pages.includes(newFd) || files.includes(newFd))) {
            set({ error: translate('pagestore.error.fdNameTaken') })
            return false
          }
        }
      }
      if (saveTimer) {
        clearTimeout(saveTimer) // cancel a pending save aimed at the OLD filename
        saveTimer = null
      }
      // 改名会触发主进程全库引用重写(propagateRenames):**所有面板**先落盘 ——
      // 别的面板 400ms 待存的旧文本会在重写完成后写回、把改好的 [[链接]] 盖掉;
      // 本面板更早发出的在途写也要等(旧路径写盘晚于移动 = 旧文件复活)。(Codex 评审 P1)
      await flushAllScopes()
      // 快照必须在 flush **之后**取:标题回车改名的同一拍正文就可能继续输入,入口处的旧快照
      // 会经 IPC 把 flush 期间的编辑覆写回旧内容(Codex 评审 P0)。页在 await 间被换掉则中止。
      const { manifest, blocks, activePage: nowPage } = get()
      if (!manifest || nowPage !== activePage) return false
      const contents: Record<string, string> = {}
      for (const [id, b] of Object.entries(blocks)) contents[id] = b.content
      try {
        const { newPath, page } = await amadeus.renamePage(activePage, newName, manifest, contents)
        set({ activePage: newPath, pendingPage: null, ...hydrate(page), status: 'ready', error: null })
        remapScopePaths(activePage, newPath, 'file') // 分屏里同页的其他面板跟着换路径,防旧路径被写活
        if (hasFd && newPath !== activePage) await cascadeFdAfterRename(activePage, newPath)
        await get().refreshStructure() // 级联可能动了文件夹,pages+folders 一起刷
        return true
      } catch (e) {
        set({ error: String(e) })
        return false
      }
    },

    async setPageCover(pagePath, cover) {
      const patch = { cover: cover ?? undefined }
      const { activePage, manifest } = get()
      if (pagePath === activePage && manifest) {
        const next = patchFmExtraText(manifest.fmExtra ?? '', patch)
        if (next !== null && next !== (manifest.fmExtra ?? '')) get().setFmExtra(next)
      } else {
        await amadeus.setPageFrontmatter?.(pagePath, patch)
      }
    },

    async setPageCoverY(pagePath, y) {
      const patch = { cover_y: y ?? undefined }
      const { activePage, manifest } = get()
      if (pagePath === activePage && manifest) {
        const next = patchFmExtraText(manifest.fmExtra ?? '', patch)
        if (next !== null && next !== (manifest.fmExtra ?? '')) get().setFmExtra(next)
      } else {
        await amadeus.setPageFrontmatter?.(pagePath, patch)
      }
    },

    async setPageIcon(pagePath, icon) {
      const patch = { icon: icon ?? undefined }
      // 乐观更新本地表(索引重建有延迟);下次 refreshStructure 以索引为准
      set((st) => {
        const icons = { ...st.icons }
        if (icon) icons[pagePath] = icon
        else delete icons[pagePath]
        return { icons }
      })
      const { activePage, manifest } = get()
      if (pagePath === activePage && manifest) {
        // 活动页:改内存 fmExtra 走防抖保存(外科写会被 save() 用旧 fmExtra 盖回,同 syncFdChildren)
        const next = patchFmExtraText(manifest.fmExtra ?? '', patch)
        if (next !== null && next !== (manifest.fmExtra ?? '')) get().setFmExtra(next)
      } else {
        await amadeus.setPageFrontmatter?.(pagePath, patch)
      }
    },

    openWikiLink(name, sourcePath) {
      const raw = name.trim()
      if (!raw) return
      const src = sourcePath ?? get().activePage ?? undefined
      // PDF 目标 [[report.pdf#page=N]] → 应用内可批注阅读器(必须先接住 raw:linkTarget 会砍掉 #page=)。
      const pdf = parsePdfLinkInner(raw)
      if (pdf) {
        const pdfFile = resolveFileName(pdf.target, get().files, src)
        if (pdfFile) window.dispatchEvent(new CustomEvent('amadeus:open-pdf', { detail: { path: pdfFile, page: pdf.loc?.page } }))
        return // 是 PDF 链接:命中即开;未命中也不落「创建笔记」兜底(带 # 的名字无意义)
      }
      // 媒体时刻锚 [[lecture.mp4#t=95]] → 先问本页有没有这个播放器(就地 seek,不重建元素);
      // 没人接 → 开独立的 amadeus-media 视图(方案 P1,2026-08-28 落地)。在此之前这里回落系统
      // 播放器,时间戳静默丢失 —— 那是本轮修掉的另一半 bug(聊天引用条是同一个病的第一半)。
      // 必须先接住 raw:linkTarget 会砍掉 `#t=`,与上面 PDF 分支同一个坑。
      const media = parseMediaLinkInner(raw)
      if (media) {
        const hit = resolveFileName(media.target, get().files, src)
        if (hit && media.loc) {
          // 同步派发 + handled 回执:监听器同步执行,派发完就能读到有没有人认领。
          const ev = new CustomEvent('amadeus:media-goto', {
            detail: { path: hit, at: media.loc.at, to: media.loc.to, handled: false },
          })
          window.dispatchEvent(ev)
          if ((ev.detail as { handled: boolean }).handled) return
        }
        // 有时刻锚才改道应用内播放器:裸 `[[a.mp4]]` 维持原样交系统播放器(那是既有语义,
        // 本轮只修「时间戳静默丢失」这半边;要不要把裸链也收进应用内是另一个决定)。
        // 动态 import:amadeusNav 反向 import 本模块,静态引会绕出模块环。
        if (hit && media.loc) {
          const loc = media.loc
          void import('../../amadeusNav').then((m) => m.openMedia(hit, loc))
          return
        }
        if (hit) void amadeus.openVaultFile?.(hit)?.catch(() => {})
        return // 带 # 的名字落「创建笔记」兜底无意义,同 PDF 分支
      }
      // 裸 URL [[https://…]] → 外链。**绝不落「创建笔记」兜底**:此前它过不了下面三道解析,
      // 直落 pendingWikiCreate,用户点确认就会在库里造出一篇叫 `https:/x.com/a.md` 的垃圾笔记。
      if (/^https?:\/\//i.test(raw)) {
        // 桌面走主进程 shell:openExternal;web/移动端没有 window.tangu —— 不兜底就是**点了没反应**
        // (降级铁律:能力缺席时必须给可点落点,绝不静默)。
        if (window.tangu?.openExternal) void window.tangu.openExternal(raw)
        else window.open(raw, '_blank', 'noopener')
        return
      }
      // 画板命名空间([[X.excalidraw]] 链接,Obsidian 惯例省 .md;listPages 不收画板 → 页面命中不可能):
      // 应用内开白板 tab(事件解耦同 open-db)。绝不落「创建笔记」兜底 —— createWikiPage 的 newPage
      // 会把已有画板文件覆盖成空笔记。
      if (isDrawingPath(raw)) {
        const hit = resolveFileName(raw, get().files, src) ?? resolveFileName(`${raw}.md`, get().files, src)
        window.dispatchEvent(new CustomEvent('amadeus:open-drawing', { detail: { path: hit ?? raw } }))
        return
      }
      const match = resolvePageName(raw, get().pages, src)
      if (match) {
        void get().loadPage(match)
        return
      }
      // 文件命名空间([[xxx.db]]/[[photo.png]],页面未命中才轮到):.db 应用内开
      // (渲染层不 import 宿主 openDb,发事件由 amadeusOverlays 接;无监听的宿主静默),其余系统程序打开。
      const file = resolveFileName(raw, get().files, src)
      if (file) {
        if (/\.db$/i.test(file)) window.dispatchEvent(new CustomEvent('amadeus:open-db', { detail: { path: file } }))
        else void amadeus.openVaultFile?.(file)?.catch(() => {})
        return
      }
      // 名字直接命中库里的一个**已存在文件**(插件声明的文件类型走这条:`[[图.mindmap.md]]`、
      // 省 .md 的 `[[图.mindmap]]`、任何 `.<子类型>.md` 复合后缀)。必须赶在下面的「创建笔记」兜底
      // 之前 —— newPage 会把这份已有文件覆盖成空笔记 = 毁档。
      // 用 resolveVaultPath 而非上面的 resolveFileName:后者的 isFileRef 闸把一切 `.md` 结尾的名字
      // 都挡掉,而这些类型的正典写法恰恰以 `.md` 结尾,过不了那道闸就永远解析不到。
      // 事件解耦同 open-db:渲染层不 import 宿主的 openFile(无监听的宿主静默)。
      const vaultHit = resolveVaultPath(raw, get().files, src) ?? resolveVaultPath(`${raw}.md`, get().files, src)
      if (vaultHit) {
        window.dispatchEvent(new CustomEvent('amadeus:open-file', { detail: { path: vaultHit } }))
        return
      }
      // 未解析:询问而非静默建根。源须是笔记(.db 独立视图等无 .fd 语义 → 走根兜底)。
      set({ pendingWikiCreate: { name: raw, sourcePath: src && isNoteMd(src) ? src : null } })
    },

    async createWikiPage(name) {
      const base = name.trim().replace(/[\\/]/g, '') // filesystem-safe basename for the new page
      if (!base) return
      try {
        await get().flushSave() // 换页前落盘,防待存的上一页内容被丢/写错对象
        const path = `${base}.md`
        const page = await amadeus.newPage(path)
        track('note.create'); act('note.create', { f: path })
        await get().refreshPages()
        requestTitleFocus(path)
        set({ activePage: path, pendingPage: null, ...hydrate(page), status: 'ready' })
      } catch (e) {
        set({ error: String(e) })
      }
    },

    async confirmWikiCreate() {
      const pending = get().pendingWikiCreate
      if (!pending) return
      set({ pendingWikiCreate: null })
      const { name, sourcePath } = pending
      try {
        if (/[\\/]/.test(name)) {
          // 路径限定链接:按链接写明的精确路径创建(Obsidian 语义,不折叠进 .fd)。
          const clean = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
          if (!clean) return
          await get().flushSave()
          const path = /\.md$/i.test(clean) ? clean : `${clean}.md`
          const page = await amadeus.newPage(path)
          track('note.create'); act('note.create', { f: path })
          await get().refreshStructure()
          requestTitleFocus(path)
          set({ activePage: path, pendingPage: null, ...hydrate(page), status: 'ready' })
          return
        }
        if (sourcePath) {
          const p = await get().createChildNote(sourcePath, name)
          await get().loadPage(p)
          return
        }
        await get().createWikiPage(name)
      } catch (e) {
        set({ error: String(e) })
      }
    },

    cancelWikiCreate() {
      set({ pendingWikiCreate: null })
    },

    async createChildNote(parentPath, name) {
      await get().flushSave() // 父笔记先落盘(正文与新子文件同批可见)
      const fd = fdDirOf(parentPath)
      const stem = name.trim().replace(/[\\/]/g, '').replace(/\.md$/i, '') || translate('amadeus.default.note')
      const { pages, files } = get()
      // 双重去重:全库 pageKey(保证父笔记里插入的 [[base]] 唯一解析到新子笔记)+ .fd 内同名文件。
      const globalKeys = new Set(pages.map(pageKey))
      const inFd = new Set(
        [...pages, ...files].filter((p) => p.startsWith(`${fd}/`)).map((p) => p.split('/').pop()!.toLowerCase()),
      )
      let base = stem
      for (let i = 1; globalKeys.has(pageKey(base)) || inFd.has(`${base}.md`.toLowerCase()); i++) base = `${stem}-${i}`
      const path = `${fd}/${base}.md`
      await amadeus.newPage(path) // mkdir -p 语义:desktop atomicWrite / cloud materializeParents / mobile 同
      track('note.create'); act('note.create', { f: path })
      await get().syncFdChildren(parentPath) // 内含 refreshStructure
      requestTitleFocus(path) // 打开后落光标到标题栏(调用方负责导航)
      return path
    },

    async syncFdChildren(parentNotePath) {
      await get().refreshStructure() // children 是 pages/files 的纯函数,先取最新
      const { pages, files, activePage, manifest } = get()
      if (!pages.includes(parentNotePath)) return // 父笔记不在(孤儿 .fd / 已删)→ 跳过
      const children = computeFdChildren(parentNotePath, pages, files)
      const patch = { children: children.length ? children : undefined }
      if (parentNotePath === activePage && manifest) {
        // 父笔记开着:改内存 fmExtra 走防抖保存 —— 外科写会被后续 save() 用旧 fmExtra 盖回去
        // (桌面自写 ledger 抑制 reconcile 回声,内存不会自动更新),这是实测过的真实风险。
        const next = patchFmExtraText(manifest.fmExtra ?? '', patch)
        if (next !== null && next !== (manifest.fmExtra ?? '')) get().setFmExtra(next)
      } else {
        await amadeus.setPageFrontmatter?.(parentNotePath, patch) // ?. 容忍旧 preload 缺位(漂移可自愈)
      }
    },

    async syncFdParentsOf(paths) {
      const parents = new Set<string>()
      for (const p of paths) {
        const fd = nearestFd(p)
        if (fd) parents.add(noteOfFd(fd))
      }
      for (const parent of parents) await get().syncFdChildren(parent)
    },

    async refreshStructure() {
      const [pages, folders, files] = await Promise.all([
        amadeus.listPages(),
        amadeus.listFolders(),
        amadeus.listFiles?.() ?? [], // 旧 preload(无 listFiles)下优雅降级为空
      ])
      set({ pages, folders, files })
      fetchIcons(get().vaultRoot)
    },

    async deletePage(pagePath) {
      const fd = isNoteMd(pagePath) ? fdDirOf(pagePath) : null
      const hasFd = !!fd && get().folders.includes(fd)
      const active = get().activePage
      // 级联删 .fd:活动页在父笔记或其 .fd 子树内都要善后(不能让待存回魂/编辑器悬空)。
      const activeInside =
        !!active && (active === pagePath || (hasFd && active.startsWith(`${fd}/`)))
      if (activeInside && saveTimer) {
        clearTimeout(saveTimer) // don't let a pending save resurrect the deleted page
        saveTimer = null
      }
      // unified(v4)实例:先冲洗在途写,**删除成功后**才退休 —— 先退休再删,一旦删除 IPC 失败,
      // 文件还在而编辑器已永久只读,后续输入全部静默丢失(Codex 终审 P0)。删除 IPC 窗口里新排的
      // 防抖写 ≥800ms,晚于紧随其后的退休,复活窗口可忽略。
      await flushUnifiedScopes()
      // 桌面端优先移入回收站(.trash,可恢复);缺 trash API 的端保持硬删。
      const trash = amadeus.trashEntry?.bind(amadeus)
      try {
        if (trash) await trash(pagePath)
        else await amadeus.deletePage(pagePath)
      } catch (e) {
        set({ error: String(e) })
        return
      }
      retireUnifiedPath(pagePath)
      if (hasFd && fd) retireUnifiedPath(fd, 'prefix')
      clearScopeNotePaths(pagePath, 'file') // v4:activeInside 那条善后分支看不见它(Codex 评审 high)
      if (hasFd && fd) clearScopeNotePaths(fd, 'prefix')
      if (hasFd) {
        try {
          if (trash) await trash(fd)
          else await amadeus.deleteFolder(fd)
        } catch (e) {
          set({ error: String(e) }) // 失败 = 孤儿 .fd,树里按普通文件夹可见,可手动处理
        }
      }
      if (trash) useUiStore.getState().notify(translate('pagestore.notify.movedToTrash'))
      await get().refreshStructure()
      await get().syncFdParentsOf([pagePath]) // 删的若是别人的 .fd 子文件,更新那位父亲的 children
      if (activeInside) {
        const next = get().pages.find((p) => p !== pagePath) ?? null
        if (next) await get().loadPage(next)
        else set({ activePage: null, pendingPage: null, manifest: null, blocks: {}, status: 'idle', activeNotePath: null })
      }
      // 放在善后**之后**广播:v3 此刻 activePage 才落到 next,标签的回落逻辑读它才是对的。
      emitNotePathGone(pagePath, 'file', null)
      if (hasFd && fd) emitNotePathGone(fd, 'prefix', null)
    },

    async movePage(pagePath, destFolder) {
      const fd = isNoteMd(pagePath) ? fdDirOf(pagePath) : null
      const hasFd = !!fd && get().folders.includes(fd)
      const dst = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      if (hasFd) {
        if (dst === fd || dst.startsWith(`${fd}/`)) {
          set({ error: translate('pagestore.error.moveIntoOwnSubpage') })
          return
        }
        // 预检目标位置的同名 .fd,避免 .md 移完文件夹移不动的半级联。
        const fdName = fd.split('/').pop()!
        const fdDst = dst ? `${dst}/${fdName}` : fdName
        const { pages, folders, files } = get()
        if (fdDst !== fd && (folders.includes(fdDst) || pages.includes(fdDst) || files.includes(fdDst))) {
          set({ error: translate('pagestore.error.fdExistsAtDest') })
          return
        }
      }
      const active = get().activePage
      const wasActive = active === pagePath
      const activeInFd = !!active && hasFd && active.startsWith(`${fd}/`)
      // 移动会触发全库引用重写:所有面板先落盘(不止本面板;理由同 renamePage,Codex 评审 P1)。
      await flushAllScopes()
      try {
        const newPath = await amadeus.movePage(pagePath, dst)
        // unified 实例握着旧路径,后续编辑会把旧文件写回来(remap 只认 v3 scope;Codex P0)。
        retireUnifiedPath(pagePath)
        if (wasActive) set({ activePage: newPath, pendingPage: null })
        remapScopePaths(pagePath, newPath, 'file')
        if (hasFd) {
          try {
            const newFd = await amadeus.moveFolder(fd, dst)
            retireUnifiedPath(fd, 'prefix')
            if (activeInFd) set({ activePage: newFd + active.slice(fd.length) })
            remapScopePaths(fd, newFd, 'prefix')
          } catch (e) {
            set({ error: translate('pagestore.error.fdMoveFailed', { err: String(e) }) })
          }
        }
        await get().refreshStructure()
        await get().syncFdParentsOf([pagePath, newPath]) // 拖出/拖入 .fd 两端的父亲都同步
      } catch (e) {
        set({ error: String(e) })
        await get().refreshStructure()
      }
    },

    async createFolder(parentFolder, name) {
      try {
        await amadeus.createFolder(parentFolder, name)
      } catch (e) {
        set({ error: String(e) })
        return
      }
      await get().refreshStructure()
    },

    async renameFolder(folderPath, newName) {
      const active = get().activePage
      // 文件夹改名触发树下全部页面的引用重写:所有面板先落盘(理由同 renamePage,Codex 评审 P1)。
      await flushAllScopes()
      try {
        const newFolder = await amadeus.renameFolder(folderPath, newName)
        retireUnifiedPath(folderPath, 'prefix') // unified 实例不吃 remap,退休防旧路径复活(Codex P0)
        if (active && (active === folderPath || active.startsWith(folderPath + '/'))) {
          set({ activePage: newFolder + active.slice(folderPath.length) })
        }
        remapScopePaths(folderPath, newFolder, 'prefix')
      } catch (e) {
        set({ error: String(e) })
        return
      }
      await get().refreshStructure()
    },

    async deleteFolder(folderPath) {
      const active = get().activePage
      const activeInside = !!active && (active === folderPath || active.startsWith(folderPath + '/'))
      if (activeInside && saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      // 同 deletePage:先冲洗,删除成功后才退休(删失败不许把树下 unified 实例变永久只读,Codex 终审 P0)。
      await flushUnifiedScopes()
      try {
        if (amadeus.trashEntry) {
          await amadeus.trashEntry(folderPath)
          useUiStore.getState().notify(translate('pagestore.notify.movedToTrash'))
        } else {
          await amadeus.deleteFolder(folderPath)
        }
      } catch (e) {
        set({ error: String(e) })
        return
      }
      retireUnifiedPath(folderPath, 'prefix') // 树下 unified 实例的防抖写会复活刚删的文件(Codex P0)
      clearScopeNotePaths(folderPath, 'prefix') // 同 deletePage:v4 的 activeNotePath 不清就指着已删的路径
      await get().refreshStructure()
      if (activeInside) {
        const next = get().pages[0] ?? null
        if (next) await get().loadPage(next)
        else set({ activePage: null, pendingPage: null, manifest: null, blocks: {}, status: 'idle', activeNotePath: null })
      }
      emitNotePathGone(folderPath, 'prefix', null)
    },

    setBlockContent(id, content) {
      noteLocalEdit()
      pushUndo('edit')
      set((s) => ({ blocks: { ...s.blocks, [id]: { ...s.blocks[id], content } } }))
      scheduleSave()
    },

    insertBlockAfter(afterId, colId, initialContent = '') {
      const m = get().manifest
      const page = get().activePage
      if (!m || !page) return ''
      const newId = nextBlockId(Object.keys(m.blocks), m.nextId)
      const root = clone(m.root)

      if (afterId) {
        const loc = locate(root, afterId)
        if (loc) root.children[loc.rowIdx].columns[loc.colIdx].children.splice(loc.childIdx + 1, 0, { ref: newId })
        else appendToEnd(root, newId)
      } else if (colId) {
        const t = findColumn(root, colId)
        if (t) t.col.children.push({ ref: newId })
        else appendToEnd(root, newId)
      } else {
        appendToEnd(root, newId)
      }

      const entry: BlockEntry = { type: 'markdown' }
      const blocks = {
        ...get().blocks,
        [newId]: { id: newId, type: 'markdown', content: initialContent },
      }
      get()._commit({ ...m, root, blocks: { ...m.blocks, [newId]: entry }, nextId: bumpNextId(m.nextId, newId) }, blocks)
      get().requestFocus(newId, initialContent ? 'end' : 'start')
      return newId
    },

    insertBlocksAfter(afterId, contents) {
      const m = get().manifest
      if (!m || !contents.length) return
      const root = clone(m.root)
      // 逐个生成 id(nextBlockId 需已知全集防撞)。
      const ids: BlockId[] = []
      let known = Object.keys(m.blocks)
      for (let i = 0; i < contents.length; i++) {
        const id = nextBlockId(known, m.nextId)
        ids.push(id)
        known = [...known, id]
      }
      const loc = afterId ? locate(root, afterId) : null
      if (loc) root.children[loc.rowIdx].columns[loc.colIdx].children.splice(loc.childIdx + 1, 0, ...ids.map((ref) => ({ ref })))
      else for (const id of ids) appendToEnd(root, id)
      const bm = { ...m.blocks }
      const blocks = { ...get().blocks }
      ids.forEach((id, i) => {
        bm[id] = { type: 'markdown' }
        blocks[id] = { id, type: 'markdown', content: contents[i] }
      })
      get()._commit({ ...m, root, blocks: bm, nextId: ids.reduce(bumpNextId, m.nextId) }, blocks)
      get().requestFocus(ids[ids.length - 1], 'end')
    },

    insertEmbed(target) {
      // An embed is just a normal block whose content is an `![[ ]]` directive; BlockHost
      // renders such a block read-only by resolving the target. Append it as a new row.
      get().insertBlockAfter(null, undefined, `![[${target}]]`)
    },

    duplicateBlock(id) {
      const src = get().blocks[id]
      if (!src) return
      get().insertBlockAfter(id, undefined, src.content)
    },

    async deleteBlock(id) {
      const m = get().manifest
      const page = get().activePage
      const nonce = get().loadNonce
      if (!m) return
      // Embedded elsewhere? Warn before its content is removed. Block ids are note-local,
      // so the backlink query is scoped by the active note.
      if (m.blocks[id] && page) {
        try {
          const refs = await amadeus.blockBacklinks(`${stripPageBasename(page)}#${id}`)
          if (refs.length > 0) {
            const ok = window.confirm(
              translate('pagestore.confirm.deleteEmbeddedBlock', { n: refs.length }),
            )
            if (!ok) return
          }
        } catch {
          /* backlink check is best-effort */
        }
      }
      // 二次读取:上面的 backlink 查询是 await,期间可能有别的结构操作改了 manifest / fmExtra;仍按最初
      // 快照 m 提交会把那次改动(含 mindmap 关系 frontmatter)一并回滚(Codex)。改用 await 后的最新 manifest。
      // 且必须**核对活动页 + 装载身份**:块 id 是页内递增的(两页都有 `b1`),await 期间用户切了页就会
      // 删掉另一个文件里的同名块;只比路径不够 —— A→B→A 往返后路径相同但页已重装、id 已易主,
      // loadNonce 每次整页 hydrate 都换新对象,比它才关得死(Codex P0,2026-08-14)。
      if (get().activePage !== page || get().loadNonce !== nonce) return
      const cur = get().manifest
      if (!cur) return
      const root = clone(cur.root)
      const loc = locate(root, id)
      if (loc) root.children[loc.rowIdx].columns[loc.colIdx].children.splice(loc.childIdx, 1)
      cleanup(root)
      const blocks = { ...get().blocks }
      delete blocks[id]
      const bm = { ...cur.blocks }
      delete bm[id]
      // 删除也要抬高水位:干净的 1,2 笔记没有存量 floor,删 2 后必须记 3,否则下次插入原地复用 2。
      get()._commit({ ...cur, root, blocks: bm, nextId: bumpNextId(cur.nextId, id) }, blocks)
    },

    moveBlock(id, toColId, beforeId) {
      const m = get().manifest
      if (!m) return
      const root = clone(m.root)
      const loc = locate(root, id)
      if (!loc) return
      const [ref] = root.children[loc.rowIdx].columns[loc.colIdx].children.splice(loc.childIdx, 1)
      const target = findColumn(root, toColId)
      if (!target) return
      const idx = beforeId
        ? (() => {
            const i = target.col.children.findIndex((r) => r.ref === beforeId)
            return i >= 0 ? i : target.col.children.length
          })()
        : target.col.children.length
      target.col.children.splice(idx, 0, ref)
      cleanup(root)
      get()._commit({ ...m, root })
    },

    moveBlockDir(id, dir) {
      const m = get().manifest
      if (!m) return
      const root = clone(m.root)
      const loc = locate(root, id)
      if (!loc) return
      const col = root.children[loc.rowIdx].columns[loc.colIdx]
      const target = loc.childIdx + (dir === 'up' ? -1 : 1)
      if (target < 0 || target >= col.children.length) return // within-column only (P2)
      const tmp = col.children[loc.childIdx]
      col.children[loc.childIdx] = col.children[target]
      col.children[target] = tmp
      get()._commit({ ...m, root })
    },

    splitToColumn(id, side) {
      // Notion 语义:本块先独占一行,再与一个新空块并排成两栏(原先在「大杂烩行」里
      // 一分就与前面所有块劈开 —— 实报已修);焦点落新空栏。
      const m = get().manifest
      const page = get().activePage
      if (!m || !page) return
      const root = clone(m.root)
      const rowIdx = isolateBlockRow(root, id)
      if (rowIdx === null) return
      const row = root.children[rowIdx]
      if (row.columns.length >= 4) return // ponytail: 4 列封顶,再多没法读
      const newId = nextBlockId(Object.keys(m.blocks), m.nextId)
      const col: ColumnNode = { id: generateColumnId(), width: 1, children: [{ ref: newId }] }
      if (side === 'left') row.columns.unshift(col)
      else row.columns.push(col)
      const w = 1 / row.columns.length
      row.columns.forEach((c) => (c.width = w))
      const entry: BlockEntry = { type: 'markdown' }
      const blocks = { ...get().blocks, [newId]: { id: newId, type: 'markdown', content: '' } }
      get()._commit({ ...m, root, blocks: { ...m.blocks, [newId]: entry }, nextId: bumpNextId(m.nextId, newId) }, blocks)
      get().requestFocus(newId, 'start')
    },

    pairBlocks(dragId, targetId, side) {
      // 拖到某块左/右边缘 = 只与那一块并排(先隔离目标行,拖块进同行新列);4 列封顶时退回行尾。
      const m = get().manifest
      if (!m || dragId === targetId) return
      const root = clone(m.root)
      const dragLoc = locate(root, dragId)
      if (!dragLoc) return
      const [ref] = root.children[dragLoc.rowIdx].columns[dragLoc.colIdx].children.splice(dragLoc.childIdx, 1)
      cleanup(root) // 拖空的列/行先清,防后续索引漂移
      const rowIdx = isolateBlockRow(root, targetId)
      if (rowIdx === null) {
        appendToEnd(root, ref.ref) // 目标消失:兜底回页尾,绝不丢块
      } else {
        const row = root.children[rowIdx]
        if (row.columns.length >= 4) {
          appendToEnd(root, ref.ref)
        } else {
          const col: ColumnNode = { id: generateColumnId(), width: 1, children: [ref] }
          if (side === 'left') row.columns.unshift(col)
          else row.columns.push(col)
          const w = 1 / row.columns.length
          row.columns.forEach((c) => (c.width = w))
        }
      }
      cleanup(root)
      get()._commit({ ...m, root })
    },

    addColumnWithBlock(rowId, id, side) {
      const m = get().manifest
      if (!m) return
      const root = clone(m.root)
      const loc = locate(root, id)
      if (!loc) return
      const [ref] = root.children[loc.rowIdx].columns[loc.colIdx].children.splice(loc.childIdx, 1)
      const row = root.children.find((r) => r.id === rowId)
      if (!row) {
        // target row vanished — fall back to a fresh row
        root.children.push({
          type: 'row',
          id: generateRowId(),
          columns: [{ id: generateColumnId(), width: 1, children: [ref] }],
        })
      } else {
        const col: ColumnNode = { id: generateColumnId(), width: 1, children: [ref] }
        if (side === 'left') row.columns.unshift(col)
        else row.columns.push(col)
        // equal split on structural change; user can fine-tune via the resizer
        const w = 1 / row.columns.length
        row.columns.forEach((c) => (c.width = w))
      }
      cleanup(root)
      get()._commit({ ...m, root })
    },

    addRowWithBlock(afterRowIndex, id) {
      const m = get().manifest
      if (!m) return
      const root = clone(m.root)
      const loc = locate(root, id)
      if (!loc) return
      const [ref] = root.children[loc.rowIdx].columns[loc.colIdx].children.splice(loc.childIdx, 1)
      const newRow: RowNode = {
        type: 'row',
        id: generateRowId(),
        columns: [{ id: generateColumnId(), width: 1, children: [ref] }],
      }
      const insertAt = Math.min(afterRowIndex + 1, root.children.length)
      root.children.splice(insertAt, 0, newRow)
      cleanup(root)
      get()._commit({ ...m, root })
    },

    resizeColumns(rowId, leftColId, rightColId, leftFraction) {
      const m = get().manifest
      if (!m) return
      const root = clone(m.root)
      const row = root.children.find((r) => r.id === rowId)
      if (!row) return
      const left = row.columns.find((c) => c.id === leftColId)
      const right = row.columns.find((c) => c.id === rightColId)
      if (!left || !right) return
      const combined = left.width + right.width
      const f = Math.max(0.12, Math.min(0.88, leftFraction))
      left.width = combined * f
      right.width = combined * (1 - f)
      get()._commit({ ...m, root })
    },

    setFmExtra(text) {
      const m = get().manifest
      if (!m) return
      const fmExtra = text.replace(/^\n+|\n+$/g, '')
      const next: PageManifest = { ...m }
      if (fmExtra) next.fmExtra = fmExtra
      else delete next.fmExtra
      get()._commit(next)
    },

    async save() {
      // ⚠️ 有外部回灌在等静默 / 在途 → 先让它落地再写。押后闸只推迟了回灌**没推迟保存**,而防抖保存
      // 400ms 恒早于静默窗 700ms(两者都由 setBlockContent 同一 tick 起算)—— 那发写会带着**未合并**的
      // 本地内容盖掉对端 / agent 的整段改动,且悄无声息:云端 seq 已被 409 学新 → PUT 直接 200;桌面
      // savePage 是整文件覆写,连冲突都没有。正是 externalChange 注释里已经翻过一次车的失败模式。评审 P0。
      if (reconcileGate) await reconcileGate.catch(() => {})
      // 串行化:同一份文档的写盘绝不并发。并发时两次写的先后由 IPC 回来的顺序决定,
      // 先发的旧快照可能压在后发的新内容上。等前一次落完再读状态,后写的必然更新。
      const prev = inflightSave
      if (prev) await prev.catch(() => {})
      const { manifest, activePage, blocks } = get()
      if (!manifest || !activePage) return
      set({ status: 'saving' })
      // 记在途保存(path+promise):loadPage 借此只在「读写同一文件」时才等写完,其余并行(高 RTT 省一整个往返)。
      const savedPath = activePage
      flushingPath = savedPath
      inflightSave = (async () => {
        try {
          const contents: Record<string, string> = {}
          for (const [id, b] of Object.entries(blocks)) contents[id] = b.content
          const toSave: PageManifest = { ...manifest, updatedAt: new Date().toISOString() }
          // 内存作用域(插件仪表盘):写盘出口换成 sink,库是否打开与本作用域无关
          if (opts.sink) await opts.sink(savedPath, toSave, contents)
          else await amadeus.savePage(savedPath, toSave, contents)
          // 并行时代守卫:完成时若已导航去别页,绝不把旧页 manifest/status 盖回画面
          // 保存期间(await savePage)若有结构操作改了 manifest(加删块 / setFmExtra),完成时绝不能把
          // in-memory manifest 整个换回启动快照 toSave,否则那次改动被回滚、下一次防抖又把回滚态存盘 =
          // 静默丢新块/关系(Codex)。只把这次写盘的 updatedAt 合并进【当前】manifest,保住期间的改动。
          set((s) => (s.activePage === savedPath
            ? { manifest: s.manifest ? { ...s.manifest, updatedAt: toSave.updatedAt } : toSave, status: 'ready' as const, linkGraphVersion: s.linkGraphVersion + 1 }
            : { linkGraphVersion: s.linkGraphVersion + 1 }))
        } catch (e) {
          set((s) => (s.activePage === savedPath ? { status: 'ready' as const, error: String(e) } : { error: String(e) }))
        } finally {
          flushingPath = null
          inflightSave = null
        }
      })()
      await inflightSave
    },

    async flushSave() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        await get().save() // save() 自己会先等在途写
        return
      }
      // 没有待发的防抖 ≠ 没有在途写:更早发出的 save 可能仍在飞。路径操作(改名/移动/重写)
      // 必须等它落地,否则旧路径的写盘在移动之后完成 = 旧文件复活(Codex 评审 P1)。
      await inflightSave?.catch(() => {})
    },

    async reconcileExternal(path) {
      if (!get().manifest || path !== get().activePage) return
      // 正在打字就先押后:hydrate 换内容会让编辑器整只重挂(MarkdownBlock 渲染期换 key),
      // 输入法当场被关、防抖里那截字一起没。多设备同编时这条 SSE 是密集的。见 typingGuard.ts。
      // ⚠️ 待办用**集合**不用布尔量:单次失败/切页要 `continue` 掉这一条,不能连带把合并进来的
      // 别的事件一起丢(丢了就再没人补,面板停在陈旧内容,下一发防抖保存把它写回盘)。评审 P1。
      reconcilePending.add(path)
      if (reconcileBusy) return
      reconcileBusy = true
      // 闸必须在**第一个 await 之前**同步立起来,否则 save() 抢在这一拍里就绕过去了。
      let release = (): void => {}
      reconcileGate = new Promise<void>((r) => { release = r })
      try {
        while (reconcilePending.size) {
          const p = reconcilePending.values().next().value as string
          reconcilePending.delete(p)
          if (get().activePage !== p) continue // 押后期间切页/关页了
          await awaitTypingQuiet()
          const { manifest, blocks, activePage } = get()
          if (!manifest || activePage !== p) continue
          const contents: Record<string, string> = {}
          for (const [id, b] of Object.entries(blocks)) contents[id] = b.content
          try {
            const page = await amadeus.reconcilePage(p, manifest, contents)
            if (get().activePage !== p) continue // 在途期间切走 → 别把这篇的内容灌进另一篇
            set((s) => ({ ...hydrate(page), linkGraphVersion: s.linkGraphVersion + 1 }))
          } catch (e) {
            set({ error: String(e) }) // 这一条失败不影响待办里的其余条目
          }
        }
      } finally {
        reconcileBusy = false
        reconcileGate = null
        release()
      }
    },

    undo() {
      const r = history.undo(snapNow())
      if (!r) return
      set({ manifest: r.data.manifest, blocks: r.data.blocks })
      scheduleSave()
    },
    redo() {
      const r = history.redo(snapNow())
      if (!r) return
      set({ manifest: r.data.manifest, blocks: r.data.blocks })
      scheduleSave()
    },

    _commit(manifest, blocks) {
      pushUndo('struct')
      set(blocks ? { manifest, blocks } : { manifest })
      scheduleSave()
    },
  }
  })
}

export type PageStoreApi = ReturnType<typeof makePageStore>

// ── 新建流的两个一次性信号(跨 scope)──────────────────────────────────────
// 「新建笔记」的落点面板由宿主的 openNote 门面现算(可能是新开的 leaf),创建方拿不到它的 scope id ——
// 所以这两个信号都住模块级、按 path 认领,谁先挂载谁拿走。放进 store 就会锁死在创建时的那个 scope 上。

/** 导航请求:交给宿主的 openNote 门面(amadeusOverlays 接;`amadeus/` 是可移植层,不 import 宿主)。
 *  返回 true = 已被接管;false = 没人听(纯 amadeus 宿主 / 台架 / 单测)→ 调用方自己 loadPage。 */
export function navigateToNote(path: string): boolean {
  // cancelable + preventDefault:平台自带的「有人接管了吗」握手,不用再自己发明标志位。
  const ev = typeof CustomEvent === 'function' ? new CustomEvent('amadeus:navigate-note', { detail: { path }, cancelable: true }) : null
  return !!ev && window.dispatchEvent?.(ev) === false
}

/** 标题聚焦请求(Notion 式:新建即先命名)。一次性,由装到该篇的编辑器认领。 */
let pendingTitleFocus: string | null = null
export function requestTitleFocus(path: string): void {
  pendingTitleFocus = path
}
/** 认领:命中则清掉并返回 true(NoteTitle 与 UnifiedPage 各自挂载时问一次)。 */
export function claimTitleFocus(path: string | null): boolean {
  if (!path || pendingTitleFocus !== path) return false
  pendingTitleFocus = null
  return true
}

// ── 面板作用域(分屏)────────────────────────────────────────────────────────
// scope = 编辑器面板的 leaf id。编辑器**子树内**经 PageScopeCtx 拿到自己那份;
// 编辑器**之外**的一切(侧栏 / 命令面板 / 状态栏 / 日历 / 快切)读「当前活动面板」那份 ——
// 那正是它们本来就想要的语义(「当前这篇笔记」)。
const stores = new Map<string, PageStoreApi>()

/** 默认作用域:没有分屏时就它一个,永不回收。 */
export const MAIN_SCOPE = 'main'
const useActiveScope = create<{ id: string }>(() => ({ id: MAIN_SCOPE }))
export const activePageScope = (): string => useActiveScope.getState().id
/** 活动面板跟随焦点。切换会把门面订阅整体改挂到新面板(见下面 attachFacade)。 */
export function setActivePageScope(id: string): void {
  if (useActiveScope.getState().id !== id) useActiveScope.setState({ id })
}

// 状态分两类:**文档级**(activePage/manifest/blocks/status/focusRequest…)每个面板各一份 —— 这才是分屏;
// **仓库级**(vault 根、页面/文件/文件夹清单、页面图标)全局只有一份真相,必须在面板间镜像:
// 新面板的 store 生下来是空的,不同步的话它里面的 [[ 补全没有候选、双链全判成未解析(红链)。
const VAULT_KEYS = ['vaultRoot', 'vaultSide', 'pages', 'folders', 'files', 'icons'] as const
type VaultSlice = Pick<PageState, (typeof VAULT_KEYS)[number]>
const vaultSlice = (s: PageState): VaultSlice =>
  ({ vaultRoot: s.vaultRoot, vaultSide: s.vaultSide, pages: s.pages, folders: s.folders, files: s.files, icons: s.icons })

/**
 * 换库(切本地/云端、换根)前:**所有面板**的待存内容先在旧根落盘。
 * 保存走「相对路径 + 当前根」,只 flush 自己那份的话,隔壁面板揣着的旧库活动页会在根换掉之后才写出去 ——
 * 表现就是「切换本地/云端后,本地库里凭空多出一篇云端的笔记」(用户实报)。分屏之前只有一份 store,
 * 所以这条链是分屏引入的:switchVaultSide 里的单份 flush + 作废,分屏后只护住了当前面板。
 */
export async function flushAllScopes(): Promise<void> {
  await Promise.all([
    ...[...stores.values()].map((s) => s.getState().flushSave().catch(() => {})),
    // unified(v4)实例的写盘管线不在 scope store 里,经登记处一起落盘(Codex P0:换库竞态)。
    flushUnifiedScopes(),
  ])
}

/**
 * 改名/移动后把 old→new 广播给**所有**面板 scope。分屏里别的面板还握着旧 activePage 的话,
 * 它的下一次防抖保存会把旧路径整个写回来 —— 旧文件复活、且内容是移动前的快照(Codex 评审 P1)。
 * kind='file' 精确匹配一页;kind='prefix' 匹配整棵子树(文件夹改名/移动、.fd 级联)。
 * 发起操作的面板自己已 set 过新路径 → 等值判定天然跳过,重复调用无害。
 */
export function remapScopePaths(oldP: string, newP: string, kind: 'file' | 'prefix'): void {
  const hit = (a: string): boolean => (kind === 'file' ? a === oldP : a === oldP || a.startsWith(`${oldP}/`))
  const to = (a: string): string => (kind === 'file' ? newP : newP + a.slice(oldP.length))
  for (const s of stores.values()) {
    const st = s.getState()
    // activeNotePath 必须一起改:v4 面板的 activePage 恒 null,只 remap 它等于没 remap ——
    // 改名/移动之后 noteOf 会一直返回**旧路径**(Codex 评审 high)。
    const patch: Partial<PageState> = {}
    if (st.activePage && hit(st.activePage)) patch.activePage = to(st.activePage)
    if (st.activeNotePath && hit(st.activeNotePath)) patch.activeNotePath = to(st.activeNotePath)
    if (Object.keys(patch).length) s.setState(patch)
  }
  emitNotePathGone(oldP, kind, newP) // v4 标签自己改指(v3 走效果③,两边写同一个值,幂等)
}

type PathGoneListener = (from: string, kind: 'file' | 'prefix', to: string | null) => void
const pathGoneListeners = new Set<PathGoneListener>()

/** 某路径(或其子树)被**删除**(to=null)或**挪走/改名**(to=新路径)。攥着它的编辑器标签据此改指。
 *
 *  为什么需要这条广播:v3 有一条自愈链 —— deletePage/movePage 会把 store 导航/remap 到新页,
 *  `activePage` 一变,amadeusViews 的效果③ 就把本 leaf 的 notePath 认领过去。**v4 的 activePage
 *  恒 null,效果③ 永不触发**,标签于是一直攥着一个已删/已挪走的路径,显示着一个已退休
 *  (`pipe.retired`,打字静默不落盘)的编辑器。这条广播给 v4 补上同一条自愈链。 */
export function onNotePathGone(f: PathGoneListener): () => void {
  pathGoneListeners.add(f)
  return () => pathGoneListeners.delete(f)
}
function emitNotePathGone(from: string, kind: 'file' | 'prefix', to: string | null): void {
  for (const f of pathGoneListeners) f(from, kind, to)
}

/** 删除后把各 scope 里指向该路径(或其子树)的 activeNotePath 清掉。
 *  v3 有 activeInside 那条善后分支兜底,v4 的 activePage 恒 null 走不到 —— 不清的话
 *  noteOf 会一直返回一个**已删掉的**路径,图谱/反链/在场/聊天引用全指着它(Codex 评审 high)。 */
export function clearScopeNotePaths(path: string, kind: 'file' | 'prefix'): void {
  for (const s of stores.values()) {
    const a = s.getState().activeNotePath
    if (!a) continue
    if (kind === 'file' ? a === path : a === path || a.startsWith(`${path}/`)) s.setState({ activeNotePath: null })
  }
}

/**
 * 换库后:**所有面板**的编辑器状态即刻作废。save() 见 activePage=null 就直接 return,
 * 于是旧库那份内容再没有任何路径能写进新根(挂着的防抖定时器烧掉也只是空转)。
 * 发起切换的那个面板紧接着会 loadPage 新库的目标页,重新填回来。
 */
export function resetAllScopeDocs(): void {
  for (const s of stores.values()) {
    s.setState({ activePage: null, pendingPage: null, manifest: null, blocks: {}, status: 'idle', error: null, activeNotePath: null })
  }
}

let mirroring = false // 防镜像回弹成无限循环
function mirrorVault(src: PageStoreApi): void {
  if (mirroring) return
  mirroring = true
  const patch = vaultSlice(src.getState())
  for (const other of stores.values()) if (other !== src) other.setState(patch)
  mirroring = false
}

// 摘表在途标记(scope → 本次 dispose 的身份):dispose 的 stores.delete 挂在 flushSave().finally
// (至少一个微任务)之后,而 React 对同一 effect 的 cleanup→setup 同步连跑 —— 同名 scope 立即重建
// 会拿回同一个 store,随后旧 finalizer 的 `stores.get(scope)===s` 恰因同实例而通过,把**新主人正在用
// 的 store** 摘成孤儿:逃逸 flushAllScopes/resetAllScopeDocs/外部回灌广播,切库时旧内容可写进新库
// (评审 P0,2026-08-14)。修法 = 重领养即取消:pageStoreFor 命中已有实例就清掉在途摘表标记。
const pendingDispose = new Map<string, object>()

export function pageStoreFor(scope: string, opts?: PageStoreOptions): PageStoreApi {
  let s = stores.get(scope)
  if (s) {
    pendingDispose.delete(scope) // 重领养:取消在途摘表,旧 finalizer 作废
    return s
  }
  s = makePageStore(opts) // opts 只在首次建店时生效(内存作用域由挂载方先建、再被子树 useScopedPageStore 领用)
  const seed = stores.values().next().value // 任取一个已有的:仓库级字段在它们之间恒等
  if (seed) s.setState(vaultSlice(seed.getState()))
  stores.set(scope, s)
  s.subscribe((n, p) => { if (VAULT_KEYS.some((k) => n[k] !== p[k])) mirrorVault(s!) })
  return s
}
/** 面板关掉时回收(先落盘,别把没写完的改动带走)。'main' 是默认作用域,永不回收。 */
export function disposePageStoreScope(scope: string): void {
  if (scope === MAIN_SCOPE) return
  const s = stores.get(scope)
  if (!s) return
  // 先落盘、落完再摘表。摘早了 pageStoreFor() 会在 flush 还在飞的时候凭空重建一个空 store,
  // 那份空的一旦被写回就是把整篇笔记清掉。(真正的兜底仍是退出前的全局 flush,不在这一层。)
  // 摘表还须核对在途标记:期间有人 pageStoreFor 重领养过,这次摘表整体作废(见 pendingDispose)。
  const token = {}
  pendingDispose.set(scope, token)
  void s.getState().flushSave().finally(() => {
    if (pendingDispose.get(scope) !== token) return // 已被重领养,别摘新主人的店
    pendingDispose.delete(scope)
    if (stores.get(scope) === s) stores.delete(scope)
  })
  // 关掉的正好是活动面板 → 活动指针必须改投,否则下一次 getState() 会**凭空重建一个空 store**:
  // 侧栏/命令面板/状态栏立刻看到「没有活动笔记」,而剩下那半屏明明还开着。
  if (activePageScope() === scope) setActivePageScope(stores.keys().next().value ?? MAIN_SCOPE)
}
export { disposePageStoreScope as disposePageScope }

/** 编辑器子树用它声明「我属于哪个面板」;不在任何面板里(null)= 跟随活动面板。 */
export const PageScopeCtx = createContext<string | null>(null)

/** 组件当前该读哪份文档状态。 */
export function usePageScope(): string {
  const ctx = useContext(PageScopeCtx)
  const active = useActiveScope((s) => s.id)
  return ctx ?? active
}
/** 编辑器子树里做**写操作**时用它拿自己那份 store —— 别用 usePageStore.getState()。
 *  后者解析到「活动面板」,异步回调(防抖保存 / await 后的斜杠动作)里就可能写到隔壁那篇去。 */
/** 「本 scope 当前这篇」的统一读法:v3 有 activePage,v4 只有 activeNotePath。
 *  所有**只读**面板一律经它取路径,别再各写各的(v4 全面适配,2026-08-20)。 */
export function noteOf(s: Pick<PageState, 'activePage' | 'activeNotePath'>): string | null {
  return s.activePage ?? s.activeNotePath
}

/** 「本 scope 当前这篇是不是 v4/unified」的**判据单源**:activePage 只有 v3 块编辑器会设。
 *  是 → 返回它的路径(正文活在 UnifiedPage 私有 pipe 里,得经 unified/lifecycle 的接缝去问);
 *  不是(v3 / 没打开笔记)→ null。大纲·字数(lib/activeNote)与插件块表面共用它,别再各写各的。 */
export function v4PathOf(s: Pick<PageState, 'activePage' | 'activeNotePath'>): string | null {
  return s.activePage ? null : s.activeNotePath
}

export function useScopedPageStore(): PageStoreApi {
  return pageStoreFor(usePageScope())
}

// 门面订阅:转挂到当前活动面板。切面板时补发一次通知 —— 对订阅者来说「当前文档」确实整体换了。
type Listener = (s: PageState, prev: PageState) => void
const facadeListeners = new Set<Listener>()
let detachFacade: (() => void) | null = null
function attachFacade(prev?: PageStoreApi): void {
  detachFacade?.()
  const cur = pageStoreFor(activePageScope())
  detachFacade = cur.subscribe((s, p) => { for (const l of facadeListeners) l(s, p) })
  if (prev) for (const l of facadeListeners) l(cur.getState(), prev.getState())
}
useActiveScope.subscribe((s, p) => {
  if (s.id !== p.id) attachFacade(pageStoreFor(p.id))
})

/**
 * 门面 hook + 静态访问器。153 处 `usePageStore(sel)` 一行不用改:
 * 在编辑器子树里解析到本面板的 store,子树之外解析到活动面板的。
 */
export const usePageStore = Object.assign(
  function usePageStoreHook<T>(selector: (s: PageState) => T): T {
    return useStore(pageStoreFor(usePageScope()), selector)
  },
  {
    getState: (): PageState => pageStoreFor(activePageScope()).getState(),
    // 显式写 Partial:zustand v5 的 setState 是重载签名,Parameters<> 只会取到最后那条(整份替换),
    // 于是所有「只塞几个字段」的调用点都会被判缺 60 多个属性。
    setState: (partial: Partial<PageState> | ((s: PageState) => Partial<PageState>)): void => {
      pageStoreFor(activePageScope()).setState(partial)
    },
    subscribe: (listener: Listener): (() => void) => {
      facadeListeners.add(listener)
      if (!detachFacade) attachFacade()
      return () => {
        facadeListeners.delete(listener)
        if (!facadeListeners.size) { detachFacade?.(); detachFacade = null }
      }
    },
  },
)

// 外部改文件(agent 直接写盘 / Obsidian / 云端拉回)→ 回灌当前页。**必须模块级订阅**:
// 曾挂在 AmadeusPagesView(左栏笔记树)的 effect 里,左栏切到「会话/文件」档或人在 Agent Desk、
// Coding Space 时该组件根本没挂载 → 没人听 → 编辑器一直显示旧内容(要重开才刷新),
// 且下一次敲键的防抖保存会把陈旧文档写回去、抹掉 agent 的改动。
// drawingStore / dbAggregateStore 早就是模块级订阅,这里是漏网的一条。
// ⚠️ 分屏后必须**广播给每一个面板**,不能只喂活动的那个:另一半屏正显示被改的那篇时,
// 它收不到就一直是旧内容,而它下一次防抖保存会把陈旧文档写回盘 —— 正是上面这段注释里
// 已经翻过一次车的那个失败模式,只不过换成了「按面板」维度。reconcileExternal 自己会判
// 「这条改动是不是我这篇」,喂多了不会误伤。
amadeus?.onExternalChange?.((p) => {
  for (const s of stores.values()) void s.getState().reconcileExternal(p)
})

/** 笔记改名后的 .fd 跟随改名(pageStore.renamePage 与 noteViewStore.renameNote 共用)。
 *  renameFolder 内部自带 flushSave / activePage 重映射 / refreshStructure / 失败置 error。 */
export async function cascadeFdAfterRename(oldPath: string, newPath: string): Promise<void> {
  const st = usePageStore.getState()
  const oldFd = fdDirOf(oldPath)
  if (!st.folders.includes(oldFd)) return
  const newBase = newPath.split('/').pop()!.replace(/\.md$/i, '')
  await st.renameFolder(oldFd, `${newBase}.fd`)
}
