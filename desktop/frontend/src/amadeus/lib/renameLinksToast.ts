/** web / 移动端桥在改名 / 移动之后重写全库 `[[链接]]`,有笔记没能改写时的提示(评审 G2-04:失败必须可见)。
 *  ⚠️ 桥在 window.amadeus 装上**之前**就被求值:本模块只许 import i18n,绝不能沾 `amadeus/api.ts`
 *  (它在模块级抓 window.amadeus,早求值一次就永远是 undefined)—— 所以不借 writeSafety.emitAmadeusToast,
 *  直接发同一个 `amadeus:toast` 事件(载荷形状见 writeSafety.AmadeusToastDetail,由 amadeusOverlays 接)。 */
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'amxlinks.rewriteFailed': {
    zh: '已改名 / 移动，但有 {n} 篇笔记里指向它的链接没能跟着更新：{names}。请打开这些笔记检查链接。',
    en: 'Renamed or moved, but links to it in {n} notes could not be updated: {names}. Open those notes and check the links.',
  },
  'amxlinks.nameSep': { zh: '、', en: ', ' },
})

const noteName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

export function toastRenameRewriteFailed(paths: string[]): void {
  if (!paths.length || typeof window === 'undefined') return
  const shown = paths.slice(0, 5).map(noteName).join(translate('amxlinks.nameSep'))
  const names = paths.length > 5 ? `${shown} …` : shown
  window.dispatchEvent(new CustomEvent('amadeus:toast', {
    detail: { text: translate('amxlinks.rewriteFailed', { n: paths.length, names }), level: 'error', dedupeKey: 'amxlinks.rewriteFailed' },
  }))
}
