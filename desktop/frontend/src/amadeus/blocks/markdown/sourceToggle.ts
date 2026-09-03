// 「查看源码」`</>` 小按钮(Obsidian 同款):挂在渲染出来的行内块右上角,悬停才浮现。
//
// ⚠️ 这里**没有**新建什么「源码模式」—— Amadeus 的公式 / 双链 / 图片嵌入本来就是
// 「光标不在这一行 → 渲染;光标回到这一行 → 露出字面源码可编辑」(见 mathLivePreview.ts 的长注释)。
// 这颗按钮只是给那条既有通道一个看得见的入口:点它 = 把光标塞进那段源码。
// 「编辑光标离开这片区域才复渲染」因此是白拿的 —— 逐行显隐本来就这么判。
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'srctoggle.viewSource': { zh: '查看源码', en: 'View source' },
})

/** 把光标送进 srcFrom 处的源码(开定界符之后),该行随即露出字面源码。 */
export function revealSource(view: EditorView, srcFrom: number): void {
  const pos = Math.min(srcFrom + 1, view.state.doc.content.size)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
  // 各家实况预览用 DOM focus 事件翻自己的 focus 标志位,故必须真的置焦(已聚焦则标志位本就是 true)。
  view.focus()
}

/**
 * 给一个「渲染结果」元素挂上 `</>` 按钮。inline=true 时按钮缩到左上角外沿,
 * 免得盖住本来就很小的行内公式。只读视图不给编辑入口(和 renderMath 同一条约定)。
 *
 * `reveal` 两种口径:
 *  · **数字** = 源码在文档里的位置 → 把光标送进去(公式 / 双链 / `![[…]]` 图片,它们本来就是文本);
 *  · **函数** = 自定入口 —— `![](path)` 那种是 PM 的 image **节点**,文档里根本没有字面源码可露,
 *    由 mdImage.ts 自己弹一行源码输入框(见那边的注释)。
 */
export function attachSourceButton(host: HTMLElement, view: EditorView, reveal: number | (() => void), inline = false): void {
  if (!view.editable) return
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `amx-src-btn${inline ? ' amx-src-btn--inline' : ''}`
  b.title = translate('srctoggle.viewSource')
  b.setAttribute('aria-label', translate('srctoggle.viewSource'))
  b.contentEditable = 'false'
  b.textContent = '</>'
  // mousedown 必须吞掉:否则 ProseMirror 先按坐标改选区,再轮到 click,光标落点就不是我们要的。
  b.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (typeof reveal === 'function') reveal()
    else revealSource(view, reveal)
  })
  host.classList.add('amx-has-src-btn')
  host.appendChild(b)
}
