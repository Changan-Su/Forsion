/** 标准 markdown 图片 `![](attachments/x.png)` 的选中态 + 缩放把手。
 *
 *  为什么单独一份:Amadeus 里图片有**两种**磁盘形态 —— `![[x.png|200]]`(Obsidian 嵌入,
 *  拖入/斜杠菜单/侧栏拖拽走这条,由 wikilink.ts 的装饰 widget 渲染)与 `![](path)`(**粘贴/上传**
 *  走这条,是 ProseMirror 的 image **节点**,见 amadeusImport.ts:144 记的决定)。装饰管不到节点,
 *  所以这一形态走 NodeView —— 但复用同一套 wrap / 把手 / CSS,两边手感必须一模一样。
 *
 *  宽度存 alt:`![|200](path)` —— Obsidian 官方口径,与 `![[x|200]]` 同一个 `|宽度` 语法。
 *  路径一个字节不动,Obsidian 里打开同样按 200px 显示;别的 markdown 渲染器最多把 `|200`
 *  当成 alt 文字,图片照显示。 */
import { $prose } from '@milkdown/kit/utils'
import { imageSchema } from '@milkdown/kit/preset/commonmark'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { Plugin, NodeSelection, type Transaction } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { fromAssetUrl, toAssetUrl } from '@amadeus-shared/assets'
import { attachResizeHandle } from '../../lib/imageResize'
import { armImageDrag } from './imageDrag'
import { mediaNameOf, watchBrokenImage } from './brokenMedia'
import { normalizeTextAlignment, setTextAlignment, type TextAlignment } from './paragraphIndent'
import { buildImageToolbar, coarsePointer, downloadImage, imageToast as toast, openImageSheet, placeHoverToolbar, viewImageFullscreen, type ImageToolbar, type ImageToolbarActions } from './imageToolbar'
import { translate } from '../../../i18n'

/** 宿主交进来的能力(MarkdownBlock 的 MilkdownInner 按自己的 ref 现取)。不给 = 对应按钮不出 / 不可用。 */
export interface MdImageOpts {
  /** 选好的图片存进库,回显示 URL(与粘贴图片同一条 saveImage);「替换」靠它。 */
  saveImage?: (file: File) => Promise<string | null>
  /** 把**当前选中**的图片复制成真图片(块菜单「复制图片」那份,copySelectedImage)。 */
  copyImage?: (view: EditorView) => Promise<boolean>
}

/** 图片 schema 的读 DOM 规则去掉「没有 title 就拿 alt 顶上」(Milkdown 原版 `title || alt`)。
 *  粘贴 / 剪切粘贴 / 拖入都要过一趟 DOM(md → PM → DOM → parseSlice),原版会把 alt(连 `|宽度`)塞进 title 落盘:
 *  `![图|300](a.png "图|300")`。title 从前只是个悬停提示,看不出来;现在 title = 图下说明,这一塞就是一句凭空的说明。 */
const imageCaptionSchema = imageSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  parseDOM: [{
    tag: 'img[src]',
    getAttrs: (dom: HTMLElement | string) => {
      if (!(dom instanceof HTMLElement)) return false
      return { src: dom.getAttribute('src') || '', alt: dom.getAttribute('alt') || '', title: dom.getAttribute('title') || '' }
    },
  }],
}))
/** commonmark preset 里原位换上 imageCaptionSchema(位置不动,同 paragraphIndent 的换法)。 */
export function withImageCaptionSchema(preset: MilkdownPlugin[]): MilkdownPlugin[] {
  return preset.map((p) => ((p as unknown) === (imageSchema.node as unknown) ? imageCaptionSchema.node
    : (p as unknown) === (imageSchema.ctx as unknown) ? imageCaptionSchema.ctx : p) as MilkdownPlugin)
}
/** 图下要显示的说明。title 与 alt 一字不差 = 旧版粘贴路径顺手塞进来的(见 imageCaptionSchema),不当说明显示
 *  (盘上原样不动;用户在「说明」里写下一句和 alt 一模一样的话,这一条也会把它当成没写 —— 已知取舍)。 */
export function captionOf(node: ProseNode): string {
  const t = (node.attrs.title as string | null) ?? ''
  return t && t !== ((node.attrs.alt as string | null) ?? '') ? t : ''
}

/** 说明(title)在源码行里的写法:`\` 与 `"` 加反斜杠(与 markdown 标题同口径)。读回只解 CommonMark 的
 *  反斜杠转义(反斜杠 + ASCII 标点):`C:\folder\test` 里的 `\f` `\t` 是字面量,不许吃掉反斜杠。 */
const escapeTitle = (t: string): string => t.replace(/[\\"]/g, (c) => `\\${c}`)
const unescapeTitle = (t: string): string => t.replace(/\\([!-/:-@[-`{-~])/g, '$1')
/** 单行输入框放不下换行(浏览器还会把换行直接删掉):显示时换成空格。原 title 带换行时,
 *  没改过的提交一律原样保留(见 openCaption / commitSource),不让单行框悄悄改写多行说明。 */
const flatLine = (t: string): string => t.replace(/\r\n?|\n/g, ' ')

/** 工具条 / 把手的一次动作 = 一步撤销:连点几下对齐、拖两次把手,不并进同一步(history 缺省 500ms 内相邻改动合并)。 */
const ownStep = (tr: Transaction): Transaction => closeHistory(tr)

/** `![|200](x)` / `![说明|200](x)` 的 alt → 说明文字 + 宽度;没有 `|数字` 尾巴 → 整串都是说明。 */
export function parseAlt(alt: string): { label: string; width?: number } {
  const m = /^(.*)\|(\d+)$/.exec(alt)
  return m ? { label: m[1], width: Number(m[2]) } : { label: alt }
}

/** 宽度写回 alt(说明文字原样保留)。 */
export function buildAlt(label: string, width: number): string {
  return `${label}|${width}`
}

class MdImageView implements NodeView {
  dom: HTMLElement
  private img: HTMLImageElement
  /** 图下的说明(title);为空不占位(hidden)。 */
  private cap: HTMLElement
  /** 悬停工具条:第一次悬停才建(长笔记几百张图,别每张都先挂一排按钮)。 */
  private tb: ImageToolbar | null = null
  private sheet: { close(): void; refresh(): void } | null = null
  private drops: Array<() => void> = []
  private srcLine: HTMLInputElement | null = null
  private capLine: HTMLInputElement | null = null
  private hovered = false
  private ro: ResizeObserver | null = null
  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private opts: MdImageOpts,
    private onDestroy: () => void,
  ) {
    // 包一层 span 的理由与行内嵌入同款:`<img>` 是空元素,挂不了把手,也没有定位父级。
    this.dom = document.createElement('span')
    this.dom.className = 'wiki-inline-img-wrap amx-img-md'
    this.dom.contentEditable = 'false'
    this.img = document.createElement('img')
    this.img.className = 'wiki-inline-img'
    this.dom.appendChild(this.img)
    this.cap = document.createElement('span')
    this.cap.className = 'amx-img-cap'
    this.cap.hidden = true
    this.dom.appendChild(this.cap)
    // 点一下 = 选中图片节点。块菜单/分栏在右键与 ⠿ 入口会继续把选区提升到顶层 paragraph;
    // 左键若直接选 paragraph,Chromium 会在 contenteditable=false 图片尾部留下整段高的蓝色边界。
    // ⚠️ 不靠 PM 的 handleClickOn:contentEditable 里点 <img>,PM 多半只把光标落到节点旁边
    // (实测 click 后既无 NodeSelection 也无选中环)。自己派 NodeSelection,并在 stopEvent 里
    // 把 mousedown 拦下,免得 PM 随后又按坐标把选区改回去。
    this.dom.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.amx-img-resize, .amx-img-srcline, .amx-img-capline, .amx-img-tb, .amx-img-more')) return
      // 双击**不**在这里拦:用户 2026-08-28 拍板「双击 = 看大图」,交给 UnifiedPage 的灯箱。
      // 源码入口只有一个 —— 悬停工具条里的 `</>`(见 openSource)。
      // 独占一段时可以按住直接拖走整块:那次按下不能 preventDefault,选中也挪到 click(见 imageDrag.ts)。
      if (armImageDrag(this.view, this.dom, e, () => this.select())) return
      e.preventDefault()
      this.select()
    })
    // 悬停工具条(2026-11-17 Notion 对齐第 4 条):`</>` 收进这一排,不再单挂一颗。
    this.dom.addEventListener('pointerenter', () => {
      this.hovered = true
      this.placeToolbar()
    })
    this.dom.addEventListener('pointerleave', () => { this.hovered = false })
    // 两侧把手(右在前:台架 / 旧仪器 querySelector('.amx-img-resize') 取第一颗当右缘)。
    // 悬停或选中才露(CSS);只读不露,commit 里也再判一次。居中的图两边同时外扩,指针走 1px 宽度走 2px。
    const factor = (): number => (this.align() === 'center' ? 2 : 1)
    this.drops.push(attachResizeHandle(this.dom, this.img, (w) => this.commit(w), { factor }))
    this.drops.push(attachResizeHandle(this.dom, this.img, (w) => this.commit(w), { side: 'left', factor }))
    // 把手 / 工具条按**图片**定位,不按包裹层:说明行、源码行都会把包裹层撑高(见 layout)。
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.layout()) : null
    this.ro?.observe(this.img)
    this.ro?.observe(this.dom)
    // 加载失败 → 占位说明(R-21);名字取说明文字,没有就取路径末段。
    watchBrokenImage(this.dom, this.img, () => parseAlt((this.node.attrs.alt as string) ?? '').label || mediaNameOf((this.node.attrs.src as string) ?? ''))
    this.apply(node)
  }
  private apply(node: ProseNode): void {
    const { label, width } = parseAlt((node.attrs.alt as string) ?? '')
    const src = (node.attrs.src as string) ?? ''
    if (this.img.getAttribute('src') !== src) this.img.src = src
    this.img.alt = label
    this.img.style.width = width ? `${width}px` : ''
    const title = captionOf(node)
    if (this.cap.textContent !== title) this.cap.textContent = title
    this.cap.hidden = !title || !!this.capLine
    this.dom.toggleAttribute('data-ro', !this.view.editable)
  }
  /** 图片在包裹层里的位置 → CSS 变量(把手竖直居中于图片、工具条贴图片顶)。只在尺寸变了 / 开合输入行时算。 */
  private layout(): void {
    const top = `${this.img.offsetTop}px`
    const mid = `${this.img.offsetTop + this.img.offsetHeight / 2}px`
    const h = `${this.img.offsetHeight}px`
    const st = this.dom.style
    if (st.getPropertyValue('--amx-img-top') !== top) st.setProperty('--amx-img-top', top)
    if (st.getPropertyValue('--amx-img-mid') !== mid) st.setProperty('--amx-img-mid', mid)
    if (st.getPropertyValue('--amx-img-h') !== h) st.setProperty('--amx-img-h', h)
  }
  /** 露出前:现取文案 / 只读 / 当前档;图比工具条窄 → 挪到图片上方(按对齐靠左 / 居中 / 靠右)。 */
  private placeToolbar(): void {
    this.dom.toggleAttribute('data-ro', !this.view.editable)
    if (!this.tb) {
      this.tb = buildImageToolbar(this.actions(), this.dom, 'hover')
      this.dom.appendChild(this.tb.el)
    }
    this.tb.refresh()
    this.layout()
    placeHoverToolbar(this.dom, this.img, this.tb.el, this.align())
  }
  private pos(): number | null {
    try {
      const p = this.getPos()
      return p == null ? null : p
    } catch {
      return null // 节点已不在文档里
    }
  }
  private select(): void {
    const pos = this.pos()
    if (pos == null) return
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    this.view.focus()
  }
  /** 图片所在那一段的对齐(段落 / 标题的 align attr,落盘 = 段首对齐标记)。 */
  private align(): TextAlignment {
    const pos = this.pos()
    if (pos == null) return 'left'
    try {
      return normalizeTextAlignment(this.view.state.doc.resolve(pos).parent.attrs.align)
    } catch {
      return 'left'
    }
  }
  private actions(): ImageToolbarActions {
    const view = this.view
    return {
      view,
      align: () => this.align(),
      setAlign: (a) => {
        if (!view.editable) return
        const pos = this.pos()
        if (pos == null) return
        // 工具条是悬停出来的,光标可能在别的段落:先把选区放到这张图上,再交给段落对齐命令(Mod-Shift-L/E/R 同一条)。
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
        setTextAlignment(view.state, (tr) => view.dispatch(ownStep(tr)), a)
        view.focus()
        this.tb?.refresh()
        this.sheet?.refresh()
        if (this.hovered) requestAnimationFrame(() => this.placeToolbar()) // 换了档:窄图的工具条要跟着换边
      },
      caption: () => this.openCaption(),
      captionOpen: () => !!this.capLine,
      replace: this.opts.saveImage ? () => this.replace() : undefined,
      fullscreen: () => viewImageFullscreen(this.img, this.dom),
      download: () => void downloadImage(this.img, String(this.node.attrs.src ?? '')),
      source: () => this.openSource(),
      copy: this.opts.copyImage ? () => {
        this.select()
        void this.opts.copyImage!(view).then((ok) => toast(ok ? 'imgtb.copied' : 'imgtb.copyFailed', !ok), () => toast('imgtb.copyFailed', true))
      } : undefined,
      remove: () => this.remove(),
    }
  }
  /** 「替换」:与 `/图片` 同一个选图对话框,存进库后只换 src —— 宽度(alt 的 `|宽度`)和说明(title)原样留着。 */
  private replace(): void {
    if (!this.view.editable || !this.opts.saveImage) return
    const before = String(this.node.attrs.src ?? '')
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      void (async () => {
        const url = await this.opts.saveImage!(f).catch(() => null)
        if (!url) return toast('imgtb.replaceFailed', true)
        // 存盘要一会儿:回来时这张图可能已被删 / 挪 / 改过地址 —— 重新取位置,那里还是**这张**图才写。
        const pos = this.pos()
        const node = pos == null ? null : this.view.state.doc.nodeAt(pos)
        if (pos == null || !node || node.type.name !== 'image' || node.attrs.src !== before || !this.view.editable) return
        this.markup(pos, { ...node.attrs, src: url })
      })()
    }
    input.click()
  }
  /** ⋯ →「删除」:独占一段的图连段落一起删(不留一个空段落);混在文字里的只删图。 */
  private remove(): void {
    if (!this.view.editable) return
    const pos = this.pos()
    if (pos == null) return
    const $p = this.view.state.doc.resolve(pos)
    const para = $p.parent
    const tr = this.view.state.tr
    if (para.childCount === 1 && $p.depth > 0 && $p.node($p.depth - 1).childCount > 1) tr.delete($p.before(), $p.after())
    else tr.delete(pos, pos + this.node.nodeSize)
    this.view.dispatch(ownStep(tr.scrollIntoView()))
    this.view.focus()
  }
  /** 「说明」:图下出一行输入框(纯文本,写进 title)。Enter / 失焦 = 提交,Esc = 取消;值没变不派事务
   *  (保住「没动过的块逐字落盘」),清空 = 去掉 title。 */
  private openCaption(): void {
    if (!this.view.editable) return
    if (this.capLine) {
      this.capLine.focus()
      return
    }
    const old = captionOf(this.node)
    const input = document.createElement('input')
    input.className = 'amx-img-capline'
    input.type = 'text'
    input.value = flatLine(old)
    const shown = input.value // 浏览器可能再规整一遍,以实际显示出来的为准
    input.placeholder = translate('imgtb.captionPlaceholder')
    input.setAttribute('aria-label', translate('imgtb.caption'))
    input.spellcheck = false
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      // 没改过 = 什么都不做:原 title 的换行、首尾空格都原样留着(不在「原样提交」时顺手规整)
      const edited = input.value !== shown
      const v = flatLine(input.value).trim()
      input.remove()
      this.capLine = null
      this.apply(this.node)
      this.layout()
      this.tb?.refresh()
      this.sheet?.refresh()
      const pos = this.pos()
      if (commit && edited && v !== old && pos != null && this.view.editable) {
        const node = this.view.state.doc.nodeAt(pos)
        if (node?.type.name === 'image') this.markup(pos, { ...node.attrs, title: v || null })
      }
      this.view.focus()
    }
    input.addEventListener('mousedown', (e) => e.stopPropagation()) // 别让包裹层把这次按下当成「选中图片」
    input.addEventListener('keydown', (e) => {
      e.stopPropagation() // 编辑器的快捷键别来吃这一行的按键
      if (e.isComposing || e.keyCode === 229) return // 输入法选词的回车不是提交
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    this.capLine = input
    this.cap.hidden = true
    this.cap.after(input)
    this.layout()
    this.tb?.refresh()
    this.sheet?.refresh()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
  update(node: ProseNode): boolean {
    if (node.type.name !== this.node.type.name) return false
    this.node = node
    this.apply(node)
    if (this.hovered) this.placeToolbar()
    return true
  }
  selectNode(): void {
    this.dom.dataset.selected = ''
    // 粗指针没有悬停:选中就在底部出同一排按钮。
    if (coarsePointer() && !this.sheet) this.sheet = openImageSheet((host) => buildImageToolbar(this.actions(), host, 'sheet'))
  }
  deselectNode(): void {
    delete this.dom.dataset.selected
    this.sheet?.close()
    this.sheet = null
  }
  /** NodeView 选中态兜底同步:部分外部命令直接恢复 NodeSelection 时,仍要保证环与把手在。 */
  syncSelection(): void {
    const pos = this.pos()
    if (pos == null) {
      delete this.dom.dataset.rangeSelected
      return this.deselectNode()
    }
    const sel = this.view.state.selection
    // 跨块文字选区覆盖图片时,图片节点本身没有可着色字符;给渲染体一圈选中反馈。
    if (sel.from < pos + this.node.nodeSize && sel.to > pos) this.dom.dataset.rangeSelected = ''
    else delete this.dom.dataset.rangeSelected
    const picked = sel instanceof NodeSelection && sel.from === pos
    if (picked && !this.dom.hasAttribute('data-selected')) this.selectNode()
    else if (!picked && this.dom.hasAttribute('data-selected')) this.deselectNode()
    // 工具条露着时跟上当前档(撤销 / 快捷键改了这一段的对齐)
    if (this.hovered || this.sheet) {
      this.tb?.refresh()
      this.sheet?.refresh()
    }
  }
  /** 露源码(`</>`):图片上方浮出一行可编辑的 `![说明|宽度](路径 "图下说明")`。
   *
   *  ⚠️ 刻意**不往文档里塞字面文本** —— `![[…]]` 那条能直接「露源码」是因为它本来就是文本;
   *  image 是节点,它的 `src` 是显示用的 `amadeus-asset://` URL,而磁盘上是**页相对**路径,
   *  两者的换算(编码 + 页相对化)住在保存管线 toStoredMarkdown 里,这里拿不到 pageDir。
   *  所以走 v3 EmbedSourceLine 同款:框里给**库相对**的可读路径,提交时换回 URL,
   *  落盘形态仍旧全交给保存管线 —— 一个字节都不用自己拼(自己拼过一次的下场见 assets.ts 的长注释)。
   *  Enter / 失焦 = 提交,Esc = 取消;done 闩保证只认第一次。 */
  private openSource(): void {
    if (!this.view.editable) return
    if (this.srcLine) {
      this.srcLine.focus()
      this.srcLine.select()
      return
    }
    const src = String(this.node.attrs.src ?? '')
    const title = String(this.node.attrs.title ?? '')
    const input = document.createElement('input')
    input.className = 'embed-src-input amx-img-srcline'
    input.value = `![${String(this.node.attrs.alt ?? '')}](${fromAssetUrl(src) ?? src}${title ? ` "${escapeTitle(flatLine(title))}"` : ''})`
    const shown = input.value
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      const v = input.value.trim()
      const edited = input.value !== shown
      input.remove()
      this.srcLine = null
      this.dom.removeAttribute('data-src-open')
      this.layout()
      if (commit && edited) this.commitSource(v)
      this.view.focus()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation() // 编辑器的快捷键别来吃这一行的按键
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    this.dom.insertBefore(input, this.img)
    this.srcLine = input
    this.tb?.closeMenu()
    // 源码行开着时收起工具条:窄图的工具条挪在图片上方,正好压在这一行上(点进输入框会点到按钮、源码行失焦提交)
    this.dom.setAttribute('data-src-open', '')
    this.layout()
    input.focus()
    input.select()
  }

  /** `![说明|宽度](路径 "图下说明")` → 回写 attrs。外链(http/data/blob)原样存;库内路径换回显示 URL。
   *  解析不出来就当用户改坏了,原样不动(绝不代用户重写)。路径可以带空格(框里给的是解码后的可读形态),
   *  所以标题段从**尾巴**上认:` "…")` 结尾才算标题。 */
  private commitSource(text: string): void {
    const m = /^!\[([^\]]*)\]\((.*?)(?:\s+"((?:[^"\\]|\\[\s\S])*)")?\)$/.exec(text)
    const pos = this.pos()
    if (!m || pos == null || !this.view.editable) return
    const p = m[2].trim()
    if (!p) return
    // exact:框里填的是库内路径(openSource 给出去的就是它)。不带的话云端先按当前页的目录找,显示的和存下去的
    // (存盘按库内路径换成页相对 / `../`)可能不是同一张图(Codex 评审 2026-10-10)。
    const src = /^(https?:|data:|blob:)/i.test(p) ? p : toAssetUrl(p, true)
    let title = m[3] == null ? null : unescapeTitle(m[3]) || null
    // 只改了宽度 / 地址:说明还是框里显示的那句(多行说明被摊成了一行)→ 保留原 title,换行不丢
    const orig = (this.node.attrs.title as string | null) ?? null
    if (title != null && orig != null && title === flatLine(orig)) title = orig
    const next = { ...this.node.attrs, alt: m[1], src, title }
    if (next.alt === this.node.attrs.alt && next.src === this.node.attrs.src && (next.title ?? null) === (this.node.attrs.title ?? null)) return
    this.markup(pos, next)
  }
  /** 改图片 attrs(一步撤销)。叶子节点的 setNodeMarkup 是整颗替换,NodeSelection 映射过去会塌成光标 ——
   *  原来选着这张图就放回去,不然手机底栏写完说明 / 替换完就收起了。 */
  private markup(pos: number, attrs: Record<string, unknown>): void {
    const { state } = this.view
    const tr = state.tr.setNodeMarkup(pos, undefined, attrs)
    if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(ownStep(tr))
  }

  /** 松手 → 宽度写进 alt。一次事务 = 一步撤销;写完把选区放回本节点,免得把手跟着消失。 */
  private commit(width: number): void {
    const pos = this.pos()
    if (pos == null || !this.view.editable) return void this.apply(this.node)
    const { label } = parseAlt((this.node.attrs.alt as string) ?? '')
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, alt: buildAlt(label, width) })
    tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(ownStep(tr))
  }
  /** 本 NodeView 内的按下类事件一律自理:交给 PM 会被当成「在节点上按下」而改选区、打断把手拖拽。
   *  源码行 / 说明行是真 `<input>`,工具条与 ⋯ 菜单是按钮:它们的**所有**事件(尤其 keydown)都得挡住,
   *  否则打的字会被编辑器吃掉。 */
  stopEvent(e: Event): boolean {
    if ((e.target as HTMLElement | null)?.closest?.('.amx-img-srcline, .amx-img-capline, .amx-img-tb, .amx-img-more')) return true
    return e.type === 'mousedown' || e.type.startsWith('pointer')
  }
  /** src / style / 说明 / 工具条都是我们自己按 attrs 刷的,不是文档变化 —— 让 PM 别去重读 DOM。 */
  ignoreMutation(): boolean {
    return true
  }
  destroy(): void {
    for (const d of this.drops) d()
    this.drops = []
    this.ro?.disconnect()
    this.tb?.destroy()
    this.sheet?.close()
    this.sheet = null
    this.onDestroy()
  }
}

/** opts 现取(MarkdownBlock 传进来的是读 ref 的闭包):换笔记 / 换宿主不用重建编辑器。 */
export function mdImagePlugin(opts: MdImageOpts = {}) {
  return $prose(
    () => {
      const views = new Set<MdImageView>()
      return new Plugin({
        view: () => ({ update: () => { for (const image of views) image.syncSelection() } }),
        props: {
          nodeViews: {
            image: (node, view, getPos) => {
              let image!: MdImageView
              image = new MdImageView(
                node as ProseNode,
                view as EditorView,
                getPos as () => number | undefined,
                opts,
                () => views.delete(image),
              )
              views.add(image)
              return image
            },
          },
        },
      })
    },
  )
}
