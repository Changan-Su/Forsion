/** `![[x.png|200]]` 图片的悬停工具条 / 手机底栏(2026-11-18 定「①」:工具条全给,「说明」只给标准写法)。
 *
 *  同一排按钮(imageToolbar.ts),动作换成改**源码文本**:这一形态在文档里就是一段字面 `![[…]]`,
 *  由 wikilink.ts 的装饰 widget 渲染 —— 不是节点,没有 attrs。
 *   · 对齐 = 所在段落的对齐(段首对齐标记,与 `![](…)` 和 Mod-Shift-L/E/R 同一条命令)
 *   · 替换 = 与 `/图片` 同一条 saveAttachment,只换 `![[` 后面的库内名,`|宽度` 原样留着
 *   · 全屏 / 下载 / `</>` / ⋯(打开 · 复制图片 · 删除)
 *   · 没有「说明」:`![[…]]` 没有放说明的地方(Obsidian 同样没有),存法一个字节不变。
 *
 *  ⚠️ widget 不是 NodeView:源码一变(换图 / 改宽度)、所在段落换了 attrs(对齐),整颗 widget 都会重建,
 *  旧 DOM 连同它的工具条一起销毁。所以位置一律经 span() 现算,派完事务后按位置找新那颗补一次露出。 */
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeTextAlignment, setTextAlignment, type TextAlignment } from './paragraphIndent'
import {
  buildImageToolbar, coarsePointer, downloadImage, holdToolbar, imageToast, openImageSheet, placeHoverToolbar, viewImageFullscreen,
  type ImageToolbar, type ImageToolbarActions,
} from './imageToolbar'

/** 宿主交进来的能力(MarkdownBlock 读 ref 现取)。不给 = 对应按钮不出。 */
export interface WikiImageOpts {
  /** 选好的图片存进库,回 `![[…]]` 里要写的库内名(与 `/图片` 同一条 saveAttachment);「替换」靠它。 */
  saveEmbed?: (file: File) => Promise<string | null>
  /** 把**当前选中**的图片复制成真图片(块菜单「复制图片」那份,copySelectedImage)。 */
  copyImage?: (view: EditorView) => Promise<boolean>
}

export interface WikiImageCtx {
  view: EditorView
  wrap: HTMLElement
  img: HTMLImageElement
  /** 本 widget 此刻的源码区间(`!` 到 `]]`);widget 已销毁 / 不在文档里 → null。 */
  span(): { from: number; to: number } | null
  /** 独占一段(点一下选整段)。 */
  standalone: boolean
  /** `![[…]]` 里的库内路径(不含 `|宽度`),下载文件名用。 */
  name: string
  /** 选中这张图(与单击同一份)。 */
  select(): void
  /** 显式进入源码(`</>`)。 */
  source(): void
  /** 应用内打开(无 vault 的宿主不给)。 */
  open?: (newTab: boolean) => void
  opts: WikiImageOpts
}

const ownStep = closeHistory

function alignOf(ctx: WikiImageCtx): TextAlignment {
  const at = ctx.span()
  if (!at) return 'left'
  try {
    return normalizeTextAlignment(ctx.view.state.doc.resolve(at.from).parent.attrs.align)
  } catch {
    return 'left'
  }
}

/** 源码区间里此刻的原文;对不上 `![[…]]` 就当这张图已经不在了。 */
function sourceAt(view: EditorView, at: { from: number; to: number }): string | null {
  try {
    const t = view.state.doc.textBetween(at.from, at.to)
    return /^!\[\[[^\]\n]+\]\]$/.test(t) ? t : null
  } catch {
    return null
  }
}

/** 能原样写进 `![[…]]` 的库内名:不含 wiki 语法的定界符(`[` `]` `|` 别名 / 宽度、`#` 标题、`^` 块)和换行。 */
export const EMBED_UNSAFE_RE = /[[\]|#^\r\n]/g
export function isEmbedSafeName(name: string): boolean {
  EMBED_UNSAFE_RE.lastIndex = 0
  return !!name.trim() && !EMBED_UNSAFE_RE.test(name)
}

/** 换图后的源码:只换库内名,`|宽度`(以及 Obsidian 的其它 `|…` 尾巴)原样留着。 */
export function replaceEmbedName(source: string, name: string): string {
  const inner = source.slice(3, -2)
  const bar = inner.indexOf('|')
  return `![[${name}${bar >= 0 ? inner.slice(bar) : ''}]]`
}

function actions(ctx: WikiImageCtx): ImageToolbarActions {
  const { view } = ctx
  return {
    view,
    align: () => alignOf(ctx),
    setAlign: (a) => {
      const at = ctx.span()
      if (!view.editable || !at) return
      const held = ctx.wrap.hasAttribute('data-tb-hold')
      // 工具条是悬停出来的,光标可能在别的段落:先选中这张图,再交给段落对齐命令(Mod-Shift-L/E/R 同一条)。
      ctx.select()
      const picked = view.state.selection
      setTextAlignment(view.state, (tr) => {
        // 独占一段的图选的是整段:setNodeMarkup 换掉段落,NodeSelection 映射过去会塌成光标 —— 放回去,
        // 不然选中环没了、手机底栏当场收起
        if (picked instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, picked.from))
        view.dispatch(ownStep(tr))
      }, a)
      view.focus()
      reshowAt(view, at.from, held)
    },
    replace: ctx.opts.saveEmbed ? () => replace(ctx) : undefined,
    fullscreen: () => viewImageFullscreen(ctx.img, ctx.wrap),
    download: () => void downloadImage(ctx.img, ctx.name),
    source: () => ctx.source(),
    open: ctx.open,
    copy: ctx.opts.copyImage ? () => {
      ctx.select()
      void ctx.opts.copyImage!(view).then((ok) => imageToast(ok ? 'imgtb.copied' : 'imgtb.copyFailed', !ok), () => imageToast('imgtb.copyFailed', true))
    } : undefined,
    remove: () => {
      const at = ctx.span()
      if (!view.editable || !at || !sourceAt(view, at)) return
      const $p = view.state.doc.resolve(at.from)
      const tr = view.state.tr
      // 独占一段的图连段落一起删(不留一个空段落);混在文字里的只删这段源码。
      const alone = $p.parent.content.size === at.to - at.from
      if (alone && $p.depth > 0 && $p.node($p.depth - 1).childCount > 1) tr.delete($p.before(), $p.after())
      else tr.delete(at.from, at.to)
      view.dispatch(ownStep(tr.scrollIntoView()))
      view.focus()
    },
  }
}

/** 「替换」:与 `/图片` 同一个选图对话框,存进库后只换库内名。存盘要一会儿:回来时这张图可能已被删 / 挪 / 改过 ——
 *  这颗 widget 还在、那里还是**同一段**源码才写(源码一改 widget 就重建,span() 便取不到了)。 */
function replace(ctx: WikiImageCtx): void {
  const { view } = ctx
  const at0 = ctx.span()
  const before = at0 && sourceAt(view, at0)
  if (!view.editable || !ctx.opts.saveEmbed || !before) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f) return
    void (async () => {
      const name = await ctx.opts.saveEmbed!(f).catch(() => null)
      // 库内名里带 `]` `[` `|` `#` `^` 或换行会写坏 `![[…]]`(宿主 saveEmbed 先把这些换掉了,这里再挡一道,绝不写坏源码)
      if (!name || !isEmbedSafeName(name)) return imageToast('imgtb.replaceFailed', true)
      const at = ctx.span()
      if (!at || !view.editable || sourceAt(view, at) !== before) return
      const next = replaceEmbedName(before, name)
      const sel = view.state.selection
      const wasPicked = (sel instanceof NodeSelection && sel.from === at.from - 1) || (sel.from === at.from && sel.to === at.to)
      const tr = view.state.tr.insertText(next, at.from, at.to)
      if (wasPicked) {
        tr.setSelection(sel instanceof NodeSelection
          ? NodeSelection.create(tr.doc, at.from - 1)
          : TextSelection.create(tr.doc, at.from, at.from + next.length))
      }
      view.dispatch(ownStep(tr))
      reshowAt(view, at.from, false)
    })()
  }
  input.click()
}

interface Armed { ctx: WikiImageCtx; tb: ImageToolbar | null }
const armed = new WeakMap<HTMLElement, Armed>()

/** 露出前:建工具条(第一次悬停才建,长笔记几百张图别每张先挂一排按钮)、现取文案 / 只读 / 当前档;
 *  图比工具条窄 → 挪到图片上方(按对齐靠左 / 居中 / 靠右)。 */
function show(wrap: HTMLElement): void {
  const st = armed.get(wrap)
  if (!st) return
  // 小图(显示宽 < 80px,wikilink 打 amx-img-tiny):11-07 定只留一颗缩小版 `</>`(整排按钮会压到旁边的字),不出工具条。
  if (wrap.classList.contains('amx-img-tiny')) return
  wrap.toggleAttribute('data-ro', !st.ctx.view.editable)
  if (!st.tb) {
    st.tb = buildImageToolbar(actions(st.ctx), wrap, 'hover')
    wrap.appendChild(st.tb.el)
  }
  st.tb.refresh()
  // 工具条按**图片**定位(同 mdImage.layout):图片自己有上下外边距,包裹层比图高出一截
  const top = `${st.ctx.img.offsetTop}px`
  if (wrap.style.getPropertyValue('--amx-img-top') !== top) wrap.style.setProperty('--amx-img-top', top)
  placeHoverToolbar(wrap, st.ctx.img, st.tb.el, alignOf(st.ctx))
  shown.set(st.ctx.view, wrap)
}

/** 每个编辑器最近露出过工具条的那张图。 */
const shown = new WeakMap<EditorView, HTMLElement>()
/** 每次事务(wikilink 的 syncPicked 调):露着的悬停工具条跟上当前档 —— 快捷键 / 撤销改了段落对齐时,
 *  PM 把 widget 原样挪进新的段落元素,不重建,pointerenter 也不会再来。只刷这一颗,不扫全篇。 */
export function refreshShownToolbar(view: EditorView): void {
  const w = shown.get(view)
  if (!w) return
  if (!w.isConnected || !armed.has(w)) return void shown.delete(view)
  if (w.matches(':hover') || w.hasAttribute('data-tb-hold') || w.hasAttribute('data-tb-menu')) show(w)
}

/** 派完事务:装饰可能整颗重建了 / 被挪进了新的段落元素,指针还停在那张图上,pointerenter 却不会再来 ——
 *  按位置找到它补一次露出(刷新当前档)。held = 刚点的是对齐,工具条钉住到下一次指针移动(见 holdToolbar)。 */
function reshowAt(view: EditorView, from: number, held: boolean): void {
  requestAnimationFrame(() => {
    const w = view.dom.querySelector<HTMLElement>(`.wiki-inline-img-wrap[data-src-from="${from}"]`)
    if (!w) return
    if (held && !w.hasAttribute('data-tb-hold')) holdToolbar(w)
    if (held || w.matches(':hover')) show(w)
  })
}

/** widget 构建时挂上;返回卸载(widget 的 destroy 调)。 */
export function armWikiImageToolbar(ctx: WikiImageCtx): () => void {
  armed.set(ctx.wrap, { ctx, tb: null })
  ctx.wrap.classList.add('amx-img-wiki')
  const enter = (): void => show(ctx.wrap)
  ctx.wrap.addEventListener('pointerenter', enter)
  return () => {
    ctx.wrap.removeEventListener('pointerenter', enter)
    armed.get(ctx.wrap)?.tb?.destroy()
    armed.delete(ctx.wrap)
  }
}

/** 手机 / 平板:选中的那张图贴底出一条。寿命跟着**选区**走(wikilink 的 syncPicked 每次事务调),
 *  不跟 widget DOM —— 换图 / 改宽度会重建 widget,底栏按新那颗重开。 */
const sheets = new WeakMap<EditorView, { wrap: HTMLElement; handle: { close(): void; refresh(): void } }>()
export function syncWikiImageSheet(view: EditorView, wrap: HTMLElement | null): void {
  const cur = sheets.get(view)
  if (cur && cur.wrap === wrap) return cur.handle.refresh() // 跟上当前档(撤销 / 快捷键改了这一段的对齐)
  cur?.handle.close()
  sheets.delete(view)
  const st = wrap && armed.get(wrap)
  if (!wrap || !st || !coarsePointer()) return
  sheets.set(view, { wrap, handle: openImageSheet((host) => buildImageToolbar(actions(st.ctx), host, 'sheet')) })
}
