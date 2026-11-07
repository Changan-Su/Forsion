/** 宿主侧打开 Mini 的唯一入口(LCL 表面规范第二期 · Mini 多开):调 window.tangu.openMini,开满了负责告诉用户。
 *  主进程按实体复用、满 MINI_WINDOW_LIMIT 扇不开并把原因交回来;这里把「不开」变成一句看得见的提示,不静默失败。
 *  Mini 窗里没有通知宿主(NotificationHost 只挂在主窗),由 MiniRoot 经 setMiniNoticeSink 把提示接进卡片。
 *  ⚠️ Tangu 界面(views/chat2)不许引宿主模块(check:tanguboundary):通话键仍直调 window.tangu.openMini,通话那扇本来就不占名额。 */
import { registerMessages, translate } from '../i18n'
import { notifyApp } from '../stores/notificationStore'
import type { MiniOpenOptions, MiniOpenResult } from '../../../shared/miniPanel'

registerMessages({
  'mini.limit': { zh: '最多同时开 {n} 个 Mini 窗口，先关掉一个再开', en: 'Up to {n} Mini windows can be open at once. Close one first.' },
})

let sink: ((text: string) => void) | null = null
/** Mini 窗把提示接到自己卡片里;返回撤销。 */
export function setMiniNoticeSink(fn: (text: string) => void): () => void {
  sink = fn
  return () => { if (sink === fn) sink = null }
}

export function openMiniWindow(opts?: MiniOpenOptions): Promise<MiniOpenResult | undefined> {
  const open = window.tangu?.openMini
  if (!open) return Promise.resolve(undefined)
  return Promise.resolve(open(opts)).then((result) => {
    if (result && !result.ok && result.reason === 'limit') {
      const text = translate('mini.limit', { n: result.limit })
      if (sink) sink(text)
      else notifyApp({ text, level: 'info', dedupeKey: 'mini.limit' })
    }
    return result || undefined
  }, () => undefined)
}
