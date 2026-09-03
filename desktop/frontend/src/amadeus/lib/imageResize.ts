/** 图片缩放把手(右缘竖条,选中态才挂):拖它改宽度。
 *  拖动中只改 style.width 做实时预览,松手才 commit 一次整数宽度 —— 一次事务 = 一步撤销。
 *
 *  ⚠️ 坐标系:clientX 是**视口 px**,而宽度是**布局 px**,两者不同尺的来源有两个 ——
 *  端级 CSS zoom(手机 body 恒 1.15)和画布舞台的 `translate() scale(z)`(canvasStage 的
 *  stage-inner,卡片里就住着这个编辑器)。所以缩放比**按下时实测**:
 *  `rect.width / offsetWidth` 一次量到 zoom × transform 的合成值。
 *  别退回 `zoomOf()` —— currentCSSZoom **不含 transform**,画布 z=0.5 时拖 60px 只加 60 布局 px
 *  (该加 120),把手跟不上指针、写进 md 的宽度也是错的(Codex 评审实证)。 */

import { registerMessages, translate } from '../../i18n'

registerMessages({
  'imgresize.dragWidth': { zh: '拖动调整宽度', en: 'Drag to resize' },
})

/** 再窄就抓不住把手了。 */
export const MIN_IMG_WIDTH = 40

/** 给定位父级 `wrap` 挂一枚右缘把手,拖完把新宽度交给 `commit`;返回撤销函数。 */
export function attachResizeHandle(
  wrap: HTMLElement,
  img: HTMLElement,
  commit: (width: number) => void,
): () => void {
  const h = document.createElement('span')
  h.className = 'amx-img-resize'
  h.contentEditable = 'false'
  h.title = translate('imgresize.dragWidth')
  let active = false
  let startX = 0
  let startW = 0
  let startStyle = ''
  let scale = 1
  const widthAt = (clientX: number): number =>
    Math.max(MIN_IMG_WIDTH, Math.round(startW + (clientX - startX) / scale))
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault() // 别让 ProseMirror 按坐标改选区(图片会当场让位给源码)
    e.stopPropagation()
    startX = e.clientX
    startW = img.offsetWidth
    startStyle = img.style.width // 取消 / 空拖时原样回滚
    scale = startW > 0 ? img.getBoundingClientRect().width / startW : 1
    active = true
    h.setPointerCapture(e.pointerId)
    wrap.dataset.resizing = ''
  }
  const onMove = (e: PointerEvent): void => {
    if (active) img.style.width = `${widthAt(e.clientX)}px`
  }
  /** ok=false(pointercancel / 丢捕获)→ 回滚预览,**绝不落盘**:半截的宽度不是用户的意图。
   *  ok=true 但宽度没变(只点了一下把手)→ 同样不落盘:不该给用户的 md 平白添一个 `|宽度`,
   *  更不该为此多一步撤销和一次写盘。active 是唯一闩,pointerup 先落闩,随后的
   *  lostpointercapture 因此恒空转。 */
  const finish = (e: PointerEvent, ok: boolean): void => {
    if (!active) return
    active = false
    try {
      h.releasePointerCapture(e.pointerId)
    } catch {
      /* 捕获已经丢了,无所谓 */
    }
    delete wrap.dataset.resizing
    const w = ok ? widthAt(e.clientX) : startW
    if (ok && w !== startW) commit(w)
    else img.style.width = startStyle
  }
  h.addEventListener('pointerdown', onDown)
  h.addEventListener('pointermove', onMove)
  h.addEventListener('pointerup', (e) => finish(e, true))
  h.addEventListener('pointercancel', (e) => finish(e, false))
  h.addEventListener('lostpointercapture', (e) => finish(e, false))
  wrap.appendChild(h)
  return () => h.remove()
}
