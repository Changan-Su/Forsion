/** 触屏下光标行别被悬浮胶囊盖住(评审 G2-11)。移动端编辑胶囊 `.amx-mbar` 悬浮在视口底部(键盘弹起后 = 键盘上沿),
 *  约 56 局部 px 高、再乘 body zoom 1.15。PM 打字时的 scrollIntoView 只留默认 5px 边距:在文中插新行,第 3 行起
 *  光标行就滚到了胶囊底下(文末打字不受影响 —— 那里有 .amx-editor 的 padding-bottom 兜着)。
 *  只写 CSS 不起作用(评审已证:滚动是 PM 按 scrollMargin 算的),所以在 PM 的滚动参数上让出胶囊那一截 ——
 *  **两个都要**:scrollThreshold 决定「离底多近就开始滚」(缺省 0 = 光标出了滚动容器底边才滚,压在胶囊底下的那几行
 *  根本不触发),scrollMargin 决定「滚完离底留多少」。单位是视口 px(PM 拿 getBoundingClientRect 比),
 *  故 80 局部 px × zoom。插件建实例时现算:移动端 zoom 常驻不变。 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { zoomOf } from '@lcl/engine'
import { isCoarsePointer } from '../../touch'

/** 胶囊高度 + 悬浮底距 + 余量(局部 px)。改胶囊尺寸(amadeus-host.css 的 .amx-mbar)时一并看这里。 */
const CAPSULE_CLEARANCE = 80

export function touchScrollMarginPlugin() {
  return $prose(() => {
    if (!isCoarsePointer()) return new Plugin({})
    const bottom = Math.round(CAPSULE_CLEARANCE * zoomOf(document.body))
    return new Plugin({ props: { scrollThreshold: { top: 0, left: 0, right: 0, bottom }, scrollMargin: { top: 5, left: 5, right: 5, bottom } } })
  })
}
