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
import { Plugin, NodeSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { fromAssetUrl, toAssetUrl } from '@amadeus-shared/assets'
import { attachResizeHandle } from '../../lib/imageResize'
import { attachSourceButton } from './sourceToggle'

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
  private drop: (() => void) | null = null
  private srcLine: HTMLInputElement | null = null
  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    // 包一层 span 的理由与行内嵌入同款:`<img>` 是空元素,挂不了把手,也没有定位父级。
    this.dom = document.createElement('span')
    this.dom.className = 'wiki-inline-img-wrap'
    this.dom.contentEditable = 'false'
    this.img = document.createElement('img')
    this.img.className = 'wiki-inline-img'
    this.dom.appendChild(this.img)
    // 点一下 = 选中这个节点。⚠️ 不靠 PM 的 handleClickOn:contentEditable 里点 <img>,PM 多半
    // 只把光标落到节点旁边(实测 click 后既无 NodeSelection 也无选中环)。自己派 NodeSelection,
    // 并在 stopEvent 里把 mousedown 拦下,免得 PM 随后又按坐标把选区改回去。
    this.dom.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.amx-img-resize, .amx-src-btn, .amx-img-srcline')) return
      e.preventDefault()
      // 双击**不**在这里拦:用户 2026-08-28 拍板「双击 = 看大图」,交给 UnifiedPage 的灯箱。
      // 源码入口只有一个 —— 悬停的 `</>`(见 openSource)。
      const pos = this.getPos()
      if (pos == null) return
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
      this.view.focus()
    })
    attachSourceButton(this.dom, view, () => this.openSource()) // 悬停浮现的 `</>`,与其它图片一致
    this.apply(node)
  }
  private apply(node: ProseNode): void {
    const { label, width } = parseAlt((node.attrs.alt as string) ?? '')
    this.img.src = (node.attrs.src as string) ?? ''
    this.img.alt = label
    this.img.style.width = width ? `${width}px` : ''
    if (node.attrs.title) this.img.title = node.attrs.title as string
  }
  update(node: ProseNode): boolean {
    if (node.type.name !== this.node.type.name) return false
    this.node = node
    this.apply(node)
    return true
  }
  selectNode(): void {
    this.dom.dataset.selected = ''
    if (!this.view.editable) return
    this.drop = attachResizeHandle(this.dom, this.img, (w) => this.commit(w))
  }
  deselectNode(): void {
    delete this.dom.dataset.selected
    this.drop?.()
    this.drop = null
  }
  /** 露源码(`</>` 与双击的共同出口):图片上方浮出一行可编辑的 `![说明|宽度](路径)`。
   *
   *  ⚠️ 刻意**不往文档里塞字面文本** —— `![[…]]` 那条能直接「露源码」是因为它本来就是文本;
   *  image 是节点,它的 `src` 是显示用的 `amadeus-asset://` URL,而磁盘上是**页相对**路径,
   *  两者的换算(编码 + 页相对化)住在保存管线 toStoredMarkdown 里,这里拿不到 pageDir。
   *  所以走 v3 EmbedSourceLine 同款:框里给**库相对**的可读路径,提交时换回 URL,
   *  落盘形态仍旧全交给保存管线 —— 一个字节都不用自己拼(自己拼过一次的下场见 assets.ts 的长注释)。
   *  Enter / 失焦 = 提交,Esc = 取消;done 闩保证只认第一次。 */
  private openSource(): void {
    if (this.srcLine) {
      this.srcLine.focus()
      this.srcLine.select()
      return
    }
    const src = String(this.node.attrs.src ?? '')
    const input = document.createElement('input')
    input.className = 'embed-src-input amx-img-srcline'
    input.value = `![${String(this.node.attrs.alt ?? '')}](${fromAssetUrl(src) ?? src})`
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      const v = input.value.trim()
      input.remove()
      this.srcLine = null
      if (commit) this.commitSource(v)
      this.view.focus()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation() // 编辑器的快捷键别来吃这一行的按键
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    this.dom.insertBefore(input, this.img)
    this.srcLine = input
    input.focus()
    input.select()
  }

  /** `![说明|宽度](路径)` → 回写 attrs。外链(http/data/blob)原样存;库内路径换回显示 URL。
   *  解析不出来就当用户改坏了,原样不动(绝不代用户重写)。 */
  private commitSource(text: string): void {
    const m = /^!\[([^\]]*)\]\((.*)\)$/.exec(text)
    const pos = this.getPos()
    if (!m || pos == null) return
    const p = m[2].trim()
    if (!p) return
    const src = /^(https?:|data:|blob:)/i.test(p) ? p : toAssetUrl(p)
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, alt: m[1], src }))
  }

  /** 松手 → 宽度写进 alt。一次事务 = 一步撤销;写完把选区放回本节点,免得把手跟着消失。 */
  private commit(width: number): void {
    const pos = this.getPos()
    if (pos == null) return
    const { label } = parseAlt((this.node.attrs.alt as string) ?? '')
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, alt: buildAlt(label, width) })
    tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(tr)
  }
  /** 本 NodeView 内的按下类事件一律自理:交给 PM 会被当成「在节点上按下」而改选区、打断把手拖拽。
   *  源码行是个真 `<input>`,它的**所有**事件(尤其 keydown)都得挡住,否则打的字会被编辑器吃掉。 */
  stopEvent(e: Event): boolean {
    if ((e.target as HTMLElement | null)?.closest?.('.amx-img-srcline')) return true
    return e.type === 'mousedown' || e.type.startsWith('pointer')
  }
  /** src / style 是我们自己按 attrs 刷的,不是文档变化 —— 让 PM 别去重读 DOM。 */
  ignoreMutation(): boolean {
    return true
  }
  destroy(): void {
    this.drop?.()
  }
}

export function mdImagePlugin() {
  return $prose(
    () =>
      new Plugin({
        props: {
          nodeViews: {
            image: (node, view, getPos) => new MdImageView(node as ProseNode, view as EditorView, getPos as () => number | undefined),
          },
        },
      }),
  )
}
