/** 图片本体直接拖(2026-09-22 用户拍板):独占一段的图片,按住图片本身就能拖走整块,与 ⠿ 同一条管线。
 *
 *  图片 widget(wikilink.ts 的 `![[…]]`、mdImage.ts 的 `![](…)`)只决定「这次按下能不能起拖」;
 *  起拖之后的序列化、落点、指示线、执行全归统一编辑器的 blockLayer —— 所以只有它登记过的 view
 *  才开这扇门,v3 块编辑器与只读视图照旧。
 *
 *  为什么是原生拖拽而不是自己模拟:图片 mousedown 原本 preventDefault(拦落焦点 / 选词),而按下被
 *  preventDefault 的元素 Chromium 根本不起原生拖拽。能起拖的那次按下改为不拦,只把 wrap 标 draggable
 *  (按下在可拖元素上,浏览器不开始选文字)。实测松手时也不按坐标落光标:首次单击、在已选中的图片上
 *  再点一次,选区都原样(台架 09-22)。双击的第二下照旧 preventDefault —— 双击是看大图,不是起拖。
 *
 *  Codex 评审两条(09-22)落在这里:①这次按下**不动选区**,没拖成(click)才选中图片 —— 按下就收成单图,
 *  会把盖住它的跨块选区冲掉,拖走的就只剩这张图(⠿ 是整批);拖起来时的拖动单位由 blockLayer 按 ⠿
 *  同一套规则定。②draggable 只活这一次按下:常开的话,`</>` 打开的源码行 <input> 里拖选文字会被可拖祖先抢走。 */
import type { EditorView } from '@milkdown/kit/prose/view'

/** blockLayer 装载时登记、销毁时摘除。 */
export const blockDragViews = new WeakSet<EditorView>()

/** 单独成块的图片/嵌入以可见媒体盒作为交互几何。它们的 PM 段落壳还可能带隐藏源码、基线行盒，
 *  高度会比画面多出一截；拿壳去拉长抓手/画按压框，就会在图片底下多垂几十像素。 */
export function visualBlockElement(el: HTMLElement): HTMLElement {
  if (el.tagName !== 'P') return el
  const media = el.querySelector<HTMLElement>(
    ':scope > img:not(.ProseMirror-separator), :scope > .wiki-inline-img-wrap, :scope > .unified-embed',
  )
  if (!media) return el
  // PM 会在叶子图片后补 separator img + trailingBreak；wiki/embed 的源码则留在隐藏 span 里。
  // 它们都不是用户可见的同排内容，不能让 `:only-child` 判据失效。真正混有文字/其它元素时仍用段落壳。
  const visibleSibling = [...el.children].some((child) =>
    child !== media
    && !child.matches('.ProseMirror-separator, .ProseMirror-trailingBreak, .wikilink-src-hidden'),
  )
  const visibleText = [...el.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && !!child.textContent?.trim())
  return visibleSibling || visibleText ? el : media
}

/** 图片独占的那个段落;图片混在文字里 → null(行内图片不起整块拖)。 */
export function soleMediaParagraph(wrap: HTMLElement): HTMLElement | null {
  const p = wrap.parentElement
  return p && visualBlockElement(p) === wrap ? p : null
}

const NOT_DRAG = '.amx-img-resize, .amx-src-btn, .amx-img-srcline'

/** 这次按下能否起「整块拖」。能 → 标 draggable、约好「单击才 select()」,返回 true:调用方**别**
 *  preventDefault,也**别**在按下时改选区。否则返回 false,调用方照旧 preventDefault 并当场选中。 */
export function armImageDrag(view: EditorView, wrap: HTMLElement, e: MouseEvent, select: () => void): boolean {
  if (e.button !== 0 || e.detail > 1 || !view.editable || !blockDragViews.has(view)) return false
  if ((e.target as HTMLElement | null)?.closest?.(NOT_DRAG) || !soleMediaParagraph(wrap)) return false
  wrap.draggable = true
  // 这次按下挂的监听全挂在一个 AbortController 上,收的时候一把摘干净 —— 只单击不拖的话 dragend 不来,
  // 零散的 once 监听会一次次攒在同一个 wrap 上,下一次真拖时一起跑(Codex 复审)。
  const ac = new AbortController()
  const on = { signal: ac.signal, once: true }
  // 摘属性而不是置 false:收回到按下前的原样(wrap 原本没有这个属性)。探针里显式 draggable="false"
  // 改过源码行 <input> 的原生手势(在全选文字上按住拖,光标变成跟着指针跑)。
  const disarm = (): void => {
    wrap.removeAttribute('draggable')
    ac.abort()
  }
  wrap.addEventListener('click', () => { disarm(); select() }, on) // 没拖成 = 单击:选中图片
  // 松手在图外时 click 不来:mouseup 与 click 同一轮派发,排到其后再收
  window.addEventListener('mouseup', () => setTimeout(disarm, 0), { ...on, capture: true })
  wrap.addEventListener('dragend', disarm, on) // 拖起来了:click 不再来;来源被删也照样收到 dragend
  window.addEventListener('blur', disarm, on) // 按下后切走窗口:mouseup / dragend 都不来(Codex 复审)
  return true
}

/** 起拖的来源是不是一张可整块拖的图片:是 → 返回它独占的段落;把手/`</>`/源码行上起的拖 → null。 */
export function imageDragParagraph(target: EventTarget | null): HTMLElement | null {
  const t = target as HTMLElement | null
  const wrap = t?.closest?.('.wiki-inline-img-wrap') as HTMLElement | null
  if (!wrap || t!.closest(NOT_DRAG)) return null
  return soleMediaParagraph(wrap)
}
