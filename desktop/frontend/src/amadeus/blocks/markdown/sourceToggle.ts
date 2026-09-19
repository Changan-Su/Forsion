// 「查看源码」`</>` 小按钮(Obsidian 同款):挂在渲染出来的行内块右上角,悬停才浮现。
//
// 普通双链 / 公式仍是「光标回到这一行 → 露源码」;附件类“难源码编辑块”则由这颗按钮
// 显式打开自己的 source state,光标只是经过或整块选中都不让位。两类入口共用这一枚按钮。
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
 *  · **数字** = 源码在文档里的位置 → 把光标送进去(普通公式 / 双链);
 *  · **函数** = 自定入口 —— 图片和通用附件要显式打开 hard-source state;`![](path)` 还是 PM 的
 *    image 节点,文档里没有字面源码,由 mdImage.ts 自己弹一行输入框。
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
