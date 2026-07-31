import { Suspense, createContext, lazy, memo, useContext, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { stripPageBasename } from '@amadeus-shared/compiler/names'
import { toAssetUrl } from '@amadeus-shared/assets'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import type { EmbedResolved } from '@amadeus-shared/ipc'
import { getBlockType } from '../blocks/registry'
import { DatabaseEmbed } from '../blocks/database/DatabaseEmbed'
import { ExcalidrawEmbed } from '../blocks/excalidraw/ExcalidrawEmbed'
import { BookmarkCard } from './BookmarkCard'
import { ButtonBlock } from '../blocks/button/ButtonBlock'
import { parseButtonBlock, serializeButtonBlock } from '../blocks/button/format'
import { useBlockSelection } from '../store/blockSelection'
import { useClampedMenu } from '../lib/clampMenu'
import { OverlayPortal } from '../lib/overlayPortal'
import { usePageStore, useScopedPageStore } from '../store/pageStore'
import { usePluginStore, findEmbedRenderer } from '../plugins/pluginStore'
import { PluginEmbed } from '../blocks/plugin/PluginEmbed'
import { amadeus } from '../api'
import { resolveFileName } from '../lib/vaultFiles'

// PDF 预览用自家可批注阅读器的只读形态(Chromium 内置 iframe 阅读器观感突兀且不认主题)。
// 懒加载:pdf.js viewer 较重,chunk 与独立 PDF 视图共用,笔记里真有 PDF 块才拉。
const PdfEmbedViewer = lazy(() => import('../pdf/PdfAnnotator').then((m) => ({ default: m.PdfAnnotator })))

const noop = (): void => {}

/** A host surface (e.g. the mindmap plugin's canvas) that OWNS block structure. When present, a block's
 *  NOTE-structural editor commands are neutralized — backspace-merge / delete-empty at the edges,
 *  move up/down, arrow-out to a flat-adjacent block — because in a mindmap those keystrokes would
 *  silently create orphan roots / delete nodes / move content between unrelated nodes.
 *  `insertAfter` is NOT neutralized but REROUTED: content that can't be merged into the current
 *  block (a `/数据库` `![[x.db]]` scaffold, a code block, Shift+Enter) must still land somewhere —
 *  the surface decides where (a mindmap makes it a child node). Dropping it on the floor is how a
 *  `/数据库` in a non-empty node became "创建了文件但什么也没出现" (user-reported).
 *  Content editing, the slash menu, embeds and wiki links always stay. */
export interface BlockSurface {
  insertAfter: (blockId: string, content: string) => void
}
export const BlockSurfaceContext = createContext<BlockSurface | null>(null)

/** A block whose entire content is a single `![[ ]]` is a cross-note embed. */
const EMBED_RE = /^!\[\[([^\]\n]+)\]\]$/
/** `![[pic.png]]` (optionally `![[pic.png|width]]`) is an image transclusion, not a block embed. */
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
/** `![[report.pdf]]` — a non-image file transclusion (has a file extension, no block anchor `#`) → file card. */
const FILE_EXT_RE = /\.[a-z0-9]{1,8}$/i
/** `![[tasks.db]]` — a Database file transclusion → interactive table (see blocks/database). */
const DB_EXT_RE = /\.db$/i
/* 可内联预览的文件类型(经 amadeus-asset:// 协议;PDF 用 Chromium 内置阅读器,音视频靠协议的 Range 支持 seek)。 */
const PDF_EXT_RE = /\.pdf$/i
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac)$/i

/** 嵌入块“二次选中”时,预览上方浮出的可编辑源码行(![[目标]])。回车/失焦提交→重解析,Esc 取消。
 *  刻意用原生 <input>(非 mini 编辑器):就一行链接文本,所见即所得改目标即可。 */
function EmbedSourceLine({
  content,
  onCommit,
  onDone,
}: {
  content: string
  onCommit: (v: string) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const valRef = useRef(content) // 追踪当前值,供卸载兜底提交(此时 DOM 可能已 detach)
  const done = useRef(false)
  // done 闩:Enter/Esc/blur/卸载 只认第一次。提交值取自 valRef,不依赖仍挂载的 DOM。
  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) {
      const v = valRef.current.trim()
      if (v && v !== content.trim()) onCommit(v)
    }
    onDone()
  }
  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.select() // 刻意编辑触发(双击):全选待重打。被动 arrow-in 触发已押后,不会误全选覆盖
    }
    // 卸载兜底提交:外部点击清 activeEmbed 会直接卸载本组件,触控/笔/滚动条/程序化导航未必先触发 blur;
    // 不在此提交则用户改的 ![[目标]] 被静默丢弃(Codex M5)。已 Enter/Esc/blur 过则 done 闩令其空转。
    return () => finishRef.current(true)
  }, [])
  return (
    <div className="block-body embed-src-line">
      <input
        ref={ref}
        className="embed-src-input"
        defaultValue={content}
        spellCheck={false}
        onChange={(e) => {
          valRef.current = e.currentTarget.value
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(false)
          }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  )
}

/** Universal wrapper around any block: drag handle + actions + the resolved BlockType editor.
 *  A block whose content is just `![[note#id]]` renders the target read-only with a source link. */
export const BlockHost = memo(function BlockHost({
  blockId,
  autoFocus,
  readOnly,
}: {
  blockId: string
  autoFocus?: boolean
  /** 只读呈现(Dashboard 的「编辑锁定」浏览态):文字不可改、无斜杠菜单,但双链可点、嵌入照常活。 */
  readOnly?: boolean
}) {
  const ps = useScopedPageStore() // 本面板那份文档 store:写操作绝不能落到隔壁半屏那篇去
  const block = usePageStore((s) => s.blocks[blockId])
  const setBlockContent = usePageStore((s) => s.setBlockContent)
  const insertBlockAfter = usePageStore((s) => s.insertBlockAfter)
  const duplicateBlock = usePageStore((s) => s.duplicateBlock)
  const splitToColumn = usePageStore((s) => s.splitToColumn)
  const deleteBlock = usePageStore((s) => s.deleteBlock)
  const deleteBlockFocusPrev = usePageStore((s) => s.deleteBlockFocusPrev)
  const mergeWithPrev = usePageStore((s) => s.mergeWithPrev)
  const focusAdjacent = usePageStore((s) => s.focusAdjacent)
  const moveBlockDir = usePageStore((s) => s.moveBlockDir)
  const requestFocus = usePageStore((s) => s.requestFocus)
  const consumeFocus = usePageStore((s) => s.consumeFocus)
  const openWikiLink = usePageStore((s) => s.openWikiLink)
  const focusPlace = usePageStore((s) => (s.focusRequest?.id === blockId ? s.focusRequest.place : null))
  const focusGoalX = usePageStore((s) => (s.focusRequest?.id === blockId ? s.focusRequest.goalX : undefined))
  const focusAnchor = usePageStore((s) => (s.focusRequest?.id === blockId ? s.focusRequest.anchor : undefined))
  const isDropTarget = usePageStore(
    (s) => s.dndOverId === blockId && s.dndActiveId !== null && s.dndActiveId !== blockId,
  )
  const pagePath = usePageStore((s) => s.activePage ?? '')
  const surface = useContext(BlockSurfaceContext) // mindmap 等宿主:接管结构语义(见 context 注释)
  const embedRenderers = usePluginStore((s) => s.embedRenderers)
  const selected = useBlockSelection((s) => s.ids.has(blockId))
  const isActiveEmbed = useBlockSelection((s) => s.activeEmbed === blockId)
  // linkGraphVersion 每次 save 都 bump;只有嵌入块(![[...]])需要跟着重解析。
  // 纯文本块订阅恒 0 → 不再「每次保存全页重渲染」(大页高频打字时的隐性卡源)。
  const linkVersion = usePageStore((s) =>
    (s.blocks[blockId]?.content ?? '').includes('![[') ? s.linkGraphVersion : 0,
  )

  const embedTarget = useMemo(() => {
    const m = EMBED_RE.exec((block?.content ?? '').trim())
    return m ? m[1] : null
  }, [block?.content])

  // `![[pic.png|200]]` → image transclusion: resolve the target (basename or vault path) to an
  // asset URL; the main asset protocol finds a bare basename anywhere in the vault (Obsidian-style).
  const embedImage = useMemo(() => {
    if (!embedTarget) return null
    const [rawPath, size] = embedTarget.split('|')
    const p = rawPath.trim()
    if (!IMG_EXT_RE.test(p)) return null
    const w = size?.trim()
    return { url: toAssetUrl(p), width: w && /^\d+$/.test(w) ? Number(w) : undefined, name: p }
  }, [embedTarget])

  // `![[xxx.db]]` → Database 嵌入(交互式表格,数据在独立 .db 文件;必须先于 embedFile 判定)。
  const embedDb = useMemo(() => {
    if (!embedTarget || embedImage) return null
    const [rawPath, viewName] = embedTarget.split('|') // `![[tasks.db|看板]]` 的管道段 = 激活视图名(存笔记 md,不碰 .db)
    const t = rawPath.trim()
    if (t.includes('#') || !DB_EXT_RE.test(t)) return null
    return { name: t, view: viewName?.trim() || null }
  }, [embedTarget, embedImage])

  // `![[画板.excalidraw]]` → Excalidraw 画板(文件其实是 `画板.excalidraw.md`,Obsidian 链接省略 .md 的
  // 惯例;主进程解析 ref 时会补回来)。同 embedDb:必须先于 embedFile 判定,否则被文件卡吃掉。
  const embedDraw = useMemo(() => {
    if (!embedTarget || embedImage || embedDb) return null
    const t = embedTarget.split('|')[0].trim()
    return !t.includes('#') && isDrawingPath(t) ? t : null
  }, [embedTarget, embedImage, embedDb])

  // 插件声明的文件类型嵌入(如 `![[x.mindmap.md]]`)→ 插件自渲染只读预览块。必须先于 embedFile,否则被文件卡吃掉。
  const embedPlugin = useMemo(() => {
    if (!embedTarget || embedImage || embedDb || embedDraw) return null
    // 先拿**完整 target** 问一次插件 matcher:`#` 和 `|` 也可以是文件夹/文件名的一部分
    // (笔记 `C# 日记.md` → `![[C# 日记.fd/x.mindmap.md]]`),无条件按 `#`/`|` 切断会把它误判成块锚点/别名
    // 而拒绝渲染(Codex)。完整串仍以插件声明的后缀结尾,足以与真正的 `file#block` 区分。
    const raw = embedTarget.trim()
    if (findEmbedRenderer(embedRenderers, raw)) return raw
    const t = raw.split('|')[0].trim()
    if (t.includes('#')) return null
    return findEmbedRenderer(embedRenderers, t) ? t : null
  }, [embedTarget, embedImage, embedDb, embedDraw, embedRenderers])

  // Non-image file (has an extension, no block anchor) → inline preview (pdf/video/audio) or file card.
  const embedFile = useMemo(() => {
    if (!embedTarget || embedImage || embedDb || embedDraw || embedPlugin) return null
    const t = embedTarget.split('|')[0].trim()
    if (t.includes('#') || !FILE_EXT_RE.test(t)) return null
    const kind = PDF_EXT_RE.test(t) ? 'pdf' : VIDEO_EXT_RE.test(t) ? 'video' : AUDIO_EXT_RE.test(t) ? 'audio' : 'other'
    return { name: t, kind, url: kind === 'other' ? '' : toAssetUrl(t) }
  }, [embedTarget, embedImage, embedDb, embedDraw, embedPlugin])
  const [previewOpen, setPreviewOpen] = useState(true)
  // PDF 嵌入:链接目标(可能是裸文件名)→ vault 路径,给只读阅读器读字节;解析不出退回 iframe。
  const vaultFiles = usePageStore((s) => s.files)
  const pdfVaultPath = useMemo(
    () => (embedFile?.kind === 'pdf' ? resolveFileName(embedFile.name, vaultFiles, pagePath) : null),
    [embedFile, vaultFiles, pagePath],
  )

  // 整块恰是一条裸 URL → 书签卡(og 元数据/YouTube 嵌入);md 落盘仍是那行 URL,零私有语法。
  const bookmarkUrl = useMemo(() => {
    const t = (block?.content ?? '').trim()
    return !embedTarget && /^https?:\/\/\S+$/i.test(t) ? t : null
  }, [block?.content, embedTarget])

  // 整块恰是一个 ```forsion-button 围栏 → 「按钮」块(点一下跑一条 manual 自动化)。
  // JSON 坏了 parse 返回 null → 自动回落成普通代码块,源码原样可见可改(绝不代用户重写)。
  const buttonSpec = useMemo(
    () => (embedTarget || bookmarkUrl ? null : parseButtonBlock(block?.content ?? '')),
    [block?.content, embedTarget, bookmarkUrl],
  )

  // Resolve a cross-note embed; re-resolve when the link graph changes (source edited externally).
  const [embed, setEmbed] = useState<EmbedResolved | null | 'loading'>('loading')
  useEffect(() => {
    if (!embedTarget || embedImage || embedDb || embedDraw || embedPlugin || embedFile) return
    let alive = true
    setEmbed('loading')
    amadeus
      .resolveEmbed(embedTarget)
      .then((r) => {
        if (alive) setEmbed(r)
      })
      .catch(() => {
        if (alive) setEmbed(null)
      })
    return () => {
      alive = false
    }
  }, [embedTarget, embedImage, embedDb, embedDraw, embedPlugin, embedFile, linkVersion])

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: blockId })

  // 块级左右边缘落点(Notion 式两栏配对):仅拖拽进行中且非自身时激活/显示。
  const dndPairing = usePageStore((s) => s.dndActiveId !== null && s.dndActiveId !== blockId)
  const leftEdge = useDroppable({ id: `bedge:${blockId}:left`, disabled: !dndPairing })
  const rightEdge = useDroppable({ id: `bedge:${blockId}:right`, disabled: !dndPairing })
  const blockEdges = dndPairing ? (
    <>
      <div ref={leftEdge.setNodeRef} className="block-edge" data-side="left" data-over={leftEdge.isOver || undefined} />
      <div ref={rightEdge.setNodeRef} className="block-edge" data-side="right" data-over={rightEdge.isOver || undefined} />
    </>
  ) : null

  // Notion 式块菜单:点 ⠿(不动即点击,动 5px 起才是拖拽)或块上右键呼出;替代原右侧悬浮小图标列。
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!blockMenu) return
    // 捕获相 pointerdown/contextmenu:打开路径的 stopPropagation(止于 React 根)与 dnd-kit
    // 拖后吞 click(document 捕获)都拦不住它 → 别的块开菜单/起拖时旧菜单必被关(防同屏残留+拖拽期错位)。
    const close = (e: Event): void => {
      if (e.target instanceof Element && e.target.closest('.ctx-menu')) return // 点菜单项自身不先行卸载
      setBlockMenu(null)
    }
    window.addEventListener('pointerdown', close, { capture: true })
    window.addEventListener('contextmenu', close, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', close, { capture: true })
      window.removeEventListener('contextmenu', close, { capture: true })
    }
  }, [blockMenu])
  // 菜单量真实尺寸后夹进视口(纵向溢出上移、横向溢出收进屏幕)。关闭态哨兵用 -1(非 0),
  // 否则恰在 (0,0) 打开时 deps 不变、layout effect 不触发 → 菜单不量测(codex P3)。
  const menuPos = useClampedMenu(blockMenu?.x ?? -1, blockMenu?.y ?? -1)

  // 只读控件块(嵌入/图片/db/画板/书签,无文本光标):方向键把 focusRequest 落到本块时,转成「选中整块」
  // (高亮 + 露只读源码行),先 blur 掉来源编辑器,后续方向键交给 BlockSelectionKeys 继续穿过(option A)。
  // 可编辑块由其自身编辑器的 focus effect 消费 focus 请求,不进此分支。
  const isWidgetHost = !!embedTarget || !!bookmarkUrl || !!buttonSpec
  useEffect(() => {
    if (focusPlace == null || !isWidgetHost) return
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    useBlockSelection.getState().select(blockId)
    consumeFocus(blockId)
  }, [focusPlace, isWidgetHost, blockId, consumeFocus])

  if (!block) return null

  const onCtxMenu = (e: ReactMouseEvent): void => {
    // ⚠️ readOnly 不只是「文字打不进去」:块菜单里有 删除 / 复制块 / 移到新列 —— 全是结构写操作。
    // Dashboard 的「编辑锁定」此前只把 .block-gutter 用 CSS 藏了,右键照样能删卡片(Codex 评审实证,
    // 而 check:dashboard 只断言了 contenteditable=false,是假绿)。真只读必须连菜单一起关。
    if (readOnly) return
    e.preventDefault()
    e.stopPropagation()
    setBlockMenu({ x: e.clientX, y: e.clientY })
  }

  // 焦点进入块 → 清块选中 / 退出嵌入源码编辑;但源码编辑器自身获焦除外(否则一聚焦就退出)。
  const onBlockFocus = (e: ReactFocusEvent): void => {
    if ((e.target as HTMLElement).closest?.('.embed-src-input')) return
    const st = useBlockSelection.getState()
    if (st.ids.size || st.activeEmbed) st.clear()
  }

  // 源码行(注入到手柄之后、预览之上;非嵌入块 embedTarget 为空恒不显示):
  //  · 二次选中/编辑态(activeEmbed)→ 可编辑 EmbedSourceLine(双击/回车进入,自动聚焦)。
  //  · 仅选中态(方向键选中/点手柄)→ 只读显示 ![[...]] 源码(option A:露原始内容但不抢焦点)。
  // 嵌入块的源码行 + 悬停浮现的 `</>` 入口。两者同住一个片段:所有嵌入分支(图片/PDF/文件/画板/
  // 多维表/插件)都已经在渲染 {embedSrcLine},挂这儿就等于一次接入全部,不用逐个分支去加。
  // 源码编辑本来就有(双击 / 选中回车),EmbedSourceLine 失焦即提交并复渲染 —— `</>` 只是看得见的入口。
  const embedSrcLine = (
    <>
      {embedTarget && !isActiveEmbed && (
        <button
          className="amx-src-btn amx-src-btn--block"
          title="查看源码"
          aria-label="查看源码"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            useBlockSelection.getState().setActiveEmbed(blockId)
          }}
        >
          {'</>'}
        </button>
      )}
      {isActiveEmbed && embedTarget ? (
        <EmbedSourceLine
          content={block.content}
          onCommit={(v) => setBlockContent(blockId, v)}
          onDone={() => useBlockSelection.getState().setActiveEmbed(null)}
        />
      ) : selected && embedTarget ? (
        <div className="block-body embed-src-line embed-src-readonly" aria-hidden>
          {`![[${embedTarget}]]`}
        </div>
      ) : null}
    </>
  )

  const gutter = (
    <div className="block-gutter">
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        {...attributes}
        {...listeners}
        onClick={(e) => {
          e.stopPropagation()
          useBlockSelection.getState().select(blockId) // Notion 式:点手柄=选中块(键盘删/复制可用)
          const r = e.currentTarget.getBoundingClientRect()
          setBlockMenu({ x: r.left, y: r.bottom + 4 })
        }}
        title="点击打开菜单,按住拖动 / Click for menu, hold to drag"
        aria-label="block menu / drag"
      >
        ⠿
      </button>
      <button
        className="block-add"
        onClick={(e) => {
          e.stopPropagation()
          insertBlockAfter(blockId, undefined, '') // 自带 requestFocus,新块聚焦
        }}
        title="在下方插入块 / Add block below"
        aria-label="add block below"
      >
        ＋
      </button>
    </div>
  )

  /** 块菜单(fixed .ctx-menu):普通块四个动作;嵌入块只有 移到新列/移除。
   *  传送到最近的 .am-app:祖先有 transform(思维导图画布)时 fixed 会以它为包含块 → 菜单跑偏。 */
  const blockMenuNode = blockMenu && !readOnly && (
    <OverlayPortal>
    <div ref={menuPos.ref} className="ctx-menu" style={menuPos.style} onClick={(e) => e.stopPropagation()}>
      {!embedTarget && (
        <button onClick={() => { void navigator.clipboard?.writeText(`![[${stripPageBasename(pagePath)}#${blockId}]]`); setBlockMenu(null) }}>
          ↪ 复制嵌入引用
        </button>
      )}
      {/* 结构类动作在「宿主接管结构」的面(思维导图)上一律不出现:它们直接调 store,会绕过宿主的
          关系图维护 —— 删除留下悬空的父子/关系线、复制出一个没有父级的游离节点、分栏更是笔记专属
          排版。这些操作在导图里由节点自己的菜单负责(Codex)。 */}
      {!embedTarget && !surface && (
        <button onClick={() => { duplicateBlock(blockId); setBlockMenu(null) }}>⎘ 复制块</button>
      )}
      {!surface && <button onClick={() => { splitToColumn(blockId, 'right'); setBlockMenu(null) }}>⫿ 移到新列</button>}
      {!surface && (
        <button className="danger" onClick={() => { setBlockMenu(null); deleteBlock(blockId) }}>
          ✕ {embedTarget ? '移除嵌入' : '删除'}
        </button>
      )}
    </div>
    </OverlayPortal>
  )

  // --- Image transclusion (`![[pic.png]]`) ---
  if (embedImage) {
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        {embedSrcLine}
        <div className="block-body embed-image-body">
          <img
            className="embed-image"
            src={embedImage.url}
            alt={embedImage.name}
            draggable={false}
            style={embedImage.width ? { width: embedImage.width } : undefined}
          />
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- 裸 URL 块 → 书签卡(✎ 就地改地址;删除走块菜单) ---
  if (bookmarkUrl) {
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        {embedSrcLine}
        <div className="block-body">
          <BookmarkCard url={bookmarkUrl} onChangeUrl={(next) => setBlockContent(blockId, next)} />
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- 「按钮」块(```forsion-button)→ 点一下跑一条 manual 自动化 ---
  if (buttonSpec) {
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        <div className="block-body">
          <ButtonBlock spec={buttonSpec} onChange={(next) => setBlockContent(blockId, serializeButtonBlock(next))} />
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- Database transclusion (`![[tasks.db]]`) → interactive table (✕ removes the block, not the file) ---
  if (embedDb) {
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        {embedSrcLine}
        <div className="block-body">
          <DatabaseEmbed
            target={embedDb.name}
            pagePath={pagePath}
            initialView={embedDb.view}
            onViewChange={(v) => setBlockContent(blockId, v ? `![[${embedDb.name}|${v}]]` : `![[${embedDb.name}]]`)}
          />
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- Excalidraw 画板(`![[画板.excalidraw]]`)→ 可编辑画布(✕ 只移除块,不删文件) ---
  if (embedDraw) {
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        {embedSrcLine}
        <div className="block-body">
          <ExcalidrawEmbed target={embedDraw} pagePath={pagePath} />
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- 插件文件类型嵌入(`![[x.mindmap.md]]`)→ 插件只读预览块(✕ 只移除块,不删文件) ---
  if (embedPlugin) {
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        {embedSrcLine}
        <div className="block-body">
          <PluginEmbed target={embedPlugin} pagePath={pagePath} blockId={blockId} />
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- Non-image file transclusion (`![[report.pdf]]`) → openable file card ---
  if (embedFile) {
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        {embedSrcLine}
        <div className="block-body">
          {embedFile.kind === 'other' ? (
            <button
              className="embed-file"
              onClick={() => {
                // 先试 wiki 解析:插件声明的文件类型(如 .mindmap.md)会在应用内开它自己的视图 ——
                // 直接丢给系统默认程序等于用 TextEdit 打开一张思维导图。
                if (/\.[a-z0-9]+\.md$/i.test(embedFile.name)) openWikiLink(embedFile.name, pagePath)
                else if (pagePath) void amadeus.openAttachment(pagePath, embedFile.name)
              }}
              title={/\.[a-z0-9]+\.md$/i.test(embedFile.name) ? '在 Forsion 标签页中打开' : '用系统默认程序打开'}
            >
              <span className="embed-file-ic" aria-hidden>📄</span>
              <span className="embed-file-name">{embedFile.name}</span>
              <span className="embed-file-open">打开 ↗</span>
            </button>
          ) : (
            <div className="embed-media">
              <div className="embed-media-head">
                <span className="embed-file-ic" aria-hidden>
                  {embedFile.kind === 'pdf' ? '📕' : embedFile.kind === 'video' ? '🎬' : '🎵'}
                </span>
                <span className="embed-file-name">{embedFile.name}</span>
                <button className="embed-media-btn" onClick={() => setPreviewOpen((o) => !o)}>
                  {previewOpen ? '收起' : '展开'}
                </button>
                <button
                  className="embed-media-btn"
                  title={embedFile.kind === 'pdf' ? '在 Forsion 标签页中打开(可批注)' : '用系统默认程序打开'}
                  onClick={() => {
                    // PDF 在应用内新 tab 打开可批注阅读器(openWikiLink 的 .pdf 分支);音视频仍交给系统播放器。
                    if (embedFile.kind === 'pdf') openWikiLink(embedFile.name, pagePath)
                    else if (pagePath) void amadeus.openAttachment(pagePath, embedFile.name)
                  }}
                >
                  打开 ↗
                </button>
              </div>
              {previewOpen && embedFile.kind === 'pdf' && (
                pdfVaultPath ? (
                  <div className="embed-pdf embed-pdf-live">
                    <Suspense fallback={<div className="embed-pdf-loading">加载 PDF…</div>}>
                      <PdfEmbedViewer pdfPath={pdfVaultPath} readOnly />
                    </Suspense>
                  </div>
                ) : (
                  // webhost-ok: 固定已知嵌入(Chromium 内置 PDF 阅读器),无 sandbox 属性 → 不削能力
                  <iframe className="embed-pdf" src={embedFile.url} title={embedFile.name} />
                )
              )}
              {previewOpen && embedFile.kind === 'video' && (
                <video className="embed-video" src={embedFile.url} controls preload="metadata" />
              )}
              {previewOpen && embedFile.kind === 'audio' && (
                <audio className="embed-audio" src={embedFile.url} controls preload="metadata" />
              )}
            </div>
          )}
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- Cross-note embed (read-only) ---
  if (embedTarget) {
    const et = embed && embed !== 'loading' ? getBlockType(embed.type) : undefined
    const EmbedEditor = et?.Editor
    return (
      <div
        ref={setNodeRef}
        className="block-host"
        data-block-id={blockId}
        data-selected={selected || undefined}
        data-embed
        data-menu={blockMenu ? '' : undefined}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
      >
        {isDropTarget && <div className="drop-line" />}
        {blockEdges}
        {gutter}
        {embedSrcLine}
        <div className="block-body embed-body">
          <div className="embed-head">
            <span className="embed-badge" title="跨笔记嵌入（只读）">
              ↪ 嵌入
            </span>
            {embed && embed !== 'loading' && (
              <button
                className="embed-src"
                onClick={() => void ps.getState().loadPage(embed.owner)} // 已持有全路径,不走 basename 往返(重名会开错)
                title="去源头编辑"
              >
                {stripPageBasename(embed.owner)} ↗
              </button>
            )}
          </div>
          {embed === 'loading' ? (
            <div className="embed-loading">解析中…</div>
          ) : embed && EmbedEditor ? (
            <EmbedEditor
              blockId={blockId}
              content={embed.content}
              pagePath={embed.owner}
              readOnly
              onChange={noop}
              onInsertAfter={noop}
              onDeleteEmpty={noop}
              onMergePrev={noop}
              onArrowOut={noop}
              onMoveDir={noop}
              focusPlace={null}
              onFocused={noop}
              requestSelfFocus={noop}
              onOpenWiki={(name) => openWikiLink(name, embed.owner)} // 嵌入内容里的链接按其所有者解析
              getPageNames={() => ps.getState().pages}
            />
          ) : (
            <div className="embed-missing">
              嵌入丢失：<code>{embedTarget}</code>
            </div>
          )}
        </div>
        {blockMenuNode}
      </div>
    )
  }

  // --- Normal (owned) block ---
  const bt = getBlockType(block.type)
  const Editor = bt?.Editor

  return (
    <div
      ref={setNodeRef}
      className="block-host"
      data-block-id={blockId}
      data-selected={selected || undefined}
      data-menu={blockMenu ? '' : undefined}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onContextMenu={onCtxMenu}
        onFocusCapture={onBlockFocus}
    >
      {isDropTarget && <div className="drop-line" />}
      {blockEdges /* 七个 embed 分支都有,唯独普通块(text)漏了 → text 块左右分栏从来没有落点(实报根因) */}
      {gutter}
        {embedSrcLine}
      <div className="block-body">
        {Editor ? (
          <Editor
            blockId={blockId}
            content={block.content}
            pagePath={pagePath}
            autoFocus={autoFocus}
            readOnly={readOnly}
            onChange={(c) => setBlockContent(blockId, c)}
            onInsertAfter={surface ? (content) => surface.insertAfter(blockId, content ?? '') : (content) => insertBlockAfter(blockId, undefined, content)}
            onDeleteEmpty={surface ? noop : () => deleteBlockFocusPrev(blockId)}
            onMergePrev={surface ? noop : () => mergeWithPrev(blockId)}
            onArrowOut={surface ? noop : (dir, goalX) => focusAdjacent(blockId, dir, goalX)}
            onMoveDir={surface ? noop : (dir) => moveBlockDir(blockId, dir)}
            focusPlace={focusPlace}
            focusGoalX={focusGoalX}
            focusAnchor={focusAnchor}
            onFocused={() => consumeFocus(blockId)}
            requestSelfFocus={(place) => requestFocus(blockId, place)}
            onOpenWiki={(name) => openWikiLink(name, pagePath)}
            // 宿主接管时,`/嵌入块引用` 也必须交给宿主:store.insertEmbed 会把嵌入块追加到页尾,
            // 在导图里那是一个游离的新中心,而不是当前节点下的一条(Codex)。
            onInsertEmbed={(t) => (surface ? surface.insertAfter(blockId, `![[${t}]]`) : ps.getState().insertEmbed(t))}
            getPageNames={() => ps.getState().pages}
          />
        ) : (
          <div className="block-unknown">未知块类型：{block.type}</div>
        )}
      </div>
      {blockMenuNode}
    </div>
  )
})
