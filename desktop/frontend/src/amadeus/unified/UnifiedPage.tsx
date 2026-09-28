import { Image as CoverImageIcon, Smile as PageSmileIcon } from 'lucide-react'
// ── v4 统一实例编辑器(生产路径,spec §9 step 3 绞杀者)────────────────────────────
// 服务对象:v4 素文件(含一切外来 md)与 v4 结构化文件;v3 标记文件不进这里(router.ts 分流)。
//
// 数据链(P0 契约,见 fm.ts):源文拆成「fm 块原文 + 正文」,**编辑器只吃正文** ——
// fm 若喂进 Milkdown,首次落盘会被序列化成水平线+setext 标题(毁档)。保存 = fm + 正文原样拼回,
// 编辑器与 chrome(图标/封面/属性)共用这一条防抖整文件写盘管线(单写者,绝无 IPC 外科写竞态)。
//
// 外部回灌:等打字静默 → 重读 → fm 侧直接换状态,正文侧走**同实例最小差异事务**;回灌期间冻结保存。
// 本编辑器刻意不写 pageStore(陈旧快照经 reconcilePage 回写会复活旧内容,数据安全优先);
// 只读它的标题聚焦请求(新建流)与 pages(wiki 补全),写侧仅 refreshPages(纯刷新)。
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { MilkdownProvider, useInstance } from '@milkdown/react'
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import { NodeSelection, TextSelection, type Selection } from '@milkdown/kit/prose/state'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { Fragment } from '@milkdown/kit/prose/model'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { undo as pmUndo, redo as pmRedo } from '@milkdown/kit/prose/history'
import { Pilcrow, Heading1, Heading2, Heading3, List, ListOrdered, ListTodo, TextQuote, ChevronsDown, Copy, Columns2, Trash2, Undo2, StickyNote, MessageSquarePlus, Code2, Info, Link2, FileInput } from 'lucide-react'
import { isCoarsePointer } from '../../touch'
import { joinRel, toAssetUrl, toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'
import { amadeus } from '../api'
import { getAttachmentPrefs } from '../lib/attachments'
import { awaitTypingQuiet, installTypingGuard } from '../store/typingGuard'
import {
  DbLinkPicker, MilkdownInner, normalizeSerializedMd, serializeUnified, stampedFileName,
  PREFIX_TRIGGERS, SLASH_SENTINELS, slashTurnFailed, getFocusedBlockApply, setFocusedBlockApply, type SlashItem, type SlashOps,
} from '../blocks/markdown/MarkdownBlock'
import { emptyDb, emptyNoteView, serializeDb } from '@amadeus-shared/db/schema'
import { BLANK_SCENE_JSON, blankDrawing } from '@amadeus-shared/excalidraw/format'
import { fdDirOf } from '../lib/fd'
import { askString } from '../components/askString'
import { resolvePageName } from '@amadeus-shared/links'
import { resolveFileName } from '../lib/vaultFiles'
import { wikiFilesEnabled } from '../lib/wikiFiles'
import { usePageStore, useScopedPageStore, flushAllScopes, remapScopePaths, cascadeFdAfterRename, claimTitleFocus, PageScopeCtx, useActivePageScope, hasPageScope } from '../store/pageStore'
// 模式胶囊复用 `.t2s-vaultseg`(见渲染处):样式真源是侧栏那张表。App 里 amadeusViews 已显式引过,
// 这里再引是给**独立挂载**兜底(harness / 只挂 UnifiedPage 的场景,不引就是一排裸按钮)。
import '../../views/chat2/sidebar2.css'
import { editorExtensionGen, subscribeEditorExtensions } from '../plugins/editorExtensions'
import { announceUnifiedWrite, registerUnifiedPipe, retireUnifiedPath, unifiedScopeLive } from './lifecycle'
import { AlertCircle, History } from 'lucide-react'
import { Lock as LockIcon } from 'lucide-react'
import { useNotesSpellcheck } from '../blocks/markdown/spellcheck'
import type { TextWriteResult } from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { formatDateTime } from '../../format/time'
import { SAVE_RETRY_MS, clearDraft, isElectronHost, readDraft, stashDraft, toastConflictCopy, toastSaveFailed, writeConflictCopy, type UnsavedDraft } from './writeSafety'
import { docHeadings } from './outline'
import { revealBlockAtTop } from './revealScroll'
import { findTextHit, unfoldToReveal } from './revealText'
import { isLoneBlockId, trailingBlockId } from '@amadeus-shared/pdfLink'
import { useUiOverlay } from '../../amadeusOverlayStore'
import { CanvasSegPortal } from './CanvasModeSeg'
import { claimCanvasToggle, releaseCanvasToggle } from './canvasToggleCommand'
import { AmadeusPropertiesPanel, PropsDraftFlushContext } from '../../amadeusProperties'
import { NoteCover, CoverPicker, IconPicker, randomEmoji, UNTITLED_RE } from '../chrome/pageChrome'
import { OverlayPortal } from '../lib/overlayPortal'
import { OverlayAt } from '../lib/clampMenu'
import { applyTrigger, codeBlockTurnInto, type Trigger } from '../blocks/markdown/blockTriggers'
import { turnBlocksInto, turnIntoCallout, turnRangeIntoCode } from './blockTurn'
import { columnSplitApplies } from '../blocks/markdown/menuContext'
import { NotePicker, blockLinkOf, canMove, copyLink, moveBlocksTo } from './blockLinks'
import { hardBreakRemark } from '../blocks/markdown/softBreak'
import { adoptOrigins } from '../blocks/markdown/verbatim'
import { createBlockLayer } from './blockLayer'
import { askDeleteRemovedAssets, refTextOf } from './assetDelete'
import { columnPlugins, createColumnsFold, parseLayoutJson, deriveLayoutJson, splitToColumn } from './columns'
import { canvasPlugins, createCanvasFold, createSelectionClamp, createHistoryTimeline, createCardActiveDeco, createCardDepthDeco, parseCanvasJson, deriveCanvasJson, withElements, withTree, withMain, CARD_W, MAIN_W, type CanvasMain, type UndoTimeline } from './canvas'
import { CanvasStage, unwrapCard, blockToCard } from './canvasStage'
import { rawTree, setParent, childrenOf } from './canvasEdit'
import { createEmbedLayer } from './embedLayer'
import { reconcileTr, type ReconcileChange } from './reconcileDiff'
import { createAgentChanges, keepAgentChanges, markAgentChanges, nextAgentChange, revertAgentChanges, type AgentChangesState } from './agentChanges'
import { AgentChangeCapsule } from './AgentChangeCapsule'
import { InlineAiPanel, type InlineAiRun } from './InlineAiPanel'
import { aiContextOf, aiTargetOf, applyAiResult, clearAiTarget, createInlineAi, setAiTarget, translateTargetOf, type AiApply } from './inlineAi'
import { aiSpaceTriggerEnabled } from '../lib/aiSpaceTrigger'
import type { TanguInlineAction } from '../plugins/tanguSeam'
import type { ToolbarAiItem } from '../blocks/markdown/InlineToolbar'
import { claimAgentWrite } from '../../stores/agentWriteLedger'
import { askTanguQuote } from './askTangu'
import { readTangu } from '../plugins/tanguSeam'
import { usePluginStore } from '../plugins/pluginStore'
import { headingFoldPlugins } from './headingFold'
import { listFoldPlugins } from './listFold'
import { LinkHoverCard } from './linkCard'
import { TableMenuSection, isTableSelected, tableCellAtPoint } from './tableMenu'
import { noteLinkTarget } from '../blocks/markdown/linkHref'
import { fromDisk, toDisk, type Eol } from './eol'
import { splitFm, composeFm, patchFm, setForeignFm, foreignFmObject, foreignFmText, setAmadeusStructure, layoutLineOf, canvasLineOf, fixStructKeys } from './fm'
import { readDocumentScroll, readNoteSurfaceMode, remapNoteViewMemory, writeDocumentScroll, writeNoteSurfaceMode } from './viewMemory'
import { createFoldMemory, remapFoldMemory } from './foldActions'
import { registerMessages, translate, useI18n } from '../../i18n'
import { registerFindProvider, textareaFindProvider } from '../../findInPage'
import { pmFindProvider } from './findReplace'

registerMessages({
  'unipage.upload.uploading': { zh: '上传中 {name}', en: 'Uploading {name}' },
  'unipage.upload.fileN': { zh: '文件{n}', en: 'File {n}' },
  'unipage.toast.insertPointLost': { zh: '文件已创建，但原插入位置已失效（笔记已切换）', en: 'The file was created, but the original insertion point is gone (the note was switched).' },
  'unipage.plugin.notString': { zh: 'run() 必须返回字符串，实际是 {type}', en: 'run() must return a string, but returned {type}' },
  'unipage.plugin.tooLong': { zh: 'run() 返回内容过长', en: 'run() returned too much content' },
  'unipage.plugin.controlChars': { zh: 'run() 返回内容含控制字符', en: 'run() returned content containing control characters' },
  'unipage.plugin.failed': { zh: '「{label}」失败：{err}', en: '"{label}" failed: {err}' },
  'unipage.toast.columnTopLevelOnly': { zh: '分栏只能对顶层块使用，请先把这一块拖出当前列/列表', en: 'Columns only work on top-level blocks — move this block out of its current column or list first.' },
  'unipage.file.drawing': { zh: '画板', en: 'Whiteboard' },
  'unipage.file.noteView': { zh: '笔记视图', en: 'Note view' },
  'unipage.file.noteViewN': { zh: '笔记视图 {n}', en: 'Note view {n}' },
  'unipage.file.untitledView': { zh: '未命名视图', en: 'Untitled view' },
  'unipage.bookmark.title': { zh: '插入书签', en: 'Insert bookmark' },
  'unipage.bookmark.label': { zh: '粘贴链接地址（https:// 开头）；YouTube 链接会直接内嵌播放器。', en: 'Paste a link starting with https:// — YouTube links turn into an embedded player.' },
  'unipage.embed.title': { zh: '嵌入块引用', en: 'Embed a block reference' },
  // B-15:v4 块菜单没有「复制嵌入引用」(那是 v3 BlockHost 的项),说明改指 v4 真有的「复制标题链接 / 复制块链接」。
  'unipage.embed.label': { zh: '形如 笔记名#标题 或 笔记名#^块ID（块菜单「复制标题链接」「复制块链接」可得）；也可只填笔记名嵌整篇首块。', en: 'Looks like NoteName#Heading or NoteName#^blockId — the block menu items "Copy heading link" and "Copy block link" give you one. A note name on its own embeds the first block of that note.' },
  'unipage.embed.confirm': { zh: '嵌入', en: 'Embed' },
  'unipage.title.iconAction': { zh: '更换/移除页面图标', en: 'Change or remove the page icon' },
  'unipage.title.addIcon': { zh: '添加图标', en: 'Add icon' },
  'unipage.title.addCover': { zh: '添加封面', en: 'Add cover' },
  'unipage.toast.canvasElementsFailed': { zh: '画布改动没能保存：这篇笔记的 amadeus_canvas 行无法解析，请在源码模式检查', en: 'Canvas changes were not saved: the amadeus_canvas line in this note cannot be parsed — check it in source mode.' },
  'unipage.toast.canvasTreeFailed': { zh: '层级改动没能保存：这篇笔记的 amadeus_canvas 行无法解析，请在源码模式检查', en: 'Hierarchy changes were not saved: the amadeus_canvas line in this note cannot be parsed — check it in source mode.' },
  'unipage.toast.canvasMainFailed': { zh: '主卡改动没能保存：这篇笔记的 amadeus_canvas 行无法解析，请在源码模式检查', en: 'Main card changes were not saved: the amadeus_canvas line in this note cannot be parsed — check it in source mode.' },
  'unipage.toast.cardUnavailable': { zh: '当前块不能转换为卡片；请先移出列表或分栏', en: 'This block cannot be turned into a card — move it out of the list or columns first.' },
  'unipage.toast.cardMade': { zh: '已转换为卡片 —— 右上角切到画布模式查看', en: 'Turned into a card — switch to canvas mode at the top right to see it.' },
  'unipage.menu.turnInto': { zh: '转换为', en: 'Turn into' },
  'unipage.menu.text': { zh: '正文', en: 'Text' },
  'unipage.menu.h1': { zh: '标题 1', en: 'Heading 1' },
  'unipage.menu.h2': { zh: '标题 2', en: 'Heading 2' },
  'unipage.menu.h3': { zh: '标题 3', en: 'Heading 3' },
  'unipage.menu.bullet': { zh: '无序列表', en: 'Bulleted list' },
  'unipage.menu.ordered': { zh: '有序列表', en: 'Numbered list' },
  'unipage.menu.task': { zh: '待办', en: 'To-do list' },
  'unipage.menu.quote': { zh: '引用', en: 'Quote' },
  'unipage.menu.fold': { zh: '折叠', en: 'Toggle' },
  'unipage.menu.callout': { zh: '标注', en: 'Callout' },
  'unipage.menu.code': { zh: '代码块', en: 'Code block' },
  'unipage.menu.card': { zh: '卡片', en: 'Card' },
  'unipage.menu.toNewColumn': { zh: '移到新列', en: 'Move to new column' },
  'unipage.menu.aria': { zh: '块操作', en: 'Block actions' },
  'unipage.menu.stale': { zh: '笔记在菜单打开期间变了，请重新打开块菜单', en: 'The note changed while the menu was open — open the block menu again' },
  'unipage.menu.toNewColumnMulti': { zh: '选中多块时不能移到新列，请只选一块', en: 'Select a single block to move it to a new column' },
  'unipage.menu.backToDoc': { zh: '收回文档', en: 'Return to document' },
  'unipage.menu.duplicate': { zh: '复制块', en: 'Duplicate block' },
  'unipage.menu.delete': { zh: '删除', en: 'Delete' },
  'unipage.lock.bar': { zh: '页面已锁定，防止误改。', en: 'This page is locked to prevent accidental edits.' },
  'unipage.lock.unlock': { zh: '解锁', en: 'Unlock' },
})

const SAVE_DEBOUNCE_MS = 800 // WsFileView 同款节奏(外部文件不抢 400ms 的 pageStore 节拍)

/** 改名重建时的「接着写」(评审 D-17):旧实例的 doc 与选区原样交给新实例,**不重做**一遍「进入正文」。
 *  标题回车的 body-enter 在旧实例里已经执行过(顶插了空段、光标落进去、可能已经打了字);新实例若再执行一次,
 *  首块非空就又顶插一个空段 —— 落盘成 `SECOND\n\nfirst`、跨重建打的字劈成两段并颠倒。 */
interface BodyCarry {
  place: 'restore'
  /** 旧实例写进新路径的正文(= 新实例读盘应得的那份)。对不上 = 期间盘上被别处改过:只按位置落光标,不接 doc。 */
  body: string
  /** 旧实例的 doc(JSON)。含没进盘的东西(回车顶插的空段序列化后读回来就没了)与重建窗口里刚打的字。 */
  doc: unknown
  anchor: number
  head: number
}
type BodyFocusReq = 'start' | 'end' | 'body-enter' | BodyCarry

/** 标题回车的聚焦请求要跨「改名 → 实例随 key 重建」存活(重建清零一切组件态,只能挂模块级)。
 *  没有它:新建笔记打完名按回车,焦点刚进正文就被改名后的重建拆掉(P12b 实测)。
 *  at:没人认领的请求 10s 后作废 —— 否则下次打开同一篇时凭空执行一次(顶插空段、抢焦点)。
 *  scope:发起改名的实例所属的 leaf(评审 G1-02 返修)。同一篇开在几个标签里时改名会让它们**全部**在新路径重挂,
 *  只按路径认领的话谁先挂上谁拿走 —— 别的标签抢走发起标签的正文与选区(后台标签甚至凭空顶插一个空段)。 */
let pendingBodyFocus: { path: string; scope: string | null; req: BodyFocusReq; at: number } | null = null

const NOOP_KEYS = {
  insertAfter: () => {},
  deleteEmpty: () => {},
  mergePrev: () => {},
  arrow: () => {},
  moveDir: () => {},
  selfFocus: () => {},
}

/** 存一个 OS 文件为附件 → 磁盘形态的引用 md(`![[base]]`);失败 null。
 *  正文粘贴/拖入(saveFiles)与画布落卡(CanvasStage.saveFile)共用这一份。 */
async function saveOneFile(page: string, f: File): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await f.arrayBuffer())
    const { opts } = await getAttachmentPrefs()
    const { base } = await amadeus.saveAttachment(page, f.name || 'file', bytes, opts)
    return `![[${base}]]`
  } catch {
    return null
  }
}

/** 引用条落点([[笔记#标题]])的一次性提醒覆盖片。
 *
 *  ⚠️ **不能给 PM 渲染出来的节点直接加 class**:ProseMirror 的 DOMObserver 把 contenteditable 里的
 *  外来 DOM 改动当脏数据,同一拍就把节点重绘回去 —— 实测类是挂上了(MutationObserver 抓得到),
 *  但同一个元素在下一个 setTimeout(0) 里已经 isConnected:false,屏幕上一帧都没闪。
 *  所以画一片贴在 body 上的 fixed 覆盖片(和 PDF 引语高亮同思路):不碰文档、不碰编辑器 DOM。
 *
 *  三条纪律(Codex 评审):①全局单例,连点两条只留最后一片;②端级 zoom 下 rect 是视口 px 而写进
 *  style 的长度会再乘一次 zoom,必须反补偿(老坑);③fixed 跟不了滚动 —— 用户一滚就撤,比错位地
 *  飘在无关正文上强。滚动监听要晚 300ms 再挂:reveal 自己那次 scrollIntoView 的 scroll 事件下一帧
 *  才到,立刻挂等于自己把自己撤了。
 */
let citeTip: { el: HTMLElement; timer: number; arm: number; off: () => void } | null = null
function dropCiteTip(): void {
  if (!citeTip) return
  clearTimeout(citeTip.timer)
  clearTimeout(citeTip.arm)
  citeTip.off()
  citeTip.el.remove()
  citeTip = null
}
function flashCiteTip(r: DOMRect): void {
  dropCiteTip()
  if (r.width < 1 || r.height < 1) return
  const el = document.createElement('div')
  el.className = 'am-citeflash'
  el.style.cssText = 'position:fixed;pointer-events:none;z-index:60;left:0;top:0'
  document.body.appendChild(el)
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  el.style.left = `${(r.left - 4) / z}px`
  el.style.top = `${(r.top - 2) / z}px`
  el.style.width = `${(r.width + 8) / z}px`
  el.style.height = `${(r.height + 4) / z}px`
  const off = (): void => {
    window.removeEventListener('scroll', dropCiteTip, true)
    window.removeEventListener('wheel', dropCiteTip, true)
  }
  const arm = window.setTimeout(() => {
    window.addEventListener('scroll', dropCiteTip, true)
    window.addEventListener('wheel', dropCiteTip, true)
  }, 300)
  citeTip = { el, timer: window.setTimeout(dropCiteTip, 1400), arm, off }
}

/** 外部回灌 → 同实例最小差异事务:顶层块级对齐 + 块内字符级多段替换,选区 / 折叠随 mapping 保住;
 *  不进撤销栈(K-05)。算法与理由见 reconcileDiff.ts(评审 D-08)。
 *  恢复草稿(restoreDraft)也走 applyBody:同样不可撤销 —— 它是「装载一份内容」,被盖掉的那版已另存冲突副本。 */
function applyMinimalDiff(view: EditorView, next: ProseNode, agent = false): void {
  // agent = 这次外部改动是 Tangu 写的(G3-03):顺带交出每一处改动(新区间 + 旧片段),打标给 agentChanges 画出来。
  const changes: ReconcileChange[] = []
  const tr = reconcileTr(view.state, next, agent ? changes : undefined)
  if (tr) view.dispatch(agent ? markAgentChanges(tr, view.state.doc, changes) : tr)
}

/** 保存/回灌管线的可变心脏(ref 持有,渲染无关)。 */
interface Pipe {
  fm: string
  body: string
  lastSaved: string
  /** 该文件在磁盘上的行尾(D-19,见 ./eol):内存一律 LF,只在 readTextFile / writeTextFile 边界换。 */
  eol: Eol
  pending: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** 进行中的回灌**层数**(不是布尔):押后回灌期间冻结防抖保存。两次回灌重叠时(外部改动 + 同窗实例写盘通知),
   *  布尔量会被先结束的那次清掉,后一次还在等静默时保存就解冻了 —— 正是「押后回灌必须冻结 save」要挡的那条。 */
  reconcileBusy: number
  /** 待保全的盘上版本(D-03 / G1-01):即将被本地版本覆盖的外部内容。写盘前必须先落成冲突副本,副本没保住就不写。
   *  单槽:只有「此刻盘上、我要盖掉的那一版」归本实例保全(更早的版本是被外部写者自己盖掉的)。 */
  unpreserved: string | null
  /** 已保全过的内容指纹:同一版本不出第二份冲突副本。 */
  preserved: Set<string>
  /** 写盘失败中(D-04):页面挂「未保存」条、按 SAVE_RETRY_MS 退避重试、恢复信号(online/可见/聚焦)补写。成功一次即清。 */
  failed: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
  retryN: number
  /** 本实例最近一次存进本机的草稿内容(D-04)。写成功时凭它删草稿:成功写下的是此刻的全文,是那份草稿的超集;
   *  按「此刻写的内容」比对会漏删 —— 失败后又打了字,存着的那份旧草稿就成了下次打开时的假提示。
   *  例外:写的**不是**此刻的全文(在途那发 ack 前本地又变了,例如撤回后卸载冲洗存的草稿)→ 草稿比盘上新,留着。 */
  stashed: string | null
  /** 正在跑的写盘轮数(writeNow 的 run 从 compose 到收尾;计数不是布尔,与 reconcileBusy 同理)。
   *  非零 = lastSaved 马上会被这一轮改掉(ack 后 = 它写的那份 / CAS 拒写后 = 盘上现文):此刻拿本地和 lastSaved
   *  比出的「没有待写」不作数 —— 用户在 ack 前撤回到旧基线再切走,同步判定就会把撤回丢掉(返修 R1)。 */
  writing: number
  dead: boolean
  /** 改名/删除/移动后本实例退休:任何后续写盘都会把旧路径的文件写回来(复活幽灵文件),一律禁止。 */
  retired: boolean
  /** 本实例是否**真渲染过**分栏行:layout 剥除(解散语义)只许在此后发生 —— layout 形状合法
   *  但因缺锚/错位没折叠成功时,首次编辑绝不能顺手把结构键抹掉(Codex 终审 P0)。 */
  sawRows: boolean
  /** 画布卡片的**归属集合**:本实例负责得起的卡锚 = 本次 parse 折出来的 ∪ 本实例建出来的。
   *  磁盘上的 cards 只要有一枚不在这里面,派生就整行逐字保留。四条毁数据理由见
   *  `canvas.ts` 的 `deriveCanvasJson` 顶注。**每次 parse 前必须清零**(不是终身锁存)。 */
  ownedCards: Set<string>
  /** 写盘串行链(Codex P0):并发 writeNow 一律排队,且**执行时**才 compose——
   *  旧内容的大写入绝不可能后完成盖掉新状态。 */
  chain: Promise<void>
  /** 只读实例(公开分享页):writeNow / 生命周期 flush 在此短路。挂在 pipe 上而不是闭包读 prop ——
   *  writeFailures.test 把 writeNow 与 flush 两段源码切出来单独求值,闭包里的自由标识符会让它炸。 */
  readOnly: boolean
  /** 本实例的草稿槽位(= 所属 leaf,见 writeSafety 的 draftKey;评审 G1-02 返修)。同样挂在 pipe 上(理由同 readOnly)。 */
  slot: string | null
  /** 同篇另一个实例替两边写的 fm 补丁(unifiedPatchFm 的 follow,G1-02 返修),多次 follow 累积。isPristine 只豁免
   *  **这部分**:基线 fm 打上它恰好等于 pipe.fm → fm 这一半不算本实例的改动(否则本实例卸载冲洗 / CAS 让位时会拿
   *  「旧正文 + 新 fm」抢着写,盖掉写者的字)。本实例自己的 fm 改动不在里面,照旧算改动(Codex 复核 P0:早先记成
   *  「补丁后的整份 fm」,把本实例没落盘的 fm 修改一并豁免了,回灌随即用盘上版本整份换掉,既不保存也不留副本)。
   *  回灌采纳盘上版本、本实例写成功后清掉。 */
  peerPatch: Record<string, unknown> | null
}

interface HostApi {
  /** 外部回灌正文(stored md)→ 同实例最小差异事务;编辑器未挂载返回 false。
   *  agent = 改动出自 Tangu(G3-03):只有回灌路径会传,恢复草稿那条绝不传(那不是「Tangu 修改」)。 */
  applyBody: (stored: string, agent?: boolean) => boolean
  /** 当前 doc 立即序列化为 stored md(编辑器未挂载 = null)。flush 路径必用:listener 的
   *  markdownUpdated 有 200ms 防抖,pipe.body 可能落后最后几击(Codex A4:快打字后立刻
   *  改名/关页,不强制序列化就丢字)。 */
  serializeNow: () => string | null
  /** stored md 经本编辑器 parse → 序列化一遍的结果(= 打开它、什么都不改时编辑器会写出的样子)。
   *  判「本实例有没有用户自己的改动」用(G1-01 的 isPristine);编辑器未挂载 = null。 */
  canonical: (stored: string) => string | null
  /** OS 拖入/上传按钮的文件:存附件 + 光标处插 `![[base]]`(经 lifecycle.insertFilesForPath 递入)。 */
  insertFiles: (files: File[]) => void
  /** 插一段 markdown(插件块表面的 v4 写口;经 lifecycle.unifiedInsertMarkdown 递入)。编辑器未挂载 = false。 */
  insertMarkdown: (md: string, where: 'cursor' | 'start' | 'end') => boolean
  /** markdown → 块内容(画布粘贴/拖入用)。解析不出东西 = null。 */
  parseMd: (md: string) => Fragment | null
  /** 块内容 → markdown(parseMd 的反向;画布跨实例复制卡用)。编辑器未挂载 = null。
   *  给的是**显示形**(asset 协议 URL 原样),对面 parseMd 的 toDisplayMarkdown 会原样放行 ——
   *  换成 stored 形的话页相对路径会按目标笔记重解析,跨文件夹粘贴的图片当场断链。 */
  serializeMd: (content: Fragment) => string | null
  focusStart: () => void
  focusEnd: () => void
  /** 尾部空白区点击(AFFiNE 语义):末行有内容 → 追加一个普通空段并落光标;已是空段 → 直接落。
   *  末块是卡片时空段追加在**卡尾**(v4 卡片区必须收尾,顶层追加会被 normalizer 吸回同一位置)。 */
  focusTail: () => void
  /** 移动端「+」块面板选中的条目 → 本实例的 applySlash(v3 的对位是 MarkdownBlock 逐块登记)。 */
  applySlashItem: (it: SlashItem) => void
  /** 模式胶囊按下时保留 PM 焦点；切面只在用户当时真的正在编辑时才做光标接力。 */
  hasFocus: () => boolean
  /** 画布 → 文档：DOM 恢复为流式排版后，把原 PM 选区滚回视野并继续编辑。 */
  revealSelection: () => void
}

function UnifiedEditorHost({ path, pageDir, body, onChange, onFinalFlush, skipFinalFlush, apiRef, probe, extraPlugins, focusPlace, onFocused, onCard, readOnly = false, onAskTangu, aiMenu, onAiPrompt }: {
  path: string
  pageDir: string
  body: string
  onChange: (storedMd: string) => void
  /** 卸载(切源码/换 key 重建/关页)时的终末快照:markdownUpdated 有 200ms 防抖且销毁即 cancel,
   *  不在拆编辑器前拉平,最近击键就消失(Codex 终审 P0)。 */
  onFinalFlush: (storedMd: string) => void
  /** 回灌触发的重建要跳过终末快照(旧 doc 会盖掉刚回灌进 pipe 的新内容)。 */
  skipFinalFlush: () => boolean
  apiRef: { current: HostApi | null }
  probe?: Record<string, unknown>
  extraPlugins?: MilkdownPlugin[]
  /** 走 MilkdownInner 的 v3 聚焦通道(等 loading 完才消费):hostApi.focusStart 在编辑器
   *  初始化窗口/重建期间是静默 no-op,聚焦请求一律走这条。'body-enter' = 标题回车档(见 registry)。 */
  focusPlace: 'start' | 'end' | 'body-enter' | null
  onFocused: () => void
  /** `/card`：消费 slash 查询后，把当前顶层块交给 Canvas 卡片事务。 */
  onCard: (view: EditorView) => void
  /** 只读:PM `editable=false`、不挂键盘/粘贴/slash/工具栏(MilkdownInner 同一道门)。 */
  readOnly?: boolean
  /** 选区工具栏「问 Tangu」(G3-04);缺 = 宿主没有侧栏对话,不出按钮。 */
  onAskTangu?: (view: EditorView) => void
  /** 选区工具栏「AI ▾」(G3-07);缺 = 宿主做不了正文 AI。 */
  aiMenu?: { items: ToolbarAiItem[]; onPick: (id: string, view: EditorView) => void }
  /** `/ai`(G3-07):消费掉 '/ai' 之后在光标处开 AI 面板。 */
  onAiPrompt?: (view: EditorView) => void
}): ReactElement {
  const [, getInstance] = useInstance()
  const store = useScopedPageStore()
  // 传了它,MilkdownInner 的选中文字浮动工具栏与 slash 菜单才开(v3 同一道门)。
  const slashOps = useRef<SlashOps | null>(null)
  const [dbPick, setDbPick] = useState(false) // slash「链接数据库」唤起的已有 .db 选择器
  const finalFlushRef = useRef({ onFinalFlush, skipFinalFlush })
  finalFlushRef.current = { onFinalFlush, skipFinalFlush }
  const onCardRef = useRef(onCard)
  onCardRef.current = onCard
  const onAiPromptRef = useRef(onAiPrompt)
  onAiPromptRef.current = onAiPrompt
  useEffect(() => {
    apiRef.current = {
      applySlashItem: (it) => applySlashRef.current(it),
      applyBody: (stored, agent) => {
        let ok = false
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const doc = ctx.get(parserCtx)(toDisplayMarkdown(stored, pageDir))
          if (!doc) return
          applyMinimalDiff(view, doc as ProseNode, agent)
          adoptOrigins(view.state.doc, doc as ProseNode) // D-18:保留下来的块改记到新盘上文本的来源
          ok = true
          if (probe) probe.reconciled = ((probe.reconciled as number) ?? 0) + 1
        })
        return ok
      },
      serializeNow: () => {
        let out: string | null = null
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          // 必须与监听器同一条落盘链(Codex 终审 P0:绕过=把 \[\[ 持久化成死链;D-18:逐字回填也在这条链上)。
          out = toStoredMarkdown(serializeUnified(ctx, view.state.doc), pageDir)
        })
        return out
      },
      canonical: (stored) => {
        let out: string | null = null
        getInstance()?.action((ctx) => {
          const doc = ctx.get(parserCtx)(toDisplayMarkdown(stored, pageDir))
          if (!doc) return
          out = toStoredMarkdown(serializeUnified(ctx, doc as ProseNode), pageDir) // 与落盘同口径(见 serializeUnified 注)
        })
        return out
      },
      insertFiles: (files) => {
        void saveFiles(files)
      },
      insertMarkdown: (md, where) => insertMd(md, where),
      parseMd: (md) => {
        let out: Fragment | null = null
        getInstance()?.action((ctx) => {
          const parsed = ctx.get(parserCtx)(toDisplayMarkdown(md, pageDir)) as ProseNode | undefined
          out = parsed?.childCount ? parsed.content : null
        })
        return out
      },
      serializeMd: (content) => {
        let out: string | null = null
        // ⚠️ 必须吞异常:序列化器碰上没有 toMarkdown handler 的节点会**抛**(columns.ts 顶注:
        //    amadeusColumnRow 折进序列化树必炸)。本方法的调用方之一是画布的 cut —— 让它抛出去
        //    的话 preventDefault 与「删掉被剪的卡」两步一起没执行,剪切当场变成什么都没发生。
        //    交回 null,调用方自己兜底(舞台退回 textBetween)。
        try {
          getInstance()?.action((ctx) => {
            const view = ctx.get(editorViewCtx)
            const doc = view.state.schema.topNodeType.createAndFill(undefined, content)
            if (doc) out = normalizeSerializedMd(ctx.get(serializerCtx)(doc))
          })
        } catch {
          return null
        }
        return out
      },
      focusStart: () => {
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)))
          view.focus()
        })
      },
      focusEnd: () => {
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
          view.focus()
        })
      },
      focusTail: () => {
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { doc, schema } = view.state
          const para = schema.nodes.paragraph
          const emptyPara = (n: ProseNode | null): boolean => !!n && n.type === para && n.content.size === 0
          const last = doc.lastChild
          let tr = view.state.tr
          // 末块有内容(含「末块是卡」—— 闭合锚 2026-08-19 之后卡后顶层正文完全合法,AFFiNE 同款
          // 卡外新行)→ 顶层追加普通空段;已是空段 → 不重复加,直接落光标。
          if (!emptyPara(last)) tr = tr.insert(doc.content.size, para.create())
          view.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView())
          view.focus()
        })
      },
      hasFocus: () => {
        let focused = false
        getInstance()?.action((ctx) => { focused = ctx.get(editorViewCtx).hasFocus() })
        return focused
      },
      revealSelection: () => {
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          view.dispatch(view.state.tr.scrollIntoView())
          view.focus()
        })
      },
    }
    return () => {
      // 终末快照(见 onFinalFlush 注):子效应清理先于 MilkdownProvider 销毁,实例此刻还活着。
      if (!finalFlushRef.current.skipFinalFlush()) {
        const md = apiRef.current?.serializeNow() ?? null
        if (md != null) finalFlushRef.current.onFinalFlush(md)
      }
      apiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getInstance, pageDir])

  const saveImage = async (file: File): Promise<string | null> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { opts } = await getAttachmentPrefs()
      const { pageRel } = await amadeus.saveAttachment(path, file.name || 'pasted.png', bytes, opts)
      return toAssetUrl(joinRel(pageDir, pageRel))
    } catch {
      return null
    }
  }

  /** 粘贴的非图片文件(v3 同语义):逐个存附件 → 光标所在块之后插一串 `![[base]]` 段落
   *  (嵌入层自动渲染成文件卡/PDF)。此前 unified 传空实现,粘贴被 preventDefault 后静默吞掉(审计实报)。 */
  const saveFiles = async (files: File[]): Promise<void> => {
    if (!files.length) return
    // 先出占位块再上传(AFFiNE 同):大文件时用户立刻看到「东西已经落在这儿了」,而不是盯着
    // 一个没反应的编辑器等几秒。占位文本带零宽标记,替换时按标记找回位置 —— 期间用户照常打字,
    // 位置会跟着事务走(靠文本定位而不是缓存 pos,回灌/外部改动都不会把它对错地方)。
    const marks = files.map((f, i) => `\u200b${translate('unipage.upload.uploading', { name: f.name || translate('unipage.upload.fileN', { n: i + 1 }) })}\u200b`)
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const paragraph = view.state.schema.nodes.paragraph
      if (!paragraph) return
      const { $to } = view.state.selection
      // 选区末端在 doc 顶层(选中的顶层块 —— 文件拖到 hr 上就是这样,见 blockLayer 的文件落点)= 紧跟其后。
      let pos = $to.depth >= 1 ? $to.after(1) : $to.pos
      let tr = view.state.tr
      for (const m of marks) {
        const node = paragraph.create(null, view.state.schema.text(m))
        tr = tr.insert(pos, node)
        pos += node.nodeSize
      }
      view.dispatch(tr.scrollIntoView())
    })
    /** 用占位文本找回它现在在哪(找不到 = 用户已经把它删了 → 什么都不做)。 */
    const replaceMark = (mark: string, md: string | null): void => {
      getInstance()?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        let fFrom = -1
        let fTo = -1
        view.state.doc.descendants((n, pos) => {
          if (fFrom >= 0 || !n.isTextblock || n.textContent !== mark) return true
          fFrom = pos
          fTo = pos + n.nodeSize
          return false
        })
        if (fFrom < 0) return
        const found = { from: fFrom, to: fTo }
        const paragraph = view.state.schema.nodes.paragraph
        const tr = md && paragraph
          ? view.state.tr.replaceWith(found.from, found.to, paragraph.create(null, view.state.schema.text(md)))
          : view.state.tr.delete(found.from, found.to)
        view.dispatch(tr)
      })
    }
    for (let i = 0; i < files.length; i++) {
      replaceMark(marks[i], await saveOneFile(path, files[i])) // 失败 = null → 把占位撤掉,不留一行假内容
    }
  }

  /** 把一段 markdown 插进当前文档。返回是否真落地(编辑器没挂载 / 解析成空 = false)。
   *  - `'cursor'`(缺省,用户动作走这档):光标所在**顶层块**为空 → 原地替换;否则插到它之后。
   *    「顶层块」= doc 或分栏 cell 的直接子节点 —— 列内插入绝不许穿出到 doc 级(否则 /代码块
   *    在列里会插到整行下面)。列表项里插 = 插在整份列表之后(与 Tab 层同一套祖先判定)。落光标+聚焦。
   *  - `'start'`/`'end'`(插件写口走这两档):doc 的最前/最后。**不动选区、不抢焦点** —— 调用方是
   *    插件按钮/浮层,用户此刻的光标可能正在别处,PM 会把选区随事务映射过去。
   *  卡片文档也安全:插的是普通顶层节点,`canvasIntegrityGuard` 那道 filterTransaction 只拒
   *  「卡不在 doc 顶层」,不拒卡前后的正文(闭合锚 2026-08-19 之后卡外顶层正文完全合法)。
   *  v3 走的是 store 的 onChange/onInsertAfter(块世界);统一实例没有块 id,一切都是本 doc 的事务。 */
  const insertMd = (md: string, where: 'cursor' | 'start' | 'end' = 'cursor'): boolean => {
    let done = false
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const parsed = ctx.get(parserCtx)(toDisplayMarkdown(md, pageDir)) as ProseNode | undefined
      if (!parsed?.childCount) return
      const content = parsed.content
      if (where !== 'cursor') {
        const at = where === 'start' ? 0 : view.state.doc.content.size
        view.dispatch(view.state.tr.insert(at, content))
        done = true
        return
      }
      const { $from } = view.state.selection
      let d = $from.depth
      while (d >= 1 && !['doc', 'amadeusColumnCell'].includes($from.node(d - 1).type.name)) d--
      if (d < 1) return
      const from = $from.before(d)
      const to = $from.after(d)
      const blank = $from.node(d).textContent.trim() === ''
      let tr = blank ? view.state.tr.replaceWith(from, to, content) : view.state.tr.insert(to, content)
      // 落点=插入内容的末尾(v3 的 requestSelfFocus('end') 同位):near() 会自己找最近的合法文字位。
      const end = Math.min((blank ? from : to) + content.size, tr.doc.content.size)
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(end)))
      view.dispatch(tr.scrollIntoView())
      view.focus()
      done = true
    })
    return done
  }

  /** 建文件类 slash 项的落点守卫:await 期间用户可能已切走(实例退休/换页)。v3 靠 blockId 三道闸,
   *  统一实例只需一道 —— 编辑器还活着就还是同一篇(实例与路径同生共死,pipe.retired 会拆掉它)。 */
  const insertAsync = (md: string): void => {
    if (!apiRef.current) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('unipage.toast.insertPointLost') } }))
      return
    }
    insertMd(md)
  }

  /** 新建 .fd 子文件(数据库/画板/笔记视图)→ 插 `![[base]]` 嵌入块。三处只差文件名与内容。 */
  const createFdFile = async (name: string, bytes: Uint8Array, stripMd = false): Promise<void> => {
    try {
      const { base } = await amadeus.saveAttachment(path, name, bytes, { mode: 'vault', folder: fdDirOf(path) })
      insertAsync(`![[${stripMd ? base.replace(/\.md$/i, '') : base}]]`) // Obsidian 惯例:嵌入链接省掉 .md
      void store.getState().syncFdChildren(path)
    } catch { /* 保存失败静默跳过(v3 同款) */ }
  }

  /** 移动端双列块面板的落点(真身)。登记/撤销由**宿主 UnifiedPage** 管(见那边的 stableApply):
   *  登记必须跟着焦点走,而焦点信号在宿主的 `.unified-body` 上。这里只负责把 applySlash
   *  经 HostApi 交出去,并保持 ref 型身份 —— apiRef 是挂载期一次性组装的,直接放 applySlash
   *  会把闭包钉死在首帧。 */
  const applySlashRef = useRef<(it: SlashItem) => void>(() => {})

  /** slash 选中项 → 统一实例的落地(v3 MarkdownBlock.applySlash 的对位实现)。
   *  前缀型(文本/标题/列表/待办/引用/折叠)走编辑器内单事务转换,不新建块;其余先消费 '/query',
   *  再按类型插入。「模板」把本篇 path 交给宿主的选择器,由它插回来。 */
  const applySlash = (item: SlashItem): void => {
    const ops = slashOps.current
    if (!ops) return // fail closed:实例刚重挂/已销毁时不执行,免得删不掉的 '/query' 留成残渣
    const prefix = item.run ? undefined : PREFIX_TRIGGERS[item.scaffold]
    if (prefix) {
      if (!ops.transform(prefix)) slashTurnFailed(item.label)
      return
    }
    ops.consume() // 返回值是「整篇是否空」,统一实例用不着:空块判定在 insertMd 里按当前顶层块算
    const S = SLASH_SENTINELS
    if (item.scaffold === S.template) {
      // 模板库住在宿主壳里(vault 的 templates/),编辑器不认识它 —— 照 v3 的老规矩发事件,
      // 由 amadeusOverlays 的 TemplatePicker 接。**必须带上本篇 path**:v4 没有块 id,选择器
      // 回插时要的是「往哪篇写」,而选择器开着的这段时间面板还可能被切走。
      window.dispatchEvent(new CustomEvent('amadeus:template-picker', { detail: { v4Path: path } }))
      return
    }
    if (item.scaffold === S.card) {
      getInstance()?.action((ctx) => onCardRef.current(ctx.get(editorViewCtx)))
      return
    }
    if (item.scaffold === S.ai) {
      // `/ai`(G3-07):'/ai' 已被 consume 掉,光标留在原处 → 宿主在这里开 AI 面板(先问一句指令,留空 = 续写)。
      getInstance()?.action((ctx) => onAiPromptRef.current?.(ctx.get(editorViewCtx)))
      return
    }
    if (item.run) {
      // 插件注册的「先干活再插入」项。插件是 new Function 装载的第三方 JS,返回值一律当外部输入校验
      // (与 v3 同一套闸:非字符串会毒化文档,NUL/控制字符会污染笔记文件)。
      void (async () => {
        try {
          const md = await item.run!({ pagePath: path, folder: fdDirOf(path) })
          if (md === '' || md == null) return
          if (typeof md !== 'string') throw new Error(translate('unipage.plugin.notString', { type: typeof md }))
          if (md.length > 8192) throw new Error(translate('unipage.plugin.tooLong'))
          // 控制字符逐码点判(放行 \t \n):正则字面量写法会把真控制字节带进源文件。
          if (Array.from(md).some((c) => c.charCodeAt(0) < 32 && c !== String.fromCharCode(9) && c !== String.fromCharCode(10))) {
            throw new Error(translate('unipage.plugin.controlChars'))
          }
          insertAsync(md)
          void store.getState().syncFdChildren(path)
        } catch (e) {
          console.error('[plugin] slash item failed', e)
          window.dispatchEvent(new CustomEvent('amadeus:toast', {
            detail: { text: translate('unipage.plugin.failed', { label: item.label, err: e instanceof Error ? e.message : String(e) }), error: true },
          }))
        }
      })()
      return
    }
    if (item.scaffold === S.image) {
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
            const { base } = await amadeus.saveAttachment(path, f.name || 'image.png', bytes, opts)
            insertAsync(`![[${base}]]`) // 与拖入同形态:嵌入层渲染成图片块
          } catch { /* 保存失败静默跳过 */ }
        })()
      }
      input.click()
      return
    }
    if (item.scaffold === S.column) {
      getInstance()?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const { $from } = view.state.selection
        if ($from.depth !== 1) {
          // 已在列内/列表里:分栏只做顶级(与 ⠿ 菜单同规)。'/query' 此刻已被 consume 删掉 ——
          // 什么都不说等于「打了字、字没了、也没分栏」,必须给一句。
          window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('unipage.toast.columnTopLevelOnly') } }))
          return
        }
        splitToColumn(view, $from.before(1), $from.after(1), $from.node(1))
        view.focus()
      })
      return
    }
    if (item.scaffold === S.page) {
      // 新建子页面(Notion /page):落本笔记的 .fd 子文件夹,插入 [[链接]] 随后打开。
      void (async () => {
        try {
          const st = store.getState()
          const newPath = await st.createChildNote(path, translate('amadeus.default.note'))
          insertAsync(`[[${newPath.split('/').pop()!.replace(/\.md$/i, '')}]]`)
          void st.loadPage(newPath) // 本实例随之退休,onFinalFlush 把刚插的链接一并落盘
        } catch { /* 创建失败静默跳过 */ }
      })()
      return
    }
    if (item.scaffold === S.database) {
      const dbName = translate('amadeus.default.database')
      void createFdFile(`${dbName}.db`, new TextEncoder().encode(serializeDb(emptyDb(dbName))))
      return
    }
    if (item.scaffold === S.drawing) {
      // Obsidian Excalidraw 插件同款 .excalidraw.md(同一个库两边可互开);时间戳命名照抄它。
      void createFdFile(`${stampedFileName(translate('unipage.file.drawing'))}.excalidraw.md`, new TextEncoder().encode(blankDrawing(BLANK_SCENE_JSON)), true)
      return
    }
    if (item.scaffold === S.noteview) {
      // 「笔记视图」(Bases 式,行即笔记):行文件夹与 .db 视图定义都落 .fd 子文件夹。
      void (async () => {
        const fdDir = fdDirOf(path)
        let folderRel: string | null = null
        for (let i = 1; i <= 20 && folderRel === null; i++) {
          try {
            folderRel = await amadeus.createFolder(fdDir, i === 1 ? translate('unipage.file.noteView') : translate('unipage.file.noteViewN', { n: i }))
          } catch { /* 撞名,试下一个 */ }
        }
        if (folderRel === null) return
        const viewName = translate('unipage.file.untitledView')
        await createFdFile(`${viewName}.db`, new TextEncoder().encode(serializeDb(emptyNoteView(viewName, folderRel))))
      })()
      return
    }
    if (item.scaffold === S.linkdb) {
      setDbPick(true)
      return
    }
    if (item.scaffold === S.bookmark) {
      // 整块 = 一行裸 URL → 嵌入层渲染为书签卡(og 元数据/YouTube 播放器);md 零私有语法。
      void askString(translate('unipage.bookmark.title'), '', { label: translate('unipage.bookmark.label') }).then((raw) => {
        const url = raw?.trim()
        if (url && /^https?:\/\/\S+$/i.test(url)) insertAsync(url)
      })
      return
    }
    if (item.scaffold === S.embed) {
      // 跨笔记块嵌入:剪贴板里有块菜单复制的 `![[笔记#块]]` 就预填。
      void (async () => {
        let prefill = ''
        try {
          const m = /!?\[\[([^\]\n]+)\]\]/.exec(await navigator.clipboard.readText()) // 块菜单复制的是 `[[笔记#…]]`
          if (m) prefill = m[1].trim()
        } catch { /* clipboard unavailable */ }
        const raw = await askString(translate('unipage.embed.title'), prefill, {
          label: translate('unipage.embed.label'),
          confirmLabel: translate('unipage.embed.confirm'),
        })
        const target = raw?.trim().replace(/^!?\[\[/, '').replace(/\]\]$/, '').trim()
        if (target) insertAsync(`![[${target}]]`)
      })()
      return
    }
    // 整块型(代码/表格/分隔线/公式/[[/按钮):scaffold 本身就是要插的 markdown。
    insertMd(item.scaffold)
  }
  applySlashRef.current = applySlash // 交出去的是恒等身份 stableApply,真身逐渲染刷新

  return (
    <>
      <MilkdownInner
        initial={toDisplayMarkdown(body, pageDir)}
        onChange={(displayMd) => onChange(toStoredMarkdown(displayMd, pageDir))}
        keys={NOOP_KEYS}
        saveImage={saveImage}
        saveFiles={saveFiles}
        onOpenWiki={(name, o) => void store.getState().openWikiLink(name, path, o)}
        getPageNames={() => store.getState().pages}
        slashOpsRef={slashOps}
        onSlashPick={applySlash}
        getFiles={() => (wikiFilesEnabled() ? store.getState().files : [])}
        isWikiResolved={(n) =>
          !!resolvePageName(n, store.getState().pages, path) || !!resolveFileName(n, store.getState().files, path)}
        wikiIcon={(n) => {
          const p = resolvePageName(n, store.getState().pages, path)
          return p ? store.getState().icons[p] : undefined
        }}
        focusPlace={focusPlace}
        onFocused={onFocused}
        unified
        attachmentPagePath={path}
        extraPlugins={extraPlugins}
        readOnly={readOnly}
        onAskTangu={onAskTangu}
        aiMenu={aiMenu}
      />
      {dbPick && (
        <OverlayPortal><DbLinkPicker
          onClose={() => setDbPick(false)}
          onPick={(inner) => {
            setDbPick(false)
            insertMd(`![[${inner}]]`)
          }}
        /></OverlayPortal>
      )}
    </>
  )
}

/** 行内标题 + emoji 图标 + 添加图标/封面动作(与 v3 NoteTitle 同 DOM/同 CSS,数据走 fm 管线)。 */
function UnifiedTitle({ path, icon, cover, onSetIcon, onSetCover, onRename, onEnterBody, focusSignal, compact = false, readOnly = false }: {
  compact?: boolean
  path: string
  icon: string | null
  cover: string | null
  /** 只读(公开分享页):标题是静态文本,没有图标/封面动作,也不改名。 */
  readOnly?: boolean
  onSetIcon: (em: string | null) => void
  onSetCover: (cover: string) => void
  /** 返回改名是否成功:失败(撞名/非法名)时输入框还原旧名,不留「显示新名实为旧名」的假象。 */
  /** focusKind = 触发本次 commit 的按键档(回车/方向键),点走 blur 恒 null —— 逐次绑定逐次消费,
   *  不用时间窗推断(Codex 深夜 F2:5 秒窗会把「回车后 5 秒内点走改名」误判成回车改名,凭空插首行抢焦点)。 */
  onRename: (next: string, focusKind: 'enter' | 'move' | null) => Promise<boolean>
  /** 'enter' = 回车确定标题(首块非空段则顶插空白首行);'move' = 方向键滑入正文(只落光标不插行)。 */
  onEnterBody: (kind: 'enter' | 'move') => void
  /** 新建流:挂载即聚焦标题(认领 pageStore 的一次性聚焦请求后由父级置真)。 */
  focusSignal: boolean
}): ReactElement {
  const { t } = useI18n()
  const spell = useNotesSpellcheck() // 标题与正文同一个拼写检查开关(G4-07)
  const current = (path.split('/').pop() ?? path).replace(/\.md$/i, '')
  const shown = UNTITLED_RE.test(current) ? '' : current
  const [val, setVal] = useState(shown)
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null)
  const [coverPick, setCoverPick] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { setVal(shown) }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focusSignal) return
    const el = ref.current
    if (el) {
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
    }
  }, [focusSignal])
  // 本次 blur 由哪个键触发(commit 时一次性消费):回车/方向键在 keydown 里设,点走 blur 恒 null。
  const blurKind = useRef<'enter' | 'move' | null>(null)
  const commit = (): void => {
    const kind = blurKind.current
    blurKind.current = null
    const next = val.trim()
    if (next && next !== current) void onRename(next, kind).then((ok) => { if (!ok) setVal(shown) })
    else setVal(shown)
  }
  if (readOnly) {
    // 同一套 DOM 类名(.amx-title-wrap / .amx-title-bigicon / .amx-title-input)保证观感与编辑态逐字同源;
    // 只是把 input 换成静态标题、按钮换成 span。未命名笔记直接显示文件名,不显示「New Page」占位。
    return (
      <div className="amx-title-wrap amx-title-ro">
        {icon && <span className="amx-title-bigicon" aria-hidden>{icon}</span>}
        <div className="amx-title-row">
          <h1 className="amx-title-input amx-title-static">{shown || current}</h1>
        </div>
      </div>
    )
  }
  return (
    <div className="amx-title-wrap">
      {!compact && icon && (
        <button
          className="amx-title-bigicon"
          title={t('unipage.title.iconAction')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setPick({ x: r.left, y: r.bottom + 6 })
          }}
        >
          {icon}
        </button>
      )}
      {!compact && (!icon || !cover) && (
        <div className="amx-title-actions">
          {!icon && <button onClick={() => onSetIcon(randomEmoji())}><PageSmileIcon size={14} strokeWidth={1.7} aria-hidden="true" />{t('unipage.title.addIcon')}</button>}
          {!cover && (
            <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCoverPick({ x: r.right, y: r.bottom + 6 }) }}><CoverImageIcon size={14} strokeWidth={1.7} aria-hidden="true" />{t('unipage.title.addCover')}</button>
          )}
        </div>
      )}
      <div className="amx-title-row">
        <input
          ref={ref}
          className="amx-title-input"
          spellCheck={spell}
          value={val}
          placeholder="New Page"
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // 输入法组合中一律放行(AFFiNE doc-title 同款守卫):中文用拼音打标题、按 Enter 选词,
            // 没有这道闸就会当场跳进正文、候选词也丢了。正文侧由 PM 自己挡(inOrNearComposition),
            // 标题是原生 input,得自己挡。
            if (e.nativeEvent.isComposing) return
            const el = e.currentTarget
            // Tab 吞掉:与 blockLayer tabKeymap 的「编辑器内按 Tab 绝不把焦点放走」同口径 ——
            // 标题栏此前漏了这条,一按 Tab 焦点就跑到侧栏/工具条上去了。
            if (e.key === 'Tab') { e.preventDefault(); return }
            const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
            if (e.key === 'Enter' || ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && atEnd)) {
              e.preventDefault()
              blurKind.current = e.key === 'Enter' ? 'enter' : 'move'
              el.blur() // blur → commit(改名);统一实例正文恒存在,先后顺序无 v3 的首块竞态
              onEnterBody(e.key === 'Enter' ? 'enter' : 'move')
            }
            if (e.key === 'Escape') { setVal(shown); el.blur() }
          }}
        />
      </div>
      {pick && (
        <IconPicker
          x={pick.x}
          y={pick.y}
          current={icon}
          onPick={(em) => { onSetIcon(em); setPick(null) }}
          onClose={() => setPick(null)}
        />
      )}
      {coverPick && (
        <CoverPicker page={path} x={coverPick.x} y={coverPick.y} onApply={(c) => onSetCover(c)} onClose={() => setCoverPick(null)} />
      )}
    </div>
  )
}

/** 本实例的撤销 / 重做入口(宿主的非键盘按钮用,如移动端胶囊;返回是否真退/进了一步)。 */
export interface UnifiedHistory {
  undo: () => boolean
  redo: () => boolean
  /** 缩进 / 提升一档(= Tab / Shift-Tab)。挂在同一只句柄上,是因为宿主的移动端胶囊只握这一只(G2-06)。 */
  indent?: (dir: 1 | -1) => boolean
}

export function UnifiedPage({ path, initial, diskRaw, probe, onRenamed, onCanvasMode, historyRef, filesRef, onUnlock, compact = false, readOnly = false, hardBreaks = false }: {
  /** Mini Panel keeps a small editable title and body, without page decoration or metadata. */
  compact?: boolean
  path: string
  /** router 已读到的源文(打开即升场景是升级后的 v4 源)。 */
  initial: string
  /** 磁盘上的原始字节(打开即升场景 ≠ initial):回灌基线必须用它 —— 否则挂载补读会把
   *  盘上旧 v3 原文当外部更新灌回编辑器,升级当场被冲掉(Codex 终审)。缺省 = initial。 */
  diskRaw?: string
  probe?: Record<string, unknown>
  /** 行内改名成功 → 通知宿主换 leaf 参数(路径变了,本实例随 key 重建)。 */
  onRenamed?: (newPath: string) => void
  /** 画布模式的状态出口。桌面走 CanvasSegPortal 投进顶栏插槽,移动端整条顶栏不渲染 → 没插槽,
   *  改由宿主(NoteView)把它放进底栏胶囊的「⋯」。交给**父组件**而不是全局槽:结构上就是同一篇
   *  笔记,旧写法「uiOverlay 单槽 + 路径比对」栽过的那三条歧路(见 CanvasModeSeg 顶注)一条都不沾。 */
  onCanvasMode?: (s: { on: boolean; toggle: () => void } | null) => void
  /** 撤销 / 重做的出口(G2-05)。v4 不进 pageStore,宿主按 activePage 门控的 `myPs().undo()` 在这里是死键;
   *  宿主(NoteView)给本 leaf 自己的 ref,不按路径全局查找。卸载时清空。 */
  historyRef?: { current: UnifiedHistory | null }
  /** 本 leaf 自己的文件写口(评审 G1-02):宿主的 OS 拖入 / 上传按钮直接递给**这个**实例(存附件 + 光标处插 `![[base]]`),
   *  不按路径全局查找 —— 同篇双开时按路径找到的是另一个标签:指示线画在这边,文件却插进那边、随即被这边的写入盖掉。
   *  返回 false = 本实例不接(只读 / 已退休)。卸载时清空。 */
  filesRef?: { current: ((files: File[]) => boolean) | null }
  /** 锁定页面(评审 C-07,拍板 #15):宿主按本机记忆把自己的笔记锁成只读时给;只读下显示「已锁定」条与解锁键。
   *  分享页 / 收件箱这类天生只读的宿主不给 —— 那里没有「解锁」可言。锁定态由宿主放进本组件的 key(pipe.readOnly
   *  只在首次渲染写入,换锁定态必须重挂)。 */
  onUnlock?: () => void
  /** 只读实例(公开分享页 /share/<token>,2026-09-07):同一套渲染(块/分栏/卡片/画布/嵌入/chrome),
   *  但**一个字节都不写**:PM editable=false,writeNow/schedule/setFm/改名/生命周期 flush 全部短路,
   *  舞台只能平移缩放,标题/封面/属性只展示。桥那头(shareBridge)的写方法本就拒绝 —— 这里是第一道闸,
   *  桥是第二道;两道缺一不可(桥拒了会 toast「保存失败」,用户以为自己在编辑)。 */
  readOnly?: boolean
  /** 单个 `\n` 当换行渲染(收件箱的信按聊天口径;标准 markdown 里它是空格)。**别按 readOnly 判** ——
   *  公开分享页也是 readOnly,那是笔记,得守标准 markdown 语义。见 softBreak.ts 的 hardBreakRemark。 */
  hardBreaks?: boolean
}): ReactElement {
  const pageDir = path.split('/').slice(0, -1).join('/')
  const scoped = useScopedPageStore()
  const vaultRoot = scoped.getState().vaultRoot
  /** 所属 leaf(不在面板里 = null):同篇多开时的实例身份 —— 草稿槽位、改名聚焦的认领、openNote 落点都认它(G1-02)。 */
  const scope = useContext(PageScopeCtx)
  const activeScope = useActivePageScope()
  // 源码模式是全局开关(`</>`):只读实例(分享页 / 收件箱消息 / 库外预览)一律钉在所见即所得 —— 源码 textarea 可编辑但
  // 什么也不会落盘,切走即丢,等于假编辑(Codex 09-11 P1)。
  const globalMode = useUiOverlay((s) => s.editorMode)
  const mode = readOnly ? 'wysiwyg' : globalMode
  const { t } = useI18n()
  // 源码模式与可视模式同一个拼写检查开关(G4-07:此前源码恒关、可视恒开,两种模式口径相反)。
  const spellcheck = useNotesSpellcheck()

  const pipeRef = useRef<Pipe | null>(null)
  if (!pipeRef.current) {
    // D-19:纯 CRLF 的笔记进门归一成 LF、记下行尾,写盘时还原(见 ./eol;打开即升场景行尾以 diskRaw 为准)。
    const disk = fromDisk(diskRaw ?? initial)
    const { fmText, body } = splitFm(diskRaw == null ? disk.text : fromDisk(initial).text)
    pipeRef.current = { fm: fmText, body, lastSaved: disk.text, eol: disk.eol, pending: false, timer: null, reconcileBusy: 0, unpreserved: null, preserved: new Set(), failed: false, retryTimer: null, retryN: 0, stashed: null, writing: 0, dead: false, retired: false, sawRows: false, ownedCards: new Set(), chain: Promise.resolve(), readOnly, slot: scope, peerPatch: null }
  }
  const pipe = pipeRef.current
  /** 最近一次被用户用到的时刻(评审 G1-02):焦点 / 指针进入本实例、或所属 leaf 成为活动面板时记一笔。
   *  lifecycle 按它给同路径实例排序 —— 按路径的操作(插模板 / 大纲 / 跳转 / 树行拖入 / fm 补丁)落到最近用过的那个。 */
  const lastActive = useRef(0)
  /** 「切换文档 / 画布」命令(V-20)的落点:与 lastActive 同一个时机认领(最近用过的那一篇)。恒等身份,真身在下面随渲染刷新。 */
  const canvasToggleImpl = useRef<(() => void) | null>(null)
  const canvasToggleCmd = useRef((): void => { canvasToggleImpl.current?.() }).current
  const touchActive = (): void => { lastActive.current = performance.now(); claimCanvasToggle(canvasToggleCmd) }
  useEffect(() => {
    // 切标签只激活 leaf、未必把焦点给编辑器(命令面板插模板就是这个形态):活动面板本身也算「正在用」。
    if (scope != null && scope === activeScope) touchActive()
  }, [scope, activeScope])
  // 属性面板里还没失焦的草稿(C-02):落盘冲洗(卸载 / beforeunload / 换库 / 退出握手)先把它们提交进 pipe.fm。
  const [propDrafts] = useState(() => new Set<() => void>())
  const flushPropDrafts = (): void => { for (const f of [...propDrafts]) f() }
  const [fmVer, setFmVer] = useState(0) // fm 变更驱动 chrome 重渲(pipe 本身是 ref)
  const [editorKey, setEditorKey] = useState(0) // 源码 → 可视切回时重建编辑器(正文可能被改)

  // ⚠️ 插件启停 = **第四条重 parse 路径**,而且是唯一一条绕开本组件的:MarkdownBlock 自己订阅
  //    `editorExtensionGen` 并把它挂在 `useEditor` 的 deps 上,milkdown 于是 destroy+create,
  //    `ctx.set(defaultValueCtx, initial)` 吃的是**那一刻的 prop**。v3 时代 content 由 store 驱动、
  //    变了就重渲,所以 prop 恒新;v4 换成 ref 型 pipe 之后,拖块成卡与打字全程零 setState ——
  //    prop 停在上一次 UnifiedPage 渲染那一刻。后果不是「丢几个字」而是**毁数据**:陈旧 body 里
  //    缺新卡的锚 → foldCanvas fail-closed 早退 → onFolded 不被调用,而这条重建**不经
  //    setEditorKey、也不卸载 UnifiedEditorHost**,三处 ownedCards.clear() 一处都够不着 →
  //    归属集合停在上一世代 ⊇ 磁盘 cards → 派生判据放行 → 写回 `cards: []`,全部卡片几何没了
  //    (没有 elements 时更狠:整个 amadeus_canvas 键被剥)。
  //    修法是把它拉回既有纪律:代次进 MilkdownProvider 的 key(整棵子树按**本次渲染**的 pipe.body
  //    重挂,旧实例卸载时的 onFinalFlush 先把真实内容收回来),归属集合在**渲染期**换世代 ——
  //    放 effect 里会排在子树 fold 之后,把刚折出来的锚当场清掉。
  const extGen = useSyncExternalStore(subscribeEditorExtensions, editorExtensionGen)
  const lastExtGen = useRef(extGen)
  if (lastExtGen.current !== extGen) {
    lastExtGen.current = extGen
    pipe.ownedCards.clear()
  }
  const hostApi = useRef<HostApi | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const segAnchorRef = useRef<HTMLSpanElement | null>(null)
  const [segAnchor, setSegAnchor] = useState<HTMLElement | null>(null)

  // ── 画布模式(canvas.ts / canvasStage.tsx)。────────────────────────────────────
  // **默认恒为文档模式**(用户 2026-08-16 原话:「它首先是个文档」)。只有磁盘上已经物化过画布、
  // 且上次退出时停在画布模式,打开才直接进画布 —— 没有 amadeus_canvas 键的笔记永远从文档进。
  // 移动端**忽略持久化的 mode:"canvas"**,恒从文档进(方案 §6.1,Codex P1):mode 是跨设备
  // 持久化的 —— 不挡的话「在桌面切到画布」会让同一篇笔记在手机上打开就直接是画布,用户完全
  // 不知道发生了什么。手机要看画布,自己点底栏胶囊「⋯」里的模式项(见下面的 onCanvasMode)。
  // ⚠️ 判据 2026-08-20 从 `UI_MODE !== 'mobile'` 改成 `!isCoarsePointer()`:UI_MODE 读的是
  //    localStorage `lcl.uiMode`,而写它的那段自动脚本只在 desktop/frontend/index.html 与
  //    web/index.html 里 —— **mobile/index.html 没有**,MobileRoot 也绕过 uiMode.ts 直接渲
  //    SingleColumnHost。于是安卓 APK 里 UI_MODE 恒 'desktop',这道门从来没生效过(用户实报
  //    「移动端没有画布」时顺带查出)。改用顶栏渲染与否用的**同一个信号**,两者不再各说各话。
  const [canvasOn, setCanvasOn] = useState(() => {
    if (isCoarsePointer()) return false
    const remembered = readNoteSurfaceMode(vaultRoot, path)
    return remembered ? remembered === 'canvas' : parseCanvasJson(canvasLineOf(pipe.fm))?.mode === 'canvas'
  })
  /** 正在编辑时切面才发定位信号；普通浏览/点选切面保持各自记忆的位置，不凭陈旧选区乱跳。 */
  const [canvasReveal, setCanvasReveal] = useState(0)
  const revealDocAfterSwitch = useRef(false)
  const canvasModeRef = useRef(canvasOn) // deriveFmFromDoc 在事件里同步读,不能等 state 落定
  canvasModeRef.current = canvasOn
  // ⚠️ 只有用户**亲手点过模式钮**,本实例才有资格改盘上的 mode。不设这道闸的话:桌面存了
  // `mode:"canvas"`,手机按约定以文档模式打开,随后只改正文 → 派生无条件把 mode 覆写成 "doc",
  // 「移动端忽略 mode」就变成了「移动端改写 mode」,桌面下次也进不去画布了(Codex P1-7)。
  const modeTouched = useRef(false)
  // 单次解析(canvasLine 是字符串,不变时 memo 命中 → main/elements 的引用也稳,不会每渲染
  // 把舞台的白板层依赖抖一遍)。
  const canvasLine = canvasLineOf(pipe.fm)
  const canvasDoc = useMemo(() => parseCanvasJson(canvasLine), [canvasLine])
  const canvasMain = canvasDoc?.main ?? { x: 0, y: 0, w: MAIN_W }
  const toggleCanvas = (): void => {
    const next = !canvasOn
    const editing = hostApi.current?.hasFocus() ?? false
    if (editing) {
      if (next) setCanvasReveal((v) => v + 1)
      else revealDocAfterSwitch.current = true
    }
    // 满铺 class 提交时浏览器可能先把 pane.scrollTop 归零、随后才跑 effect cleanup；切面按钮的
    // click 里先同步留档，避免 cleanup 读到归零后的假位置。
    if (next) {
      const pane = segAnchorRef.current?.closest<HTMLElement>('.amx-pane')
      if (pane) writeDocumentScroll(vaultRoot, path, pane.scrollTop)
    }
    canvasModeRef.current = next
    modeTouched.current = true
    writeNoteSurfaceMode(vaultRoot, path, next ? 'canvas' : 'doc')
    setCanvasOn(next)
    // 切模式本身**不算用过画布**(方案 §4):没物化过就只是换个视角,一个字节都不写。
    // 已物化的才把 mode 跟着落盘 —— 走的仍是同一条防抖单写者,不另开写路径。
    if (canvasLineOf(pipe.fm) != null) {
      syncFromEditor()
      schedule()
    }
  }
  const toggleCanvasRef = useRef(toggleCanvas)
  toggleCanvasRef.current = toggleCanvas
  // 源码模式没有胶囊(见下方 CanvasSegPortal 的门),命令同口径空操作。
  canvasToggleImpl.current = mode === 'source' ? null : () => toggleCanvasRef.current()
  useEffect(() => {
    claimCanvasToggle(canvasToggleCmd) // 新开一篇不点正文也能用(同 setFocusedBlockApply 的挂载登记)
    return () => releaseCanvasToggle(canvasToggleCmd)
  }, [canvasToggleCmd])

  /** 移动端「+」双列块面板的落点登记。v3 由每个 MarkdownBlock 在 onFocusCapture 里登记自己,
   *  v4 整页只有一个编辑器 —— 但**不能只在挂载时登记**:dockview 会把非活动面板一起挂着,
   *  触屏笔记本上分屏两篇 v4,最后挂载的那篇会抢走落点,点「+」插进背景那篇里去。
   *  所以照抄 v3 的口径:挂载先登记一次(新开一篇不点正文也能用「+」),焦点进本页再登记一次。
   *  卸载只撤自己那份;applySlash 经 hostApi 走,实例没了就是 null → fail-closed。 */
  const stableApply = useRef((it: SlashItem) => hostApi.current?.applySlashItem(it)).current
  useEffect(() => {
    setFocusedBlockApply(stableApply)
    return () => { if (getFocusedBlockApply() === stableApply) setFocusedBlockApply(null) }
  }, [stableApply])
  // 交出去时 toggle 恒经 ref 取最新那份(宿主把它存进 state,不然会捏着某一帧的闭包)。
  useEffect(() => {
    onCanvasMode?.({ on: canvasOn, toggle: () => toggleCanvasRef.current() })
    return () => onCanvasMode?.(null)
  }, [canvasOn, onCanvasMode])
  /** 画布舞台的统一撤销仲裁(CanvasStage 经 histStepRef 交上来,与它的 Cmd+Z 捕获同一个 histStep)。 */
  const stageHist = useRef<((dir: 'undo' | 'redo') => boolean) | null>(null)
  // 撤销 / 重做交给宿主:与键盘**同路** —— 画布态走舞台仲裁(canvasStage 的 onKeyDownCapture),
  // 文档态走 PM history(milkdown history keymap 的同一对命令)。只读实例没有可退的东西。
  useEffect(() => {
    if (!historyRef) return
    const step = (dir: 'undo' | 'redo'): boolean => {
      if (pipe.readOnly) return false
      if (canvasModeRef.current && stageHist.current) return stageHist.current(dir)
      const v = layer.getView()
      return !!v && (dir === 'undo' ? pmUndo : pmRedo)(v.state, v.dispatch)
    }
    const indent = (dir: 1 | -1): boolean => {
      const v = layer.getView()
      return !pipe.readOnly && !!v && layer.indent(v, dir)
    }
    const h: UnifiedHistory = { undo: () => step('undo'), redo: () => step('redo'), indent }
    historyRef.current = h
    return () => { if (historyRef.current === h) historyRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRef])
  /** 白板元素落盘。cards 的真源是 doc(deriveCanvasJson 派生),**elements 的真源是磁盘那行** ——
   *  所以这一支不经 deriveFmFromDoc,直接换掉 canvas 行里的 elements 键、其余字段逐字保留。
   *  ⚠️ 那行读不懂时(手改坏的 JSON)当面说、什么都不写:withElements 会逐字返回原行,
   *  静默丢改动比报错更糟 —— 用户会以为画了、下次打开发现没了。 */
  const setCanvasElements = (next: unknown[]): void => {
    const stored = canvasLineOf(pipe.fm)
    if (stored != null && parseCanvasJson(stored) == null) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', {
        detail: { text: translate('unipage.toast.canvasElementsFailed'), error: true },
      }))
      return
    }
    pipe.fm = setAmadeusStructure(pipe.fm, layoutLineOf(pipe.fm), withElements(stored, next))
    setFmVer((v) => v + 1) // canvasDoc 是 canvasLine 的 memo:不推这一下,舞台看不到新元素
    syncSrcDraft()
    schedule()
  }
  /** 节点层级落盘。与 setCanvasElements 同一套(真源在磁盘那行、不经 deriveFmFromDoc、坏行当面说)。 */
  const setCanvasTree = (next: Record<string, unknown>): void => {
    const stored = canvasLineOf(pipe.fm)
    if (stored != null && parseCanvasJson(stored) == null) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', {
        detail: { text: translate('unipage.toast.canvasTreeFailed'), error: true },
      }))
      return
    }
    pipe.fm = setAmadeusStructure(pipe.fm, layoutLineOf(pipe.fm), withTree(stored, next))
    setFmVer((v) => v + 1)
    syncSrcDraft()
    schedule()
  }
  /** 主卡几何落盘(2026-08-18 一等公民)。同一套三口径;withMain 自带「盘上无键 + 默认位形 =
   *  一个字节不写」的懒物化闸(撤销回默认位不该物化一行 JSON)。 */
  const setCanvasMain = (next: CanvasMain): void => {
    const stored = canvasLineOf(pipe.fm)
    if (stored != null && parseCanvasJson(stored) == null) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', {
        detail: { text: translate('unipage.toast.canvasMainFailed'), error: true },
      }))
      return
    }
    pipe.fm = setAmadeusStructure(pipe.fm, layoutLineOf(pipe.fm), withMain(stored, next))
    setFmVer((v) => v + 1)
    syncSrcDraft()
    schedule()
  }
  /** 统一撤销时间线:编辑器插件(createHistoryTimeline)与舞台(histStep 仲裁)共享的一个对象。
   *  与 fm 快照栈同寿命 —— 换页换新;编辑器整实例重建(editorKey)**不**换,陈旧 'pm' 由自愈丢弃。 */
  const undoTimeline = useMemo<UndoTimeline>(() => ({ log: [], future: [] }), [path])
  /** 满铺态。源码模式下恒否:那条分支渲染的是 textarea,把 chrome 抽掉只会让人无处改标题。 */
  const fullCanvas = canvasOn && mode !== 'source'
  // 模式胶囊画在**笔记顶栏** `.amx-toolbar`(用户 2026-08-17 拍板:跟路径/分享/置顶同一行)。
  // 顶栏住在宿主壳 amadeusViews 里、是本组件的**祖先**,所以胶囊由这里渲染、portal 进那一行的插槽。
  // ⚠️ 2026-08-18 从「状态进店 + 顶栏按 path 比对」改成 portal:用户实报「开机还原到一篇 md 笔记时
  //    胶囊必不显示,点过别的笔记才出来」。理由与被排除的假设都写在 CanvasModeSeg 顶注。
  useEffect(() => { setSegAnchor(segAnchorRef.current) }, [])
  // 满铺靠**给滚动容器加个类**,而不是给 `.amx-pane` 全局加 `position: relative` ——
  // 那会把面板里所有「本来解析到更外层」的绝对定位后代一起改锚点(浮层整体偏一个容器位是本仓的老账)。
  // 只在本笔记进画布期间挂,退出/卸载即摘。顶栏 sticky 且 z-index:3,满铺层压不住它,照旧可点。
  useEffect(() => {
    const pane = bodyRef.current?.closest('.amx-pane')
    if (!pane) return
    pane.classList.toggle('amx-canvas-pane', fullCanvas)
    return () => pane.classList.remove('amx-canvas-pane')
  }, [fullCanvas])

  /** 文档位置补齐与 Canvas viewport 对称的会话记忆。滚动容器是 `.amx-pane` —— **它是宿主壳的
   * 元素,换笔记时不重建**,本记忆的两个坑都长在这上头(2026-09-05 用户实报「同一个 tab 里切换
   * 之后没有上次位置的记忆」,check:notescroll 实测):
   *  ① 换笔记的次序是「新正文提交进同一个 pane(scrollTop 被内容顶成 0)→ 旧 effect 的 cleanup」。
   *     cleanup 里那句 remember() 于是把 0 写进**旧笔记**的槽位,记忆当场抹掉;两者之间浏览器
   *     补发的 scroll 事件同样落到旧路径上。⇒ cleanup 不再写(实时监听已经逐笔记着),且恢复
   *     落位之前一律不记账(armed)。
   *  ② 只等 2 帧不够:正文是异步装载的,那两帧里 pane 还没高度,`scrollTop = 700` 被夹回 0,
   *     之后再没人补一刀。⇒ 重试到真落位或 1.5s 到点为止;用户中途自己滚了就立刻交还。 */
  useEffect(() => {
    if (canvasOn) return
    const pane = segAnchorRef.current?.closest<HTMLElement>('.amx-pane')
    if (!pane) return
    const want = readDocumentScroll(vaultRoot, path)
    let armed = false
    let raf = 0
    const deadline = performance.now() + 1500
    const settle = (): void => {
      pane.scrollTop = want
      if (pane.scrollTop !== want && performance.now() < deadline) { raf = requestAnimationFrame(settle); return }
      armed = true
    }
    raf = requestAnimationFrame(settle)
    /** 用户自己动手 = 恢复期结束(别跟他抢),之后照常记账。
     *  keydown 也算:PageDown/空格/方向键翻页同样是「用户在滚」,漏了它重试循环会在这 1.5s 里
     *  把他翻的页抢回去(Codex 评审)。打字触发的 keydown 提前 armed 无害 —— 记账只在 scroll 上发生。 */
    const yieldToUser = (): void => { cancelAnimationFrame(raf); armed = true }
    const remember = (): void => { if (armed) writeDocumentScroll(vaultRoot, path, pane.scrollTop) }
    pane.addEventListener('scroll', remember, { passive: true })
    pane.addEventListener('wheel', yieldToUser, { passive: true })
    pane.addEventListener('pointerdown', yieldToUser)
    pane.addEventListener('keydown', yieldToUser)
    return () => {
      cancelAnimationFrame(raf)
      pane.removeEventListener('scroll', remember)
      pane.removeEventListener('wheel', yieldToUser)
      pane.removeEventListener('pointerdown', yieldToUser)
      pane.removeEventListener('keydown', yieldToUser)
    }
  }, [canvasOn, path, vaultRoot])

  /** 同一个 PM 实例在两种排版间复用：选区本身不会丢，只需在文档重新回流后滚回并续焦。 */
  useEffect(() => {
    if (canvasOn || !revealDocAfterSwitch.current) return
    revealDocAfterSwitch.current = false
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => hostApi.current?.revealSelection())
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [canvasOn])

  // 标题 → 正文的聚焦请求(consume-when-ready):挂载时吃掉跨重建的 pending(改名回车场景)。
  const [bodyFocus, setBodyFocus] = useState<BodyFocusReq | null>(() => {
    const p = pendingBodyFocus
    if (p?.path === path && p.scope === scope) {
      pendingBodyFocus = null
      return Date.now() - p.at < 10_000 ? p.req : null
    }
    return null
  })
  /** 事件里同步读「进入正文」是否已被执行(doRename 在 await 之后才看它)。 */
  const bodyFocusRef = useRef(bodyFocus)
  bodyFocusRef.current = bodyFocus
  /** 本实例交给改名后新实例的「接着写」(卸载那一刻再刷一次 doc / 选区,重建窗口里打的字一并带过去)。 */
  const outgoingCarry = useRef<BodyCarry | null>(null)

  // ── 块交互层(⠿/＋/拖拽/块选中):插件稳定引用,菜单由这里渲染。────────────────────
  // cell:右键单元格打开时指针下的那一格(K-10 表格区的锚格;打开那一刻记下,浮层一出来就盖住那个点)。
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; cell?: number | null; keyboard?: boolean } | null>(null)
  /** 菜单打开那一刻的目标(B-10):动作一律作用在它上面,不在点下去那一刻现读选区 ——
   *  此前菜单开着时按 ↓ 选区就挪到下一块,「删除」删掉的是别人。文档期间变了 → 不动手(fail closed)。 */
  const menuTarget = useRef<{ doc: ProseNode; sel: Selection } | null>(null)
  /** 「移动到…」选择器开着时要搬的那段(B-15)。 */
  const [movePick, setMovePick] = useState<{ doc: ProseNode; from: number; to: number } | null>(null)
  const onBlocksDeletedRef = useRef<(content: Fragment) => void>(() => {})
  // 文档模式卡片拖拽的层级上下文(2026-08-31)。layer 是 useMemo([]) 的终身单例,而 pipe 随
  // path 换新 —— 闭包必须经 ref 现读(与 onBlocksDeletedRef 同一条纪律),否则捏着首篇的 fm。
  const cardDragCtxRef = useRef<{ tree: () => Record<string, unknown>; detach: (anchors: string[]) => void; minted: (anchors: string[]) => void }>({ tree: () => ({}), detach: () => {}, minted: () => {} })
  const layer = useMemo(() => createBlockLayer({
    onMenu: (at) => {
      const v = layer.getView()
      menuTarget.current = v ? { doc: v.state.doc, sel: v.state.selection } : null
      setBlockMenu({ ...at, cell: tableCellAtPoint(v, at.x, at.y) })
    },
    onBlocksDeleted: (content) => onBlocksDeletedRef.current(content),
    canvasTree: () => cardDragCtxRef.current.tree(),
    onCardDetach: (anchors) => cardDragCtxRef.current.detach(anchors),
    onCardsMinted: (anchors) => cardDragCtxRef.current.minted(anchors),
  }), [])
  /** 整块删掉的内容里若牵着只有本篇引用的磁盘文件,删完问一句(见 assetDelete 顶注)。
   *  ⚠️ 只能在删除事务**之后**调:这里读的 doc 已是删完的,「同一篇里还有没有别处引用」才算得准。 */
  const onBlocksDeleted = (content: Fragment): void => {
    const view = layer.getView()
    if (view) void askDeleteRemovedAssets(path, refTextOf(content), refTextOf(view.state.doc.content))
  }
  onBlocksDeletedRef.current = onBlocksDeleted
  cardDragCtxRef.current = {
    tree: () => rawTree(parseCanvasJson(canvasLineOf(pipe.fm))?.tree),
    // 摘爹(文档模式把带爹的卡拖离父段)。基底**现读**磁盘那行(setCanvasTree 是整表替换,
    // 拿陈的当基底会抹掉别处刚写的关系);坏行由 setCanvasTree 自己的 fail-closed 挡。
    detach: (anchors) => {
      const tree = rawTree(parseCanvasJson(canvasLineOf(pipe.fm))?.tree)
      let changed = false
      for (const a of anchors) {
        if (a in tree) {
          delete tree[a]
          changed = true
        }
      }
      if (changed) setCanvasTree(tree)
    },
    // Alt 拖复制卡的新锚 → 归属集合(Codex 08-31 high:漏了它,首次派生把新锚写进盘后,
    // 「stored ⊆ owned」判据 fail-closed,画布派生冻结到重开)。与 makeCard 的 ownedCards.add 同源。
    minted: (anchors) => { for (const a of anchors) pipe.ownedCards.add(a) },
  }
  /** 折叠本机记忆的键(B-13):插件是稳定引用,智库 / 路径经 ref 现读。 */
  const foldWhere = useRef({ vaultRoot, path })
  foldWhere.current = { vaultRoot, path }
  // 正文 AI(G3-07):入口可用性与空格唤起的回调经 ref 现读(editorPlugins 只建一次)。
  const canAiRef = useRef(false)
  const aiSpaceRef = useRef<(view: EditorView) => void>(() => {})
  // Agent 改动呈现(G3-03):插件状态 → 胶囊的 N / 当前第几处。回调经 ref 现读(editorPlugins 只建一次)。
  const [agentView, setAgentView] = useState<{ count: number; index: number }>({ count: 0, index: 0 })
  const agentStateRef = useRef<(st: AgentChangesState) => void>(() => {})
  agentStateRef.current = (st) => {
    const index = st.current == null ? 0 : st.changes.findIndex((c) => c.id === st.current) + 1
    setAgentView((v) => (v.count === st.changes.length && v.index === index ? v : { count: st.changes.length, index }))
  }
  // 分栏列节点 schema + per-page fold(闭包现读 pipe.fm,多页并发不串,Codex 终审 P1)+ 嵌入层。
  // ⚠️ 稳定引用:MilkdownInner 只建一次编辑器。
  const editorPlugins = useMemo(
    () => [
      ...layer.plugins,
      ...columnPlugins,
      ...createColumnsFold(
        () => parseLayoutJson(layoutLineOf(pipe.fm)),
        () => { pipe.sawRows = true }, // parse 折叠成功=真渲染过行(打开即拖散也要能剥 layout)
      ),
      // 画布卡片(canvas.ts)。两种模式共用同一次折叠 —— 不折的话文档模式的正文里会冒出
      // `<!-- a c1 -->` 字面注释行。layout 一并传进去做互斥判定(同一枚锚不许两个折叠器抢)。
      ...canvasPlugins,
      ...createCanvasFold(
        () => parseCanvasJson(canvasLineOf(pipe.fm)),
        () => parseLayoutJson(layoutLineOf(pipe.fm)),
        // 折出来的锚进归属集合。⚠️ 这里**只增不清**,清零由 parse 的发起方负责(见 resetOwned)——
        // 折叠失败时这个回调根本不会被调,清零动作放在它里面就永远等不到。
        (refs) => { for (const r of refs) pipe.ownedCards.add(r) },
      ),
      ...createEmbedLayer({ path, readOnly }),
      // 画布模式的两个编辑器侧插件(2026-08-18):跨卡选区夹断 + 统一撤销时间线的 PM 记账。
      // 都经闭包/共享对象现读状态,文档模式下零行为(夹断有 inCanvas 闸,记账在文档模式照记 ——
      // 时间线只在画布模式被查询,顺序跨模式仍然成立)。
      ...createSelectionClamp(() => canvasModeRef.current),
      ...createHistoryTimeline(undoTimeline),
      // 文档模式的「光标在哪张卡」标注(约束框 CSS 只在文档模式消费,画布下类挂着无害)。
      ...createCardActiveDeco(),
      // 文档模式的层级缩进档位(同一份 pipe.fm 闭包;tree 变了要补一笔空事务推醒,见下面的 effect)。
      ...createCardDepthDeco(() => parseCanvasJson(canvasLineOf(pipe.fm))),
      // Tangu 改了这篇 → 装饰 + 胶囊(G3-03)。装饰与旧片段只在插件状态里,不进序列化。
      ...createAgentChanges(agentStateRef),
      // 正文 AI(G3-07):目标区间随编辑映射 + 空行按空格唤起(缺省关、IME 守卫,见 inlineAi.ts)。
      ...createInlineAi({ spaceTrigger: () => aiSpaceTriggerEnabled() && canAiRef.current, onSpace: aiSpaceRef }),
      ...headingFoldPlugins,
      ...listFoldPlugins,
      ...createFoldMemory(() => foldWhere.current), // 折叠的本机记忆 + 折叠命令的目标登记(B-13)
      // 收件箱:单个 `\n` = 一次换行(标准 markdown 里它是空格)。extraPlugins 在 MarkdownBlock 里
      // 排在最后 .use,故必定跑在 commonmark 的 remark-line-break 之后。
      ...(hardBreaks ? hardBreakRemark : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer, path, readOnly, hardBreaks],
  )
  useEffect(() => {
    if (!blockMenu) return
    // 捕获期收(v3 BlockHost 同款):打开路径的 stopPropagation 到不了 window 冒泡,得在捕获期看目标。
    const close = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.ctx-menu')) return
      setBlockMenu(null)
    }
    // Esc 关菜单并把焦点还给编辑器(此前 Esc 对块菜单完全无效,探针实测)。块还选着,
    // 接着按 Cmd+C / Cmd+X / Delete 就能直接操作 —— 不必非得从菜单里挑。
    // 菜单开着时的键盘(B-10,捕获期接管):↑↓ / Home / End 在菜单项间移动(焦点移进菜单),Enter / 空格由
    // 聚焦项的原生 click 执行;其余键先关菜单再照常落到编辑器 —— 绝不让方向键去挪编辑器选区(此前 ↓ 把块选区
    // 挪到下一块,「删除」删掉的是别人;菜单开着打字替换了当前块)。
    const onKey = (e: KeyboardEvent): void => {
      const menu = document.querySelector<HTMLElement>('.unified-block-menu')
      const inside = !!menu && menu.contains(document.activeElement)
      if (e.key === 'Escape') {
        e.stopPropagation()
        setBlockMenu(null)
        layer.getView()?.focus()
        return
      }
      if (!menu || e.isComposing) return
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (bare && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        const items = [...menu.querySelectorAll<HTMLElement>('button:not([aria-disabled="true"])')]
        const i = items.indexOf(document.activeElement as HTMLElement)
        const n = items.length
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : i < 0 ? (e.key === 'ArrowUp' ? n - 1 : 0) : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
        items[next]?.focus()
        return
      }
      if (inside && (e.key === 'Enter' || e.key === ' ')) return // 聚焦项的原生 click
      if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return
      setBlockMenu(null)
      if (inside) {
        e.preventDefault()
        layer.getView()?.focus()
      }
    }
    // 键盘打开的(聚焦 ⠿ 按 Enter)→ 焦点进首项;鼠标打开的不抢焦点(Cmd+C / Delete 仍直接作用于选中的块)。
    if (blockMenu.keyboard) requestAnimationFrame(() => document.querySelector<HTMLElement>('.unified-block-menu button')?.focus())
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('contextmenu', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('contextmenu', close, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [blockMenu])
  /** 把选区恢复成菜单打开时的目标;期间文档变了 → false(调用方不动手,给一句提示)。 */
  const restoreMenuTarget = (view: EditorView): boolean => {
    const snap = menuTarget.current
    menuTarget.current = null
    if (!snap) return true
    if (view.state.doc !== snap.doc) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('unipage.menu.stale') } }))
      return false
    }
    if (!view.state.selection.eq(snap.sel)) view.dispatch(view.state.tr.setSelection(snap.sel))
    return true
  }
  /** 菜单动作作用在当前 NodeSelection 上(点 ⠿ 的 mousedown 已由交互层设好)。 */
  const withSelectedNode = (fn: (view: EditorView, sel: NodeSelection) => void): void => {
    setBlockMenu(null)
    const view = layer.getView()
    if (!view || !restoreMenuTarget(view)) return
    const sel = view.state.selection
    if (!(sel instanceof NodeSelection)) return
    fn(view, sel)
    view.focus()
  }
  // 跨块选区范围的判定**只有一份**,在 blockLayer(它同时供拖拽用;两端同父的校验也在那儿 ——
  // 一端在分栏 cell 内、一端在顶层时会切坏行并复制出重复锚,评审实测)。这里直接复用,别再抄。
  /** 菜单动作:跨块选区优先(整批),否则作用在单个 NodeSelection 上。 */
  const withBlocks = (multi: (view: EditorView, r: { from: number; to: number }) => void,
    single: (view: EditorView, sel: NodeSelection) => void): void => {
    setBlockMenu(null)
    const view = layer.getView()
    if (!view || !restoreMenuTarget(view)) return
    const r = layer.topRangeOf(view)
    if (r) multi(view, r)
    else if (view.state.selection instanceof NodeSelection) single(view, view.state.selection)
    view.focus()
  }
  /** 「问 Tangu」(评审 G3-04):选区 / 块的文字 + 最近标题的锚点交给侧栏对话(挂成引用,不发送)。
   *  笔记一个字不动 —— 不铸 `^id`,锚点只到标题(askTangu.ts)。入口只在宿主给了 askInChat(= 注册了侧栏
   *  对话)时出现:纯 Amadeus 壳、automation-only 档案、台架都不给,不画一个点了没反应的按钮。 */
  const canAskTangu = !readOnly && !!readTangu()?.askInChat
  const askTangu = (view: EditorView, from: number, to: number): void => {
    const quote = askTanguQuote(view.state.doc, from, to, path)
    if (quote) readTangu()?.askInChat?.(quote)
  }
  // ── 正文 AI(评审 G3-07,拍板 #13)───────────────────────────────────────────────
  // 入口:选区工具栏「AI ▾」(内置动作 + 插件 registerSelectionAction)、`/ai`、空行按空格(缺省关)。不进右键菜单。
  // 宿主能做才出现(探针给了 complete);结果先进 InlineAiPanel 预览,确认后才写(applyAiResult:一个事务、纯 md)。
  const canAi = !readOnly && !!readTangu()?.complete
  canAiRef.current = canAi
  const pluginSelActions = usePluginStore((s) => s.selectionActions)
  const [aiPanel, setAiPanel] = useState<null | { key: number; x: number; y: number; top: number; title: string; hasSelection: boolean; askFirst: boolean; action: TanguInlineAction | 'prompt'; plugin?: string }>(null)
  const AI_ACTIONS: TanguInlineAction[] = ['improve', 'fix', 'shorter', 'longer', 'summarize', 'translate', 'continue', 'custom']
  const aiMenuItems: ToolbarAiItem[] = [
    ...AI_ACTIONS.map((a) => ({ id: a, label: t(`inlineai.action.${a}`) })),
    ...pluginSelActions.map((o) => ({ id: `plugin:${o.pluginId}:${o.item.id}`, label: o.item.title, plugin: true })),
  ]
  /** 开面板:记目标区间(选区 / 光标一点),面板贴在目标下方。kind = 内置动作 / `plugin:<插件>:<项>` / 'prompt'(光标处先问一句)。 */
  const openAi = (view: EditorView, kind: string): void => {
    if (!canAi) return
    const sel = view.state.selection
    const cursor = kind === 'prompt'
    const from = cursor ? sel.head : sel.from
    const to = cursor ? sel.head : sel.to
    if (!cursor && to <= from) return
    setAiTarget(view, from, to)
    const a = view.coordsAtPos(from)
    const b = view.coordsAtPos(to)
    const plugin = kind.startsWith('plugin:') ? kind.slice('plugin:'.length) : undefined
    const action = (plugin || cursor ? (cursor ? 'prompt' : 'custom') : kind) as TanguInlineAction | 'prompt'
    const title = plugin
      ? (pluginSelActions.find((o) => `${o.pluginId}:${o.item.id}` === plugin)?.item.title ?? t('inlineai.label'))
      : cursor ? t('inlineai.label') : t(`inlineai.action.${kind}`)
    setAiPanel({ key: Date.now(), x: a.left, y: b.bottom + 6, top: a.top - 6, title, hasSelection: !cursor, askFirst: cursor || kind === 'custom', action, plugin })
  }
  aiSpaceRef.current = (view) => openAi(view, 'prompt')
  /** 面板的请求:内置动作走引擎 /agent/inline;插件项走它自己的 run(结果同样只进预览)。目标区间现读(随编辑映射)。 */
  const runAi = (panel: NonNullable<typeof aiPanel>): InlineAiRun => async (instruction, onDelta, signal) => {
    const view = layer.getView()
    const target = view ? aiTargetOf(view) : null
    if (!view || !target) throw new Error(translate('unipage.toast.insertPointLost'))
    const selMd = target.to > target.from
      ? (hostApi.current?.serializeMd(view.state.doc.slice(target.from, target.to).content) ?? target.text)
      : ''
    if (panel.plugin) {
      const owned = usePluginStore.getState().selectionActions.find((o) => `${o.pluginId}:${o.item.id}` === panel.plugin)
      if (!owned) throw new Error(translate('unipage.toast.insertPointLost'))
      const md = await owned.item.run({ text: target.text, markdown: selMd, pagePath: path })
      if (md == null || md === '') return { text: '' }
      if (typeof md !== 'string') throw new Error(translate('unipage.plugin.notString', { type: typeof md }))
      if (Array.from(md).some((c) => c.charCodeAt(0) < 32 && c !== String.fromCharCode(9) && c !== String.fromCharCode(10))) {
        throw new Error(translate('unipage.plugin.controlChars'))
      }
      return { text: md }
    }
    const probe = readTangu()
    if (!probe?.complete) throw new Error(translate('inlineai.unavailable'))
    const { before, after } = aiContextOf(view.state.doc, target.from, target.to)
    const action: TanguInlineAction = panel.action === 'prompt' ? (instruction ? 'custom' : 'continue') : panel.action
    return probe.complete({
      action,
      ...(instruction ? { instruction } : {}),
      ...(selMd ? { selection: selMd } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      title: path.split('/').pop()!.replace(/\.md$/i, ''),
      ...(action === 'translate' ? { language: translateTargetOf(target.text) } : {}),
    }, { signal, onDelta })
  }
  const closeAi = (): void => {
    setAiPanel(null)
    const view = layer.getView()
    if (!view) return
    clearAiTarget(view)
    view.focus()
  }
  /** 确认写入:结果按 markdown 经本编辑器的 parser 解析,一个事务落进文档(普通用户编辑:进撤销栈、走防抖 + CAS 保存)。 */
  const applyAi = (how: AiApply, text: string): void => {
    const view = layer.getView()
    const target = view ? aiTargetOf(view) : null
    const content = hostApi.current?.parseMd(text)
    setAiPanel(null)
    if (!view || !target || !content) {
      if (view) clearAiTarget(view)
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('unipage.toast.insertPointLost') } }))
      return
    }
    const used = applyAiResult(view, target, content, how)
    view.focus()
    syncFromEditor()
    schedule()
    if (how === 'replace' && used === 'below') {
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('inlineai.targetChanged') } }))
    }
  }
  /** 胶囊「逐处查看」:停到下一处(循环),把那一处滚到阅读位置(装饰带 data-agent-change,定位与大纲跳转同一套)。 */
  const onAgentReview = (): void => {
    const view = layer.getView()
    if (!view) return
    const c = nextAgentChange(view)
    const el = c ? bodyRef.current?.querySelector(`[data-agent-change="${c.id}"]`) : null
    if (el instanceof HTMLElement) revealBlockAtTop(el, 48)
  }
  /** 胶囊「全部撤回」:一次普通的用户编辑(进撤销栈),照常走防抖 + CAS 保存链。用户已改过的那几处不撤。 */
  const onAgentRevert = (): void => {
    const view = layer.getView()
    if (!view) return
    const { skipped } = revertAgentChanges(view)
    syncFromEditor()
    schedule()
    if (skipped) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('agentchg.skipped', { n: String(skipped) }) } }))
    }
  }
  /** 「转换为」:跨块选区逐块转换(B-05:此前只认 NodeSelection,多选时静默无效),单块走 applyTrigger。
   *  做不成(结构不允许)给一句提示,不再静默。 */
  const turnInto = (trig: Trigger, label: string): void => {
    let ok = true
    withBlocks(
      (view, r) => { ok = turnBlocksInto(view, r.from, r.to, trig) },
      (view, sel) => {
        // 代码块按行拆 / 包进容器(R-23):applyTrigger 按文本块走,会把代码换行压成空格、列表类静默无效、折叠令牌插进代码首行。
        if (sel.node.type.spec.code && codeBlockTurnInto(view, sel.from, trig)) return
        // applyTrigger 作用在光标所在文本块:先把光标落进节点首个文本块,再走 v3 同一套转换引擎。
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(sel.from + 1))))
        ok = applyTrigger(view, trig, null)
      },
    )
    if (!ok) window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('mdblock.turn.failed', { kind: label }) } }))
  }
  /** 「转换为 → 代码块 / 标注」(B-14):不是前缀型转换,各走 blockTurn 里的整块重写。 */
  const turnIntoSpecial = (kind: 'code' | 'callout', label: string): void => {
    let ok = true
    withBlocks(
      (view, r) => { ok = kind === 'code' ? turnRangeIntoCode(view, r.from, r.to) : turnIntoCallout(view, r.from, r.to, true) },
      (view, sel) => { ok = kind === 'code' ? turnRangeIntoCode(view, sel.from, sel.to) : turnIntoCallout(view, sel.from, sel.to, false) },
    )
    if (!ok) window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('mdblock.turn.failed', { kind: label }) } }))
  }

  /** 当前块 → Canvas 卡片。slash 落点是 TextSelection，块菜单落点是 NodeSelection；两条入口先
   *  在这里归一，再共用 blockToCard 的单事务搬迁与同一套几何/保存链。
   *  **卡里建卡 = 子卡**(2026-08-31 用户拍板:此前 slash 一律 unavailable、块菜单则默默建成顶层卡,
   *  两条入口自相矛盾)。层级写进 fm 的 tree,文档模式立刻呈现为缩进+框,画布模式是父卡右侧一支。 */
  const makeCard = (view: EditorView): boolean => {
    const unavailable = (): false => {
      window.dispatchEvent(new CustomEvent('amadeus:toast', {
        detail: { text: translate('unipage.toast.cardUnavailable') },
      }))
      return false
    }
    if (!(view.state.selection instanceof NodeSelection)) {
      const { $from } = view.state.selection
      // 块菜单对 list_item 本就隐藏 Card；slash 也必须同规，不能悄悄把整份父列表搬成一张卡。
      for (let depth = $from.depth; depth >= 1; depth--) {
        if ($from.node(depth).type.name === 'list_item') return unavailable()
      }
      // 容器一律在这一行认:doc / 分栏 cell / **卡片**。少了卡片那一项时,光标在卡内的 slash 会
      // 一路走到卡节点自己身上,blockToCard 对卡片返回 null → 用户看到的就是「forbidden」。
      let depth = $from.depth
      while (depth >= 1 && !['doc', 'amadeusColumnCell', 'amadeusCanvasCard'].includes($from.node(depth - 1).type.name)) depth--
      if (depth < 1) return false
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, $from.before(depth))))
    }
    // 父卡 = 选中块的直接容器(两条入口归一之后,块菜单那条也自动吃到子卡语义)。
    const sel = view.state.selection as NodeSelection
    const $at = view.state.doc.resolve(sel.from)
    const host = $at.depth >= 1 ? $at.node($at.depth) : null
    const parent = host?.type.name === 'amadeusCanvasCard' ? String(host.attrs.anchor) : ''
    // 层级的真源是磁盘那行,**现读**(canvasDoc 是渲染期的 memo,慢一拍;setCanvasTree 又是整表替换,
    // 拿陈的当基底会把这期间别处写进去的父子关系抹掉)。
    const tree = rawTree(parseCanvasJson(canvasLineOf(pipe.fm))?.tree)
    let count = 0
    view.state.doc.forEach((node) => { if (node.type.name === 'amadeusCanvasCard') count++ })
    // 子卡摆在父卡右侧、按已有兄弟错开;自由卡照旧排在主卡右侧的队列里。
    const px = parent ? (Number(host!.attrs.x) || 0) + (Number(host!.attrs.w) || CARD_W) + 80 : canvasMain.x + canvasMain.w + 80
    const py = parent ? (Number(host!.attrs.y) || 0) + childrenOf(tree, parent).length * 72 : canvasMain.y + count * 72
    const made = blockToCard(view, Math.round(px), Math.round(py), parent ? { parent, tree } : undefined)
    if (!made) return unavailable()
    pipe.ownedCards.add(made)
    syncFromEditor()
    schedule()
    // ⚠️ 顺序:层级必须写在 syncFromEditor **之后** —— 它会按 doc 重写整行 canvas,先写就被盖掉。
    // ponytail: 这一笔走宿主的 setCanvasTree 而不是舞台的 writeFm,所以撤销时是「卡片先回退、
    //   tree 里那条悬空一瞬、下一次派生剪掉」(悬空父到处都按「没有爹」处理,不会画错)。
    //   要做到卡与层级一次 Cmd+Z 齐退,得给舞台开一条命令式接缝,不值。
    // ⚠️ 写基底**再读一次**(不是上面那份 tree):syncFromEditor 刚跑过一次派生,那一步会剪掉
    //    悬空的层级条目 —— 拿派生前的快照当基底,等于把刚被剪掉的垃圾原样写回去。
    if (parent) setCanvasTree(setParent(rawTree(parseCanvasJson(canvasLineOf(pipe.fm))?.tree), made, parent))
    if (!canvasModeRef.current && !parent) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('unipage.toast.cardMade') } }))
    }
    return true
  }

  // ── 写盘安全(评审 2026-09-27 波次 0a:D-03 / D-04 / G1-01)。这几件被 writeNow 调用,但**刻意放在它前面**
  //    (writeFailures.test 把 writeNow 那段源码切出来单独求值,这几件在测试里是注入的桩)。

  /** 本实例相对基线(lastSaved)**有没有用户自己的改动**:fm 逐字相同,且正文 = 编辑器对基线的规范化结果 → 没有。
   *  用途:CAS 拒写时「让位回灌」还是「本地胜 + 保全」、卸载冲洗要不要写、押后回灌时 pending 是不是只因规范化。
   *  判不出来(编辑器不在 / 有分栏画布结构键 —— 那两类的 parse 带折叠副作用,不拿来空跑)一律按「有改动」:
   *  宁可多出一份冲突副本,也不把用户的字当规范化噪音让掉。 */
  const isPristine = (): boolean => {
    const base = splitFm(pipe.lastSaved)
    // 同篇另一个实例正替两边写的 fm 补丁不算本实例的改动(G1-02 返修,见 Pipe.peerPatch)—— 只豁免那一份补丁。
    if (base.fmText !== pipe.fm && (pipe.peerPatch == null || patchFm(base.fmText, pipe.peerPatch) !== pipe.fm)) return false
    if (base.body === pipe.body) return true
    if (layoutLineOf(pipe.fm) != null || canvasLineOf(pipe.fm) != null) return false
    const canon = hostApi.current?.canonical(base.body)
    return canon != null && canon === pipe.body
  }
  /** 回灌入口(住在下面的回灌 effect 里,按路径重装);CAS 让位与同窗通知从这里进。 */
  const reconcileRef = useRef<(() => void) | null>(null)
  const reconcileNow = (): void => { reconcileRef.current?.() }
  const [saveFailed, setSaveFailed] = useState(false)

  /** 盘上那版要被本地版本盖掉 → 先落冲突副本(与云同步同名)+ error 级提示。写不进去就抛,writeNow 据此不写。 */
  const preserveExternal = async (content: string): Promise<void> => {
    const fp = textFingerprint(content)
    if (pipe.preserved.has(fp)) return
    const copy = await writeConflictCopy(path, toDisk(content, pipe.eol))
    pipe.preserved.add(fp)
    toastConflictCopy(path, copy)
    void scoped.getState().refreshPages() // 副本是新文件:树 / 补全要看得见它
  }

  /** 写失败(D-04):首次即提示 + 「未保存」条;按退避补写;草稿同步存进本机(渲染层随时可能被关)。 */
  const noteWriteFailed = (error: unknown): void => {
    // 已退休(在途那发写在删除 / 移动之后才失败):路径已不归本实例,存草稿 = 旧路径上的孤儿(收口 N-5,同卸载冲洗)。
    if (!pipe.retired) {
      pipe.stashed = composeFm(pipe.fm, pipe.body)
      stashDraft(vaultRoot, path, pipe.stashed, pipe.lastSaved, pipe.slot)
    }
    if (!pipe.failed) {
      pipe.failed = true
      setSaveFailed(true)
      toastSaveFailed(path, error)
    }
    if (pipe.retryTimer || pipe.dead || pipe.retired) return // 已卸载:草稿在本机,下次打开提示恢复
    const delay = SAVE_RETRY_MS[Math.min(pipe.retryN, SAVE_RETRY_MS.length - 1)]
    pipe.retryN++
    pipe.retryTimer = setTimeout(() => {
      pipe.retryTimer = null
      if (pipe.dead || pipe.retired || !pipe.pending) return
      if (pipe.reconcileBusy) return // 回灌收尾会补发(押后回灌 × 冻结保存的互斥契约)
      void writeNow()
    }, delay)
  }

  /** 本地与盘上重新一致:清失败态、退避计时与本实例存下的草稿。不只写成功才会一致 —— 写失败期间用户把改动
   *  撤回到盘上那版,也就没有「未保存」可言了;不收的话条一直挂着,切走再回来还提示恢复用户亲手删掉的字。
   *  `written` = 写成功时这次落盘的内容:草稿只在盘上已覆盖它时删(草稿就是这份,或这份就是此刻的全文)。
   *  在途那发 ack 时本地已走到后面(返修 R1:撤回后卸载冲洗存的草稿)→ 草稿比盘上新,留给排在后面的那发写。 */
  const settleUnsaved = (written?: string): void => {
    if (pipe.retryTimer) {
      clearTimeout(pipe.retryTimer)
      pipe.retryTimer = null
    }
    pipe.retryN = 0
    if (pipe.failed) {
      pipe.failed = false
      setSaveFailed(false)
    }
    // 只删**本实例存的**那份(别的会话留下、恢复条还在等用户决定的草稿不碰)。
    if (pipe.stashed != null && (written == null || pipe.stashed === written || composeFm(pipe.fm, pipe.body) === written)) {
      clearDraft(vaultRoot, path, pipe.stashed, pipe.slot)
      pipe.stashed = null
    }
  }

  /** 写成功:收掉「未保存」;通知同窗同路径的其它实例回灌(G1-01,跨窗那半在主进程)。 */
  const noteWriteOk = (written: string): void => {
    pipe.peerPatch = null // 自己写成功:盘上 fm 已是本实例的,别人的补丁记录作废
    settleUnsaved(written)
    announceUnifiedWrite(path, pipe)
  }

  const writeNow = (strict = false): Promise<void> => {
    if (pipe.readOnly) return Promise.resolve() // 只读实例:唯一的写盘出口在此封死(见 readOnly prop 注)
    const step = async (): Promise<void> => {
      let conflicts = 0
      while (!pipe.retired) {
        const text = composeFm(pipe.fm, pipe.body) // 执行时 compose:链上永远写「此刻」的状态
        if (text === pipe.lastSaved) {
          pipe.pending = false
          settleUnsaved() // 撤回到了盘上那版 / 别人写的正是这份:没有待写的了
          return
        }
        let res: void | TextWriteResult
        try {
          // 要盖掉的盘上版本还没保全(打字中外部改动 / CAS 拒写后本地胜)→ 先落冲突副本;落不下就当写失败,不许覆盖。
          if (pipe.unpreserved != null && pipe.unpreserved !== text) await preserveExternal(pipe.unpreserved)
          pipe.unpreserved = null
          // 比对交换写(G1-01):带上「我以为盘上是什么」的指纹。支持的宿主盘上不符就拒写、回现文;
          // 不支持的宿主忽略它照旧写、回 void(= 写成了)。
          // D-19:正文与 CAS 基线都按磁盘行尾(基线必须是盘上字节的指纹,否则 CRLF 笔记每次写都被拒)。
          res = await amadeus.writeTextFile(path, toDisk(text, pipe.eol), { base: textFingerprint(toDisk(pipe.lastSaved, pipe.eol)) })
        } catch (error) {
          pipe.pending = true // 写失败保留草稿;严格切号屏障必须拒绝,不能随后 retire 丢掉待写内容。
          noteWriteFailed(error)
          if (strict) throw error
          return // 普通自动保存:退避重试 / 恢复信号 / 下一次编辑 / 卸载再试。
        }
        if (res && res.ok === false) {
          // CAS 拒写:盘上已不是本实例的基线 —— 同篇的另一个实例 / 窗口,或外部写者刚写过。
          const cur = fromDisk(res.current)
          pipe.eol = cur.eol
          res = { ...res, current: cur.text }
          if (res.current === text) {
            pipe.lastSaved = text // 殊途同归:别人写的正是这份
            continue
          }
          if (++conflicts > 3) {
            // 每轮都被拒 = 有人在持续写,或宿主写入时改写了内容;别无限循环地出副本,按写失败退避。
            const error = new Error('The note kept changing on disk while saving')
            pipe.pending = true
            noteWriteFailed(error)
            if (strict) throw error
            return
          }
          if (isPristine()) {
            // 本实例没有用户自己的改动(正文只是编辑器对旧基线的规范化):让位,走回灌吃盘上版本,不写不出副本。
            pipe.pending = false
            reconcileNow()
            return
          }
          // 本地胜(拍板 #6):盘上那版登记为待保全,换基线再写一轮 —— 循环开头先落副本。
          pipe.unpreserved = res.current
          pipe.lastSaved = res.current
          continue
        }
        pipe.lastSaved = text
        scoped.getState().bumpLinkGraph() // v4 自写账本不经 store 的 save → 反链/图谱/![[嵌入]] 只能靠这一声
        // 只有「写的就是此刻的状态」才算清账(Codex A9):await 期间落进来的新编辑不能被
        // 旧写入顺手抹掉 dirty 标志,否则回灌会把脏编辑器当干净实例覆盖。
        if (composeFm(pipe.fm, pipe.body) === text) pipe.pending = false
        noteWriteOk(text)
        // 严格落盘同时排尽在途 I/O 期间新增的编辑;否则 pending=true 也会被成功 ack 后退休。
        if (!strict) return
      }
    }
    // 这一轮在跑的全程(含 compose 之后、写之前的保全副本那一段)计入 pipe.writing,卸载冲洗据此不做同步的「没有待写」判定。
    const run = async (): Promise<void> => {
      pipe.writing++
      try {
        await step()
      } finally {
        pipe.writing--
      }
    }
    const task = pipe.chain.then(run, run)
    pipe.chain = task.catch(() => {}) // 失败对本次调用可见,但不能毒死后续重试的串行链。
    return task
  }

  /** 从编辑器 doc 派生 layout + canvas 进 fm(两者的真源都是 doc,Codex A13);仅可视模式有 view。
   *  ⚠️ 两个结构键各自独立判定后**合并成一次** setAmadeusStructure。早先写成 if/else-if 阶梯
   *  (先 layout、else 才轮到 canvas)时有个必现雷:一篇曾经有分栏、后来被解散的笔记 sawRows 恒 true,
   *  阶梯永远停在 layout 分支,画布的任何改动从此再也写不进 fm。结构键之间没有优先级,别再串成阶梯。 */
  const deriveFmFromDoc = (): void => {
    const v = layer.getView()
    if (!v) return
    const storedLayout = layoutLineOf(pipe.fm)
    const json = deriveLayoutJson(v.state.doc)
    // layout 三分支:派生出行 → 用派生值;没派生出来但本实例**确实渲染过行** → 用户解散了,剥掉;
    // 折叠从未成功(缺锚/错位)或行本身非法 → 逐字保留(fail-closed,Codex 终审 P0/共1)。
    let layoutVal = storedLayout
    if (json != null) {
      layoutVal = json
      pipe.sawRows = true
    } else if (pipe.sawRows && storedLayout != null && parseLayoutJson(storedLayout) != null) {
      layoutVal = null
    }
    // 画布:cards 段的真源 = doc 里的卡片节点,mode/main/elements/未知键从磁盘那行原样搬(canvas.ts
    // 顶注的「组装点唯一」)。**懒物化**与「折叠没成功就逐字保留」两条都在 deriveCanvasJson 里。
    const canvasVal = deriveCanvasJson(
      v.state.doc,
      canvasLineOf(pipe.fm),
      modeTouched.current ? (canvasModeRef.current ? 'canvas' : 'doc') : null, // 见 modeTouched 的告警
      pipe.ownedCards,
    )
    const before = canvasLineOf(pipe.fm)
    pipe.fm = setAmadeusStructure(pipe.fm, layoutVal, canvasVal)
    // ⚠️ canvas 行**真变了**才推版本。舞台的 elements/tree 两个 prop 都来自 `canvasDoc`(canvasLine
    //    的 memo),而这个函数只改 pipe.fm、本身不触发任何重渲染 —— 少这一句的实测表现是:
    //    删掉/收回中间那张卡后,层级线仍按旧 tree 去找那张卡的盒子、两端双双解析失败,线全没了
    //    且再也不回来(4 秒后、手动扰动 DOM 之后仍是 0 条)。
    //    判据必须是「行变了」而不是无条件推:这个函数每次击键都跑,无条件推 = 每敲一个字重渲染一次。
    if (canvasLineOf(pipe.fm) !== before) setFmVer((x) => x + 1)
  }

  /** flush 前强制取编辑器**此刻**的 doc(Codex A4):listener 的 markdownUpdated 有 200ms 防抖,
   *  pipe.body 可能落后最后几击;改名/关页/换库前不拉平就丢字。编辑器未挂载(源码模式)= no-op。 */
  const syncFromEditor = (): void => {
    const md = hostApi.current?.serializeNow()
    if (md == null) return
    pipe.body = md
    deriveFmFromDoc()
  }

  const schedule = (): void => {
    if (pipe.dead || pipe.retired || readOnly) return
    // 有写盘在跑时 lastSaved 马上会变(见 Pipe.writing):撤回到旧基线的这一击照样排上,ack 后链上再判。
    if (!pipe.writing && composeFm(pipe.fm, pipe.body) === pipe.lastSaved) return
    pipe.pending = true
    if (pipe.timer) clearTimeout(pipe.timer)
    pipe.timer = setTimeout(() => {
      pipe.timer = null
      // 回灌进行中冻结保存(押后回灌×冻结 save 的互斥契约):回灌完成后统一补一发。
      if (pipe.reconcileBusy) return
      void writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  // 源码模式草稿:声明在 setFm 之前 —— chrome 写 fm 时若正处源码模式,textarea 草稿必须跟着
  // 重组(Codex P1:否则下一次击键会从旧草稿整文重拆,把刚落盘的 chrome 变更又抹掉)。
  const [srcDraft, setSrcDraft] = useState<string | null>(null)
  const syncSrcDraft = (): void => {
    setSrcDraft((d) => (d == null ? d : composeFm(pipe.fm, pipe.body)))
  }

  /** chrome 写 fm(值 undefined = 删键)。图标/封面是单击动作(非打字流)→ 立即落盘。 */
  const setFm = (patch: Record<string, unknown>, immediate = true): void => {
    if (readOnly) return
    pipe.fm = patchFm(pipe.fm, patch)
    setFmVer((v) => v + 1)
    syncSrcDraft()
    if (immediate) {
      pipe.pending = true
      void writeNow().then(() => {
        const ps = usePageStore.getState()
        void ps.refreshPages()
        // ⚠️ 侧栏/树/双链补全的 emoji 走的是**另一张表**(icons,真源=主进程索引),refreshPages
        //    只刷页面清单、一个字都不碰它 —— 老注释「侧栏 emoji 跟上」写在 refreshPages 上是错的,
        //    图标改完在工作区一直不显示的另一半就是这里(2026-08-31 用户实报)。
        //    主进程那半(writeTextFile 不更索引)已在 fs/pageWrite.ts 修掉,这一句才拿得到新值。
        ps.refreshIcons()
      })
    } else schedule()
  }

  // 押后回灌依赖打字静默闸(本编辑器不碰 pageStore 的装载链,自装,幂等)。
  useEffect(() => {
    installTypingGuard(document)
  }, [])

  // 双击图片开大图(AFFiNE 的 peek view 对位):浮层里原尺寸显示,点任意处或 Esc 关。
  // 只认编辑区内的 <img>,不碰嵌入卡自己的双击(那条是「露源码」,见 embedLayer)。
  const [lightbox, setLightbox] = useState<string | null>(null)
  useEffect(() => {
    const onDbl = (e: MouseEvent): void => {
      // ⚠️ 判据必须按**坐标**取元素,不能只信 `e.target`:图片若是装饰 widget(`![[pic.png]]` 那条),
      // 第一次点击会把它的 DOM 整个重建 —— 两次点击的 target 不是同一个节点,浏览器就把 dblclick
      // 派到公共祖先 <p> 上,`tagName === 'IMG'` 当场扑空、双击看大图时灵时不灵(2026-08-28 实测)。
      const hit = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? (e.target as HTMLElement | null)
      const img = hit?.tagName === 'IMG' ? (hit as HTMLImageElement) : null
      if (!img || !img.closest('.unified-body')) return
      const src = img.currentSrc || img.src
      if (!src) return
      e.preventDefault()
      e.stopPropagation()
      setLightbox(src)
    }
    document.addEventListener('dblclick', onDbl, true)
    return () => document.removeEventListener('dblclick', onDbl, true)
  }, [])
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [lightbox])

  // 外部回灌:等静默 → 重读 → fm 换状态 + 正文同实例最小差异。回灌期间冻结保存。
  useEffect(() => {
    const reconcile = async (): Promise<void> => {
      pipe.reconcileBusy++
      try {
        await awaitTypingQuiet()
        // 在途的自写先落定再读(评审 D-03 返修):宿主可能先落盘、后回 ack(web PUT / 网络盘),此间读到的是
        // **自己**刚写出去的那版,而 lastSaved 还停在上一版 → 下面会把它当外部改动保全成冲突副本。
        // chain 恒不 reject;写链从不等回灌(CAS 让位那条是 fire-and-forget),这里等不出死锁。
        await pipe.chain
        const rawDisk = await amadeus.readTextFile(path)
        if (rawDisk == null || pipe.dead || pipe.retired) return // 读失败/已卸载:保持现状,绝不清空
        const read = fromDisk(rawDisk) // D-19:内存一律 LF,行尾跟盘上走
        pipe.eol = read.eol
        const raw = read.text
        if (raw === pipe.lastSaved && !pipe.pending) return // 自写回声兜底
        if (pipe.pending) syncFromEditor() // 判「是不是真有用户改动」前先拉平防抖窗里的最后几击
        if (pipe.pending && !isPristine()) {
          // 冲突策略(Codex P0「冻结期本地输入被吞」):本地有未落盘编辑 → **活动编辑器赢**,不动编辑器、
          // 不打断输入。但被盖掉的盘上版本**必须**留底(拍板 #6,评审 D-03:此前这里只换基线,外部那版静默
          // 蒸发、零提示):登记为待保全,finally 的补发在写之前先落冲突副本 + error 级提示,副本没保住就不写。
          // (pending 却 isPristine = 只是编辑器把上一版规范化了一下,不算用户改动 → 照常回灌,不出副本。)
          // ⚠️ 只有盘上**真的离开了本实例的基线**才算外部改动(评审 D-03 返修 B1):raw === lastSaved = 盘上还是
          //    自己上次写的那版(挂载补读、自写回声、改名重挂后接着打字、切篇后立刻打字),没有任何东西要保全;
          //    漏了这一项,每次「读回自己 + 手上有未落盘的字」都会凭空生出一份冲突副本 + error 提示。
          if (raw !== pipe.lastSaved && raw !== composeFm(pipe.fm, pipe.body)) pipe.unpreserved = raw
          pipe.lastSaved = raw
          return
        }
        const { fmText, body } = splitFm(raw)
        // 结构键行变没变要在换 pipe.fm **之前**判(Codex P0-4)。
        const structChanged = layoutLineOf(fmText) !== layoutLineOf(pipe.fm) || canvasLineOf(fmText) !== canvasLineOf(pipe.fm)
        pipe.fm = fmText // fold 闭包现读 pipe.fm:此行必须先于 applyBody 的重 parse(advisor)
        pipe.peerPatch = null // 采纳了盘上版本:同篇写者替我们写的那笔已经在里面了
        setFmVer((v) => v + 1)
        if (body !== pipe.body) {
          pipe.ownedCards.clear() // 归属集合按 parse 世代重建,绝不跨 parse 锁存(Codex P0-5)
          // 归属(G3-03):写类工具在途或刚结束、目标就是这篇、且盘上正文核得上这次写入 → 按 Tangu 的改动画出来。
          // 每次写入只认领一次(Codex 复核 P0):之后同路径的别的改动不再算 Tangu 的。
          // 查不到 = 别人改的 / 云同步 / 外部编辑器 —— 照旧静默回灌。
          const agent = !pipe.readOnly && claimAgentWrite(vaultRoot ? `${vaultRoot.replace(/[\\/]+$/, '')}/${path}` : path, rawDisk)
          if (hostApi.current?.applyBody(body, agent)) {
            pipe.body = body
          } else {
            pipe.body = body
            setEditorKey((k) => k + 1) // 编辑器不在(源码模式等):换 key 重建吃新正文
          }
        } else if (structChanged) {
          // 正文一字未变、只有结构键变了(外部工具只挪了卡片坐标)。卡片几何活在 PM attrs 里,
          // 而 applyBody 的最小差异事务对「正文相同」会算出零差异**根本不重 parse** —— doc 停在旧
          // 坐标,用户随后敲一个字,派生就把外部那次修改静默写回旧值(Codex P0-4)。只能整实例重建
          // 让 fold 拿新的 canvas 行重跑一遍。回灌本就少见,这点成本换正确性。
          pipe.ownedCards.clear()
          setEditorKey((k) => k + 1)
        }
        pipe.lastSaved = raw
        pipe.pending = false
        // 采纳了盘上版本 = 本地与盘上重新一致(收口 N-4):写失败后撤回、外部改动随后被采纳时,退避重试 / 恢复信号
        // 都因 !pending 直接返回,不在这里收,「未保存」条就一直挂着,失败时存的旧草稿留到下次提示恢复。
        settleUnsaved()
        syncSrcDraft() // 源码模式下回灌:textarea 草稿必须跟上,否则下一击键用旧草稿盖掉刚回灌的内容(Codex 终审 P0)
      } finally {
        pipe.reconcileBusy--
        // 冻结期被压下的保存补发 —— 只在**最后一层**回灌收尾时发(还有一层在等静默 = 仍在冻结期)。
        if (pipe.reconcileBusy === 0 && pipe.pending) void writeNow()
      }
    }
    reconcileRef.current = () => { void reconcile() }
    const off = amadeus.onExternalChange?.((p: string) => {
      if (p !== path) return
      void reconcile()
    })
    // 路由读文件 → 本效应装订阅之间有一扇空窗(Codex P1):装完补读一次,
    // 空窗里若有外部写入,走同一条回灌路径;无变化则 raw===lastSaved 直接返回。
    void reconcile()
    return () => {
      reconcileRef.current = null
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 卸载/刷新:立刻冲洗待写(同步启动写,不等防抖;先拉平编辑器最后几击)。
  useEffect(() => {
    const flush = (): void => {
      syncFromEditor()
      flushPropDrafts()
      if (pipe.timer) clearTimeout(pipe.timer)
      pipe.timer = null
      if (pipe.readOnly) return
      // 退休实例(改名 / 删除 / 移动之后,收口 N-5):这条路径已不归本实例 —— writeNow 对它一个字都不写,在这里存草稿
      // 就是一份永不删除的孤儿,之后同名位置出现新笔记会误弹「恢复草稿」。改名 IPC 窗口里打的字由 doRename 按新路径
      // 补写;本实例此前写失败存下的那份也一并清掉(只删自己存的,别的会话留的不碰)。
      if (pipe.retired) {
        if (pipe.stashed != null) clearDraft(vaultRoot, path, pipe.stashed, pipe.slot)
        pipe.stashed = null
        return
      }
      const text = composeFm(pipe.fm, pipe.body)
      // ⚠️ 下面两个同步出口都拿 lastSaved 比,只在**本实例没有写盘在跑**时作数(返修 R1):在途那发 ack 回来会把
      //    lastSaved 改成它写的那份。ack 前用户撤回到旧基线再切走 → 此刻「本地 = lastSaved / 没改动」,直接 return
      //    就再没人把撤回写下去,盘上留着用户亲手删掉的字。有写在跑就照常存草稿 + 排一发 writeNow:链上那轮在 ack
      //    之后按新的 lastSaved 判「还有没有待写」(isPristine 不能挪进链里:卸载后编辑器已不在,canonical 恒为 null)。
      if (!pipe.writing && text === pipe.lastSaved) {
        settleUnsaved() // 写失败后又撤回到盘上那版就关:失败时存下的旧草稿不许留到下次提示恢复
        return
      }
      // G1-01:没有用户改动的实例(正文只是编辑器对基线的规范化)卸载时不写 —— 它若是同篇多开里的陈旧那个,
      // 写下去就是拿旧全文盖掉别的实例 / 窗口刚写的新版。
      if (!pipe.writing && isPristine()) {
        pipe.pending = false
        return
      }
      // D-04:写是异步的,切走 / 关窗后未必来得及完成,也可能失败 —— 先同步把草稿存进本机,写成功再删
      // (noteWriteOk);下次打开同一篇若草稿 ≠ 盘上内容,提示恢复,绝不自动覆盖。
      pipe.stashed = text
      stashDraft(vaultRoot, path, text, pipe.lastSaved, pipe.slot)
      void writeNow()
    }
    const onUnload = (e: BeforeUnloadEvent): void => {
      flush()
      // 离开确认只在 web / 移动宿主、且**真有写不进去的内容**时拦。Electron 里绝不拦:渲染层 beforeunload 的
      // 返回值会无提示地阻止窗口关闭(用户退不出去),桌面走切号 / 退出的冲洗握手;正常防抖期的内容上一行已存成草稿。
      if (pipe.failed && pipe.pending && !isElectronHost()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      pipe.dead = true
      window.removeEventListener('beforeunload', onUnload)
      flush()
      // D-17:改名后交给新实例的「接着写」按**卸载这一刻**的 doc / 选区刷新(新实例在渲染期已拿到同一个对象,
      // 它的编辑器异步建好后才读)—— 改名 IPC 到重建之间打进旧实例的字不随旧实例一起消失。
      // 放在 flush 外面:writeFailures.test 把 flush 的源码单独切出来求值,不往里加自由标识符。
      const carry = outgoingCarry.current
      const v = layer.getView()
      if (carry && v) {
        carry.doc = v.state.doc.toJSON()
        carry.anchor = v.state.selection.anchor
        carry.head = v.state.selection.head
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // D-04 补写:写失败后网络恢复 / 窗口回到前台 / 重新聚焦时立刻再试一次(不等退避到点,也不等下一次击键)。
  useEffect(() => {
    const kick = (): void => {
      if (!pipe.failed || !pipe.pending || pipe.dead || pipe.retired) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (pipe.retryTimer) {
        clearTimeout(pipe.retryTimer)
        pipe.retryTimer = null
      }
      if (pipe.reconcileBusy) return // 回灌收尾会补发
      void writeNow()
    }
    window.addEventListener('online', kick)
    window.addEventListener('focus', kick)
    document.addEventListener('visibilitychange', kick)
    return () => {
      window.removeEventListener('online', kick)
      window.removeEventListener('focus', kick)
      document.removeEventListener('visibilitychange', kick)
      if (pipe.retryTimer) {
        clearTimeout(pipe.retryTimer)
        pipe.retryTimer = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  /** OS 文件进本实例(存附件 + 光标处插 `![[base]]`)。只读 / 已退休 / 编辑器不在 = 不接(false),宿主据此不另找实例。 */
  const insertFilesHere = (files: File[]): boolean => {
    if (pipe.readOnly || pipe.retired || pipe.dead || !hostApi.current) return false
    hostApi.current.insertFiles(files)
    return true
  }
  // 本 leaf 自己的文件写口交给宿主(G1-02:拖入 / 上传不按路径全局找实例)。
  useEffect(() => {
    if (!filesRef) return
    const f = (files: File[]): boolean => insertFilesHere(files)
    filesRef.current = f
    return () => { if (filesRef.current === f) filesRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesRef])

  // 生命周期登记(Codex P0):换库前 flushAllScopes 要等我们落盘;删除/改名/移动要能叫停本实例
  // (防抖写复活刚删/刚移走的文件)。
  useLayoutEffect(() => {
    return registerUnifiedPipe({
      path,
      owner: pipe, // 同窗同篇通知时排除自己(announceUnifiedWrite)
      peerWrote: () => reconcileNow(), // 同窗另一实例刚写盘:与外部改动同一条回灌路径
      // ── 同篇多开的路由依据(G1-02):按路径的操作落到最近用过的实例;fm 补丁交给手里有待写的那个写。 ──
      scope,
      lastActive: () => lastActive.current,
      dirty: () => {
        if (pipe.readOnly || pipe.retired || pipe.dead) return false
        syncFromEditor() // 防抖窗里的最后几击也算
        return composeFm(pipe.fm, pipe.body) !== pipe.lastSaved && !isPristine()
      },
      flush: (strict = false) => {
        if (pipe.readOnly) return Promise.resolve() // 只读实例没有待写内容,换库/切号屏障不必等它
        syncFromEditor()
        flushPropDrafts()
        if (pipe.timer) {
          clearTimeout(pipe.timer)
          pipe.timer = null
        }
        return writeNow(strict)
      },
      insertFiles: (files) => insertFilesHere(files),
      // G1-05:外科写 fm 的实例写口 —— 与 chrome 改图标同一条路(setFm:patchFm → 立即写盘,CAS 带基线)。
      patchFm: (patch, follow = false) => {
        if (pipe.readOnly || pipe.retired || pipe.dead) return null
        if (follow) {
          // G1-02 返修:同篇另一个实例在写这一笔 —— 只并进本实例的 fm(chrome / 源码草稿跟上),不写;
          // 记进 peerPatch(只记外来这一份,本实例自己的 fm 差异不混进去):写者落盘后本实例经 peerWrote 回灌对齐,
          // 期间卸载 / CAS 让位都不拿旧正文抢着写;本实例若另有自己的改动,照旧按冲突策略处理。
          pipe.fm = patchFm(pipe.fm, patch)
          pipe.peerPatch = { ...(pipe.peerPatch ?? {}), ...patch }
          setFmVer((v) => v + 1)
          syncSrcDraft()
          return Promise.resolve()
        }
        setFm(patch)
        return pipe.chain // setFm 刚把这发写排上链:链尾 = 它落定(恒不 reject)
      },
      // ── 插件块表面的接缝(读 fm / 插 markdown):v4 没有块模型,插件对「当前这篇」的读写走这里。 ──
      fmNow: () => foreignFmText(pipe.fm),
      insertMarkdown: (md, where) => (pipe.retired || pipe.readOnly ? false : (hostApi.current?.insertMarkdown(md, where) ?? false)),
      // ── 只读面板的接缝(大纲 / 字数):v4 正文不进 pageStore,它们读 blocks 只会得空。 ──
      bodyNow: () => pipe.body,
      headings: () => {
        const v = layer.getView()
        return v ? docHeadings(v.state.doc) : []
      },
      revealHeading: (index, text, flash) => {
        const v = layer.getView()
        if (!v) return
        // 现遍历一次:大纲那份是渲染时算的,点击之间文档可能已增删标题 → 同序号未必是同一条。
        // 先按序号取,文本对不上就退回按文本找第一条;都不成就不动(绝不静默跳到别的标题)。
        const hs = docHeadings(v.state.doc)
        const h = hs[index]?.text === text ? hs[index] : hs.find((x) => x.text === text)
        if (!h) return
        // C-03:**先 focus 再放选区**,滚动显式做(revealBlockAtTop:贴顶、让开顶栏)。原来先 dispatch
        // scrollIntoView 再 focus —— PM 只在 DOM 选区已在编辑器里时才滚,刚打开 / 焦点在标题框时首击不动;
        // 而且那是最小滚动,往下跳贴视口底、往上跳被 sticky 顶栏盖住。
        v.focus()
        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.tr.doc.resolve(h.pos + 1))))
        const el = v.nodeDOM(h.pos)
        if (!(el instanceof HTMLElement)) return
        revealBlockAtTop(el)
        // 引用条落点闪一下 —— 覆盖片走 flashCiteTip(为什么不能直接给标题节点加类,见那边的注释)。
        // 位置同步读:上面的滚动是同步写 scrollTop,此刻的 rect 就是最终位置。
        if (flash) flashCiteTip(el.getBoundingClientRect())
      },
      revealBlock: (id, flash) => {
        const v = layer.getView()
        if (!v) return false
        // Obsidian 的块锚在 v4 素文件里**没有任何结构** —— 就是块最后一行尾部的一段字面文本,
        // 所以「按原文找」就是唯一正确的找法(现取一遍 doc,与 revealHeading 同理:点击发生在
        // 渲染之后,期间文档可能已增删)。
        const blocks: Array<{ pos: number; text: string; parent: unknown }> = []
        v.state.doc.descendants((node, pos, parent) => {
          if (!node.isTextblock) return true
          blocks.push({ pos, text: node.textContent, parent })
          return false // 文本块内部不必再下钻
        })
        let idx = blocks.findIndex((b) => trailingBlockId(b.text) === id)
        if (idx < 0) return false // 找不到就不动(调用方据此重试/放弃),绝不静默跳到别的块
        // 整行只有 `^id` 时,Obsidian 语义里它标注的是**上一个块** —— 往回退一格。
        // ⚠️ 只在**同一个父节点**里退:光杆锚是引用块/列表项里的第一段时,文档序的上一块属于
        //    另一个容器,退过去就跳到了无关内容(Codex 评审)。跨容器就停在锚自己这一段 ——
        //    它紧贴目标内容,总比跳到别人家里强。文档首行就是光杆锚时同理。
        if (isLoneBlockId(blocks[idx].text) && idx > 0 && blocks[idx - 1].parent === blocks[idx].parent) idx -= 1
        const pos = blocks[idx].pos
        // 先 focus、再放选区、显式贴顶滚动 —— 理由同 revealHeading(C-03)。
        v.focus()
        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.tr.doc.resolve(pos + 1))))
        const el = v.nodeDOM(pos)
        if (el instanceof HTMLElement) {
          revealBlockAtTop(el)
          // 位置同步读:滚动是同步写 scrollTop,此刻的 rect 就是最终位置(同标题锚)。
          if (flash) flashCiteTip(el.getBoundingClientRect())
        }
        return true
      },
      revealText: (needles, opts) => {
        const v = layer.getView()
        if (!v) return false
        const hit = findTextHit(v.state.doc, needles, !!opts?.tag)
        if (!hit) return false // 命中只在标题 / 属性里,或这篇还没装上正文:不动(调用方据此重试 / 放弃)
        // 顺序是死的(G4-01 / C-03):① 先展开藏着命中的会话折叠 —— 两个折叠插件的光标守卫会把放进隐藏区的
        // 选区弹回标题;② focus;③ 选中命中文字;④ 显式贴顶滚动。
        unfoldToReveal(v, hit.from)
        v.focus()
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hit.from, hit.to)))
        // 命中在折起的 callout 里(那是 md 标记,展开 = 写盘,点搜索结果不许动文件)时文本块没有盒子:
        // 退到最近一个看得见的祖先(callout 本身)去亮,至少把用户带到那一块。
        let el: Node | null = v.nodeDOM(hit.block)
        while (el instanceof HTMLElement && el !== v.dom) {
          const r = el.getBoundingClientRect()
          if (r.width || r.height) break
          el = el.parentElement
        }
        if (!(el instanceof HTMLElement) || el === v.dom) return true
        revealBlockAtTop(el)
        if (opts?.flash) flashCiteTip(el.getBoundingClientRect())
        return true
      },
      retire: (movedTo) => {
        dropCiteTip() // 视图退休时把还挂着的落点覆盖片撤掉(它住在 body 上,不随组件卸载)
        // 被挪走 / 改名(评审 G2-03:别处改名经 onPathGone → remapScopePaths 到这里;本端树上移动同理):退休之后
        // 本实例一个字都不再写,还没落盘的字先**同步**存成新路径的草稿 —— 标签随后改指新路径,新实例挂载即出
        // 「恢复草稿」条,恢复时 0a 的流程负责保全盘上那版(基线对不上先落冲突副本)。不做异步交接写:新实例挂载就
        // 读盘,两边会赛跑。本实例自己发起的改名(doRename)先置 retired 并自己补写新路径,这里不重复。
        if (movedTo && !pipe.retired && !pipe.readOnly && !pipe.dead) {
          syncFromEditor()
          const text = composeFm(pipe.fm, pipe.body)
          if (text !== pipe.lastSaved && !isPristine()) stashDraft(vaultRoot, movedTo, text, pipe.lastSaved, pipe.slot)
        }
        pipe.retired = true
        if (pipe.timer) {
          clearTimeout(pipe.timer)
          pipe.timer = null
        }
        if (pipe.retryTimer) {
          clearTimeout(pipe.retryTimer)
          pipe.retryTimer = null
        }
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // D-04 草稿恢复:上次卸载冲洗没写成(磁盘满 / 无权限 / 离线 / 窗口先关了)时存在本机的那份。
  // 只提示,**绝不自动覆盖**盘上内容;草稿 = 盘上内容(其实写成了)时静默删掉。
  // 同篇多开时草稿按实例分槽(G1-02 返修):先认本 leaf 的那份,见 writeSafety.readDraft。别的槽位只认领主人已不在的
  // (leaf 已关 / 没有活实例)—— 活槽归它自己的标签,这里绝不拿来丢弃或恢复(Codex 复核 P1)。
  const [draft, setDraft] = useState<UnsavedDraft | null>(() => {
    if (readOnly) return null
    const slotLive = (s: string | null): boolean => (s == null ? unifiedScopeLive(path, null) : hasPageScope(s) || unifiedScopeLive(path, s))
    const d = readDraft(vaultRoot, path, pipe.slot, slotLive)
    if (!d) return null
    if (d.text === pipe.lastSaved || d.text === (diskRaw ?? initial)) {
      clearDraft(vaultRoot, path, undefined, d.slot)
      return null
    }
    return d
  })
  const discardDraft = (): void => {
    if (draft) clearDraft(vaultRoot, path, undefined, draft.slot)
    setDraft(null)
  }
  const restoreDraft = (): void => {
    const d = draft
    setDraft(null)
    if (!d || readOnly || pipe.retired) return
    // 别的槽位留下的(那个标签已关 / 重启换了 leaf):认领 = 挪进本实例的槽位,之后的删除 / 失败重存都按本槽走。
    if ((d.slot ?? null) !== pipe.slot) {
      clearDraft(vaultRoot, path, d.text, d.slot)
      stashDraft(vaultRoot, path, d.text, pipe.lastSaved, pipe.slot)
    }
    syncFromEditor()
    const disk = pipe.lastSaved
    const local = composeFm(pipe.fm, pipe.body)
    // 恢复会盖掉的那一版先登记保全(writeNow 开头落冲突副本):打开后已经打过字 → 保全本地这版(它就是盘上版 +
    // 新打的字);没打过字但草稿之后盘上又被别处写过(基线指纹对不上)→ 保全盘上那版。都不是 = 纯恢复,无可保全。
    const keep = local !== disk ? local : textFingerprint(disk) !== d.base ? disk : null
    if (keep != null && keep !== d.text) pipe.unpreserved = keep
    const { fmText, body } = splitFm(d.text)
    pipe.fm = fmText
    setFmVer((v) => v + 1)
    if (body !== pipe.body) {
      pipe.ownedCards.clear() // 与回灌同一条纪律:重 parse 前归属集合换世代
      pipe.body = body
      if (!hostApi.current?.applyBody(body)) setEditorKey((k) => k + 1)
    }
    syncSrcDraft()
    pipe.pending = true
    pipe.stashed = d.text // 认领这份草稿:写成功后 noteWriteOk 删掉它
    void writeNow()
  }

  useEffect(() => {
    if (!probe) return
    probe.scheduleState = () => ({ pending: pipe.pending, lastSaved: pipe.lastSaved })
    probe.flush = () => {
      syncFromEditor()
      if (pipe.timer) clearTimeout(pipe.timer)
      pipe.timer = null
      return writeNow()
    }
    probe.fmState = () => ({ fm: pipe.fm, body: pipe.body })
    probe.setFm = (patch: Record<string, unknown>) => setFm(patch, false) // 仪器造「本实例有未落盘的 fm 改动」(防抖写)
    probe.view = () => layer.getView() // 仪器直驱 PM 事务(分栏 spike/检查用)
    probe.serializeNow = () => hostApi.current?.serializeNow() ?? null // 与 200ms 监听同一条落盘序列化链(check:editorperf 计时)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe])

  // 新建流:createPageInFolder 落聚焦请求 → 挂载即聚焦标题(Notion 式先命名)。
  // 信号住模块级而非本 scope:新建的落点面板由 openNote 现算,创建时那份 store 未必是这一份。
  const [titleFocus, setTitleFocus] = useState(false)
  useEffect(() => {
    if (claimTitleFocus(path)) setTitleFocus(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  /** D-17「接着写」:新实例的编辑器建好、已聚焦到文首时调用。盘上正文就是旧实例写下的那份 → 旧 doc 原样接过来
   *  (含没进盘的顶插空段与重建窗口里打的字;多出的字随后走正常防抖保存落盘),再把选区放回原处。
   *  不进撤销栈:这不是一次编辑,是同一次编辑会话跨重建的延续。 */
  const continueFrom = (c: BodyCarry): void => {
    const view = layer.getView()
    if (!view) return
    let tr = view.state.tr
    if (pipe.body === c.body) {
      try {
        const prev = view.state.schema.nodeFromJSON(c.doc)
        if (!prev.eq(tr.doc)) tr = tr.replaceWith(0, tr.doc.content.size, prev.content)
      } catch { /* schema 对不上(插件启停换了 schema)→ 只按位置落光标 */ }
    }
    const max = tr.doc.content.size
    const at = (n: number) => tr.doc.resolve(Math.max(0, Math.min(n, max)))
    try {
      tr = tr.setSelection(TextSelection.between(at(c.anchor), at(c.head)))
    } catch { /* 落不进合法文字位就留在文首 */ }
    view.dispatch(tr.setMeta('addToHistory', false).scrollIntoView())
  }

  const doRename = async (next: string, focusKind: 'enter' | 'move' | null = null): Promise<boolean> => {
    if (readOnly) return false
    try {
      syncFromEditor() // 快打字后立刻回车改名:先拉平防抖窗里的最后几击(Codex A4)
      await writeNow() // 待写先落旧路径(chain 串行:在途写全部排完)
      await flushAllScopes() // 全库 [[链接]] 重写前,其它面板待存文本先落盘
      const newPath = await amadeus.renamePageFile(path, next)
      if (newPath !== path) {
        remapNoteViewMemory(vaultRoot, path, newPath)
        remapFoldMemory(vaultRoot, path, newPath)
        pipe.retired = true // 本实例退休:再写旧路径 = 复活幽灵文件
        // 改名 IPC 窗口里刚打的字不该丢(Codex P0):按新路径补一发,随 key 重建被读回。
        // IPC await 期间可能又打了字(200ms 监听窗)→ 补写前再拉平一次(Codex 终审 P0)。
        syncFromEditor()
        const text = composeFm(pipe.fm, pipe.body)
        const writtenBody = pipe.body // 同步取:await 期间监听器还会改 pipe.body
        if (text !== pipe.lastSaved) {
          // 补写失败不能吞(Codex 0b):存成新路径草稿 + 提示,新实例打开时会提示恢复。
          await amadeus.writeTextFile(newPath, toDisk(text, pipe.eol)).catch((e) => { stashDraft(vaultRoot, newPath, text, pipe.lastSaved, pipe.slot); toastSaveFailed(newPath, e) })
        }
        // D-17:聚焦请求跨重建带给新实例 —— 必须在 remapScopePaths 之前落下(生产里它同步广播,标签当场改指、
        // 新实例可能在下面的 await 期间就挂上)。「进入正文」还没执行(源码模式等编辑器不在)→ 交给新实例执行这一次;
        // 已经执行过、光标在正文里 →「接着写」(旧 doc + 选区),绝不再执行一遍。
        // 档位由**本次 commit** 逐次携带(Codex 深夜 F2:原 5 秒时间窗会把「回车后 5 秒内点走改名」
        // 误判成回车改名 —— 凭空顶插空段还把焦点从用户点的控件抢回正文);点走 blur 的改名只在光标确在正文里时续上。
        const pending = bodyFocusRef.current
        const view = layer.getView()
        if (focusKind && pending != null && typeof pending !== 'object') {
          pendingBodyFocus = { path: newPath, scope, req: pending, at: Date.now() }
        } else if (view?.hasFocus()) {
          const carry: BodyCarry = { place: 'restore', body: writtenBody, doc: view.state.doc.toJSON(), anchor: view.state.selection.anchor, head: view.state.selection.head }
          outgoingCarry.current = carry
          pendingBodyFocus = { path: newPath, scope, req: carry, at: Date.now() }
        }
        retireUnifiedPath(path, 'file', newPath) // 别的标签开着同一篇:一并停写旧路径(它们未落盘的字存成新路径的草稿,G2-03)
        remapScopePaths(path, newPath, 'file')
        await cascadeFdAfterRename(path, newPath)
        void usePageStore.getState().refreshPages()
        onRenamed?.(newPath)
      }
      return true
    } catch {
      return false // 撞名/非法名:调用方(UnifiedTitle)把输入框还原成旧名
    }
  }

  // 层级缩进的重算触发。tree 住在 fm 里、不在 doc 里 → 改层级不产生 PM 事务 → createCardDepthDeco
  // 的 decorations 不会自己重算(现象:认了爹但缩进要等下一次击键才出现;删掉中间那层后孙卡
  // 一直缩着不动)。canvas 行**真变过**才推 fmVer(见 deriveFmFromDoc 那句),挂在它上面正好。
  // ⚠️ 两条都是刻意的**收窄**,别图省事改回去:
  //  1. `updateState(state)` 而不是 dispatch 一笔空事务 —— 想要的只是「照现有 state 重画一次
  //     decoration」。空事务看着无害,实际要穿过 filterTransaction / appendTransaction / history /
  //     listener 一整排钩子,而这条 effect 恰好在撤销/重做收尾的那一刻触发,白给的风险面。
  //  2. 只在 **tree 真变了**时推:fmVer 每拖一次卡、挪一次元素都会涨,那些与缩进档位无关。
  const treeSeen = useRef<string>('')
  useEffect(() => {
    const now = JSON.stringify(parseCanvasJson(canvasLineOf(pipe.fm))?.tree ?? null)
    if (now === treeSeen.current) return
    treeSeen.current = now
    const view = layer.getView()
    if (view) view.updateState(view.state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmVer, layer])
  void fmVer // chrome 数据全部经 pipe.fm 派生,fmVer 只负责触发重渲
  const fmObj = foreignFmObject(pipe.fm)
  const icon = typeof fmObj.icon === 'string' && fmObj.icon.trim() ? fmObj.icon.trim() : null
  const cover = typeof fmObj.cover === 'string' && fmObj.cover.trim() ? fmObj.cover.trim() : null
  const coverYRaw = fmObj.cover_y
  const coverYNum = typeof coverYRaw === 'number' ? coverYRaw : typeof coverYRaw === 'string' ? parseFloat(coverYRaw) : NaN
  const coverY = Number.isFinite(coverYNum) ? Math.max(0, Math.min(100, coverYNum)) : 50

  const srcText = useMemo(() => (mode === 'source' ? composeFm(pipe.fm, pipe.body) : ''), [mode, fmVer]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // 源码 → 可视:textarea 编辑已实时进 pipe,这里只负责让编辑器重建吃新正文。
    if (mode !== 'source') {
      setSrcDraft(null)
      // ⚠️ 重建 = 一次新 parse,归属集合必须跟着换世代(与 reconcile 那两处同一条纪律,Codex P0-5)。
      // 漏在这里是潜伏的毁数据:在源码模式把某张卡的锚改坏 → 回可视时折叠失败、doc 零卡片,而
      // 上一代的集合仍然满足 deriveCanvasJson 的归属判据 → 派生出 `cards: []` → 整个 amadeus_canvas
      // 键被剥,全部卡片几何一次没。(sawRows 是分栏那边的同族布尔量,毛病更老,不在本轮动。)
      pipe.ownedCards.clear()
      setEditorKey((k) => k + 1)
    }
  }, [mode])
  // 源码 textarea 自动撑高(v3 SourceEditor 的 grow 同款):.amx-source 是 overflow:hidden,
  // 滚动交给外层容器 —— unified 首版漏带这一手,超过 min-height(60vh) 的尾部被整段裁掉且
  // 滚不到(真机第5振「粘贴图片后源码后面的内容不显示」,文件本身完好)。
  // 依赖限定到模式/内容(Codex 第5振评审 P2:无依赖数组=每次重渲染都强制同步布局测量)。
  const srcTaRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = srcTaRef.current
    if (mode === 'source' && el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [mode, srcDraft, srcText])
  // 页内查找替换(C-18):可编辑实例把本篇注册成 replace provider —— 所见即所得映射成 PM 事务(findReplace.ts),
  // 源码模式走 textarea(textareaFindProvider,保原生撤销栈)。只读实例不注册 = 查找条不给替换行。
  useEffect(() => {
    if (readOnly) return
    if (mode === 'source') {
      const ta = srcTaRef.current
      return ta ? registerFindProvider(textareaFindProvider(ta)) : undefined
    }
    const el = bodyRef.current
    return el ? registerFindProvider(pmFindProvider(el, () => layer.getView())) : undefined
  }, [readOnly, mode, layer])

  return (
    <>
      {/* 顶栏胶囊的锚:恒在场(源码模式也在),只用来 `closest('.amx-pane')` 找本 pane 的插槽。
          零尺寸、不吃指针 —— 它不参与任何布局。 */}
      <span ref={segAnchorRef} className="amx-seg-anchor" aria-hidden />
      {mode === 'source' ? null : (
        <CanvasSegPortal anchor={segAnchor} on={canvasOn} toggle={() => toggleCanvasRef.current()} />
      )}
      {/* 画布模式满铺(用户 2026-08-17 拍板「像 AFFiNE 一样整个 view 显示」):封面/标题/属性整层
          不渲染,笔记体脱出 920px 纸面铺满面板。⚠️ 这几个槽位用 `x ? <A/> : null` 而不是把它们
          挪走 —— 静态 JSX 的子节点按位置对位,槽位在场就不会把后面的编辑器挤到别的 index 上重挂。 */}
      {fullCanvas || compact ? null : (
        <NoteCover
          page={path}
          cover={cover}
          coverY={coverY}
          readOnly={readOnly}
          onSetCover={(c) => setFm({ cover: c ?? undefined, ...(c ? {} : { cover_y: undefined }) })}
          onSetCoverY={(y) => setFm({ cover_y: y })}
        />
      )}
      {fullCanvas ? null : (
      <div className="amx-doc unified-page" data-unified-path={path} onFocusCapture={touchActive} onPointerDownCapture={touchActive}>
        <UnifiedTitle
          compact={compact}
          path={path}
          icon={icon}
          cover={cover}
          readOnly={readOnly}
          onSetIcon={(em) => setFm({ icon: em ?? undefined })}
          onSetCover={(c) => setFm({ cover: c })}
          onRename={doRename}
          onEnterBody={(kind) => setBodyFocus(kind === 'enter' ? 'body-enter' : 'start')}
          focusSignal={titleFocus}
        />
        {!compact && <PropsDraftFlushContext.Provider value={propDrafts}><AmadeusPropertiesPanel
          fmExtra={foreignFmText(pipe.fm)}
          readOnly={readOnly}
          notePath={path}
          onCommit={(yaml) => {
            pipe.fm = setForeignFm(pipe.fm, yaml)
            setFmVer((v) => v + 1)
            syncSrcDraft()
            pipe.pending = true
            void writeNow()
          }}
        /></PropsDraftFlushContext.Provider>}
        {/* 锁定条(C-07):锁着的笔记一眼看得出为什么打不了字,解锁就在手边。样式复用写盘状态条。 */}
        {readOnly && onUnlock && (
          <div className="mk-notice unified-savebar" data-lock="on" role="status">
            <LockIcon size={15} />
            <div className="mk-notice-body"><span>{t('unipage.lock.bar')}</span></div>
            <button type="button" className="btn sm" onClick={onUnlock}>{t('unipage.lock.unlock')}</button>
          </div>
        )}
        {/* 写盘状态条(D-04):写失败 → 常驻「未保存」+ 立即重试;上次没写成的草稿 → 恢复 / 丢弃。
            样式复用全局 `.mk-notice` 提示条(base.css),本处只在 amadeus-host.css 里改宽度与外距。 */}
        {!readOnly && saveFailed && (
          <div className="mk-notice is-error unified-savebar" data-save="failed" role="alert">
            <AlertCircle size={15} />
            <div className="mk-notice-body"><span>{t('unisave.failed.bar')}</span></div>
            <button type="button" className="btn sm" onClick={() => {
              if (pipe.retryTimer) {
                clearTimeout(pipe.retryTimer)
                pipe.retryTimer = null
              }
              void writeNow()
            }}>{t('unisave.failed.retry')}</button>
          </div>
        )}
        {!readOnly && draft && (
          <div className="mk-notice unified-savebar" data-save="draft" role="status">
            <History size={15} />
            <div className="mk-notice-body">
              <span>{t('unisave.draft.bar', { time: formatDateTime(draft.at) })}</span>
              <small>{t('unisave.draft.hint')}</small>
            </div>
            <button type="button" className="btn sm primary" onClick={restoreDraft}>{t('unisave.draft.restore')}</button>
            <button type="button" className="btn sm" onClick={discardDraft}>{t('unisave.draft.discard')}</button>
          </div>
        )}
      </div>
      )}
      {mode === 'source' ? (
        <textarea
          ref={srcTaRef}
          className="amx-source"
          value={srcDraft ?? srcText}
          spellCheck={spellcheck}
          onFocus={touchActive}
          onChange={(e) => {
            const v = e.target.value
            setSrcDraft(v)
            const { fmText, body } = splitFm(v)
            // 源码模式是**唯一**绕过 setAmadeusStructure 的写点(Codex P0):手删掉 amadeus_schema
            // 却留着 layout/canvas,文件下次打开就被 classifyPageSource 判 v3 → 升级链把 canvas
            // 从 fmExtra 里剥掉 = 几何永久丢失。这里只做「缺 schema 就补回」这一个方向的修复:
            // 用户想整个解散结构就把 layout/canvas 也删掉(那时 structureKeysFor 一行都不发)。
            pipe.fm = fixStructKeys(fmText)
            pipe.body = body
            schedule()
          }}
        />
      ) : (
        <div
          ref={bodyRef}
          className={`page-view unified-body${canvasOn ? ' amx-canvas' : ''}${fullCanvas ? ' amx-canvas-full' : ''}`}
          data-bare
          onFocusCapture={() => { touchActive(); setFocusedBlockApply(stableApply) }}
          onPointerDownCapture={touchActive}
        >
          {/* 模式钮(AFFiNE 同位:页面右上)。整篇零画布数据时也照常显示 —— 画布是任意笔记随时
              可用的能力,不是某种文件类型的特权;点进去只是换视角,不写盘(见 toggleCanvas)。 */}
          <CanvasStage
            path={path}
            vaultRoot={vaultRoot}
            active={canvasOn}
            readOnly={readOnly}
            revealSelection={canvasReveal}
            getView={() => layer.getView()}
            main={canvasMain}
            mainStored={canvasDoc?.main != null}
            elements={canvasDoc?.elements}
            tree={canvasDoc?.tree}
            onElements={setCanvasElements}
            onTree={setCanvasTree}
            onMain={setCanvasMain}
            timeline={undoTimeline}
            histStepRef={stageHist}
            saveFile={(f) => saveOneFile(path, f)}
            // 粘贴/拖入画布的文字走宿主的同一条解析链(与 insertMd 逐字同源:显示形 → parserCtx)。
            parseMd={(md) => hostApi.current?.parseMd(md) ?? null}
            serializeMd={(frag) => hostApi.current?.serializeMd(frag) ?? null}
            onBlocksDeleted={onBlocksDeleted}
            onCommit={(newRef) => {
              if (newRef) pipe.ownedCards.add(newRef) // 本实例建的卡也算「负责得起」,见 deriveCanvasJson
              syncFromEditor() // 版本推送在 deriveFmFromDoc 里(canvas 行真变了才推)
              schedule()
            }}
          >
            <MilkdownProvider key={`${path}:${editorKey}:${extGen}${readOnly ? ':ro' : ''}`}>
              <UnifiedEditorHost
                path={path}
                pageDir={pageDir}
                body={pipe.body}
                onChange={(stored) => {
                  pipe.body = stored
                  deriveFmFromDoc() // 分栏 layout 单一真源 = 当前 doc(Codex A13)
                  schedule()
                }}
                onFinalFlush={(stored) => {
                  pipe.body = stored
                  deriveFmFromDoc()
                  schedule()
                  setFmVer((v) => v + 1) // 切源码场景:srcText 用拉平后的 pipe 重算,别显示旧草稿
                }}
                skipFinalFlush={() => pipe.reconcileBusy > 0}
                apiRef={hostApi}
                probe={probe}
                extraPlugins={editorPlugins}
                focusPlace={bodyFocus != null && typeof bodyFocus === 'object' ? 'start' : bodyFocus}
                onFocused={() => {
                  if (bodyFocus != null && typeof bodyFocus === 'object') continueFrom(bodyFocus)
                  setBodyFocus(null)
                }}
                onCard={makeCard}
                readOnly={readOnly}
                onAskTangu={canAskTangu ? (view) => askTangu(view, view.state.selection.from, view.state.selection.to) : undefined}
                aiMenu={canAi ? { items: aiMenuItems, onPick: (id, view) => openAi(view, id) } : undefined}
                onAiPrompt={canAi ? (view) => openAi(view, 'prompt') : undefined}
              />
            </MilkdownProvider>
          </CanvasStage>
          {!canvasOn && !readOnly && <div className="page-tail" onClick={() => hostApi.current?.focusTail()} />}
          {!readOnly && agentView.count > 0 && (
            <AgentChangeCapsule
              count={agentView.count}
              index={agentView.index}
              onReview={onAgentReview}
              onRevert={onAgentRevert}
              onKeep={() => { const v = layer.getView(); if (v) keepAgentChanges(v) }}
            />
          )}
        </div>
      )}
      <LinkHoverCard
        getView={() => layer.getView()}
        onOpenNote={(href) => void scoped.getState().openWikiLink(noteLinkTarget(href, path, scoped.getState().pages), path)}
      />
      {lightbox && (
        <OverlayPortal>
          <div className="amx-lightbox" onClick={() => setLightbox(null)} role="presentation">
            <img src={lightbox} alt="" />
          </div>
        </OverlayPortal>
      )}
      {aiPanel && canAi && (
        <OverlayPortal>
          <InlineAiPanel
            key={aiPanel.key}
            x={aiPanel.x}
            y={aiPanel.y}
            anchorTop={aiPanel.top}
            title={aiPanel.title}
            hasSelection={aiPanel.hasSelection}
            askFirst={aiPanel.askFirst}
            run={runAi(aiPanel)}
            onApply={applyAi}
            onClose={closeAi}
            editorEl={bodyRef.current}
          />
        </OverlayPortal>
      )}
      {movePick && !readOnly && (
          <NotePicker
            pages={scoped.getState().pages}
            exclude={path}
            onClose={() => { setMovePick(null); layer.getView()?.focus() }}
            onPick={(target) => {
              const pick = movePick
              setMovePick(null)
              const view = layer.getView()
              if (!view) return
              // 选择器开着的这段时间文档变了 → 旧区间不再指向那几块(同块菜单的 fail closed)。
              if (view.state.doc !== pick.doc) {
                window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('unipage.menu.stale') } }))
                return
              }
              void moveBlocksTo({ view, from: pick.from, to: pick.to, source: path, target, serialize: (c) => hostApi.current?.serializeMd(c) ?? null })
                .then((moved) => { if (moved) { syncFromEditor(); schedule() } })
              view.focus()
            }}
          />
      )}
      {/* 只读兜底(B-02):交互层已不在只读下开菜单,这里再挡一层 —— 菜单项全是改文档的动作。 */}
      {blockMenu && !readOnly && (
        <OverlayPortal>
          <OverlayAt className="ctx-menu unified-block-menu" role="menu" aria-label={t('unipage.menu.aria')} x={blockMenu.x} y={blockMenu.y} onClick={(e) => e.stopPropagation()}>
            {canAskTangu && (
              <>
                {/* 块级 AI 入口排首位(Notion ⋮⋮ 的 Ask AI 同位)。不走 withBlocks:那条收尾会把焦点拽回编辑器,
                    而这里焦点该留给侧栏输入框(引用落地后它自己 focus)。 */}
                <button role="menuitem" tabIndex={-1} data-act="ask" onClick={() => {
                  setBlockMenu(null)
                  const view = layer.getView()
                  if (!view || !restoreMenuTarget(view)) return
                  const r = layer.topRangeOf(view)
                  const sel = view.state.selection
                  if (r) askTangu(view, r.from, r.to)
                  else if (sel instanceof NodeSelection) askTangu(view, sel.from, sel.to)
                }}>
                  <MessageSquarePlus size={13} /> {t('unipage.menu.askTangu')}
                </button>
                <div className="ubm-sep" role="separator" />
              </>
            )}
            <div className="ubm-label" role="presentation">{t('unipage.menu.turnInto')}</div>
            {/* 文字类转换对整张表静默无效(K-10):表格上不列出,换成下面的表格区;「卡片」对表格照常可用。 */}
            {!isTableSelected(layer.getView()) && (
              <>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'text' }, t('unipage.menu.text'))}><Pilcrow size={13} /> {t('unipage.menu.text')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'heading', level: 1 }, t('unipage.menu.h1'))}><Heading1 size={13} /> {t('unipage.menu.h1')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'heading', level: 2 }, t('unipage.menu.h2'))}><Heading2 size={13} /> {t('unipage.menu.h2')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'heading', level: 3 }, t('unipage.menu.h3'))}><Heading3 size={13} /> {t('unipage.menu.h3')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'bullet' }, t('unipage.menu.bullet'))}><List size={13} /> {t('unipage.menu.bullet')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'ordered' }, t('unipage.menu.ordered'))}><ListOrdered size={13} /> {t('unipage.menu.ordered')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'task' }, t('unipage.menu.task'))}><ListTodo size={13} /> {t('unipage.menu.task')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'quote' }, t('unipage.menu.quote'))}><TextQuote size={13} /> {t('unipage.menu.quote')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnIntoSpecial('callout', t('unipage.menu.callout'))}><Info size={13} /> {t('unipage.menu.callout')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnInto({ kind: 'fold' }, t('unipage.menu.fold'))}><ChevronsDown size={13} /> {t('unipage.menu.fold')}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => turnIntoSpecial('code', t('unipage.menu.code'))}><Code2 size={13} /> {t('unipage.menu.code')}</button>
              </>
            )}
            {/* 卡片也是块类型，放在“转换为”内与 /card 保持同一信息架构；不支持的节点不露入口。 */}
            {(() => {
              const view = layer.getView()
              const selection = view?.state.selection
              if (!view || !(selection instanceof NodeSelection)) return null
              if (['amadeusCanvasCard', 'amadeusColumnRow', 'amadeusColumnCell', 'list_item'].includes(selection.node.type.name)) return null
              const $at = view.state.doc.resolve(selection.from)
              for (let depth = $at.depth; depth >= 1; depth--) {
                if ($at.node(depth).type.name === 'amadeusColumnCell') return null
              }
              return (
                <button role="menuitem" tabIndex={-1} onClick={() => withSelectedNode((current) => { makeCard(current) })}>
                  <StickyNote size={13} /> {t('unipage.menu.card')}
                </button>
              )
            })()}
            {isTableSelected(layer.getView()) && (
              <TableMenuSection view={layer.getView()!} cell={blockMenu.cell ?? null} onDone={() => setBlockMenu(null)} />
            )}
            <div className="ubm-sep" role="separator" />
            {/* 多块选中:置灰 + 说明(B-05:此前点了静默无效)。aria-disabled 而不是 disabled —— 禁用的按钮不出 title 提示。 */}
            {layer.getView() && layer.topRangeOf(layer.getView()!) ? (
              <button role="menuitem" tabIndex={-1} aria-disabled="true" title={t('unipage.menu.toNewColumnMulti')} data-act="toNewColumn" onClick={() => {
                window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('unipage.menu.toNewColumnMulti') } }))
              }}>
                <Columns2 size={13} /> {t('unipage.menu.toNewColumn')}
              </button>
            ) : layer.getView() && columnSplitApplies(layer.getView()!.state.selection) && (
              // 只对顶层单块列出(B-18):列表项 / 分栏里 / 卡片里点了 splitToColumn 静默拒绝。
              <button role="menuitem" tabIndex={-1} data-act="toNewColumn" onClick={() => withSelectedNode((view, sel) => {
                splitToColumn(view, sel.from, sel.to, sel.node) // 与 slash「分栏」共用(columns.ts)
              })}>
                <Columns2 size={13} /> {t('unipage.menu.toNewColumn')}
              </button>
            )}
            {/* 卡片才有:把卡收回自然流(拖回主卡的键鼠等价物 —— 文档模式下没有舞台可拖)。
                条件渲染而不是「点了才 return」:对普通段落也显示一个点了没反应的菜单项是纯噪音。 */}
            {layer.getView()?.state.selection instanceof NodeSelection
              && (layer.getView()!.state.selection as NodeSelection).node.type.name === 'amadeusCanvasCard' && (
              <button role="menuitem" tabIndex={-1} onClick={() => withSelectedNode((view, sel) => {
                if (sel.node.type.name !== 'amadeusCanvasCard') return
                unwrapCard(view, String(sel.node.attrs.anchor))
                syncFromEditor()
                schedule()
              })}>
                <Undo2 size={13} /> {t('unipage.menu.backToDoc')}
              </button>
            )}
            {/* 与 Mod-D 同一份(blockLayer.duplicate,B-12):跨块选区整批(AFFiNE 的 Duplicate 也是「只选半行
                也复制整块」)、块选中复制该节点。画布卡(含跨块选区盖到的整卡)一律当场铸新锚并经 onCardsMinted
                进归属集合 —— 原样插入 = 两个同锚卡、整个 canvas 键作废(Codex P0-6);漏登记 = 派生冻结(C89b)。
                菜单这条再立刻拉平一次派生 + 排保存(原单卡支的做法),键盘那条走编辑器 onChange 的常规链。 */}
            <button role="menuitem" tabIndex={-1} onClick={() => {
              setBlockMenu(null)
              const view = layer.getView()
              if (!view || !restoreMenuTarget(view)) return
              if (layer.duplicate(view)) {
                syncFromEditor()
                schedule()
              }
              view.focus()
            }}>
              <Copy size={13} /> {t('unipage.menu.duplicate')}
            </button>
            {/* 复制标题链接 / 复制块链接 / 移动到(B-15):只在真能用的时候露出 —— 块链接只给已有 `^id` 的块(不铸 ID)。 */}
            {(() => {
              const view = layer.getView()
              if (!view) return null
              const sel = view.state.selection
              const range = layer.topRangeOf(view) ?? (sel instanceof NodeSelection ? { from: sel.from, to: sel.to } : null)
              const link = sel instanceof NodeSelection ? blockLinkOf(sel.node, path, scoped.getState().pages) : null
              const movable = !!range && canMove(view.state.doc.slice(range.from, range.to).content)
              return (
                <>
                  {link && (
                    <button role="menuitem" tabIndex={-1} data-act="copyLink" onClick={() => { setBlockMenu(null); copyLink(link.link); layer.getView()?.focus() }}>
                      <Link2 size={13} /> {t(link.kind === 'heading' ? 'blocklinks.copyHeading' : 'blocklinks.copyBlock')}
                    </button>
                  )}
                  {movable && (
                    <button role="menuitem" tabIndex={-1} data-act="moveTo" onClick={() => {
                      setBlockMenu(null)
                      const v = layer.getView()
                      if (!v || !restoreMenuTarget(v)) return
                      const s2 = v.state.selection
                      const r = layer.topRangeOf(v) ?? (s2 instanceof NodeSelection ? { from: s2.from, to: s2.to } : null)
                      if (r) setMovePick({ doc: v.state.doc, ...r })
                    }}>
                      <FileInput size={13} /> {t('blocklinks.moveTo')}
                    </button>
                  )}
                </>
              )
            })()}
            <button role="menuitem" tabIndex={-1} className="danger" onClick={() => withBlocks(
              (view, r) => {
                const removed = view.state.doc.slice(r.from, r.to).content
                view.dispatch(view.state.tr.delete(r.from, r.to).scrollIntoView())
                onBlocksDeleted(removed) // 与键盘删块同一条询问路径(assetDelete)
              },
              (view, sel) => {
                const removed = Fragment.from(sel.node)
                view.dispatch(view.state.tr.deleteSelection().scrollIntoView())
                onBlocksDeleted(removed)
              },
            )}>
              <Trash2 size={13} /> {t('unipage.menu.delete')}
            </button>
          </OverlayAt>
        </OverlayPortal>
      )}
    </>
  )
}
