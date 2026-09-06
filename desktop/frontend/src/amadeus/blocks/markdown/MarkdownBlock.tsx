// The markdown BlockType: a per-block Milkdown (WYSIWYG) editor.
// Milkdown is built on ProseMirror + remark, so a block's content serializes back to
// markdown through the SAME AST the compiler speaks — no lossy export into main.md.
//
// Editing model (per user spec):
//  - Enter           → native in-block newline (NEVER creates a block)
//  - Shift+Enter     → create a new block below and focus it
//  - Backspace at start of an empty block → delete it, focus the previous
//  - ArrowUp/Down past the top/bottom line → move the caret to the neighbour
//  - Mod+Shift+Up/Down → reorder the block within its column
//  - "/" at line start or after a space → slash menu (filterable)
//  - paste/drop an image → save under the page's .amadeus/ and embed it
// Keys/paste go through editorViewOptionsCtx, which ProseMirror checks before plugin
// keymaps, so these overrides win over the commonmark defaults.
//
// Images are stored as PORTABLE page-relative links (![](.amadeus/x.png)); for display
// they are rewritten to the amadeus-asset:// protocol and back on save (see @amadeus-shared/assets).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Editor,
  commandsCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
  type CmdKey,
} from '@milkdown/kit/core'
import { gfm } from '@milkdown/kit/preset/gfm'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  linkSchema,
} from '@milkdown/kit/preset/commonmark'
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import {
  applyBgCommand,
  applyColorCommand,
  bgSchema,
  colorSchema,
  inlineHtmlMarksRemark,
  toggleUnderlineCommand,
  underlineSchema,
} from './marks'
import { blankLineRemark, softBreakRemark, stripEmptyLineBr } from './softBreak'
import { tabIndent, tabOutdent } from './tabIndent'
import { commonmarkWithIndent, setTextAlignment, type TextAlignment } from './paragraphIndent'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { $prose } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node as ProseNode, Slice } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, Selection, TextSelection } from '@milkdown/kit/prose/state'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import { joinRel, toAssetUrl, toDisplayMarkdown, toStoredMarkdown, fromAssetUrl } from '@amadeus-shared/assets'
import { tabsToEntities, entitiesToTabs } from '@amadeus-shared/indentIo'
import { resolvePageName, unescapeWikiOutsideFences, normalizeUrlLiterals } from '@amadeus-shared/links'
import { resolveFileName } from '../../lib/vaultFiles'
import { wikiFilesEnabled } from '../../lib/wikiFiles'
import { emptyDb, emptyNoteView, serializeDb } from '@amadeus-shared/db/schema'
import { BLANK_SCENE_JSON, blankDrawing } from '@amadeus-shared/excalidraw/format'
import { amadeus } from '../../api'
import { getAttachmentPrefs } from '../../lib/attachments'
import { usePageStore, useScopedPageStore } from '../../store/pageStore'
import { registerBlockType, type BlockEditorProps, type FocusPlace } from '../registry'
import { usePluginStore } from '../../plugins/pluginStore'
import {
  BookmarkIcon, BulletedListIcon, CheckBoxCheckLinearIcon, CodeBlockIcon, DatabaseListViewIcon, DatabaseTableViewIcon,
  DividerIcon, EmbedIcon, FoldIcon, Heading1Icon, Heading2Icon, Heading3Icon, Heading4Icon, Heading5Icon, Heading6Icon,
  ImageIcon, LayoutIcon, LinkedPageIcon, PageIcon,
  NewPageIcon, NumberedListIcon, PenIcon, QuoteIcon, SelectIcon, TableIcon, TemplateIcon, TeXIcon, TextIcon,
  resolveIcon,
} from '../../components/icons'
import { wikilinkPlugin } from './wikilink'
import { mdImagePlugin } from './mdImage'
import { focusStructuralPrefix, structuralSourcePlugin } from './structuralSource'
import { applyTrigger, matchTrigger, posAtTextAnchor, slashRange, splitTail, textBeforeCursor, unwrapAtStart, type Trigger } from './blockTriggers'
import { fullWidthWikiRule, mentionSuggestPlugin, selectionToolbarPlugin, slashSuggestPlugin, wikiSuggestPlugin, type SelRect, type WikiQuery } from './wikiAutocomplete'
import { InlineToolbar, type ToolbarAction } from './InlineToolbar'
import { OverlayPortal } from '../../lib/overlayPortal'
import { OverlayAt } from '../../lib/clampMenu'
import { getRecentPages } from '../../lib/recents'
import { fdDirOf } from '../../lib/fd'
import { fuzzyScore } from '../../lib/fuzzy'
import { WikiSuggest } from './WikiSuggest'
import { BLANK_BUTTON_BLOCK } from '../button/format'
import { taskCheckboxPlugin } from './taskList'
import { calloutPlugin, unescapeCalloutToken } from './callout'
import { codeBlockPlugin } from './codeBlock'
import { askString } from '../../components/askString'
import { linkInputRule, normalizeHref } from './linkHref'
import { wikiSafeUrl } from '@amadeus-shared/pdfLink'
import { useBlockSelection } from '../../store/blockSelection'
import { mathLivePreviewPlugin, unescapeMathSource } from './mathLivePreview' // LaTeX 实况预览:公式常驻纯文本,离行才渲染(见该文件）
import { pluginEditorExtensions, editorExtensionGen, subscribeEditorExtensions } from '../../plugins/editorExtensions'
import { registerMessages, translate, useI18n } from '../../../i18n'

// 本文件的文案命名空间恒为 `mdblock.*`(别的组件在同一本全局字典里注册,撞键=静默覆盖)。
// ⚠️ 模块作用域的表(SLASH_ITEMS)只存**键**,取文案一律在渲染期 t()/translate() ——
//    在这里直接写中文会把文案冻在模块加载那一刻,切英文界面纹丝不动。
registerMessages({
  // ── 落盘产物默认名 ──────────────────────────────────────────────────────
  // ⚠️ 这些会变成**真实文件名 / 文档标题**。跟随语言,不是标识符 —— 全库无一处比较它们
  //    (对照真 hazard:同文件的列 id 是 frontmatter 键、状态选项是被 `v === opt` 比较的落盘值)。
  'mdblock.default.childNote': { zh: '未命名', en: 'Untitled' },
  'mdblock.default.database': { zh: '未命名数据库', en: 'Untitled database' },
  'mdblock.default.drawing': { zh: '画板', en: 'Drawing' },
  'mdblock.default.noteViewFolder': { zh: '笔记视图', en: 'Note view' },
  'mdblock.default.noteView': { zh: '未命名视图', en: 'Untitled view' },
  'mdblock.placeholder': { zh: '输入文字，或按 “/” 选择类型…', en: 'Type something, or press “/” to pick a block…' },
  // slash 菜单 / 移动端块面板的分组名
  'mdblock.group.basic': { zh: '基础', en: 'Basic' },
  'mdblock.group.list': { zh: '列表', en: 'Lists' },
  'mdblock.group.advanced': { zh: '高级', en: 'Advanced' },
  'mdblock.group.plugin': { zh: '插件', en: 'Plugins' },
  // slash 菜单条目名(**唯一真源**,桌面菜单与移动端块面板共用)
  'mdblock.slash.text': { zh: '文本', en: 'Text' },
  'mdblock.slash.h1': { zh: '标题 1', en: 'Heading 1' },
  'mdblock.slash.h2': { zh: '标题 2', en: 'Heading 2' },
  'mdblock.slash.h3': { zh: '标题 3', en: 'Heading 3' },
  'mdblock.slash.h4': { zh: '标题 4', en: 'Heading 4' },
  'mdblock.slash.h5': { zh: '标题 5', en: 'Heading 5' },
  'mdblock.slash.h6': { zh: '标题 6', en: 'Heading 6' },
  'mdblock.slash.ul': { zh: '无序列表', en: 'Bulleted list' },
  'mdblock.slash.ol': { zh: '有序列表', en: 'Numbered list' },
  'mdblock.slash.todo': { zh: '待办', en: 'To-do list' },
  'mdblock.slash.card': { zh: '卡片', en: 'Card' },
  'mdblock.slash.quote': { zh: '引用', en: 'Quote' },
  'mdblock.slash.fold': { zh: '折叠', en: 'Toggle' },
  'mdblock.slash.code': { zh: '代码块', en: 'Code block' },
  'mdblock.slash.table': { zh: '表格', en: 'Table' },
  'mdblock.slash.divider': { zh: '分割线', en: 'Divider' },
  'mdblock.slash.math': { zh: '数学公式', en: 'Equation' },
  'mdblock.slash.wikilink': { zh: '链接笔记', en: 'Link to note' },
  'mdblock.slash.image': { zh: '图片', en: 'Image' },
  'mdblock.slash.columns': { zh: '分栏', en: 'Columns' },
  'mdblock.slash.page': { zh: '页面', en: 'Page' },
  'mdblock.slash.database': { zh: '数据库', en: 'Database' },
  'mdblock.slash.drawing': { zh: '画板', en: 'Drawing' },
  'mdblock.slash.linkdb': { zh: '链接数据库', en: 'Link database' },
  'mdblock.slash.noteview': { zh: '笔记视图', en: 'Note view' },
  'mdblock.slash.template': { zh: '模板', en: 'Template' },
  'mdblock.slash.embed': { zh: '嵌入块引用', en: 'Embed block' },
  'mdblock.slash.bookmark': { zh: '书签', en: 'Bookmark' },
  'mdblock.slash.button': { zh: '按钮', en: 'Button' },
  // 弹框(askString)
  'mdblock.link.title': { zh: '插入链接', en: 'Insert link' },
  'mdblock.link.label': { zh: '输入或粘贴地址(裸域名会自动补 https://)', en: 'Type or paste an address (a bare domain gets https:// added)' },
  'mdblock.bookmark.title': { zh: '插入书签', en: 'Insert bookmark' },
  'mdblock.bookmark.label': { zh: '粘贴链接地址(https:// 开头);YouTube 链接会直接内嵌播放器。', en: 'Paste a link (starting with https://); a YouTube link embeds the player directly.' },
  'mdblock.embed.title': { zh: '嵌入块引用', en: 'Embed a block reference' },
  'mdblock.embed.label': { zh: '形如 笔记名#块ID(块菜单「复制嵌入引用」可得);也可只填笔记名嵌整篇首块。', en: 'Shaped like note-name#block-id (the block menu’s “Copy embed reference” gives you one); a note name alone embeds that note’s first block.' },
  'mdblock.embed.confirm': { zh: '嵌入', en: 'Embed' },
  // 提示条
  'mdblock.toast.staleTarget': { zh: '文件已创建，但原插入位置已失效（笔记已切换或块已删除）', en: 'The file was created, but the original insert position is gone (the note changed or the block was deleted)' },
  'mdblock.toast.slashFailed': { zh: '「{label}」失败：{message}', en: '“{label}” failed: {message}' },
  'mdblock.plugin.runNotString': { zh: 'run() 必须返回字符串,实际是 {type}', en: 'run() must return a string, but it returned {type}' },
  'mdblock.plugin.runTooLong': { zh: 'run() 返回内容过长', en: 'run() returned too much content' },
  'mdblock.plugin.runControlChars': { zh: 'run() 返回内容含控制字符', en: 'run() returned content containing control characters' },
  // 「粘贴为」菜单
  'mdblock.pasteAs.title': { zh: '粘贴为', en: 'Paste as' },
  'mdblock.pasteAs.link': { zh: '链接', en: 'Link' },
  'mdblock.pasteAs.bookmark': { zh: '书签卡', en: 'Bookmark card' },
  'mdblock.pasteAs.bookmarkHint': { zh: '默认', en: 'Default' },
  'mdblock.pasteAs.embed': { zh: '内嵌', en: 'Embed' },
  'mdblock.pasteAs.embedHint': { zh: '播放器 / 网页', en: 'Player / web page' },
  // 菜单空态与脚注
  'mdblock.menu.noMatch': { zh: '无匹配项', en: 'No matches' },
  'mdblock.menu.noDatabase': { zh: '库里还没有数据库(用 /数据库 新建一个)', en: 'No databases in this vault yet (create one with /database)' },
  'mdblock.foot.select': { zh: '↑↓ 选择', en: '↑↓ Select' },
  'mdblock.foot.confirm': { zh: '↵ 确认', en: '↵ Confirm' },
  'mdblock.foot.insert': { zh: '↵ 插入', en: '↵ Insert' },
  'mdblock.foot.embed': { zh: '↵ 嵌入', en: '↵ Embed' },
  'mdblock.foot.close': { zh: 'esc 关闭', en: 'esc Close' },
})

/** 画板/导图文件名:`画板 2026-07-16 15.04.05`,时间戳格式照 Obsidian Excalidraw 插件。
 *  时间戳同时兜住 saveAttachment 的撞名 -N —— 它把后缀插在**最后**一个扩展名前
 *  (`x.excalidraw.md` → `x.excalidraw-1.md`),而这两种文件全靠复合后缀被挡在笔记之外。 */
export function stampedFileName(kind: string): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${kind} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

/** 序列化输出 → 落盘 md 的统一规范化(**唯一入口,勿分叉**):
 *  新打的 [[链接]] 在重解析成 wikilink 节点前仍是纯文本,remark 会转义成 \[\[(索引抽不到,双链失联);
 *  math 纯文本的 _ * { } 被转义(x_i→x\_i);`> [!note]-` 的 `[` 被转义 Obsidian 不认;空段落落成 <br />。
 *  markdownUpdated 监听器与 UnifiedPage.serializeNow(flush 前同步快照)都必须走这里 ——
 *  Codex 终审 P0:serializeNow 曾绕过本链,快打字后立刻改名会把 \[\[ 持久化成死链。 */
export function normalizeSerializedMd(markdown: string): string {
  return stripEmptyLineBr(unescapeCalloutToken(unescapeMathSource(normalizeUrlLiterals(unescapeWikiOutsideFences(markdown)))))
}
// Sentinel slash scaffold: insert a cross-note embed cell from a copied `![[ ]]` ref.
const EMBED_SENTINEL = '\u0000__amadeus_embed__'
const LINKDB_SENTINEL = '\u0000__amadeus_linkdb__'
const BOOKMARK_SENTINEL = '\u0000__amadeus_bookmark__'
// 同族 sentinel：模板选择 / 图片选取 / 分栏（触发动作，不插入文本，\u0000 开头保证不与真实文本撞车）。
const TEMPLATE_SENTINEL = '\u0000__amadeus_template__'
const IMAGE_SENTINEL = '\u0000__amadeus_image__'
const COLUMN_SENTINEL = '\u0000__amadeus_column__'
const DATABASE_SENTINEL = '\u0000__amadeus_database__'
const DRAWING_SENTINEL = '\u0000__amadeus_drawing__'
const CARD_SENTINEL = '\u0000__amadeus_card__'

const NOTEVIEW_SENTINEL = ' __amadeus_noteview__'

// Notion /page:在当前笔记的 .fd 子文件夹里新建子页面(触发动作,同族 sentinel)。
const PAGE_SENTINEL = ' __amadeus_page__'

interface BlockKeys {
  insertAfter(content?: string): void
  deleteEmpty(): void
  mergePrev(): void
  arrow(dir: 'prev' | 'next', goalX?: number): void
  moveDir(dir: 'up' | 'down'): void
  /** 请求把焦点送回**本块**(改动导致整块重挂后用它把光标要回来)。 */
  selfFocus(place: FocusPlace): void
}

/** slash 选中后由外部(applySlash)驱动编辑器的两个操作(单事务、直接改文档,不经 store)。 */
export interface SlashOps {
  /** 删掉光标前触发用的 '/';返回删后块是否为空。 */
  consume(): boolean
  /** 删 '/' 并把当前块原地转换为前缀类型(光标原位、无重挂载)。 */
  transform(trig: Trigger): void
}

/** 占位提示只在「聚焦中的空块」显示(Notion 同款;此前所有空块齐刷刷提示,实报扰视)。
 *  焦点态经 focus/blur 事务写进插件 state —— decorations(state) 拿不到 view,不能直接问 hasFocus。 */
// text 取**函数**而非字符串:编辑器只建一次,字面量会把占位文案冻在建实例那一刻,
// 切语言后空块仍显示旧语言(装饰是每次 state 变化现算的,现取即可跟上)。
function placeholderPlugin(text: () => string) {
  const key = new PluginKey<boolean>('amx-placeholder-focus')
  return $prose(
    () =>
      new Plugin({
        key,
        state: {
          init: () => false,
          apply: (tr, v) => {
            const m = tr.getMeta(key) as boolean | undefined
            return m === undefined ? v : m
          },
        },
        view: (view) => {
          const onFocus = (): void => {
            if (!key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, true))
          }
          const onBlur = (): void => {
            if (key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, false))
          }
          view.dom.addEventListener('focus', onFocus)
          view.dom.addEventListener('blur', onBlur)
          // 新建块 autoFocus 可能先于本插件视图挂载:补一拍初始态
          queueMicrotask(() => {
            if (!view.isDestroyed && view.hasFocus()) onFocus()
          })
          return {
            destroy() {
              view.dom.removeEventListener('focus', onFocus)
              view.dom.removeEventListener('blur', onBlur)
            },
          }
        },
        props: {
          decorations(state) {
            if (!key.getState(state)) return null // 未聚焦:空块保持全空白
            const { doc } = state
            const empty =
              doc.childCount === 1 && !!doc.firstChild?.isTextblock && doc.firstChild.content.size === 0
            if (!empty || !doc.firstChild) return null
            return DecorationSet.create(doc, [
              Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-empty', 'data-placeholder': text() }),
            ])
          },
        },
      }),
  )
}

function imageFromTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null
  for (const f of Array.from(dt.files)) if (f.type.startsWith('image/')) return f
  return null
}

// 光标是否在本块「首/末视觉行」——决定 ↑↓ 该在块内移行还是跳去邻块。
// 不用 view.endOfTextblock('up'/'down'):Chromium ≥150 起它在多行文本块中段就返回 true(实测:
// Electron 40=Chromium140 正常,网页端 Chrome 150 失灵),导致 ↑↓ 无法在块内上下行、只会跳块。
// 改测光标 rect 对块自身逐行 rect——与浏览器版本/缩放无关;测不到时退回 endOfTextblock(旧行为)。
// 判据:光标行带 vs **块内首/末位置的光标行带**(coordsAtPos(1) / coordsAtPos(size-1))。
//
// ⚠️ 别再改回「量 DOM 元素矩形」那一路(selectNodeContents(view.dom).getClientRects())。
//   栽过三次,原因是同一件事:**行内元素的盒子不等于行**。一条含 KaTeX 公式的单行,
//   getClientRects() 会炸出十几个子盒(strut 1px×0、各层 vlist 13~17px 高),它们的 bottom
//   都落在光标上沿之上 —— 无论按 min-top 比、还是按「有没有盒子在我上面」问、还是按高度滤碎片,
//   都会把单行块判成「上面还有一行」,于是 ↑ 既不出块、块内又无处可去,光标困死在这一行
//   (用户实报「特殊行上不去」;探针 scripts/arrow-trap.check.cjs 逐格实测)。
//   coordsAtPos 返回的是**光标位置的行带**,天生只描述行、不受行内元素高度影响。
//   也不用 view.endOfTextblock:Chromium ≥150 起它在多行文本块中段就返回 true(取不到坐标时才回退它)。
function atBlockEdge(view: EditorView, dir: 'up' | 'down'): boolean {
  const caret = caretBand(view)
  if (!caret) return view.endOfTextblock(dir)
  // 参照点用 Selection.atStart/atEnd 解出来的**文本位置**,不是裸的 1 / size-1。
  // ⚠️ 表格(以及任何「顶层节点不是 textblock」的结构)上,裸位置落在表格结构边界而不是单元格文本里,
  //   coordsAtPos 会返回结构矩形 —— 光标在中间行时上下都判成「还有别的行」,↑↓ 双向困死在表格里
  //   (Codex 评审提出怀疑,scripts/arrow-trap.check.cjs 的「表格块」用例实测坐实)。
  let edge: { top: number; bottom: number }
  try {
    const ref = dir === 'up' ? Selection.atStart(view.state.doc).from : Selection.atEnd(view.state.doc).to
    edge = view.coordsAtPos(ref)
  } catch {
    return view.endOfTextblock(dir)
  }
  const tol = Math.max(4, (caret.bottom - caret.top) * 0.5)
  return dir === 'up' ? caret.top <= edge.top + tol : caret.bottom >= edge.bottom - tol
}

/** 当前光标的**行带**(视口 top/bottom)。取不到回 null。 */
function caretBand(view: EditorView): { top: number; bottom: number } | null {
  const domSel = (view.dom.ownerDocument.defaultView ?? window).getSelection()
  if (!domSel || domSel.rangeCount === 0) return null
  const range = domSel.getRangeAt(0)
  let r: DOMRect | undefined = range.getBoundingClientRect()
  if (!r.height) r = range.getClientRects()[0]
  if (!r?.height) {
    try {
      const c = view.coordsAtPos(view.state.selection.head)
      return { top: c.top, bottom: c.bottom }
    } catch {
      return null
    }
  }
  return { top: r.top, bottom: r.bottom }
}

/** 当前光标的视口 X(goal column)——跨块 ↑↓ 时带给邻块,落点保持同一水平列(标准编辑器行为)。 */
function caretClientX(view: EditorView): number | undefined {
  const sel = (view.dom.ownerDocument.defaultView ?? window).getSelection()
  if (!sel || sel.rangeCount === 0) return undefined
  const range = sel.getRangeAt(0)
  let r = range.getBoundingClientRect()
  if (!r.height) { const rs = range.getClientRects(); if (rs.length) r = rs[0] }
  return r.left
}

/** 视口点 → DOM 命中点。caretRangeFromPoint(Blink,Chrome 150 实测可靠)优先,caretPositionFromPoint 作标准回退。
 *  刻意本地声明这两个方法(而非用 lib.dom 的 deprecated 签名),避开弃用告警且明确 Chromium-only 用法。 */
function caretNodeAtPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & {
    caretRangeFromPoint?(x: number, y: number): Range | null
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
  }
  const range = d.caretRangeFromPoint?.(x, y)
  if (range) return { node: range.startContainer, offset: range.startOffset }
  const pos = d.caretPositionFromPoint?.(x, y)
  return pos ? { node: pos.offsetNode, offset: pos.offset } : null
}

/** 把光标落在本块「首/末视觉行」上最接近 goalX 的位置(跨块进入时用)。
 *  目标点 = 内容盒的顶/底边内一点(首/末行)× 夹进盒内的 goalX;命中点 posAtDOM 转 PM 位置
 *  (不依赖失灵的 endOfTextblock);测不到退回行首/尾。 */
function posAtGoalX(view: EditorView, place: FocusPlace, goalX: number): number | null {
  const box = view.dom.getBoundingClientRect()
  const x = Math.min(Math.max(goalX, box.left + 2), box.right - 2)
  const y = place === 'end' ? box.bottom - 4 : box.top + 4
  const hit = caretNodeAtPoint(view.dom.ownerDocument, x, y)
  if (!hit || !view.dom.contains(hit.node)) return null
  try {
    return view.posAtDOM(hit.node, hit.offset)
  } catch {
    return null
  }
}

// export:UnifiedPage(v4 统一实例)复用整套插件栈;此前仅 MarkdownBlock/PlainMarkdownEditor 两个同文件宿主。
export function MilkdownInner({
  initial,
  onChange,
  keys,
  saveImage,
  saveFiles,
  onOpenWiki,
  getPageNames,
  getFiles,
  isWikiResolved,
  wikiIcon,
  focusPlace,
  focusGoalX,
  focusAnchor,
  onFocused,
  blockId,
  slashOpsRef,
  onSlashPick,
  readOnly = false,
  unified = false,
  extraPlugins,
}: {
  initial: string
  onChange: (md: string) => void
  keys: BlockKeys
  saveImage: (file: File) => Promise<string | null>
  saveFiles: (files: File[]) => Promise<void>
  onOpenWiki: (name: string) => void
  getPageNames: () => string[]
  /** vault 非笔记文件([[补全的文件候选);缺 = 只补全页面。 */
  getFiles?: () => string[]
  /** [[链接]] 是否解析得到(未解析 → 黯淡渲染);缺省恒 true(整篇宿主等无 vault 场景照旧)。 */
  isWikiResolved?: (name: string) => boolean
  /** [[链接]] 目标笔记的 emoji 图标(渲染在链接文字前);缺省无图标。 */
  wikiIcon?: (name: string) => string | undefined
  focusPlace: FocusPlace | null
  /** 跨块 ↑↓ 进入时的目标水平列(视口 X);有则落在首/末行的该列,无则落行首/尾。 */
  focusGoalX?: number
  /** 源码模式切回时带来的「光标前文本」:块内按它找回落点(见 lib/modeCursor)。 */
  focusAnchor?: string
  onFocused: () => void
  /** 块身份;缺 = 整篇宿主 PlainMarkdownEditor(走自带 history、不接块选中)。 */
  blockId?: string
  /** slash 选中时由外部(MarkdownBlock)驱动编辑器:消费触发 '/' / 原地转换(单事务,见 blockTriggers)。 */
  slashOpsRef?: { current: SlashOps | null }
  /** slash 菜单选中项的处理(= MarkdownBlock.applySlash);缺 = 不启用 slash(整篇宿主)。 */
  onSlashPick?: (it: SlashItem) => void
  readOnly?: boolean
  /** v4 统一实例模式(UnifiedPage):不挂 softBreakRemark(标准 md 分段落盘),Enter/Shift+Enter/
   *  方向键出块/块重排全部放行 PM 原生 —— 整篇一个实例,没有「邻块」可跳。 */
  unified?: boolean
  /** 宿主追加的 Milkdown 插件(UnifiedPage 的块交互层等)。⚠️ 须传稳定引用:编辑器只建一次。 */
  extraPlugins?: MilkdownPlugin[]
}) {
  const ready = useRef(false)
  const keysRef = useRef(keys)
  keysRef.current = keys
  const saveImageRef = useRef(saveImage)
  saveImageRef.current = saveImage
  const saveFilesRef = useRef(saveFiles)
  saveFilesRef.current = saveFiles
  const wikiRef = useRef(onOpenWiki)
  wikiRef.current = onOpenWiki
  const resolvedRef = useRef<(n: string) => boolean>(() => true)
  resolvedRef.current = isWikiResolved ?? (() => true)
  const iconRef = useRef<(n: string) => string | undefined>(() => undefined)
  iconRef.current = wikiIcon ?? (() => undefined)
  const [wiki, setWiki] = useState<WikiQuery | null>(null)
  const [mention, setMention] = useState<WikiQuery | null>(null) // "@" 提及页面
  const [slash, setSlash] = useState<WikiQuery | null>(null) // "/" 命令菜单(query 驻留文档,同 @/[[)
  const [toolbar, setToolbar] = useState<SelRect | null>(null) // 选中文字上浮的格式工具栏
  const [pasteAs, setPasteAs] = useState<PasteAs | null>(null) // 粘贴链接后的「粘贴为」菜单
  // Esc 闩锁:记住被关掉的那个 '@' / '/' 锚点,同锚点不再弹(否则下一击键 plugin 又 report → 关不掉)。
  const mentionDismissedFrom = useRef<number | null>(null)
  const slashDismissedFrom = useRef<number | null>(null)
  // handleKeyDown 闭包只建一次读不到 state → 用 ref 镜像弹窗开启态,供 '/' 分支避让。
  const wikiOpenRef = useRef(false)
  const mentionOpenRef = useRef(false)
  const [loading, getInstance] = useInstance()
  const ps = useScopedPageStore() // 本面板那份文档 store(撤销/重做、库存订阅都必须对着自己那篇)

  /** 用 Milkdown 自己的序列化器把任意节点转成 markdown(自定义 mark / 待办 attrs 一并认)。 */
  const serialize = (node: ProseNode): string => {
    let out = ''
    getInstance()?.action((ctx) => { out = ctx.get(serializerCtx)(node) })
    // stripEmptyLineBr:空段落别落成 `<br />`(切块切出的那半段常以空段落打头,否则新块开头凭空多一个)
    return stripEmptyLineBr(unescapeCalloutToken(out)) // 切块切出来的那半段也可能带 callout 令牌
  }

  // 插件编辑器扩展(ctx.registerEditorExtension)的注册表代次。变了 = 有插件被启用/停用,
  // 已建好的编辑器带着旧扩展集合,必须重建才能跟上 —— 塞进 useEditor 的 deps 即可(milkdown 会
  // destroy 旧实例再建新的)。代次不变时与原来的空 deps 行为完全一致。
  // 时机注意:插件启停发生在设置界面,那会儿没人在笔记里打字(200ms 的保存 debounce 早已落盘)。
  const extGen = useSyncExternalStore(subscribeEditorExtensions, editorExtensionGen)

  useEditor((root) => {
    const handleKeyDown = (view: EditorView, event: KeyboardEvent): boolean => {
      const { state } = view
      const sel = state.selection

      // 文档级撤销/重做:页内块(有 blockId)一律交给 pageStore 统一历史 —— 覆盖跨块的增删/合并/
      // 移动/斜杠转换,不再是各块各自的 ProseMirror 历史(碎片化 + 顺序错乱)。stopPropagation 防
      // PageView 兜底监听重复触发。整篇宿主 PlainMarkdownEditor 无 blockId → 走自带 history。
      const undoKey = event.key.toLowerCase() // Cmd+Shift+Z 时 event.key='Z',须大小写不敏感
      if (blockId && (event.metaKey || event.ctrlKey) && (undoKey === 'z' || undoKey === 'y')) {
        event.preventDefault()
        event.stopPropagation()
        const st = ps.getState()
        if (undoKey === 'y' || event.shiftKey) st.redo()
        else st.undo()
        return true
      }

      // 块级 markdown 触发:行首触发符(#{1,6} / - * + / 1. / > / [])+ 空格 → 单事务
      // 「删触发符 + 原地转换」(blockTriggers.ts)。preventDefault 抢在 Milkdown 内置 input rules
      // 前 —— 内置标题规则是「叠加」(h1 打 ## 变 h3),列表/引用规则在标题节点里根本不触发。
      // 统一 Notion 语义:# 设级别(同级幂等)、标题上 -/1./> 先降段落再转、[] 直接成待办。
      if (event.key === ' ' && sel.empty && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const trig = matchTrigger(textBeforeCursor(sel.$from))
        if (trig && applyTrigger(view, trig, { from: sel.$from.start(), to: sel.$from.pos })) {
          event.preventDefault()
          return true
        }
      }

      if (event.key === 'Enter') {
        if (event.shiftKey) {
          // unified:放行 PM 原生 = 段内硬换行(Notion 语义);块世界才是「切块」。
          if (unified) return false
          // 切块,不是「新建空块」:光标后还有内容就把它切到新块去,只有在块尾才是新建空块。
          // splitTail 返回 null = 已在块尾(或结构切不动)→ 退回旧行为。
          keysRef.current.insertAfter(splitTail(view, serialize) ?? undefined)
          return true
        }
        return false
      }
      // 标题/列表/待办/引用的 Markdown 标记在 PM 中是节点属性，不是真字符。光标位于正文行首时，
      // ← 进入可编辑源码；Backspace 进入后只删一个字符（通常先删渲染所需的尾随空格）。
      // 这条必须排在 unified/keyboard 的整块降级/列表脱壳之前，才不会再把 `### ` / `- [ ] `
      // 当成一个不可进入的原子。
      const bareHorizontal = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      // 裸方向键/退格都先交给结构源码入口自己判定 DOM 行首。原生 Home/← 刚移动完时，
      // 浏览器选区可能已经在行首、EditorState 还落后一拍；在这里先看旧 sel 会把第一键吞掉。
      if (bareHorizontal) {
        if (event.key === 'ArrowLeft' && focusStructuralPrefix(view)) {
          event.preventDefault()
          return true
        }
        if (event.key === 'Backspace' && focusStructuralPrefix(view, true)) {
          event.preventDefault()
          return true
        }
      }
      if (event.key === 'Backspace') {
        // v4 统一实例的退格全部归 unified/keyboard.ts 的 backspaceKeymap(三段阶梯 + callout + 列表脱壳
        // + 前块整块型只选中)。这里的块世界实现只在 v3 生效,两套并存会互相打架。
        if (unified) return false
        if (!sel.empty) return false
        if (sel.$head.pos !== Selection.atStart(state.doc).$head.pos) return false
        // 行首退格:非空标题先降级为段落(Notion 式)。这也解开「在标题开头堆了字面 '#' 号后,
        // 段落级 markdown 输入规则(列表/引用/标题)在标题节点里不触发」的卡死 —— 回到段落即恢复。
        const parent = sel.$head.parent
        const paraType = state.schema.nodes.paragraph
        if (parent.type.name === 'heading' && parent.content.size > 0 && paraType) {
          // ⚠️ 用 applyTrigger 而不是自己 dispatch setBlockType:后者改完编辑器会被整个重建,
          //   焦点掉回 body —— 于是「行首退格」在标题块上只生效一次(标题降成正文),之后再怎么按
          //   都毫无反应,永远并不进上一块(用户实报「在一个块的开头无法删除进入上一个块」;
          //   探针 scripts/backspace-merge.check.cjs 逐次实测 activeElement=BODY)。
          //   applyTrigger 是本文件既定的「原地转换、光标原位、无重挂载」通道(与空格触发符/斜杠菜单同源)。
          // 这一步只改节点类型,焦点本该原地不动。曾经「降完级焦点掉回 body、第二次退格再无反应」
          // 并不在这里 —— 病在 PageView 的折叠外壳会随「这一行还是不是标题」变换元素类型,导致
          // React 卸载重建整棵子树(连编辑器一起)。见 PageView 里 .amx-hfold-wrap 的告警。
          // 仪器:npm run check:bsfocus
          view.dispatch(state.tr.setBlockType(sel.$head.start(), sel.$head.end(), paraType))
          return true
        }
        // 行首退格:先脱掉列表/引用外壳(Notion 语义),脱完才轮到「与上一块合并」。
        // 不这么做,首块的 `- [ ] x` 会走 mergePrev —— 而首块没有上一块,于是那个 checkbox
        // **永远删不掉**(用户实报);非首块则是「还没去掉待办就整块并进上面」,同样不对。
        if (unwrapAtStart(view)) return true
        if (state.doc.textContent.trim() === '') keysRef.current.deleteEmpty()
        else keysRef.current.mergePrev()
        return true
      }
      if (event.key === 'ArrowUp') {
        if (unified) return false // 整篇一实例:无邻块可跳/可重排,全放行原生
        if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
          keysRef.current.moveDir('up')
          return true
        }
        // sel.empty 守卫:有选区时裸 ↑ 让 ProseMirror 原生把选区折叠到块内(否则多行选区的 bbox 顶=首行→误判出块跳走)。
        if (sel.empty && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && atBlockEdge(view, 'up')) {
          keysRef.current.arrow('prev', caretClientX(view))
          return true
        }
        return false
      }
      if (event.key === 'ArrowDown') {
        if (unified) return false
        if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
          keysRef.current.moveDir('down')
          return true
        }
        if (sel.empty && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && atBlockEdge(view, 'down')) {
          keysRef.current.arrow('next', caretClientX(view))
          return true
        }
        return false
      }
      if (event.key === 'Escape') {
        // [[ / @ / 斜杠等浮层开着时它们的捕获监听先吃掉 Esc,到得了这里 = 无浮层 → 选中本块(Notion 式)
        if (!blockId) return false
        ;(view.dom as HTMLElement).blur()
        useBlockSelection.getState().select(blockId)
        return true
      }
      // '/' 命令菜单不再由 keydown 接管 —— 改由 slashSuggestPlugin 从文档读 query 触发
      // (query 驻留文档、字符不被吞、空格自动关成字面文本;见 wikiAutocomplete.slashSuggestPlugin)。
      return false
    }

    /**
     * 复制:选区**恰好盖住整个文本块**且该块不是普通段落 → 连行结构一起序列化成 markdown
     * (`- [ ] x` / `## x` / `> x`);只选了半行几个字 → 照旧纯文本。
     *
     * 为什么必须自己写:待办的 checkbox 是 CSS ::before,**根本不在文档里**,默认的纯文本复制
     * 只拿得到文字(用户实报「check box 无法被复制」);而 plugin-clipboard 自带的那个把
     * 「ul>li>p>text」这种单链也判成 isPureText,同样退化成纯文本 —— 单行待办正好落进它的盲区。
     */
    const clipboardTextSerializer = (slice: Slice, view: EditorView): string => {
      const plain = (): string => slice.content.textBetween(0, slice.content.size, '\n')
      // 整张图片被选中(NodeSelection)→ 纯文本 flavor 给字面 markdown。默认的 textBetween 对
      // image 这种无文本叶子返回**空串**:编辑器内粘贴靠 text/html 没事,复制到聊天框/别的编辑器
      // 却是一片空白。`![[…]]` 那条形态本来就是文本、一直给字面源码,两边口径得一致。
      // 路径取 vault 相对(fromAssetUrl 的原样),与 `![[base]]` 一样是「库里找得到」的口径;
      // ⚠️ 天花板:贴回子目录笔记时页相对解析可能不同,库内粘贴走的是 text/html 不受影响。
      const only = slice.content.childCount === 1 ? slice.content.firstChild : null
      if (only?.type.name === 'image') {
        const src = String(only.attrs.src ?? '')
        return `![${String(only.attrs.alt ?? '')}](${fromAssetUrl(src) ?? src})`
      }
      const { $from, $to } = view.state.selection
      const whole = $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size
      if (!whole) return plain()
      // 只看 firstChild 不够:「从一个段落一直选到下面的待办」时首块是段落,会退回纯文本、
      // 把后面那条的 `- [ ]` 丢掉(Codex 复审)。只要**任意一个**顶层块不是普通段落就走 markdown。
      let structured = false
      slice.content.forEach((n) => { if (n.type.name !== 'paragraph') structured = true })
      if (!structured) return plain()
      const doc = view.state.schema.topNodeType.createAndFill(undefined, slice.content)
      if (!doc) return plain()
      // 复制分栏内容(v4 unified)时剥锚注释行:锚脱离本文件的 amadeus_layout 就是散标记,
      // 贴到别处只会污染目标(规范:锚随文件,不随剪贴板)。v3 编辑器内永远不出现标记,零影响。
      // ⚠️ `\/?` 不能省:2026-08-19 画布卡改成 `<!-- a k -->…<!-- /a k -->` 双标记包裹之后,
      //    这里只剥开标记 → 复制一张卡,末尾必跟一行 `<!-- /a xxxx -->` 贴到微信/浏览器里
      //    (用户 2026-08-20 实报)。两种形态见 shared/amadeus/compiler/markers.ts。
      // ⚠️ 只在切片里**真的有**卡/分栏节点时才剥(Codex 2026-08-20):锚是那两种节点的序列化器
      //    现生成的,别的切片里一行都不会有;而「收回卡片」留下的惰性锚是**合法正文字面**
      //    (compiler 明说不回收),无差别正则会把用户自己的那一行连同标题/列表一起悄悄吞掉。
      let structural = false
      doc.descendants((n) => {
        if (/^amadeusCanvasCard$|^amadeusColumn/.test(n.type.name)) structural = true
        return !structural
      })
      let out = serialize(doc)
      if (structural) out = out.replace(/^<!--\s*\/?a\s+[A-Za-z0-9_-]+\s*-->[ \t]*\n?/gm, '')
      // entitiesToTabs:缩进段落序列化出的 &#9; 归一成字面制表符,外部应用不见实体垃圾(评审 P2)。
      const md = entitiesToTabs(out)
      return md.trim() || plain()
    }

    const insertImage = async (view: EditorView, file: File): Promise<void> => {
      const url = await saveImageRef.current(file)
      if (!url) return
      const imageType = view.state.schema.nodes.image
      if (!imageType) return
      view.dispatch(view.state.tr.replaceSelectionWith(imageType.create({ src: url })).scrollIntoView())
    }
    const handlePaste = (view: EditorView, event: ClipboardEvent): boolean => {
      // 选中文字上粘一个 URL → 给这段文字**加链接**,而不是拿地址覆盖掉它(AFFiNE/Notion 同款,
      // 也是最常用的一条粘贴手感)。判据从严:单块内的非空选区 + 剪贴板正好是一条不含空白的地址。
      const sel = view.state.selection
      const raw = (event.clipboardData?.getData('text/plain') ?? '').trim()
      const linkMark = view.state.schema.marks.link
      // ⚠️ 父节点必须收得下 link mark:代码块的 `marks: ""` 会让 addMark 静默 no-op ——
      //    而 preventDefault 已经把默认粘贴吃掉了,结果是「链接没加上、原文也没粘进去」。
      if (
        linkMark && !sel.empty && sel.$from.sameParent(sel.$to) &&
        sel.$from.parent.type.allowsMarkType(linkMark) &&
        raw && !/\s/.test(raw) && /^https?:\/\//i.test(raw)
      ) {
        const href = normalizeHref(raw)
        if (href) {
          event.preventDefault()
          view.dispatch(view.state.tr.addMark(sel.from, sel.to, linkMark.create({ href })))
          return true
        }
      }
      const file = imageFromTransfer(event.clipboardData)
      if (file) {
        event.preventDefault()
        void insertImage(view, file)
        return true
      }
      // 非图片文件(PDF/压缩包/音视频…):存为附件 → 独立 ![[base]] 嵌入块(与拖入同形态)。
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length) {
        event.preventDefault()
        void saveFilesRef.current(files)
        return true
      }
      // 空段落里粘一条 URL → **不替用户猜**,原样落成裸 URL 并弹「粘贴为」菜单(AFFiNE 同款)。
      // 忽略菜单 = 维持裸 URL = 书签卡,与 2026-08-29 之前的落地形态逐字一致(零 churn)。
      // ⚠️ 这一支必须排在**图片/附件之后**:浏览器「复制图片」的剪贴板常常同时带一个 image File
      // 和一条来源 URL,先看 text/plain 会把图片粘贴整个吞掉,用户拿到的是链接卡(Codex 2026-08-29)。
      // ⚠️ 自己 insertText 而不是放行默认粘贴:plugin-clipboard 会把这行当 markdown 解析
      // (gfm 的 autolink 会包成链接节点),落点长度就不再是 raw.length,回写坐标当场失准。
      if (
        unified && sel.empty && raw && !/\s/.test(raw) && /^https?:\/\//i.test(raw) &&
        sel.$from.parent.type.name === 'paragraph' && sel.$from.parent.content.size === 0
      ) {
        event.preventDefault()
        const from = sel.from
        const to = from + raw.length
        view.dispatch(view.state.tr.insertText(raw, from, sel.to))
        let coords: { left: number; top: number; bottom: number }
        try {
          // 锚**光标**(粘完光标就在 URL 末尾),不是段首 —— 锚段首时长地址会让菜单离手很远。
          coords = view.coordsAtPos(to)
        } catch {
          return true // 坐标拿不到就只是没菜单,链接已经粘进去了
        }
        setPasteAs({ url: raw, from, to, left: coords.left, top: coords.bottom, anchorTop: coords.top })
        return true
      }
      return false
    }
    // 文件拖入(含图片)统一交给编辑器级附件处理(AmadeusEditorView.onDrop),按笔记设置存放 → 不在块内内联,
    // 故此处不设 handleDrop(ProseMirror 默认对文件拖放不作插入,事件冒泡到编辑器容器被 preventDefault)。

    // 点链接就打开(同 Obsidian 实时预览)。contenteditable 里 Chromium **不会**自己导航,
    // 不接这一手 `[文字](url)` 就只是个蓝字。window.open 会被主进程 setWindowOpenHandler 截住、
    // 回投给渲染层的外链路由(内置浏览器 / 系统浏览器);web 端就是开新页 —— 三端一个写法。
    const handleLinkClick = (_view: EditorView, _pos: number, event: MouseEvent): boolean => {
      const a = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || !a.getAttribute('href')) return false
      const href = normalizeHref(a.getAttribute('href') as string)
      if (!href) return false
      event.preventDefault()
      window.open(href, '_blank', 'noopener')
      return true
    }

    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initial)
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => !readOnly,
          handleKeyDown: readOnly ? undefined : handleKeyDown,
          handlePaste: readOnly ? undefined : handlePaste,
          handleClick: handleLinkClick,
          clipboardTextSerializer,
        }))
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          if (!ready.current || readOnly) return
          onChange(normalizeSerializedMd(markdown))
        })
      })
      // 段落缩进档(Tab):preset 的**原位替换**版(paragraph schema 换扩展、位置不动)。
      // 追加 .use 会把 paragraph 挪到节点序尾部 → heading 成缺省块类型,新块全变 H1(栽过)。
      // 插件编辑器扩展的**高优先级**桶:排在宿主全部插件之前 —— 插件要接管 Tab 这类宿主已占用的键
      // 只能在这儿(ProseMirror 按插件顺序问 handleKeyDown,排在后面永远够不着)。
      // 契约:high 桶的插件不该自己处理的必须返回 false,否则内置行为在它手里静默消失。
      .use(pluginEditorExtensions('high'))
      .use(commonmarkWithIndent)
      .use(gfm)
      // 自定义行内标记:下划线/文字色/背景色(schema mark + remark HTML 桥,见 ./marks)。
      // remark 桥须与 commonmark/gfm 同在,故紧随其后注册。
      .use(inlineHtmlMarksRemark)
      // 块内换行 = 单个 '\n'(Obsidian 语义),不再「空行分段」。必须晚于 inlineHtmlMarksRemark:
      // 折叠先跑完,跨行的 <u>…</u> 才不会被拆段撕成开合分家的两半(见 softBreak.ts 注释)。
      // unified(v4)不挂 softBreakRemark:标准 md 分段落盘,软换行由 Milkdown 原生 break 节点原样往返。
      // 换 blankLineRemark —— 只补读侧的「空行 → 空段落」还原(写侧本来就落成空行,见 softBreak.ts 顶注)。
      .use(unified ? blankLineRemark : softBreakRemark)
      .use(underlineSchema)
      .use(colorSchema)
      .use(bgSchema)
      .use(toggleUnderlineCommand)
      .use(applyColorCommand)
      .use(applyBgCommand)
      .use(mathLivePreviewPlugin()) // 公式=纯文本+装饰渲染(不再用 plugin-math 原子节点),离行才渲染、在行可编辑
      .use(history)
      .use(listener)
      .use(placeholderPlugin(() => translate('mdblock.placeholder')))
      .use(structuralSourcePlugin()) // 当前标题行显示可编辑井号；列表/待办/引用从行首按需进入源码
      .use(wikilinkPlugin((name) => wikiRef.current(name), (name) => resolvedRef.current(name), (name) => iconRef.current(name)))
      .use(mdImagePlugin()) // `![](path)` 图片(粘贴/上传形态)= 可选中 + 右缘缩放把手,与 `![[x|200]]` 同手感
      .use(wikiSuggestPlugin((q) => { wikiOpenRef.current = !!q; setWiki(q) }))
      .use(mentionSuggestPlugin((q) => {
        if (!q) {
          mentionDismissedFrom.current = null
          mentionOpenRef.current = false
          setMention(null)
          return
        }
        if (mentionDismissedFrom.current === q.from) { mentionOpenRef.current = false; return }
        mentionOpenRef.current = true
        setMention(q)
      }))
      // '/' 命令菜单:query 驻留文档(同 @/[[),字符不被吞、空格自动关成字面文本。注册在
      // wiki/mention 之后 —— 好让它们的 *OpenRef 已就绪,slash 在它们开着时让位(避免叠开两个菜单)。
      .use(slashSuggestPlugin((q) => {
        if (!slashOpsRef) return // 整篇宿主(PlainMarkdownEditor)不启用 slash,'/' 恒字面
        // 触发真的没了(无 '/' 或 query 非法)→ 清 Esc 闩锁 + 关菜单。
        if (!q) { slashDismissedFrom.current = null; setSlash(null); return }
        // 让位([[ / @ 弹窗开着):只藏菜单,**绝不动闩锁** —— slash 触发其实还在,若在此清闩,
        // 用户「'/' → Esc → 打 [[ → 退格」会让被 Esc 掉的同一个 '/' 重新弹出(Codex 实现审查)。
        if (wikiOpenRef.current || mentionOpenRef.current) { setSlash(null); return }
        if (slashDismissedFrom.current === q.from) { setSlash(null); return } // Esc 关掉的同一个 '/' 不再弹
        setSlash(q)
      }))
      // 非空选区 → 上浮格式工具栏(整篇宿主 PlainMarkdownEditor 无 slashOpsRef,不启用)。
      .use(selectionToolbarPlugin((r) => setToolbar(slashOpsRef ? r : null)))
      // 复制/粘贴走 markdown:选中一行待办复制出来才是 `- [ ] x`(checkbox 是 CSS ::before,
      // 不在文档里,默认的纯文本复制只拿得到文字 —— 用户实报「check box 无法被复制」)。
      // 顺带粘贴 markdown 文本会被解析成真结构(同 Obsidian)。本块自己的 handlePaste(图片/附件)
      // 在 editorViewOptionsCtx 上,ProseMirror 先问直接 props 再问插件,故仍然优先。
      .use(clipboard)
      .use(taskCheckboxPlugin())
      .use(calloutPlugin())
      .use(codeBlockPlugin()) // 语法高亮 + 语言/复制/折行工具条(lowlight,base.css .hljs-* 配色)
      // 行内格式键位补齐(AFFiNE 六件套):预设只给了 Mod-B / Mod-I / Mod-E 与 Mod-Alt-X,
      // 下划线(自有 mark)、Mod-Shift-S 删除线、Mod-K 链接三个一直没有键位。
      // Mod-K 走与工具栏 🔗 完全同一条 editLink(选区已是链接=直接摘掉,空选区不弹框)。
      .use($prose((c) =>
        keymap({
          'Mod-u': () => { c.get(commandsCtx).call(toggleUnderlineCommand.key); return true },
          'Mod-Shift-s': () => { c.get(commandsCtx).call(toggleStrikethroughCommand.key); return true },
          'Mod-k': () => { editLink(); return true },
          'Mod-l': (state, dispatch) => setTextAlignment(state, dispatch, 'left'),
          'Mod-e': (state, dispatch) => setTextAlignment(state, dispatch, 'center'),
          'Mod-r': (state, dispatch) => setTextAlignment(state, dispatch, 'right'),
        }),
      ))
      // Tab 缩进(与 v4 blockLayer 共用 tabIndent.ts 的同一份阶梯):列表 sink/lift、代码块两空格、
      // 段落并入前列表/自转 bullet、表格让位 gfm 跳格、其余吞键防焦点逃逸 —— v3 此前段落里按 Tab
      // 会直接把焦点抛出编辑器(用户实报「没做缩进」)。unified 让位:v4 由 blockLayer 带折叠钩子接管。
      .use($prose(() =>
        keymap({
          Tab: (s, d, v) => (unified ? false : tabIndent(s, d, v)),
          'Shift-Tab': (s, d) => (unified ? false : tabOutdent(s, d)),
        }),
      ))
      .use(linkInputRule) // 打完 `[文字](地址)` 当场成链接(commonmark 预设没这条行内规则)
      .use(fullWidthWikiRule) // 全角【【→ 半角 [[(中文输入法不必切键盘)
      // 插件贡献的编辑器扩展(ctx.registerEditorExtension)。**放在宿主全部插件之后**:
      // ProseMirror 按注册序问 handleKeyDown/handleTextInput,内置行为先说了算,插件只捡没人处理的。
      .use(pluginEditorExtensions())
      .use(extraPlugins ?? [])
  }, [extGen])

  // slash 选中 → 由外部(applySlash)驱动编辑器:consume 消费触发 '/',transform 原地转换。
  // 一律单事务直接改编辑器文档,绝不经 store 回写:markdownUpdated 有 200ms debounce、序列化
  // 恒带尾部 '\n',靠「改 store → content 差异 → remount」已实测出「残留 '/' + 丢焦点」两个真 bug。
  useEffect(() => {
    if (!slashOpsRef) return
    slashOpsRef.current = {
      consume: () => {
        let emptyAfter = true
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { $from, empty } = view.state.selection
          if (empty) {
            const r = slashRange($from)
            if (r) view.dispatch(view.state.tr.delete(r.from, r.to))
          }
          emptyAfter = view.state.doc.textContent.trim() === ''
        })
        return emptyAfter
      },
      transform: (trig) => {
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { $from, empty } = view.state.selection
          applyTrigger(view, trig, empty ? slashRange($from) : null)
          view.focus()
        })
      },
    }
    return () => { if (slashOpsRef) slashOpsRef.current = null }
  }, [slashOpsRef, getInstance])

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ready.current = true
    })
    return () => cancelAnimationFrame(id)
  }, [])

  // slash 菜单 position:fixed 用的是 coordsAtPos 当刻的 viewport 坐标,只在 view.update 时重算,不跟滚动;
  // 菜单开着时滚动内层容器(.main)编辑器会移走、菜单却停在旧坐标 → 脱离光标。滚动/缩放即关(不设闩锁,
  // 下次击键 view.update 会以新坐标重开,同 Notion)。捕获相位才收得到内层滚动容器的 scroll。
  // ⚠️浮层**自己**的滚动条(.slash-scroll / 工具栏的面板)也会派 scroll,捕获相位一样收得到 →
  // 不排除的话「鼠标在菜单里滚一下菜单就没了」(用户实报)。只认来自浮层之外的滚动。
  const outsideScroll = (sel: string) => (e: Event): boolean =>
    !(e.target instanceof Element && e.target.closest(sel))
  const slashActive = !!slash
  useEffect(() => {
    if (!slashActive) return
    const outside = outsideScroll('.slash-menu')
    const onScroll = (e: Event): void => { if (outside(e)) setSlash(null) }
    const close = (): void => setSlash(null)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashActive])

  // 工具栏同 slash:滚动/缩放即关(fixed 坐标不跟内层滚动容器),但同样排除浮层内部滚动。
  const toolbarActive = !!toolbar
  useEffect(() => {
    if (!toolbarActive) return
    const outside = outsideScroll('.inline-toolbar')
    const onScroll = (e: Event): void => { if (outside(e)) setToolbar(null) }
    const close = (): void => setToolbar(null)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolbarActive])

  // 「粘贴为」菜单滚动/缩放即关(fixed 坐标不跟内层滚动容器)。键盘交给菜单自己(↑↓/↵/esc),
  // 见 PasteAsMenu —— 它只吞自己认的那几个键,别的一律放行并关掉菜单。点空白由 backdrop 关。
  const pasteAsActive = !!pasteAs
  useEffect(() => {
    if (!pasteAsActive) return
    const close = (): void => setPasteAs(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pasteAsActive])

  /** 把刚粘进去的那段 URL 改写成所选形态。书签 = 文本不动(裸 URL 已在位),只把光标挪出本段。 */
  const applyPasteAs = (pick: PasteAsPick): void => {
    const p = pasteAs
    setPasteAs(null)
    if (!p) return
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      // 菜单浮着的这段时间文档可能已经变了(别的窗口回灌、撤销…)。回写前逐字核对那段还是不是
      // 原来那条 URL,对不上就什么都不做 —— 按陈旧坐标乱改比不改坏得多。
      if (p.to > view.state.doc.content.size || view.state.doc.textBetween(p.from, p.to) !== p.url) return
      if (pick === 'bookmark') {
        // 文本不用动(裸 URL 已在位),但光标得挪出本段 —— 否则「选了书签卡,还是一行 URL」。
        const $u = view.state.doc.resolve(p.to)
        const after = $u.after($u.depth)
        const tr = view.state.tr
        const next = tr.doc.nodeAt(after)
        const para = view.state.schema.nodes.paragraph
        if (para && !(next?.type.name === 'paragraph' && next.content.size === 0)) tr.insert(after, para.create())
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size))))
        view.dispatch(tr)
        view.focus()
        return
      }
      if (pick === 'embed') {
        // ⚠️ `|` / `]` 是 `![[…]]` 的分隔符,原样写进去就再也读不回来(URL 后半段永久丢失)。
        const inner = `![[${wikiSafeUrl(p.url)}]]`
        const tr = view.state.tr.insertText(inner, p.from, p.to)
        // ⚠️ 光标留在本段 = 装饰整体让位,用户只看见 `![[…]]` 源码,以为「没生效」。
        // 送到下一段(没有就补一个空段)—— 嵌入当场成形,也正好接着往下写。
        const $end = tr.doc.resolve(Math.min(p.from + inner.length, tr.doc.content.size))
        const after = $end.after($end.depth)
        const next = tr.doc.nodeAt(after)
        const para = view.state.schema.nodes.paragraph
        if (para && !(next?.type.name === 'paragraph' && next.content.size === 0)) tr.insert(after, para.create())
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size))))
        view.dispatch(tr)
      } else {
        // 行内链接:文字取主机名。**不能拿 URL 原文当链接文字** —— 那样整段文本仍是一条裸 URL,
        // classifyEmbed 照样升级成书签卡(它按 textContent 判,看不见 link mark),
        // 「链接」与「书签」就成了同一个东西。ponytail: 不去异步抓 og:title 当文字,想要就自己改。
        const link = view.state.schema.marks.link
        const label = hostLabel(p.url)
        const tr = view.state.tr.insertText(label, p.from, p.to)
        if (link) tr.addMark(p.from, p.from + label.length, link.create({ href: normalizeHref(p.url) || p.url }))
        view.dispatch(tr)
      }
      view.focus()
    })
  }

  useEffect(() => {
    if (focusPlace == null || loading) return
    const editor = getInstance()
    if (!editor) return
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.focus()
      // 标题回车(仅统一实例发 'body-enter',AFFiNE doc-title 语义):首块是空段 → 光标落进;
      // 否则(有字的段/标题/卡片)在文档最顶插一个空段再落 —— 「回车=确定标题并给我第一行」。
      if (focusPlace === 'body-enter') {
        const para = view.state.schema.nodes.paragraph
        const first = view.state.doc.firstChild
        let tr = view.state.tr
        if (para && !(first && first.type === para && first.content.size === 0)) tr = tr.insert(0, para.create())
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(1))).scrollIntoView())
        return
      }
      // 先落到首/末行边缘 + scrollIntoView:view.focus() 不滚动,目标块可能仍在视口外,而 goalX 命中测试
      // (caretRangeFromPoint)要求可视区内——故先滚入,再在可视状态下按 goalX 精修(Codex 复审坐实)。
      const edge = focusPlace === 'end' ? Selection.atEnd(view.state.doc) : Selection.atStart(view.state.doc)
      view.dispatch(view.state.tr.setSelection(edge).scrollIntoView())
      // 跨块 ↑↓ 带来 goalX → 落在首/末行的同一水平列;测不到(极端边角)则保留上面的行首/尾。
      const goalPos = focusGoalX != null ? posAtGoalX(view, focusPlace, focusGoalX) : null
      if (goalPos != null) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(goalPos))).scrollIntoView())
      }
      // 源码模式切回来:按「光标前那段文本」在块内找回落点(见 lib/modeCursor)。找不到就留在块首 ——
      // 锚点里含 markdown 语法时必然找不回(源码 `**粗**` 在这边只有「粗」),这是设计内的降级。
      const anchorPos = focusAnchor ? posAtTextAnchor(view, focusAnchor) : null
      if (anchorPos != null) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(anchorPos))).scrollIntoView())
      }
    })
    onFocused()
  }, [focusPlace, focusGoalX, focusAnchor, loading, getInstance, onFocused])

  // pages 变化(建/删/改名)→ 空事务重算装饰:未解析红链即时随库存变色。
  // pages 引用只在结构刷新时更新(refreshPages/refreshStructure),不逐键触发,代价可忽略。
  useEffect(() => {
    return ps.subscribe((s, prev) => {
      if (s.pages === prev.pages || loading) return
      getInstance()?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr)
      })
    })
  }, [loading, getInstance])

  const pickWiki = (name: string): void => {
    const w = wiki
    if (w) {
      const editor = getInstance()
      editor?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.insertText(`${name}]]`, w.from, w.to))
        view.focus()
      })
    }
    setWiki(null)
  }

  // @ 提及:把 "@query"(含 @ 本身)整体替换成 [[name]] 双链。
  const pickMention = (name: string): void => {
    const m = mention
    if (m) {
      const editor = getInstance()
      editor?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.insertText(`[[${name}]]`, m.from - 1, m.to))
        view.focus()
      })
    }
    setMention(null)
  }

  /** 日期候选:插入的是字面 `@2026-09-01T14:30`(见 dateQuery / mdMarks),不包 `[[ ]]`。
   *  ⚠️ 必须补一个尾随空格 —— 不然新插进去的 `@…` 立刻又满足 mention 的触发条件,面板当场再弹一次。 */
  const pickMentionRaw = (text: string): void => {
    const m = mention
    if (m) {
      const editor = getInstance()
      editor?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.insertText(`${text} `, m.from - 1, m.to))
        view.focus()
      })
    }
    setMention(null)
  }

  // @ 候选:最近打开的页面排最前(宿主经 setRecentsProvider 注入),其余页面跟后;空查询即按此序展示。
  const mentionPageNames = (): string[] => {
    const all = getPageNames()
    const inVault = new Set(all)
    const rec = getRecentPages().filter((p) => inVault.has(p))
    const recSet = new Set(rec)
    return [...rec, ...all.filter((p) => !recSet.has(p))]
  }

  // 工具栏动作 → Milkdown 命令(单事务,执行后 view.focus 留在编辑器,选区仍在)。
  const runCmd = <T,>(key: CmdKey<T>, payload?: T): void => {
    getInstance()?.action((ctx) => {
      ctx.get(commandsCtx).call(key, payload)
      ctx.get(editorViewCtx).focus()
    })
  }
  // 行内链接:先问地址,再把 link mark 套到当前选区上。
  // ⚠️别改回 `runCmd(toggleLinkCommand.key)` —— 那个命令不带 payload 时 href 为 undefined,
  // 而 link schema 的 href 是必填 string,mark.create 直接抛 → 按钮点了「完全没反应」(用户实报)。
  // 留空地址 = 去掉链接;javascript: 之类由 normalizeHref 挡下(笔记会被分享页独立渲染)。
  const editLink = (): void => {
    const inst = getInstance()
    if (!inst) return
    inst.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const type = linkSchema.type(ctx)
      const { from, to, empty } = view.state.selection
      if (empty) return
      // 选区已经是链接 → 直接取消链接,不弹框。PromptDialog 的空输入等同「取消」(拿不到
      // 「确认了但留空」这个信号),所以去链接只能走这条无弹窗的路 —— 与 toggleLink 的语义也一致。
      if (view.state.doc.rangeHasMark(from, to, type)) {
        view.dispatch(view.state.tr.removeMark(from, to, type))
        view.focus()
        return
      }
      const docAtAsk = view.state.doc // 弹框期间文档可能被换掉(外部改文件回灌 / agent 写盘 / 云同步)
      void askString(translate('mdblock.link.title'), '', { label: translate('mdblock.link.label') }).then((raw) => {
        const href = raw === null ? null : normalizeHref(raw)
        if (!href) return
        // ⚠️ 重新取实例:弹框期间这个块可能已重挂,闭包里的 inst 是个死实例。
        getInstance()?.action((c2) => {
          const v = c2.get(editorViewCtx)
          // 文档变了 → 旧的 from/to 不再指向用户当初选中的那段文字。宁可什么都不做,
          // 也不能给错的文字加链接(更别说越界抛)。
          if (v.state.doc !== docAtAsk) return
          const t = linkSchema.type(c2)
          v.dispatch(v.state.tr.removeMark(from, to, t).addMark(from, to, t.create({ href })))
          v.focus()
        })
      })
    })
  }
  const clearFormatting = (): void => {
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { from, to, empty } = view.state.selection
      if (!empty) view.dispatch(view.state.tr.removeMark(from, to, null))
      view.focus()
    })
  }
  const alignText = (align: TextAlignment): void => {
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      setTextAlignment(view.state, (tr) => view.dispatch(tr), align)
      view.focus()
    })
  }
  // 「转换为」一律走 applyTrigger,不再用 Milkdown 的 wrapIn*/turnInto* 命令。原因:那几个命令
  // 直接对当前 textblock 动手,在 list_item 里必然失败(content 是 `paragraph block*`,首子只能是段落)
  // 或退化成空操作(段落→段落),于是「待办上切别的行样式」点了没反应(用户实报)。applyTrigger 会
  // 先把块提出列表/引用再转,且与「空格触发符」「斜杠菜单」共用同一套 Notion 语义 —— 三条入口一个实现。
  const TURN: Partial<Record<ToolbarAction, Trigger>> = {
    text: { kind: 'text' },
    h1: { kind: 'heading', level: 1 },
    h2: { kind: 'heading', level: 2 },
    h3: { kind: 'heading', level: 3 },
    h4: { kind: 'heading', level: 4 },
    h5: { kind: 'heading', level: 5 },
    h6: { kind: 'heading', level: 6 },
    bullet: { kind: 'bullet' },
    ordered: { kind: 'ordered', order: 1 },
    todo: { kind: 'task', checked: false },
    quote: { kind: 'quote' },
    fold: { kind: 'fold' },
  }
  /** 「转成代码块 / 公式」不是前缀型转换,走各自的整块重写。
   *  代码块在**跨块选区**下是 AFFiNE 的「合并成一个代码块」(逐块转会得到 N 个代码块)。 */
  const turnIntoWrapped = (a: 'codeblock' | 'math'): void => {
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { state } = view
      const { $from, $to } = state.selection
      const from = $from.before($from.depth)
      const to = $to.after($to.depth)
      const text = state.doc.textBetween(from, to, '\n', '\n').trim()
      const node =
        a === 'codeblock'
          ? state.schema.nodes.code_block?.create(null, text ? state.schema.text(text) : undefined)
          : state.schema.nodes.paragraph?.create(null, state.schema.text(`$$ ${text} $$`))
      if (!node) return
      const tr = state.tr.replaceWith(from, to, node)
      tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)))
      view.dispatch(tr.scrollIntoView())
      view.focus()
    })
  }
  const onToolbarAct = (a: ToolbarAction): void => {
    if (a === 'codeblock' || a === 'math') {
      turnIntoWrapped(a)
      return
    }
    const trig = TURN[a]
    if (trig) {
      getInstance()?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        applyTrigger(view, trig, null) // consume=null:工具栏没有要删的触发符
        view.focus()
      })
      return
    }
    const map: Partial<Record<ToolbarAction, () => void>> = {
      bold: () => runCmd(toggleStrongCommand.key),
      italic: () => runCmd(toggleEmphasisCommand.key),
      underline: () => runCmd(toggleUnderlineCommand.key),
      strike: () => runCmd(toggleStrikethroughCommand.key),
      code: () => runCmd(toggleInlineCodeCommand.key),
      link: editLink,
      clear: clearFormatting,
      alignLeft: () => alignText('left'),
      alignCenter: () => alignText('center'),
      alignRight: () => alignText('right'),
    }
    map[a]?.()
  }

  return (
    <>
      <Milkdown />
      {/* 四个浮层一律传送到最近的 .am-app:祖先有 transform 时(思维导图画布的 pan/zoom)
          position:fixed 会以那个祖先为包含块 → 菜单跑偏+被缩放。见 overlayPortal 注释。 */}
      <OverlayPortal>
      {wiki && !readOnly && (
        <WikiSuggest
          query={wiki.query}
          left={wiki.left}
          top={wiki.top}
          anchorTop={wiki.anchorTop}
          getPageNames={getPageNames}
          getFiles={getFiles}
          onPick={pickWiki}
          onClose={() => setWiki(null)}
        />
      )}
      {!wiki && mention && !readOnly && (
        <WikiSuggest
          query={mention.query}
          left={mention.left}
          top={mention.top}
          anchorTop={mention.anchorTop}
          getPageNames={mentionPageNames}
          getFiles={getFiles}
          onPick={pickMention}
          onPickRaw={pickMentionRaw}
          dates
          allowCreate={false}
          onClose={() => {
            mentionDismissedFrom.current = mention.from // Esc:同一 '@' 不再弹
            mentionOpenRef.current = false
            setMention(null)
          }}
        />
      )}
      {slash && onSlashPick && !wiki && !mention && !readOnly && (
        <SlashMenu
          query={slash.query}
          left={slash.left}
          top={slash.top}
          anchorTop={slash.anchorTop}
          hideKeys={unified ? UNIFIED_HIDDEN_SLASH : undefined}
          unified={unified}
          onPick={(it) => { setSlash(null); onSlashPick(it) }}
          onClose={() => {
            slashDismissedFrom.current = slash.from // Esc:同一 '/' 不再弹(留成字面文本)
            setSlash(null)
          }}
        />
      )}
      {pasteAs && !readOnly && (
        <PasteAsMenu
          left={pasteAs.left}
          top={pasteAs.top}
          anchorTop={pasteAs.anchorTop}
          url={pasteAs.url}
          onPick={applyPasteAs}
          onClose={() => setPasteAs(null)}
        />
      )}
      {toolbar && !wiki && !mention && !slash && !pasteAs && !readOnly && (
        <InlineToolbar
          left={toolbar.left}
          top={toolbar.top}
          bottom={toolbar.bottom}
          kind={toolbar.kind}
          active={toolbar.active}
          align={toolbar.align}
          onAct={onToolbarAct}
          onColor={(v) => runCmd(applyColorCommand.key, v || undefined)}
          onBg={(v) => runCmd(applyBgCommand.key, v || undefined)}
          onClose={() => setToolbar(null)}
        />
      )}
      </OverlayPortal>
    </>
  )
}

export function MarkdownBlock({
  blockId,
  content,
  pagePath,
  onChange,
  onInsertAfter,
  onDeleteEmpty,
  onMergePrev,
  onArrowOut,
  onMoveDir,
  focusPlace,
  focusGoalX,
  focusAnchor,
  onFocused,
  requestSelfFocus,
  onOpenWiki,
  onInsertEmbed,
  getPageNames,
  readOnly = false,
}: BlockEditorProps) {
  // 本编辑器面板自己那份文档 store。分屏后 usePageStore.getState() 解析到「活动面板」——
  // 而这里大量调用发生在 await 之后(斜杠新建文件、附件保存),那时活动面板完全可能已经是隔壁,
  // 写过去就是把内容插进另一篇笔记。
  const ps = useScopedPageStore()
  const pageDir = pagePath.split('/').slice(0, -1).join('/')
  const emitted = useRef(content)
  const [rev, setRev] = useState(0)
  const [dbPick, setDbPick] = useState(false) // 「链接数据库」选择器(slash 唤起)
  const slashOpsRef = useRef<SlashOps | null>(null) // MilkdownInner 注入:消费触发 '/' / 原地转换(单事务)

  // ⚠️ 外部改了内容 → 换 key 重挂编辑器。这个决定必须在**渲染期**下,不能放 useEffect:
  // 子组件(MilkdownInner)的 effect 先于父组件跑,于是「同一次提交里内容变了 + 来了焦点请求」
  // 时(块合并就是这个形状:前块内容被并长 + requestFocus 落到前块),焦点会被**即将被卸载的
  // 旧编辑器**消费掉 —— 新实例永远拿不到,表现为合并后焦点掉回 body、光标不知去向。
  // 渲染期置 state 会让 React 立刻重跑本组件、用新 key 去协调子树,旧实例根本不会带着焦点请求提交。
  // 仪器:npm run check:caretmerge(C2 跨块合并)。
  if (content !== emitted.current) {
    emitted.current = content
    setRev((r) => r + 1)
  }

  // The editor speaks DISPLAY markdown (protocol image urls); we store the PORTABLE form.
  const handleChange = (displayMd: string): void => {
    const stored = toStoredMarkdown(displayMd, pageDir)
    emitted.current = stored
    onChange(stored)
  }

  const saveImage = async (file: File): Promise<string | null> => {
    if (!pagePath) return null
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // 粘贴图片同样遵循 设置→笔记 的附件存放位置(旧 saveAsset 恒写 .amadeus/)。
      const { opts } = await getAttachmentPrefs()
      const { pageRel } = await amadeus.saveAttachment(pagePath, file.name || 'pasted.png', bytes, opts)
      return toAssetUrl(joinRel(pageDir, pageRel))
    } catch {
      return null
    }
  }

  /** 粘贴的非图片文件:逐个存附件,成一串 ![[base]] 嵌入块(保持粘贴顺序)。 */
  const saveFiles = async (files: File[]): Promise<void> => {
    if (!pagePath) return
    const mds: string[] = []
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const { opts } = await getAttachmentPrefs()
        const { base } = await amadeus.saveAttachment(pagePath, f.name || 'file', bytes, opts)
        mds.push(`![[${base}]]`)
      } catch { /* 保存失败静默跳过 */ }
    }
    if (!mds.length) return
    if (content.trim() === '') {
      onChange(mds[0])
      if (mds.length > 1) ps.getState().insertBlocksAfter(blockId, mds.slice(1))
    } else {
      ps.getState().insertBlocksAfter(blockId, mds)
    }
  }

  const keys: BlockKeys = {
    insertAfter: onInsertAfter,
    deleteEmpty: onDeleteEmpty,
    mergePrev: onMergePrev,
    arrow: onArrowOut,
    moveDir: onMoveDir,
    selfFocus: requestSelfFocus,
  }

  /**
   * 异步斜杠分支(先建文件再插入:数据库/画板/子页面/图片/插件项)回写前的守卫。
   *
   * ⚠️ 这些分支都是「consume() 同步删 '/' → await 建文件 → onChange/onInsertAfter」。await 期间用户完全可能
   * 已经继续打字、删掉这个块、或**切到了另一篇笔记**;而 `blockId` 是**笔记内局部 ID**(通常从 "1" 起),
   * 换页后极易撞上另一篇笔记的同名块 —— 于是 onChange 会覆盖那边的内容(Codex 实测确认,且内置分支早就有此缺陷)。
   * 三道闸:换页 / 原块已删 / 原块已被用户写入(此时改插入到其后,绝不覆盖用户输入)。
   */
  const insertAsyncResult = (md: string, emptyBlock: boolean): void => {
    const st = ps.getState()
    if (st.activePage !== pagePath || !st.blocks[blockId]) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('mdblock.toast.staleTarget') } }))
      return
    }
    const stillEmpty = (st.blocks[blockId].content ?? '').trim() === ''
    if (emptyBlock && stillEmpty) onChange(md)
    else onInsertAfter(md)
  }

  const applySlash = async (item: SlashItem): Promise<void> => {
    const scaffold = item.scaffold
    // ref 缺失(编辑器刚重挂 / 已销毁):fail closed —— 不执行,否则删不掉文档里的 '/query' 会留残渣(Codex)。
    // 菜单开着即编辑器活着、slashOpsRef 已注入,正常永不为空;这道闸只兜异常时序。
    if (!slashOpsRef.current) return
    // 菜单关闭由 MilkdownInner 的 setSlash(null) 负责(选中即关);此处只管应用选中项。
    // 前缀型(文本/标题/列表/待办/引用):编辑器内单事务「删 '/query' + 原地转换」,不经 store 回写。
    // (store 的 content 有 200ms debounce 且序列化恒带尾部 '\n',靠它转换实测出残留 '/'/丢焦点。)
    // ⚠️ 插件项即使 scaffold 为空串也不能走这条:'' 在 PREFIX_TRIGGERS 里是「转成普通文本」。
    const prefix = item.run ? undefined : PREFIX_TRIGGERS[scaffold]
    if (prefix) {
      slashOpsRef.current.transform(prefix)
      return
    }
    // 其余类型:先在编辑器里消费掉触发 '/query'(返回删后是否空块),再各自处理。
    const emptyBlock = slashOpsRef.current.consume()
    // 插件注册的「先干活再插入」项(如思维导图:新建 .mindmap.md 再插 ![[…]] 嵌入块)。
    // 与内置 数据库/画板 同款落点:文件进本笔记的 .fd 子文件夹,插入的是嵌入引用。
    if (item.run) {
      try {
        const md = await item.run({ pagePath, folder: fdDirOf(pagePath) })
        // 插件是 new Function 装载的第三方 JS,TS 类型对它没有运行时约束 —— 返回值必须当外部输入校验,
        // 否则非字符串会毒化 store(BlockHost 对 content.trim() 直接抛)、NUL/控制字符会污染笔记文件。
        if (md !== '' && md != null) {
          if (typeof md !== 'string') throw new Error(translate('mdblock.plugin.runNotString', { type: typeof md }))
          if (md.length > 8192) throw new Error(translate('mdblock.plugin.runTooLong'))
          if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(md)) throw new Error(translate('mdblock.plugin.runControlChars')) // 放行 \\n / \\t
          insertAsyncResult(md, emptyBlock)
          void ps.getState().syncFdChildren(pagePath)
        }
      } catch (e) {
        // 内置项失败是静默跳过,但插件是第三方代码 —— 静默会让用户以为「点了没反应」。
        // amadeus/ 子树不直接依赖宿主 store(要能被 web/mobile 复用),照既有约定发 `amadeus:*` 事件由宿主壳弹提示。
        console.error('[plugin] slash item failed', e)
        window.dispatchEvent(new CustomEvent('amadeus:toast', {
          detail: {
            text: translate('mdblock.toast.slashFailed', {
              label: item.label,
              message: e instanceof Error ? e.message : String(e),
            }),
            error: true,
          },
        }))
      }
      return
    }
    if (scaffold === TEMPLATE_SENTINEL) {
      // 宿主壳(amadeusOverlays)监听该事件弹模板选择器;独立版未挂监听则静默无事。
      window.dispatchEvent(new CustomEvent('amadeus:template-picker', {
        detail: { afterId: blockId, emptyBlock: emptyBlock },
      }))
      return
    }
    if (scaffold === IMAGE_SENTINEL) {
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
            const { base } = await amadeus.saveAttachment(pagePath, f.name || 'image.png', bytes, opts)
            const md = `![[${base}]]` // 与拖入(开预览)同形态:embed-image 块
            insertAsyncResult(md, emptyBlock) // 见其注释:await 期间可能已换页/删块/用户已输入
          } catch { /* 保存失败静默跳过 */ }
        })()
      }
      input.click()
      return
    }
    if (scaffold === PAGE_SENTINEL) {
      // 新建子页面(Notion /page):落当前笔记的 .fd 子文件夹,插入 [[链接]],随后打开。
      void (async () => {
        try {
          const st = ps.getState()
          const newPath = await st.createChildNote(pagePath, translate('mdblock.default.childNote'))
          const base = newPath.split('/').pop()!.replace(/\.md$/i, '')
          const md = `[[${base}]]`
          insertAsyncResult(md, emptyBlock) // 见其注释:await 期间可能已换页/删块/用户已输入
          void st.loadPage(newPath) // loadPage 先 flushSave → 父笔记的 [[链接]]+children 一并落盘
        } catch { /* 创建失败静默跳过 */ }
      })()
      return
    }
    if (scaffold === DATABASE_SENTINEL) {
      // 新建独立 .db 文件(落本笔记 .fd 子文件夹,uniqueName 撞名 -1/-2)→ 插入 ![[base]] 嵌入块。
      void (async () => {
        try {
          const dbName = translate('mdblock.default.database') // 文件名与 db.name 必须同一个值(出生即 文件名=title)
          const bytes = new TextEncoder().encode(serializeDb(emptyDb(dbName)))
          const { base } = await amadeus.saveAttachment(pagePath, `${dbName}.db`, bytes, { mode: 'vault', folder: fdDirOf(pagePath) })
          const md = `![[${base}]]`
          insertAsyncResult(md, emptyBlock) // 见其注释:await 期间可能已换页/删块/用户已输入
          void ps.getState().syncFdChildren(pagePath)
        } catch { /* 创建失败静默跳过 */ }
      })()
      return
    }
    if (scaffold === DRAWING_SENTINEL) {
      // 新建 Excalidraw 画板:Obsidian Excalidraw 插件同款的 .excalidraw.md,同一个库两边可互开。
      void (async () => {
        try {
          const bytes = new TextEncoder().encode(blankDrawing(BLANK_SCENE_JSON))
          // 时间戳命名照 Obsidian 插件(Drawing 2026-07-16 15.04.05.excalidraw.md)。
          // ponytail: 时间戳同时兜住 saveAttachment 的撞名 -N —— 它在**最后**一个扩展名前插后缀,
          // 会把 `x.excalidraw.md` 变成 `x.excalidraw-1.md`,而画板全靠 `.excalidraw.md` 这个后缀
          // 被挡在 listPages 之外(见 shared/amadeus/excalidraw/format 的 isDrawingPath)。
          // 要撞得同一秒内往同一篇笔记里插两块画板,人手办不到;真撞了也只是多出一篇怪笔记,画不丢。
          const bs = await amadeus.saveAttachment(pagePath, `${stampedFileName(translate('mdblock.default.drawing'))}.excalidraw.md`, bytes, { mode: 'vault', folder: fdDirOf(pagePath) })
          const md = `![[${bs.base.replace(/\.md$/i, '')}]]` // Obsidian 惯例:嵌入链接省掉 .md
          insertAsyncResult(md, emptyBlock) // 见其注释:await 期间可能已换页/删块/用户已输入
          void ps.getState().syncFdChildren(pagePath)
        } catch { /* 创建失败静默跳过 */ }
      })()
      return
    }
    if (scaffold === NOTEVIEW_SENTINEL) {
      // 「笔记视图」(Bases 式,行即笔记):行文件夹与 .db 视图定义都落本笔记的 .fd 子文件夹。
      void (async () => {
        try {
          const fdDir = fdDirOf(pagePath)
          let folderRel: string | null = null
          for (let i = 1; i <= 20 && folderRel === null; i++) {
            try {
              const vf = translate('mdblock.default.noteViewFolder')
              folderRel = await amadeus.createFolder(fdDir, i === 1 ? vf : `${vf} ${i}`)
            } catch { /* 撞名,试下一个 */ }
          }
          if (folderRel === null) return
          const vName = translate('mdblock.default.noteView') // 同上:视图标题与 .db 文件名同源
          const bytes = new TextEncoder().encode(serializeDb(emptyNoteView(vName, folderRel)))
          const { base } = await amadeus.saveAttachment(pagePath, `${vName}.db`, bytes, { mode: 'vault', folder: fdDir })
          const md = `![[${base}]]`
          insertAsyncResult(md, emptyBlock) // 见其注释:await 期间可能已换页/删块/用户已输入
          void ps.getState().syncFdChildren(pagePath)
        } catch { /* 创建失败静默跳过 */ }
      })()
      return
    }
    if (scaffold === COLUMN_SENTINEL) {
      // 新语义(Notion 式):本块独占一行 + 右侧新空栏,不再与前面所有块劈开。'/' 已 consume。
      ps.getState().splitToColumn(blockId, 'right')
      return
    }
    if (scaffold === LINKDB_SENTINEL) {
      setDbPick(true) // '/' 已 consume;DbLinkPicker onPick 时 store 早已同步净内容
      return
    }
    if (scaffold === BOOKMARK_SENTINEL) {
      // 整块 = 一行裸 URL → BlockHost 渲染为书签卡(og 元数据/YouTube 嵌入);md 零私有语法。
      void askString(translate('mdblock.bookmark.title'), '', { label: translate('mdblock.bookmark.label') }).then((raw) => {
        const url = raw?.trim()
        if (url && /^https?:\/\/\S+$/i.test(url)) {
          if (emptyBlock) onChange(url)
          else onInsertAfter(url)
        }
      })
      return
    }
    if (scaffold === EMBED_SENTINEL) {
      // 跨笔记块嵌入:剪贴板里有块菜单复制的 `![[笔记#块]]` 就预填;没有也弹输入(原先静默无反应=「用不了」)。
      if (!onInsertEmbed) return
      let prefill = ''
      try {
        const clip = await navigator.clipboard.readText() // 别叫 t:那是 i18n 的取词函数
        const m = /!\[\[([^\]\n]+)\]\]/.exec(clip)
        if (m) prefill = m[1].trim()
      } catch {
        /* clipboard unavailable */
      }
      void askString(translate('mdblock.embed.title'), prefill, {
        label: translate('mdblock.embed.label'),
        confirmLabel: translate('mdblock.embed.confirm'),
      }).then((raw) => {
        const target = raw?.trim().replace(/^!?\[\[/, '').replace(/\]\]$/, '').trim()
        if (target) onInsertEmbed(target)
      })
      return
    }
    // 整块型(代码/表格/分隔线/公式/[[):空块就地替换;非空块无法并入文字行 → 下方新建
    // (= 用户说的「database 这种没办法」)。'/' 已在上面 consume,不会残留。
    if (emptyBlock) {
      onChange(scaffold)
      // 迟一拍聚焦:焦点请求若在 remount 前发出会被旧编辑器消费掉,新编辑器永远拿不到(实测)。
      setTimeout(() => requestSelfFocus('end'), 0)
    } else {
      onInsertAfter(scaffold)
    }
  }

  // 移动端块面板的落点登记:焦点进本块就把「往这里插」这件事记下来(见 getFocusedBlockApply)。
  // 恒等身份 stableApply + 卸载时撤销自己那份 → 面板永远不会往已销毁的块里写。
  const applyRef = useRef<(it: SlashItem) => void>(() => {})
  applyRef.current = (it) => { void applySlash(it) }
  const stableApply = useRef((it: SlashItem) => applyRef.current(it)).current
  useEffect(() => () => { if (focusedApply === stableApply) focusedApply = null }, [stableApply])

  return (
    <div className="md-block" onFocusCapture={() => { if (!readOnly) focusedApply = stableApply }}>
      {/* readOnly 进 key:`editable: () => !readOnly` 是**建编辑器时**捕获的闭包,光改 prop
          原地翻不过来(Dashboard 的编辑锁定一按,块看着解锁了其实还打不了字)。同 rev,换 key 重挂。 */}
      <MilkdownProvider key={`${rev}:${readOnly ? 1 : 0}`}>
        <MilkdownInner
          initial={toDisplayMarkdown(content, pageDir)}
          onChange={handleChange}
          keys={keys}
          saveImage={saveImage}
          saveFiles={saveFiles}
          onOpenWiki={onOpenWiki}
          getPageNames={getPageNames}
          blockId={blockId}
          slashOpsRef={slashOpsRef}
          onSlashPick={applySlash}
          getFiles={() => (wikiFilesEnabled() ? ps.getState().files : [])}
          isWikiResolved={(n) =>
            !!resolvePageName(n, getPageNames(), pagePath) || !!resolveFileName(n, ps.getState().files, pagePath)}
          wikiIcon={(n) => {
            const p = resolvePageName(n, getPageNames(), pagePath)
            return p ? ps.getState().icons[p] : undefined
          }}
          focusPlace={focusPlace}
          focusGoalX={focusGoalX}
          focusAnchor={focusAnchor}
          onFocused={onFocused}
          readOnly={readOnly}
        />
      </MilkdownProvider>
      {dbPick && !readOnly && (
        <OverlayPortal><DbLinkPicker
          onClose={() => setDbPick(false)}
          onPick={(inner) => {
            setDbPick(false)
            const md = `![[${inner}]]`
            if (content.trim() === '') onChange(md)
            else onInsertAfter(md)
          }}
        /></OverlayPortal>
      )}
    </div>
  )
}

/** 整篇 markdown 的独立 Milkdown 宿主(工作区外部 .md 编辑用):字符串进出,零 vault/pageStore 依赖。
 *  块级机关全部降级:无 slash 菜单('/' 正常落字,markdown 输入规则仍生效)、粘贴图片/文件忽略、
 *  双链建议无候选(输入 [[ 仅作纯文本)。资源不做 display/stored 变换 —— 外部文件原文往返无损。
 *  缩进编解码(indentIo)**要**做:它绕过 toDisplay/toStoredMarkdown,不包一层的话行首制表符
 *  段落在悬浮预览/工作区编辑里仍会被 remark 读成缩进代码块。 */
export function PlainMarkdownEditor({ initial, onChange, readOnly = false }: {
  initial: string
  onChange: (md: string) => void
  readOnly?: boolean
}) {
  const noop = (): void => {}
  const keys: BlockKeys = {
    insertAfter: noop, deleteEmpty: noop, mergePrev: noop, arrow: noop, moveDir: noop, selfFocus: noop,
  }
  return (
    <div className="md-block md-plain">
      <MilkdownProvider>
        <MilkdownInner
          initial={tabsToEntities(initial)}
          onChange={(md) => onChange(entitiesToTabs(md))}
          keys={keys}
          saveImage={async () => null}
          saveFiles={async () => {}}
          onOpenWiki={noop}
          getPageNames={() => []}
          focusPlace={null}
          onFocused={noop}
          readOnly={readOnly}
        />
      </MilkdownProvider>
    </div>
  )
}

export interface SlashItem {
  key: string
  label: string
  hint: string
  /** AFFiNE 图标组件(内置项)或字符/emoji(插件注册项),渲染层一律当 ReactNode。 */
  icon: ReactNode
  group: string
  scaffold: string
  /** 插件注册的「先干活再插入」项:返回要插入的 markdown(见 SlashContribution.run)。 */
  run?: (cx: { pagePath: string; folder: string }) => string | Promise<string>
  kw: string
  /** 只有 v4 统一实例具备的结构动作（例如 Canvas 卡片）；v3 编辑器与移动端块面板不露出。 */
  unifiedOnly?: boolean
}

/** SLASH_ITEMS 的**表内**形态:名字与分组存 i18n 键,useAllSlashItems 在渲染期取词。
 *  ⚠️ 模块作用域调不了 hook —— 表里直接写文案 = 冻在模块加载那一刻,切语言纹丝不动。
 *  对外(菜单 / 移动端块面板)露出的仍是 SlashItem,label/group 已是当前语言的成品文案。 */
type SlashSeed = Omit<SlashItem, 'label' | 'group'> & { labelKey: string; groupKey: string }

/** 触发型 scaffold 的对外名册:v4 统一实例(unified/UnifiedPage 的 applySlash)按同一套判定分流。
 *  ⚠️ 这些常量的字面量含 NUL 字符 —— 一律从这里引用,**绝不在别的文件里重打一遍**。 */
export const SLASH_SENTINELS = {
  embed: EMBED_SENTINEL,
  linkdb: LINKDB_SENTINEL,
  bookmark: BOOKMARK_SENTINEL,
  template: TEMPLATE_SENTINEL,
  image: IMAGE_SENTINEL,
  column: COLUMN_SENTINEL,
  database: DATABASE_SENTINEL,
  drawing: DRAWING_SENTINEL,
  noteview: NOTEVIEW_SENTINEL,
  page: PAGE_SENTINEL,
  card: CARD_SENTINEL,
} as const

// 前缀型 scaffold → 块转换(slash 选中时经 SlashOps.transform 在编辑器内单事务完成,绝不新建块)。
// 其余为整块型(代码/表格/公式/[[ 等)或触发型 sentinel,各自单独处理。
export const PREFIX_TRIGGERS: Record<string, Trigger> = {
  '': { kind: 'text' },
  '# ': { kind: 'heading', level: 1 },
  '## ': { kind: 'heading', level: 2 },
  '### ': { kind: 'heading', level: 3 },
  '#### ': { kind: 'heading', level: 4 },
  '##### ': { kind: 'heading', level: 5 },
  '###### ': { kind: 'heading', level: 6 },
  '- ': { kind: 'bullet' },
  '1. ': { kind: 'ordered', order: 1 },
  '- [ ] ': { kind: 'task', checked: false },
  '| ': { kind: 'quote' },
  '> ': { kind: 'fold' },
}

/** 可插入块的**唯一真源**。移动端的双列块面板(amadeusViews.AmxBlockPicker)与桌面 slash 菜单
 *  共吃这一份 —— 别在别处再手写一张清单,否则新块类型只在其中一处露出。 */
export const SLASH_ITEMS: SlashSeed[] = [
  { key: 'text', labelKey: 'mdblock.slash.text', hint: '', icon: <TextIcon />, groupKey: 'mdblock.group.basic', scaffold: '', kw: 'text 文本 paragraph zhengwen 正文' },
  { key: 'h1', labelKey: 'mdblock.slash.h1', hint: '#', icon: <Heading1Icon />, groupKey: 'mdblock.group.basic', scaffold: '# ', kw: 'h1 heading 标题 biaoti title 大标题' },
  { key: 'h2', labelKey: 'mdblock.slash.h2', hint: '##', icon: <Heading2Icon />, groupKey: 'mdblock.group.basic', scaffold: '## ', kw: 'h2 heading 标题 biaoti 中标题' },
  { key: 'h3', labelKey: 'mdblock.slash.h3', hint: '###', icon: <Heading3Icon />, groupKey: 'mdblock.group.basic', scaffold: '### ', kw: 'h3 heading 标题 biaoti 小标题' },
  { key: 'h4', labelKey: 'mdblock.slash.h4', hint: '####', icon: <Heading4Icon />, groupKey: 'mdblock.group.basic', scaffold: '#### ', kw: 'h4 heading 标题 biaoti 四级' },
  { key: 'h5', labelKey: 'mdblock.slash.h5', hint: '#####', icon: <Heading5Icon />, groupKey: 'mdblock.group.basic', scaffold: '##### ', kw: 'h5 heading 标题 biaoti 五级' },
  { key: 'h6', labelKey: 'mdblock.slash.h6', hint: '######', icon: <Heading6Icon />, groupKey: 'mdblock.group.basic', scaffold: '###### ', kw: 'h6 heading 标题 biaoti 六级' },
  { key: 'ul', labelKey: 'mdblock.slash.ul', hint: '-', icon: <BulletedListIcon />, groupKey: 'mdblock.group.list', scaffold: '- ', kw: 'ul bullet list 无序 列表 liebiao' },
  { key: 'ol', labelKey: 'mdblock.slash.ol', hint: '1.', icon: <NumberedListIcon />, groupKey: 'mdblock.group.list', scaffold: '1. ', kw: 'ol number list 有序 列表 编号' },
  { key: 'todo', labelKey: 'mdblock.slash.todo', hint: '[ ]', icon: <CheckBoxCheckLinearIcon />, groupKey: 'mdblock.group.list', scaffold: '- [ ] ', kw: 'todo task check 待办 任务 复选框 daiban renwu' },
  { key: 'card', labelKey: 'mdblock.slash.card', hint: 'Canvas', icon: <PageIcon />, groupKey: 'mdblock.group.basic', scaffold: CARD_SENTINEL, kw: 'card 卡片 node 节点 canvas 画布', unifiedOnly: true },
  { key: 'quote', labelKey: 'mdblock.slash.quote', hint: '|', icon: <QuoteIcon />, groupKey: 'mdblock.group.advanced', scaffold: '| ', kw: 'quote 引用 yinyong blockquote' },
  { key: 'fold', labelKey: 'mdblock.slash.fold', hint: '>', icon: <FoldIcon />, groupKey: 'mdblock.group.advanced', scaffold: '> ', kw: 'fold toggle 折叠 zhedie collapse 展开 详情 details' },
  { key: 'code', labelKey: 'mdblock.slash.code', hint: '```', icon: <CodeBlockIcon />, groupKey: 'mdblock.group.advanced', scaffold: '```\n\n```', kw: 'code 代码 daima codeblock' },
  { key: 'table', labelKey: 'mdblock.slash.table', hint: '⊞', icon: <TableIcon />, groupKey: 'mdblock.group.advanced', scaffold: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |', kw: 'table 表格 biaoge grid 网格' },
  { key: 'divider', labelKey: 'mdblock.slash.divider', hint: '---', icon: <DividerIcon />, groupKey: 'mdblock.group.advanced', scaffold: '---\n\n', kw: 'divider hr 分割线 分隔 fenge' },
  // 单行 $$  $$(两 delimiter 同处一个 textblock,填内容即渲染为居中块公式)。旧的 '$$\n\n$$' 会被 commonmark
  // 拆成两个段落、每段只剩一个 $$ → 实况预览永远扫不到成对公式(见 mathLivePreview.scanMath)。
  { key: 'math', labelKey: 'mdblock.slash.math', hint: '$$', icon: <TeXIcon />, groupKey: 'mdblock.group.advanced', scaffold: '$$  $$', kw: 'math latex katex formula 数学 公式 gongshi' },
  { key: 'wikilink', labelKey: 'mdblock.slash.wikilink', hint: '[[', icon: <LinkedPageIcon />, groupKey: 'mdblock.group.advanced', scaffold: '[[', kw: 'link wiki note 链接 笔记 双链 lianjie shuanglian' },
  { key: 'image', labelKey: 'mdblock.slash.image', hint: '', icon: <ImageIcon />, groupKey: 'mdblock.group.advanced', scaffold: IMAGE_SENTINEL, kw: 'image picture photo 图片 tupian 插图' },
  { key: 'columns', labelKey: 'mdblock.slash.columns', hint: '⫿', icon: <LayoutIcon />, groupKey: 'mdblock.group.advanced', scaffold: COLUMN_SENTINEL, kw: 'column split 分栏 分列 fenlan 并排' },
  { key: 'page', labelKey: 'mdblock.slash.page', hint: '.fd', icon: <NewPageIcon />, groupKey: 'mdblock.group.advanced', scaffold: PAGE_SENTINEL, kw: 'page 页面 子页面 subpage child yemian xinjian 新建页面 notion' },
  { key: 'database', labelKey: 'mdblock.slash.database', hint: '.db', icon: <DatabaseTableViewIcon />, groupKey: 'mdblock.group.advanced', scaffold: DATABASE_SENTINEL, kw: 'database db 数据库 shujuku 表格 base notion' },
  { key: 'drawing', labelKey: 'mdblock.slash.drawing', hint: 'Excalidraw', icon: <PenIcon />, groupKey: 'mdblock.group.advanced', scaffold: DRAWING_SENTINEL, kw: 'drawing draw excalidraw 画板 huaban 手绘 白板 whiteboard 草图 sketch 流程图' },
  { key: 'linkdb', labelKey: 'mdblock.slash.linkdb', hint: '![[.db]]', icon: <DatabaseTableViewIcon />, groupKey: 'mdblock.group.advanced', scaffold: LINKDB_SENTINEL, kw: 'link database db 链接数据库 引用数据库 嵌入数据库 已有 lianjie shujuku' },
  { key: 'noteview', labelKey: 'mdblock.slash.noteview', hint: 'Bases', icon: <DatabaseListViewIcon />, groupKey: 'mdblock.group.advanced', scaffold: NOTEVIEW_SENTINEL, kw: 'noteview bases 笔记视图 bijishitu 行即笔记 folder page 多维表 notion' },
  { key: 'template', labelKey: 'mdblock.slash.template', hint: 'templates/', icon: <TemplateIcon />, groupKey: 'mdblock.group.advanced', scaffold: TEMPLATE_SENTINEL, kw: 'template 模板 muban 套用' },
  { key: 'embed', labelKey: 'mdblock.slash.embed', hint: '![[ ]]', icon: <EmbedIcon />, groupKey: 'mdblock.group.advanced', scaffold: EMBED_SENTINEL, kw: 'embed 嵌入 引用 transclude block 块 qianru yinyong 复用' },
  { key: 'bookmark', labelKey: 'mdblock.slash.bookmark', hint: 'https://', icon: <BookmarkIcon />, groupKey: 'mdblock.group.advanced', scaffold: BOOKMARK_SENTINEL, kw: 'bookmark link url 书签 链接 网页 网址 shuqian youtube 视频' },
  // 整块型:插入的就是空按钮块本身(未配置态),点它才开构建器 —— 不用 sentinel。
  // hint 是**触发语法**那一列(`.db` / `![[ ]]` / `#`),按钮没有语法就留空(同「图片」)。
  // 原本放的 ⚡ 在 mac 上渲染成彩色 emoji,是整张菜单里唯一一处。
  { key: 'button', labelKey: 'mdblock.slash.button', hint: '', icon: <SelectIcon />, groupKey: 'mdblock.group.advanced', scaffold: BLANK_BUTTON_BLOCK, kw: 'button 按钮 anniu 自动化 automation 一键 yijian 快捷 notion' },
]

/** v4 统一实例里暂不支持的 slash 项(按 key 屏蔽)。**空集不是死代码** —— MarkdownBlock 是
 *  v3/v4 共用的菜单源,两边能力再次分叉时往这里加一个 key 就行,比在菜单组件里长条件便宜。
 *  (「模板」曾在这里:2026-08-21 接上 unified 路由后移出 —— UnifiedPage.applySlash 现在带着
 *   自己的 path 发 `amadeus:template-picker`,宿主 TemplatePicker 按 v4Path 走 insertMarkdown。) */
const UNIFIED_HIDDEN_SLASH: ReadonlySet<string> = new Set<string>()

/** 内置项 + 插件注册项的合并清单(桌面 slash 菜单与移动端块面板共用,插件新增项两处自动都有)。 */
export function useAllSlashItems({ unified = false }: { unified?: boolean } = {}): SlashItem[] {
  const { t } = useI18n()
  const pluginSlash = usePluginStore((s) => s.slashItems)
  const all: SlashItem[] = [
    // 内置项在**这里**取词(表里只有键):切语言时 useI18n 让消费方重渲染,菜单当场跟上。
    ...SLASH_ITEMS.map(({ labelKey, groupKey, ...rest }) => ({ ...rest, label: t(labelKey), group: t(groupKey) })),
    ...pluginSlash.map(({ item }) => ({
      key: item.id,
      label: item.label,
      hint: item.hint ?? '',
      // 插件项走图标词表(见 components/icons 的 resolveIcon):写图标名 → 和内置项同一套 SVG;
      // 写 emoji/字形 → 原样画(老插件零改动)。兜底 '·' 只在插件压根没给 icon 时出现。
      icon: resolveIcon(item.icon, '·'),
      group: item.group ?? t('mdblock.group.plugin'),
      scaffold: item.scaffold ?? '',
      run: item.run,
      kw: `${item.keywords ?? ''} ${item.label}`,
    })),
  ]
  return unified ? all : all.filter((it) => !it.unifiedOnly)
}

/** 「最后一个获得过焦点的块」的 applySlash —— 移动端双列块面板的落点。
 *  面板要占住软键盘那块地就必须先收键盘,而收键盘 = 编辑器失焦,所以**不能**等到选中时再用
 *  view.hasFocus() 现场找目标块。applySlash 自带 fail-closed(slashOpsRef 为空即 return),
 *  块卸载时也会撤销自己这份,故这里不会往已销毁的块里写。 */
let focusedApply: ((it: SlashItem) => void) | null = null
export function getFocusedBlockApply(): ((it: SlashItem) => void) | null {
  return focusedApply
}

/** v4 统一实例(整页一个编辑器,压根没有逐块的 MarkdownBlock)自己登记落点用。
 *  没有这个 setter 的话,移动端的双列块面板在**每一篇 v4 笔记**上都是空转:面板开得出来、
 *  条目点得到,applySlash 却永远是 null(2026-08-20 查出,与「移动端没有底栏」同一批)。 */
export function setFocusedBlockApply(fn: ((it: SlashItem) => void) | null): void {
  focusedApply = fn
}

/** slash 项匹配分 = label 与各关键词(空格切分)的最佳 fuzzy 分;全不匹配返回 null(过滤掉)。 */
function slashScore(q: string, it: SlashItem): number | null {
  let best: number | null = null
  for (const cand of [it.label, ...it.kw.split(/\s+/)]) {
    const s = fuzzyScore(q, cand)
    if (s !== null) best = best === null ? s : Math.max(best, s)
  }
  return best
}

// query / left / top 由 slashSuggestPlugin 从文档实时喂入(query 驻留正文,不再由本组件吸键累积)。
// 键盘只拦导航键(↑↓/Enter/Tab/Esc),字母/空格/退格全放行落进编辑器 → 插件重算 query(同 WikiSuggest)。
export type PasteAsPick = 'link' | 'bookmark' | 'embed'
export interface PasteAs {
  url: string
  /** 刚落地那段 URL 在文档里的范围;回写前会逐字核对文本没变。 */
  from: number
  to: number
  left: number
  top: number
  anchorTop: number
}

/** 链接 → 短标签(主机名,去 www.)。解析不了就原样。 */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/** 粘贴链接后的「粘贴为」菜单(AFFiNE `Paste as` 对位):三种**磁盘形态真不一样**的落法。
 *  没有第四项「URL 原样」—— 裸 URL 就是「书签」那一项的字面,再列一遍是同一份字节。
 *
 *  键盘契约(与 SlashMenu 的差别是**故意**的,这个菜单是粘贴后**不请自来**的):
 *  - 初始 `active = -1` = 谁都不高亮。**没按过方向键时,回车/Tab 一概不拦**,原样落进编辑器
 *    换行/缩进 —— 「粘贴完直接敲回车」是肌肉记忆,菜单不请自来就抢走它是纯添乱。
 *  - ↑/↓ 才进选择态(首次按下落到第一项),此后 ↵/Tab 确认、Esc 关闭。
 *  - 其余任何键(打字/退格/←→)一律**放行并关菜单** —— 用户已经在做别的事了。
 *  - IME 组字中全部放行(拼音选词就是 Enter / 空格,绝不能被吞;`Process`/229 覆盖 isComposing
 *    还没置位的首帧)。
 *  监听用 `useLayoutEffect`:`useEffect` 要等绘制后才挂,中间那一击会漏进编辑器
 *  (见 project_amadeus_suggest_popup_keytrap)。 */
function PasteAsMenu({ left, top, anchorTop, url, onPick, onClose }: {
  left: number
  top: number
  anchorTop: number
  url: string
  onPick: (p: PasteAsPick) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const items: Array<{ k: PasteAsPick; label: string; hint: string }> = [
    { k: 'link', label: t('mdblock.pasteAs.link'), hint: hostLabel(url) },
    { k: 'bookmark', label: t('mdblock.pasteAs.bookmark'), hint: t('mdblock.pasteAs.bookmarkHint') },
    { k: 'embed', label: t('mdblock.pasteAs.embed'), hint: t('mdblock.pasteAs.embedHint') },
  ]
  const [active, setActive] = useState(-1) // -1 = 还没进选择态
  // 事件里读 ref 而不是 state:副作用(onPick/onClose)绝不能写进 setState 的 updater —— React
  // 会重复调用 updater(StrictMode 必然,并发渲染也可能),那就是「回车确认了两次」。
  const activeRef = useRef(-1)
  activeRef.current = active
  useLayoutEffect(() => {
    const stop = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey // Mod+Shift+↑↓ = 块重排,别吞
      if (e.key === 'Escape') {
        stop(e)
        onClose()
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && bare) {
        stop(e)
        setActive((a) => (a < 0 ? 0 : Math.max(0, Math.min(a + (e.key === 'ArrowDown' ? 1 : -1), items.length - 1))))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const a = activeRef.current
        if (a < 0) { onClose(); return } // 没选过 → 一个键都不拦,回车照常换行
        stop(e)
        onPick(items[a].k)
      } else if (e.key !== 'Shift' && e.key !== 'Meta' && e.key !== 'Control' && e.key !== 'Alt') {
        onClose() // 用户在做别的事了,菜单让开(键本身放行)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onPick, onClose, items.length])
  return (
    <>
      <div className="slash-backdrop" onMouseDown={onClose} />
      <OverlayAt className="paste-as-menu" role="menu" x={left} y={top} anchorTop={anchorTop}>
        <div className="paste-as-label">{t('mdblock.pasteAs.title')}</div>
        {items.map((it, i) => (
          <button
            key={it.k}
            className="paste-as-item"
            data-active={i === active || undefined}
            role="menuitem"
            onMouseEnter={() => setActive(i)}
            // 同 SlashMenu:按下不夺走编辑器选区/焦点。
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onPick(it.k)
            }}
          >
            <span className="paste-as-name">{it.label}</span>
            <span className="paste-as-hint">{it.hint}</span>
          </button>
        ))}
        <div className="paste-as-foot">
          <span>{t('mdblock.foot.select')}</span>
          <span>{t('mdblock.foot.confirm')}</span>
          <span>{t('mdblock.foot.close')}</span>
        </div>
      </OverlayAt>
    </>
  )
}

function SlashMenu({ query, left, top, anchorTop, hideKeys, unified, onPick, onClose }: {
  query: string; left: number; top: number; anchorTop?: number
  /** 本宿主暂不支持的项(见 UNIFIED_HIDDEN_SLASH):点了没反应比少一条更糟,直接不露。 */
  hideKeys?: ReadonlySet<string>
  unified?: boolean
  onPick: (it: SlashItem) => void; onClose: () => void
}) {
  const { t } = useI18n()
  const [active, setActive] = useState(0)
  const all = useAllSlashItems({ unified })
  const allItems = useMemo(() => (hideKeys ? all.filter((it) => !hideKeys.has(it.key)) : all), [all, hideKeys])

  const q = query.trim().toLowerCase()
  // 有输入 → 按匹配度排序(label 与各关键词取最佳 fuzzy 分,降序);无输入 → 保持分组固定顺序。
  // 修掉「text 恒第一」:此前只 includes 过滤不排序,SLASH_ITEMS 首项 text 永远最靠前。
  const items = q
    ? allItems
        .map((it) => ({ it, s: slashScore(q, it) }))
        .filter((x): x is { it: SlashItem; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.it)
    : allItems

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const stop = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent): void => {
      // IME 组字中:一律放行给输入法(拼音选词是 Enter、候选是空格,绝不能被菜单抢走)。
      // key==='Process'/keyCode===229 覆盖 isComposing 尚未置位的首帧(AFFiNE 同款守卫)。
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return
      const bareArrow = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey // Mod+Shift+↑↓=块重排,别吞
      if (e.key === 'Escape') {
        stop(e)
        onClose()
      } else if (e.key === 'ArrowDown' && bareArrow) {
        stop(e)
        setActive((a) => Math.max(0, Math.min(a + 1, items.length - 1)))
      } else if (e.key === 'ArrowUp' && bareArrow) {
        stop(e)
        setActive((a) => Math.max(a - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const it = items[active]
        if (it) { stop(e); onPick(it) }
        else onClose() // 无匹配:不拦截,让 Enter/Tab 正常落进编辑器(换行/缩进)
      }
      // 其余(字母/空格/退格/←→/Home…)一律放行 → 落进编辑器,slashSuggestPlugin 重算 query。
      // 空格/换行让 query 含空白 → 插件 report(null) → 菜单自动关、'/…' 留成字面文本(AFFiNE 式)。
      // 退格删到 '/' 之前 → 无 '/' → 插件 report(null) → 关菜单(Notion 式撤销)。
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, active, onPick, onClose])

  const renderItem = (it: SlashItem, i: number) => (
    <button
      key={it.key}
      className="slash-item"
      data-active={i === active || undefined}
      // ↑↓ 走到可视区外的选项要跟着滚(block:'nearest' 已可见时是空操作,鼠标 hover 不会乱跳)。
      ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseEnter={() => setActive(i)}
      // onMouseDown+preventDefault:选项按下时不夺走编辑器焦点(否则 consume/transform 前编辑器已 blur),同 WikiSuggest。
      onMouseDown={(e) => { e.preventDefault(); onPick(it) }}
      role="menuitem"
    >
      <span className="slash-icon" aria-hidden>
        {it.icon}
      </span>
      <span className="slash-label">{it.label}</span>
      <span className="slash-hint">{it.hint}</span>
    </button>
  )

  // Browsing (no query) → grouped with section labels; filtering → flat list.
  const grouped: Array<{ name: string; rows: Array<{ it: SlashItem; idx: number }> }> = []
  items.forEach((it, idx) => {
    let g = grouped.find((x) => x.name === it.group)
    if (!g) {
      g = { name: it.group, rows: [] }
      grouped.push(g)
    }
    g.rows.push({ it, idx })
  })

  return (
    <>
      <div className="slash-backdrop" onMouseDown={onClose} />
      <OverlayAt className="slash-menu" role="menu" x={left} y={top} anchorTop={anchorTop}>
        {items.length === 0 && <div className="slash-empty">{t('mdblock.menu.noMatch')}</div>}
        <div className="slash-scroll">
          {q
            ? items.map((it, i) => renderItem(it, i))
            : grouped.map((g) => (
                <div key={g.name} className="slash-group">
                  <div className="slash-group-label">{g.name}</div>
                  {g.rows.map(({ it, idx }) => renderItem(it, idx))}
                </div>
              ))}
        </div>
        {items.length > 0 && (
          <div className="slash-foot">
            <span>{t('mdblock.foot.select')}</span>
            <span>{t('mdblock.foot.insert')}</span>
            <span>{t('mdblock.foot.close')}</span>
          </div>
        )}
      </OverlayAt>
    </>
  )
}

/** 「链接数据库」选择器(slash 唤起):列出 vault 全部 .db,可打字过滤;
 *  选中插入 ![[..]] 嵌入 —— 唯一裸名即最短,重名给全 vault 相对路径(resolveAttachment 根回退可解析)。 */
export function DbLinkPicker({ onPick, onClose }: { onPick: (inner: string) => void; onClose: () => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // 响应式订阅(getState 快照在 files 异步补齐前打开会一直空列表)+ 挂载强制刷一次结构兜底。
  const files = usePageStore((s) => s.files)
  useEffect(() => {
    void usePageStore.getState().refreshStructure()
  }, [])
  const all = files.filter((f) => /\.db$/i.test(f))
  const baseOf = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p
  const dupes = new Map<string, number>()
  for (const f of all) {
    const k = baseOf(f).toLowerCase()
    dupes.set(k, (dupes.get(k) ?? 0) + 1)
  }
  const q = query.trim().toLowerCase()
  const items = q
    ? all
        .map((f) => {
          const s = fuzzyScore(q, baseOf(f))
          return { f, s: s !== null ? s + 1000 : fuzzyScore(q, f) }
        })
        .filter((x): x is { f: string; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.f)
    : all
  const inner = (f: string): string =>
    (dupes.get(baseOf(f).toLowerCase()) ?? 0) > 1 ? f.replace(/\\/g, '/') : baseOf(f)

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const stop = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        stop(e)
        onClose()
      } else if (e.key === 'ArrowDown') {
        stop(e)
        setActive((a) => Math.min(a + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        stop(e)
        setActive((a) => Math.max(a - 1, 0))
      } else if (e.key === 'Enter') {
        stop(e)
        const f = items[active]
        if (f) onPick(inner(f))
        else onClose()
      } else if (e.key === 'Backspace') {
        stop(e)
        setQuery((s) => s.slice(0, -1))
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        stop(e)
        setQuery((s) => s + e.key)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, active, onPick, onClose])

  return (
    <>
      <div className="slash-backdrop" onMouseDown={onClose} />
      <div className="slash-menu" role="menu">
        {query && <div className="slash-query">{query}</div>}
        {all.length === 0 && <div className="slash-empty">{t('mdblock.menu.noDatabase')}</div>}
        {all.length > 0 && items.length === 0 && <div className="slash-empty">{t('mdblock.menu.noMatch')}</div>}
        <div className="slash-scroll">
          {items.map((f, i) => (
            <button
              key={f}
              className="slash-item"
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(inner(f))}
              role="menuitem"
            >
              <span className="slash-icon" aria-hidden><DatabaseTableViewIcon /></span>
              <span className="slash-label">{baseOf(f).replace(/\.db$/i, '')}</span>
              <span className="slash-hint">{f.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'}</span>
            </button>
          ))}
        </div>
        {items.length > 0 && (
          <div className="slash-foot">
            <span>{t('mdblock.foot.select')}</span>
            <span>{t('mdblock.foot.embed')}</span>
            <span>{t('mdblock.foot.close')}</span>
          </div>
        )}
      </div>
    </>
  )
}

registerBlockType({ id: 'markdown', fileExtensions: ['.md'], Editor: MarkdownBlock })
