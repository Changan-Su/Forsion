// ── v4 统一实例编辑器(生产路径,spec §9 step 3 绞杀者)────────────────────────────
// 服务对象:v4 素文件(含一切外来 md)与 v4 结构化文件;v3 标记文件不进这里(router.ts 分流)。
//
// 数据链(P0 契约,见 fm.ts):源文拆成「fm 块原文 + 正文」,**编辑器只吃正文** ——
// fm 若喂进 Milkdown,首次落盘会被序列化成水平线+setext 标题(毁档)。保存 = fm + 正文原样拼回,
// 编辑器与 chrome(图标/封面/属性)共用这一条防抖整文件写盘管线(单写者,绝无 IPC 外科写竞态)。
//
// 外部回灌:等打字静默 → 重读 → fm 侧直接换状态,正文侧走**同实例最小差异事务**;回灌期间冻结保存。
// 本编辑器刻意不写 pageStore(陈旧快照经 reconcilePage 回写会复活旧内容,数据安全优先);
// 只读它的 focusTitleFor(新建流标题聚焦)与 pages(wiki 补全),写侧仅 refreshPages(纯刷新)。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { MilkdownProvider, useInstance } from '@milkdown/react'
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Pilcrow, Heading1, Heading2, Heading3, List, ListOrdered, ListTodo, TextQuote, ChevronsDown, Copy, Columns2, Trash2, Undo2, StickyNote } from 'lucide-react'
import { UI_MODE } from '@lcl/engine'
import { joinRel, toAssetUrl, toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'
import { amadeus } from '../api'
import { getAttachmentPrefs } from '../lib/attachments'
import { awaitTypingQuiet, installTypingGuard } from '../store/typingGuard'
import {
  DbLinkPicker, MilkdownInner, normalizeSerializedMd, stampedFileName,
  PREFIX_TRIGGERS, SLASH_SENTINELS, type SlashItem, type SlashOps,
} from '../blocks/markdown/MarkdownBlock'
import { emptyDb, emptyNoteView, serializeDb } from '@amadeus-shared/db/schema'
import { BLANK_SCENE_JSON, blankDrawing } from '@amadeus-shared/excalidraw/format'
import { fdDirOf } from '../lib/fd'
import { askString } from '../components/askString'
import { useFindStore } from '../blocks/markdown/findInPage'
import { FindBar } from '../components/PageView'
import { resolvePageName } from '@amadeus-shared/links'
import { resolveFileName } from '../lib/vaultFiles'
import { wikiFilesEnabled } from '../lib/wikiFiles'
import { usePageStore, useScopedPageStore, flushAllScopes, remapScopePaths, cascadeFdAfterRename } from '../store/pageStore'
// 模式胶囊复用 `.t2s-vaultseg`(见渲染处):样式真源是侧栏那张表。App 里 amadeusViews 已显式引过,
// 这里再引是给**独立挂载**兜底(harness / 只挂 UnifiedPage 的场景,不引就是一排裸按钮)。
import '../../views/chat2/sidebar2.css'
import { editorExtensionGen, subscribeEditorExtensions } from '../plugins/editorExtensions'
import { registerUnifiedPipe, retireUnifiedPath } from './lifecycle'
import { useUiOverlay } from '../../amadeusOverlayStore'
import { CanvasSegPortal } from './CanvasModeSeg'
import { AmadeusPropertiesPanel } from '../../amadeusProperties'
import { NoteCover, CoverPicker, IconPicker, randomEmoji, UNTITLED_RE } from '../chrome/pageChrome'
import { OverlayPortal } from '../lib/overlayPortal'
import { OverlayAt } from '../lib/clampMenu'
import { applyTrigger, type Trigger } from '../blocks/markdown/blockTriggers'
import { createBlockLayer } from './blockLayer'
import { columnPlugins, createColumnsFold, parseLayoutJson, deriveLayoutJson, splitToColumn, freshAnchorId } from './columns'
import { canvasPlugins, createCanvasFold, createSelectionClamp, createHistoryTimeline, createCardActiveDeco, parseCanvasJson, deriveCanvasJson, withElements, withTree, withMain, MAIN_W, type CanvasMain, type UndoTimeline } from './canvas'
import { CanvasStage, unwrapCard, blockToCard } from './canvasStage'
import { createEmbedLayer } from './embedLayer'
import { headingFoldPlugins } from './headingFold'
import { listFoldPlugins } from './listFold'
import { LinkHoverCard } from './linkCard'
import { splitFm, composeFm, patchFm, setForeignFm, foreignFmObject, foreignFmText, setAmadeusStructure, layoutLineOf, canvasLineOf, fixStructKeys } from './fm'

const SAVE_DEBOUNCE_MS = 800 // WsFileView 同款节奏(外部文件不抢 400ms 的 pageStore 节拍)

/** 标题回车的聚焦请求要跨「改名 → 实例随 key 重建」存活(重建清零一切组件态,只能挂模块级)。
 *  没有它:新建笔记打完名按回车,焦点刚进正文就被改名后的重建拆掉(P12b 实测)。 */
let pendingBodyFocus: { path: string; place: 'start' | 'body-enter' } | null = null

const NOOP_KEYS = {
  insertAfter: () => {},
  deleteEmpty: () => {},
  mergePrev: () => {},
  arrow: () => {},
  moveDir: () => {},
  selfFocus: () => {},
}

/** 顶层子节点级最小差异替换:首尾相同段跳过,只替换中间不同的范围。
 *  选区在范围外由 PM 映射自动保持;在范围内钳到边界。整文替换是它的退化情形。 */
function applyMinimalDiff(view: EditorView, next: ProseNode): void {
  const cur = view.state.doc
  if (next.eq(cur)) return
  let start = 0
  const maxStart = Math.min(cur.childCount, next.childCount)
  while (start < maxStart && cur.child(start).eq(next.child(start))) start++
  let endCur = cur.childCount
  let endNext = next.childCount
  while (endCur > start && endNext > start && cur.child(endCur - 1).eq(next.child(endNext - 1))) {
    endCur--
    endNext--
  }
  let from = 0
  for (let i = 0; i < start; i++) from += cur.child(i).nodeSize
  let to = from
  for (let i = start; i < endCur; i++) to += cur.child(i).nodeSize
  const repl: ProseNode[] = []
  for (let i = start; i < endNext; i++) repl.push(next.child(i))
  view.dispatch(view.state.tr.replaceWith(from, to, repl))
}

/** 保存/回灌管线的可变心脏(ref 持有,渲染无关)。 */
interface Pipe {
  fm: string
  body: string
  lastSaved: string
  pending: boolean
  timer: ReturnType<typeof setTimeout> | null
  reconcileBusy: boolean
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
}

interface HostApi {
  /** 外部回灌正文(stored md)→ 同实例最小差异事务;编辑器未挂载返回 false。 */
  applyBody: (stored: string) => boolean
  /** 当前 doc 立即序列化为 stored md(编辑器未挂载 = null)。flush 路径必用:listener 的
   *  markdownUpdated 有 200ms 防抖,pipe.body 可能落后最后几击(Codex A4:快打字后立刻
   *  改名/关页,不强制序列化就丢字)。 */
  serializeNow: () => string | null
  /** OS 拖入/上传按钮的文件:存附件 + 光标处插 `![[base]]`(经 lifecycle.insertFilesForPath 递入)。 */
  insertFiles: (files: File[]) => void
  focusStart: () => void
  focusEnd: () => void
  /** 尾部空白区点击(AFFiNE 语义):末行有内容 → 追加一个普通空段并落光标;已是空段 → 直接落。
   *  末块是卡片时空段追加在**卡尾**(v4 卡片区必须收尾,顶层追加会被 normalizer 吸回同一位置)。 */
  focusTail: () => void
}

function UnifiedEditorHost({ path, pageDir, body, onChange, onFinalFlush, skipFinalFlush, apiRef, probe, extraPlugins, focusPlace, onFocused }: {
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
}): ReactElement {
  const [, getInstance] = useInstance()
  const store = useScopedPageStore()
  // 传了它,MilkdownInner 的选中文字浮动工具栏与 slash 菜单才开(v3 同一道门)。
  const slashOps = useRef<SlashOps | null>(null)
  const [dbPick, setDbPick] = useState(false) // slash「链接数据库」唤起的已有 .db 选择器
  const finalFlushRef = useRef({ onFinalFlush, skipFinalFlush })
  finalFlushRef.current = { onFinalFlush, skipFinalFlush }
  useEffect(() => {
    apiRef.current = {
      applyBody: (stored) => {
        let ok = false
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const doc = ctx.get(parserCtx)(toDisplayMarkdown(stored, pageDir))
          if (!doc) return
          applyMinimalDiff(view, doc as ProseNode)
          ok = true
          if (probe) probe.reconciled = ((probe.reconciled as number) ?? 0) + 1
        })
        return ok
      },
      serializeNow: () => {
        let out: string | null = null
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const serializer = ctx.get(serializerCtx)
          // 必须与 markdownUpdated 监听器同一条规范化链(Codex 终审 P0:绕过=把 \[\[ 持久化成死链)。
          out = toStoredMarkdown(normalizeSerializedMd(serializer(view.state.doc)), pageDir)
        })
        return out
      },
      insertFiles: (files) => {
        void saveFiles(files)
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
    const marks = files.map((f, i) => `\u200b上传中 ${f.name || `文件${i + 1}`}\u200b`)
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const paragraph = view.state.schema.nodes.paragraph
      if (!paragraph) return
      const { $to } = view.state.selection
      let pos = $to.depth >= 1 ? $to.after(1) : view.state.doc.content.size
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
      const f = files[i]
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const { opts } = await getAttachmentPrefs()
        const { base } = await amadeus.saveAttachment(path, f.name || 'file', bytes, opts)
        replaceMark(marks[i], `![[${base}]]`)
      } catch {
        replaceMark(marks[i], null) // 保存失败:把占位撤掉,不留一行假内容
      }
    }
  }

  /** 把一段 markdown 插进当前文档:光标所在**顶层块**为空 → 原地替换;否则插到它之后。
   *  「顶层块」= doc 或分栏 cell 的直接子节点 —— 列内插入绝不许穿出到 doc 级(否则 /代码块
   *  在列里会插到整行下面)。列表项里插 = 插在整份列表之后(与 Tab 层同一套祖先判定)。
   *  v3 走的是 store 的 onChange/onInsertAfter(块世界);统一实例没有块 id,一切都是本 doc 的事务。 */
  const insertMd = (md: string): void => {
    getInstance()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const parsed = ctx.get(parserCtx)(toDisplayMarkdown(md, pageDir)) as ProseNode | undefined
      if (!parsed?.childCount) return
      const { $from } = view.state.selection
      let d = $from.depth
      while (d >= 1 && !['doc', 'amadeusColumnCell'].includes($from.node(d - 1).type.name)) d--
      if (d < 1) return
      const from = $from.before(d)
      const to = $from.after(d)
      const blank = $from.node(d).textContent.trim() === ''
      const content = parsed.content
      let tr = blank ? view.state.tr.replaceWith(from, to, content) : view.state.tr.insert(to, content)
      // 落点=插入内容的末尾(v3 的 requestSelfFocus('end') 同位):near() 会自己找最近的合法文字位。
      const end = Math.min((blank ? from : to) + content.size, tr.doc.content.size)
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(end)))
      view.dispatch(tr.scrollIntoView())
      view.focus()
    })
  }

  /** 建文件类 slash 项的落点守卫:await 期间用户可能已切走(实例退休/换页)。v3 靠 blockId 三道闸,
   *  统一实例只需一道 —— 编辑器还活着就还是同一篇(实例与路径同生共死,pipe.retired 会拆掉它)。 */
  const insertAsync = (md: string): void => {
    if (!apiRef.current) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: '文件已创建，但原插入位置已失效（笔记已切换）' } }))
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

  /** slash 选中项 → 统一实例的落地(v3 MarkdownBlock.applySlash 的对位实现)。
   *  前缀型(文本/标题/列表/待办/引用/折叠)走编辑器内单事务转换,不新建块;其余先消费 '/query',
   *  再按类型插入。「模板」在 unified 下不露出(见 UNIFIED_HIDDEN_SLASH)。 */
  const applySlash = (item: SlashItem): void => {
    const ops = slashOps.current
    if (!ops) return // fail closed:实例刚重挂/已销毁时不执行,免得删不掉的 '/query' 留成残渣
    const prefix = item.run ? undefined : PREFIX_TRIGGERS[item.scaffold]
    if (prefix) {
      ops.transform(prefix)
      return
    }
    ops.consume() // 返回值是「整篇是否空」,统一实例用不着:空块判定在 insertMd 里按当前顶层块算
    const S = SLASH_SENTINELS
    if (item.run) {
      // 插件注册的「先干活再插入」项。插件是 new Function 装载的第三方 JS,返回值一律当外部输入校验
      // (与 v3 同一套闸:非字符串会毒化文档,NUL/控制字符会污染笔记文件)。
      void (async () => {
        try {
          const md = await item.run!({ pagePath: path, folder: fdDirOf(path) })
          if (md === '' || md == null) return
          if (typeof md !== 'string') throw new Error(`run() 必须返回字符串,实际是 ${typeof md}`)
          if (md.length > 8192) throw new Error('run() 返回内容过长')
          // 控制字符逐码点判(放行 \t \n):正则字面量写法会把真控制字节带进源文件。
          if (Array.from(md).some((c) => c.charCodeAt(0) < 32 && c !== String.fromCharCode(9) && c !== String.fromCharCode(10))) {
            throw new Error('run() 返回内容含控制字符')
          }
          insertAsync(md)
          void store.getState().syncFdChildren(path)
        } catch (e) {
          console.error('[plugin] slash item failed', e)
          window.dispatchEvent(new CustomEvent('amadeus:toast', {
            detail: { text: `「${item.label}」失败：${e instanceof Error ? e.message : String(e)}`, error: true },
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
          window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: '分栏只能对顶层块使用，请先把这一块拖出当前列/列表' } }))
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
          const newPath = await st.createChildNote(path, '未命名')
          insertAsync(`[[${newPath.split('/').pop()!.replace(/\.md$/i, '')}]]`)
          void st.loadPage(newPath) // 本实例随之退休,onFinalFlush 把刚插的链接一并落盘
        } catch { /* 创建失败静默跳过 */ }
      })()
      return
    }
    if (item.scaffold === S.database) {
      void createFdFile('未命名数据库.db', new TextEncoder().encode(serializeDb(emptyDb('未命名数据库'))))
      return
    }
    if (item.scaffold === S.drawing) {
      // Obsidian Excalidraw 插件同款 .excalidraw.md(同一个库两边可互开);时间戳命名照抄它。
      void createFdFile(`${stampedFileName('画板')}.excalidraw.md`, new TextEncoder().encode(blankDrawing(BLANK_SCENE_JSON)), true)
      return
    }
    if (item.scaffold === S.noteview) {
      // 「笔记视图」(Bases 式,行即笔记):行文件夹与 .db 视图定义都落 .fd 子文件夹。
      void (async () => {
        const fdDir = fdDirOf(path)
        let folderRel: string | null = null
        for (let i = 1; i <= 20 && folderRel === null; i++) {
          try {
            folderRel = await amadeus.createFolder(fdDir, i === 1 ? '笔记视图' : `笔记视图 ${i}`)
          } catch { /* 撞名,试下一个 */ }
        }
        if (folderRel === null) return
        await createFdFile('未命名视图.db', new TextEncoder().encode(serializeDb(emptyNoteView('未命名视图', folderRel))))
      })()
      return
    }
    if (item.scaffold === S.linkdb) {
      setDbPick(true)
      return
    }
    if (item.scaffold === S.bookmark) {
      // 整块 = 一行裸 URL → 嵌入层渲染为书签卡(og 元数据/YouTube 播放器);md 零私有语法。
      void askString('插入书签', '', { label: '粘贴链接地址(https:// 开头);YouTube 链接会直接内嵌播放器。' }).then((raw) => {
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
          const m = /!\[\[([^\]\n]+)\]\]/.exec(await navigator.clipboard.readText())
          if (m) prefill = m[1].trim()
        } catch { /* clipboard unavailable */ }
        const raw = await askString('嵌入块引用', prefill, {
          label: '形如 笔记名#块ID(块菜单「复制嵌入引用」可得);也可只填笔记名嵌整篇首块。',
          confirmLabel: '嵌入',
        })
        const target = raw?.trim().replace(/^!?\[\[/, '').replace(/\]\]$/, '').trim()
        if (target) insertAsync(`![[${target}]]`)
      })()
      return
    }
    // 整块型(代码/表格/分隔线/公式/[[/按钮):scaffold 本身就是要插的 markdown。
    insertMd(item.scaffold)
  }

  return (
    <>
      <MilkdownInner
        initial={toDisplayMarkdown(body, pageDir)}
        onChange={(displayMd) => onChange(toStoredMarkdown(displayMd, pageDir))}
        keys={NOOP_KEYS}
        saveImage={saveImage}
        saveFiles={saveFiles}
        onOpenWiki={(name) => void store.getState().openWikiLink(name, path)}
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
        extraPlugins={extraPlugins}
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
function UnifiedTitle({ path, icon, cover, onSetIcon, onSetCover, onRename, onEnterBody, focusSignal }: {
  path: string
  icon: string | null
  cover: string | null
  onSetIcon: (em: string | null) => void
  onSetCover: (cover: string) => void
  /** 返回改名是否成功:失败(撞名/非法名)时输入框还原旧名,不留「显示新名实为旧名」的假象。 */
  /** focusKind = 触发本次 commit 的按键档(回车/方向键),点走 blur 恒 null —— 逐次绑定逐次消费,
   *  不用时间窗推断(Codex 深夜 F2:5 秒窗会把「回车后 5 秒内点走改名」误判成回车改名,凭空插首行抢焦点)。 */
  onRename: (next: string, focusKind: 'enter' | 'move' | null) => Promise<boolean>
  /** 'enter' = 回车确定标题(首块非空段则顶插空白首行);'move' = 方向键滑入正文(只落光标不插行)。 */
  onEnterBody: (kind: 'enter' | 'move') => void
  /** 新建流:挂载即聚焦标题(消费 pageStore.focusTitleFor 后由父级置真)。 */
  focusSignal: boolean
}): ReactElement {
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
      {(!icon || !cover) && (
        <div className="amx-title-actions">
          {!icon && <button onClick={() => onSetIcon(randomEmoji())}>☺ 添加图标</button>}
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

export function UnifiedPage({ path, initial, diskRaw, probe, onRenamed }: {
  path: string
  /** router 已读到的源文(打开即升场景是升级后的 v4 源)。 */
  initial: string
  /** 磁盘上的原始字节(打开即升场景 ≠ initial):回灌基线必须用它 —— 否则挂载补读会把
   *  盘上旧 v3 原文当外部更新灌回编辑器,升级当场被冲掉(Codex 终审)。缺省 = initial。 */
  diskRaw?: string
  probe?: Record<string, unknown>
  /** 行内改名成功 → 通知宿主换 leaf 参数(路径变了,本实例随 key 重建)。 */
  onRenamed?: (newPath: string) => void
}): ReactElement {
  const pageDir = path.split('/').slice(0, -1).join('/')
  const scoped = useScopedPageStore()
  const mode = useUiOverlay((s) => s.editorMode)

  const pipeRef = useRef<Pipe | null>(null)
  if (!pipeRef.current) {
    const { fmText, body } = splitFm(initial)
    pipeRef.current = { fm: fmText, body, lastSaved: diskRaw ?? initial, pending: false, timer: null, reconcileBusy: false, dead: false, retired: false, sawRows: false, ownedCards: new Set(), chain: Promise.resolve() }
  }
  const pipe = pipeRef.current
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

  // ── 画布模式(canvas.ts / canvasStage.tsx)。────────────────────────────────────
  // **默认恒为文档模式**(用户 2026-08-16 原话:「它首先是个文档」)。只有磁盘上已经物化过画布、
  // 且上次退出时停在画布模式,打开才直接进画布 —— 没有 amadeus_canvas 键的笔记永远从文档进。
  // 移动端**忽略持久化的 mode:"canvas"**,恒从文档进(方案 §6.1,Codex P1):mode 是跨设备
  // 持久化的,而手机上的画布 Phase 1 只是只读查看 —— 不挡的话「在桌面切到画布」会让同一篇笔记
  // 在手机上打开就变成只读,用户完全不知道发生了什么。手机要看画布,自己点模式钮。
  const [canvasOn, setCanvasOn] = useState(() => UI_MODE !== 'mobile' && parseCanvasJson(canvasLineOf(pipe.fm))?.mode === 'canvas')
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
    canvasModeRef.current = next
    modeTouched.current = true
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
  /** 白板元素落盘。cards 的真源是 doc(deriveCanvasJson 派生),**elements 的真源是磁盘那行** ——
   *  所以这一支不经 deriveFmFromDoc,直接换掉 canvas 行里的 elements 键、其余字段逐字保留。
   *  ⚠️ 那行读不懂时(手改坏的 JSON)当面说、什么都不写:withElements 会逐字返回原行,
   *  静默丢改动比报错更糟 —— 用户会以为画了、下次打开发现没了。 */
  const setCanvasElements = (next: unknown[]): void => {
    const stored = canvasLineOf(pipe.fm)
    if (stored != null && parseCanvasJson(stored) == null) {
      window.dispatchEvent(new CustomEvent('amadeus:toast', {
        detail: { text: '画布改动没能保存:这篇笔记的 amadeus_canvas 行无法解析,请在源码模式检查', error: true },
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
        detail: { text: '层级改动没能保存:这篇笔记的 amadeus_canvas 行无法解析,请在源码模式检查', error: true },
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
        detail: { text: '主卡改动没能保存:这篇笔记的 amadeus_canvas 行无法解析,请在源码模式检查', error: true },
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
  const segAnchorRef = useRef<HTMLSpanElement | null>(null)
  const [segAnchor, setSegAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => { setSegAnchor(segAnchorRef.current) }, [])
  // 满铺靠**给滚动容器加个类**,而不是给 `.amx-pane` 全局加 `position: relative` ——
  // 那会把面板里所有「本来解析到更外层」的绝对定位后代一起改锚点(浮层整体偏一个容器位是本仓的老账)。
  // 只在本笔记进画布期间挂,退出/卸载即摘。顶栏 sticky 且 z-index:3,满铺层压不住它,照旧可点。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const pane = bodyRef.current?.closest('.amx-pane')
    if (!pane) return
    pane.classList.toggle('amx-canvas-pane', fullCanvas)
    return () => pane.classList.remove('amx-canvas-pane')
  }, [fullCanvas])

  // 标题 → 正文的聚焦请求(consume-when-ready):挂载时吃掉跨重建的 pending(改名回车场景)。
  const [bodyFocus, setBodyFocus] = useState<'start' | 'end' | 'body-enter' | null>(() => {
    if (pendingBodyFocus?.path === path) {
      const place = pendingBodyFocus.place
      pendingBodyFocus = null
      return place
    }
    return null
  })

  // ── 块交互层(⠿/＋/拖拽/块选中):插件稳定引用,菜单由这里渲染。────────────────────
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number } | null>(null)
  const layer = useMemo(() => createBlockLayer({ onMenu: (at) => setBlockMenu(at) }), [])
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
      ...createEmbedLayer({ path }),
      // 画布模式的两个编辑器侧插件(2026-08-18):跨卡选区夹断 + 统一撤销时间线的 PM 记账。
      // 都经闭包/共享对象现读状态,文档模式下零行为(夹断有 inCanvas 闸,记账在文档模式照记 ——
      // 时间线只在画布模式被查询,顺序跨模式仍然成立)。
      ...createSelectionClamp(() => canvasModeRef.current),
      ...createHistoryTimeline(undoTimeline),
      // 文档模式的「光标在哪张卡」标注(约束框 CSS 只在文档模式消费,画布下类挂着无害)。
      ...createCardActiveDeco(),
      ...headingFoldPlugins,
      ...listFoldPlugins,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer, path],
  )
  useEffect(() => {
    if (!blockMenu) return
    // 捕获期收(v3 BlockHost 同款):打开路径的 stopPropagation 到不了 window 冒泡,得在捕获期看目标。
    const close = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.ctx-menu')) return
      setBlockMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('contextmenu', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('contextmenu', close, true)
    }
  }, [blockMenu])
  /** 菜单动作作用在当前 NodeSelection 上(点 ⠿ 的 mousedown 已由交互层设好)。 */
  const withSelectedNode = (fn: (view: EditorView, sel: NodeSelection) => void): void => {
    setBlockMenu(null)
    const view = layer.getView()
    if (!view) return
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
    if (!view) return
    const r = layer.topRangeOf(view)
    if (r) multi(view, r)
    else if (view.state.selection instanceof NodeSelection) single(view, view.state.selection)
    view.focus()
  }
  const turnInto = (trig: Trigger): void => withSelectedNode((view, sel) => {
    // applyTrigger 作用在光标所在文本块:先把光标落进节点首个文本块,再走 v3 同一套转换引擎。
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(sel.from + 1))))
    applyTrigger(view, trig, null)
  })

  const writeNow = (): Promise<void> => {
    const run = async (): Promise<void> => {
      if (pipe.retired) return
      const text = composeFm(pipe.fm, pipe.body) // 执行时 compose:链上永远写「此刻」的状态
      if (text === pipe.lastSaved) {
        pipe.pending = false
        return
      }
      try {
        await amadeus.writeTextFile(path, text)
        pipe.lastSaved = text
        // 只有「写的就是此刻的状态」才算清账(Codex A9):await 期间落进来的新编辑不能被
        // 旧写入顺手抹掉 dirty 标志,否则回灌会把脏编辑器当干净实例覆盖。
        if (composeFm(pipe.fm, pipe.body) === text) pipe.pending = false
      } catch {
        pipe.pending = true // 写失败:下一次编辑/卸载再试
      }
    }
    pipe.chain = pipe.chain.then(run)
    return pipe.chain
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
    if (pipe.dead || pipe.retired) return
    if (composeFm(pipe.fm, pipe.body) === pipe.lastSaved) return
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
    pipe.fm = patchFm(pipe.fm, patch)
    setFmVer((v) => v + 1)
    syncSrcDraft()
    if (immediate) {
      pipe.pending = true
      void writeNow().then(() => { void usePageStore.getState().refreshPages() }) // 侧栏 emoji 跟上
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
      const t = e.target as HTMLElement | null
      if (!t || t.tagName !== 'IMG') return
      if (!t.closest('.unified-body')) return
      const src = (t as HTMLImageElement).currentSrc || (t as HTMLImageElement).src
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

  // 页内查找:卸载/换页必须 close() —— UNIFIED_FIND_ID 那一格若留在 counts 里,
  // findTotal 会一直走统一实例的捷径,v3 页面的跨块计数全被它顶掉(见 findInPage 注)。
  const findOpen = useFindStore((s) => s.open)
  useEffect(() => () => useFindStore.getState().close(), [path])

  // 外部回灌:等静默 → 重读 → fm 换状态 + 正文同实例最小差异。回灌期间冻结保存。
  useEffect(() => {
    const reconcile = async (): Promise<void> => {
      pipe.reconcileBusy = true
      try {
        await awaitTypingQuiet()
        const raw = await amadeus.readTextFile(path)
        if (raw == null || pipe.dead || pipe.retired) return // 读失败/已卸载:保持现状,绝不清空
        if (raw === pipe.lastSaved && !pipe.pending) return // 自写回声兜底
        if (pipe.pending) {
          // 冲突策略(Codex P0「冻结期本地输入被吞」):本地有未落盘编辑 → **活动编辑器赢**。
          // 只把基线换成盘上版本,不动编辑器;finally 的补发把本地内容写盘(外部那版被覆盖 ——
          // 有损但显性一致,绝不静默丢用户正在打的字)。
          pipe.lastSaved = raw
          return
        }
        const { fmText, body } = splitFm(raw)
        // 结构键行变没变要在换 pipe.fm **之前**判(Codex P0-4)。
        const structChanged = layoutLineOf(fmText) !== layoutLineOf(pipe.fm) || canvasLineOf(fmText) !== canvasLineOf(pipe.fm)
        pipe.fm = fmText // fold 闭包现读 pipe.fm:此行必须先于 applyBody 的重 parse(advisor)
        setFmVer((v) => v + 1)
        if (body !== pipe.body) {
          pipe.ownedCards.clear() // 归属集合按 parse 世代重建,绝不跨 parse 锁存(Codex P0-5)
          if (hostApi.current?.applyBody(body)) {
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
        syncSrcDraft() // 源码模式下回灌:textarea 草稿必须跟上,否则下一击键用旧草稿盖掉刚回灌的内容(Codex 终审 P0)
      } finally {
        pipe.reconcileBusy = false
        if (pipe.pending) void writeNow() // 冻结期被压下的保存补发
      }
    }
    const off = amadeus.onExternalChange?.((p: string) => {
      if (p !== path) return
      void reconcile()
    })
    // 路由读文件 → 本效应装订阅之间有一扇空窗(Codex P1):装完补读一次,
    // 空窗里若有外部写入,走同一条回灌路径;无变化则 raw===lastSaved 直接返回。
    void reconcile()
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 卸载/刷新:立刻冲洗待写(同步启动写,不等防抖;先拉平编辑器最后几击)。
  useEffect(() => {
    const flush = (): void => {
      syncFromEditor()
      if (pipe.timer) clearTimeout(pipe.timer)
      pipe.timer = null
      void writeNow()
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      pipe.dead = true
      window.removeEventListener('beforeunload', flush)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 生命周期登记(Codex P0):换库前 flushAllScopes 要等我们落盘;删除/改名/移动要能叫停本实例
  // (防抖写复活刚删/刚移走的文件)。
  useEffect(() => {
    return registerUnifiedPipe({
      path,
      flush: () => {
        syncFromEditor()
        if (pipe.timer) {
          clearTimeout(pipe.timer)
          pipe.timer = null
        }
        return writeNow()
      },
      insertFiles: (files) => {
        hostApi.current?.insertFiles(files)
      },
      retire: () => {
        pipe.retired = true
        if (pipe.timer) {
          clearTimeout(pipe.timer)
          pipe.timer = null
        }
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

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
    probe.view = () => layer.getView() // 仪器直驱 PM 事务(分栏 spike/检查用)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe])

  // 新建流:createPageInFolder 落 focusTitleFor → 挂载即聚焦标题(Notion 式先命名)。
  const [titleFocus, setTitleFocus] = useState(false)
  useEffect(() => {
    const st = scoped.getState()
    if (st.focusTitleFor === path) {
      st.consumeTitleFocus()
      setTitleFocus(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const doRename = async (next: string, focusKind: 'enter' | 'move' | null = null): Promise<boolean> => {
    try {
      syncFromEditor() // 快打字后立刻回车改名:先拉平防抖窗里的最后几击(Codex A4)
      await writeNow() // 待写先落旧路径(chain 串行:在途写全部排完)
      await flushAllScopes() // 全库 [[链接]] 重写前,其它面板待存文本先落盘
      const newPath = await amadeus.renamePageFile(path, next)
      if (newPath !== path) {
        pipe.retired = true // 本实例退休:再写旧路径 = 复活幽灵文件
        // 改名 IPC 窗口里刚打的字不该丢(Codex P0):按新路径补一发,随 key 重建被读回。
        // IPC await 期间可能又打了字(200ms 监听窗)→ 补写前再拉平一次(Codex 终审 P0)。
        syncFromEditor()
        const text = composeFm(pipe.fm, pipe.body)
        if (text !== pipe.lastSaved) await amadeus.writeTextFile(newPath, text).catch(() => {})
        retireUnifiedPath(path) // 别的标签开着同一篇:一并停写旧路径
        remapScopePaths(path, newPath, 'file')
        await cascadeFdAfterRename(path, newPath)
        void usePageStore.getState().refreshPages()
        // 回车/方向键触发的改名:聚焦请求跨重建带给新实例(点走 blur 的改名 focusKind=null,不抢焦点)。
        // 档位由**本次 commit** 逐次携带(Codex 深夜 F2:原 5 秒时间窗会把「回车后 5 秒内点走改名」
        // 误判成回车改名 —— 凭空顶插空段还把焦点从用户点的控件抢回正文)。
        if (focusKind) pendingBodyFocus = { path: newPath, place: focusKind === 'enter' ? 'body-enter' : 'start' }
        onRenamed?.(newPath)
      }
      return true
    } catch {
      return false // 撞名/非法名:调用方(UnifiedTitle)把输入框还原成旧名
    }
  }

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
      {fullCanvas ? null : (
        <NoteCover
          page={path}
          cover={cover}
          coverY={coverY}
          onSetCover={(c) => setFm({ cover: c ?? undefined, ...(c ? {} : { cover_y: undefined }) })}
          onSetCoverY={(y) => setFm({ cover_y: y })}
        />
      )}
      {fullCanvas ? null : (
      <div className="amx-doc unified-page" data-unified-path={path}>
        <UnifiedTitle
          path={path}
          icon={icon}
          cover={cover}
          onSetIcon={(em) => setFm({ icon: em ?? undefined })}
          onSetCover={(c) => setFm({ cover: c })}
          onRename={doRename}
          onEnterBody={(kind) => setBodyFocus(kind === 'enter' ? 'body-enter' : 'start')}
          focusSignal={titleFocus}
        />
        <AmadeusPropertiesPanel
          fmExtra={foreignFmText(pipe.fm)}
          onCommit={(yaml) => {
            pipe.fm = setForeignFm(pipe.fm, yaml)
            setFmVer((v) => v + 1)
            syncSrcDraft()
            pipe.pending = true
            void writeNow()
          }}
        />
      </div>
      )}
      {mode === 'source' ? (
        <textarea
          ref={srcTaRef}
          className="amx-source"
          value={srcDraft ?? srcText}
          spellCheck={false}
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
          onKeyDownCapture={(e) => {
            // 编辑器内 Cmd/Ctrl+F → 页内查找(与 v3 PageView 同一道门:焦点在编辑器里才接管,
            // 别抢应用全局查找)。统一实例整篇一个编辑器,命中计数走 UNIFIED_FIND_ID 单格。
            if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
              e.preventDefault()
              useFindStore.getState().openBar()
            }
          }}
        >
          {findOpen && <FindBar />}
          {/* 模式钮(AFFiNE 同位:页面右上)。整篇零画布数据时也照常显示 —— 画布是任意笔记随时
              可用的能力,不是某种文件类型的特权;点进去只是换视角,不写盘(见 toggleCanvas)。 */}
          <CanvasStage
            path={path}
            active={canvasOn}
            getView={() => layer.getView()}
            main={canvasMain}
            mainStored={canvasDoc?.main != null}
            elements={canvasDoc?.elements}
            tree={canvasDoc?.tree}
            onElements={setCanvasElements}
            onTree={setCanvasTree}
            onMain={setCanvasMain}
            timeline={undoTimeline}
            onCommit={(newRef) => {
              if (newRef) pipe.ownedCards.add(newRef) // 本实例建的卡也算「负责得起」,见 deriveCanvasJson
              syncFromEditor() // 版本推送在 deriveFmFromDoc 里(canvas 行真变了才推)
              schedule()
            }}
          >
            <MilkdownProvider key={`${path}:${editorKey}:${extGen}`}>
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
                skipFinalFlush={() => pipe.reconcileBusy}
                apiRef={hostApi}
                probe={probe}
                extraPlugins={editorPlugins}
                focusPlace={bodyFocus}
                onFocused={() => setBodyFocus(null)}
              />
            </MilkdownProvider>
          </CanvasStage>
          {!canvasOn && <div className="page-tail" onClick={() => hostApi.current?.focusTail()} />}
        </div>
      )}
      <LinkHoverCard getView={() => layer.getView()} />
      {lightbox && (
        <OverlayPortal>
          <div className="amx-lightbox" onClick={() => setLightbox(null)} role="presentation">
            <img src={lightbox} alt="" />
          </div>
        </OverlayPortal>
      )}
      {blockMenu && (
        <OverlayPortal>
          <OverlayAt className="ctx-menu unified-block-menu" x={blockMenu.x} y={blockMenu.y} onClick={(e) => e.stopPropagation()}>
            <div className="ubm-label">转换为</div>
            <button onClick={() => turnInto({ kind: 'text' })}><Pilcrow size={13} /> 正文</button>
            <button onClick={() => turnInto({ kind: 'heading', level: 1 })}><Heading1 size={13} /> 标题 1</button>
            <button onClick={() => turnInto({ kind: 'heading', level: 2 })}><Heading2 size={13} /> 标题 2</button>
            <button onClick={() => turnInto({ kind: 'heading', level: 3 })}><Heading3 size={13} /> 标题 3</button>
            <button onClick={() => turnInto({ kind: 'bullet' })}><List size={13} /> 无序列表</button>
            <button onClick={() => turnInto({ kind: 'ordered' })}><ListOrdered size={13} /> 有序列表</button>
            <button onClick={() => turnInto({ kind: 'task' })}><ListTodo size={13} /> 待办</button>
            <button onClick={() => turnInto({ kind: 'quote' })}><TextQuote size={13} /> 引用</button>
            <button onClick={() => turnInto({ kind: 'fold' })}><ChevronsDown size={13} /> 折叠</button>
            <div className="ubm-sep" />
            <button onClick={() => withSelectedNode((view, sel) => {
              splitToColumn(view, sel.from, sel.to, sel.node) // 与 slash「分栏」共用(columns.ts)
            })}>
              <Columns2 size={13} /> 移到新列
            </button>
            {/* 显式「块 → 画布」入口(2026-08-18,评审 P1「核心动作太依赖隐藏手势」):此前唯一的
                入口是画布模式下把 ⠿ 拖到舞台空白。摆位是启发式(主卡右侧、按已有卡数下移错开)。
                条件渲染与 blockToCard 的排除清单一致 —— 对做不了卡的块显示菜单项是纯噪音。 */}
            {(() => {
              const v = layer.getView()
              const s = v?.state.selection
              if (!v || !(s instanceof NodeSelection)) return null
              if (['amadeusCanvasCard', 'amadeusColumnRow', 'amadeusColumnCell', 'list_item'].includes(s.node.type.name)) return null
              const $at = v.state.doc.resolve(s.from)
              for (let d = $at.depth; d >= 1; d--) if ($at.node(d).type.name === 'amadeusColumnCell') return null
              return (
                <button onClick={() => withSelectedNode((view) => {
                  let n = 0
                  view.state.doc.forEach((node) => { if (node.type.name === 'amadeusCanvasCard') n++ })
                  const made = blockToCard(view, Math.round(canvasMain.x + canvasMain.w + 80), Math.round(canvasMain.y + n * 72))
                  if (!made) return
                  pipe.ownedCards.add(made)
                  syncFromEditor()
                  schedule()
                  if (!canvasModeRef.current) {
                    window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: '已放到画布 —— 右上角切到画布模式查看' } }))
                  }
                })}>
                  <StickyNote size={13} /> 放到画布
                </button>
              )
            })()}
            {/* 卡片才有:把卡收回自然流(拖回主卡的键鼠等价物 —— 文档模式下没有舞台可拖)。
                条件渲染而不是「点了才 return」:对普通段落也显示一个点了没反应的菜单项是纯噪音。 */}
            {layer.getView()?.state.selection instanceof NodeSelection
              && (layer.getView()!.state.selection as NodeSelection).node.type.name === 'amadeusCanvasCard' && (
              <button onClick={() => withSelectedNode((view, sel) => {
                if (sel.node.type.name !== 'amadeusCanvasCard') return
                unwrapCard(view, String(sel.node.attrs.anchor))
                syncFromEditor()
                schedule()
              })}>
                <Undo2 size={13} /> 收回文档
              </button>
            )}
            <button onClick={() => withBlocks(
              // 跨块选区:整批复制(AFFiNE 的 Duplicate 也是「只选半行也复制整块」)。
              (view, r) => view.dispatch(view.state.tr.insert(r.to, view.state.doc.slice(r.from, r.to).content).scrollIntoView()),
              (view, sel) => {
                // ⚠️ 画布卡片必须换新锚再复制(Codex P0-6):原样插入会得到两个 anchor=c1,派生写出
                // 重复 ref,下次打开 parseCanvasJson 判歧义**整键作废** —— 全部画布卡一起失效。
                if (sel.node.type.name === 'amadeusCanvasCard') {
                  const anchor = freshAnchorId(view.state.doc)
                  const copy = sel.node.type.create({ ...sel.node.attrs, anchor, x: Number(sel.node.attrs.x) + 40, y: Number(sel.node.attrs.y) + 40 }, sel.node.content)
                  view.dispatch(view.state.tr.insert(sel.to, copy).setMeta('amxCanvas', true))
                  pipe.ownedCards.add(anchor)
                  syncFromEditor()
                  schedule()
                  return
                }
                view.dispatch(view.state.tr.insert(sel.to, sel.node))
              },
            )}>
              <Copy size={13} /> 复制块
            </button>
            <button className="danger" onClick={() => withBlocks(
              (view, r) => view.dispatch(view.state.tr.delete(r.from, r.to).scrollIntoView()),
              (view) => view.dispatch(view.state.tr.deleteSelection().scrollIntoView()),
            )}>
              <Trash2 size={13} /> 删除
            </button>
          </OverlayAt>
        </OverlayPortal>
      )}
    </>
  )
}
