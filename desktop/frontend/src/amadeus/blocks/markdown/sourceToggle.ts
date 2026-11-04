// 「查看源码」`</>` 小按钮(Obsidian 同款):挂在渲染出来的行内块右上角,悬停才浮现。
//
// 普通双链 / 公式仍是「光标回到这一行 → 露源码」;附件类“难源码编辑块”则由这颗按钮
// 显式打开自己的 source state,光标只是经过或整块选中都不让位。两类入口共用这一枚按钮。
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'srctoggle.viewSource': { zh: '查看源码', en: 'View source' },
  'srctoggle.copyTex': { zh: '复制 LaTeX', en: 'Copy LaTeX' },
  'srctoggle.copied': { zh: '已复制', en: 'Copied' },
})

const SVG = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
// lucide copy / check(与 Chat 代码块的复制键同一对图标)
const COPY_ICON = SVG('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>')
const CHECK_ICON = SVG('<path d="M20 6 9 17l-5-5"/>')

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
  // 键盘按下(Tab 到这颗键再按回车 / 空格)不往上冒:否则 ProseMirror 的键位表拿去改别处的选区(删字、插段),按钮反而没按下去。
  b.addEventListener('keydown', (e) => e.stopPropagation())
  host.classList.add('amx-has-src-btn')
  host.appendChild(b)
}

/**
 * 块公式右上角的复制键:排在 `</>` 左边、同一种悬停浮现的按钮,复制纯 LaTeX(不带 `$$`,同代码块不带围栏)。
 * 只读视图照样挂(复制不改文档);那里没有 `</>`,按钮靠到最右(`--solo`)。须先于 attachSourceButton 调用,DOM 顺序 = 视觉顺序。
 */
export function attachCopyButton(host: HTMLElement, view: EditorView, text: string): void {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `amx-src-btn amx-src-btn--copy${view.editable ? '' : ' amx-src-btn--solo'}`
  b.title = translate('srctoggle.copyTex')
  b.setAttribute('aria-label', translate('srctoggle.copyTex'))
  b.contentEditable = 'false'
  b.innerHTML = COPY_ICON
  let timer = 0
  // mousedown 吞掉:公式本体的 mousedown 会把光标送进源码(露出 `$$`),点复制不该触发。
  b.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void navigator.clipboard.writeText(text).then(() => {
      b.innerHTML = CHECK_ICON
      b.title = translate('srctoggle.copied')
      b.classList.add('is-copied')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        b.innerHTML = COPY_ICON
        b.title = translate('srctoggle.copyTex')
        b.classList.remove('is-copied')
      }, 1500)
    }).catch(() => {})
  })
  // 键盘按下(Tab 到这颗键再按回车 / 空格)不往上冒:否则 ProseMirror 的键位表拿去改别处的选区(删字、插段),按钮反而没按下去。
  b.addEventListener('keydown', (e) => e.stopPropagation())
  host.classList.add('amx-has-src-btn')
  host.appendChild(b)
}
