/**
 * 「引用刚才在用的窗口」命令:默认热键是同时按下左右两个 ⌘(mac)/ 两个 Ctrl(其它),设置 → 快捷键里能改、能关。
 * 取紧挨在 Forsion 后面的那扇窗口(没有带标题的窗口就退成那个应用),挂到聊天输入框的「已选择」里;
 * 光标在笔记里时直接把引用写进笔记。只在有 `window.tangu.appRefs` 的宿主上注册。
 * ⚠️ 这个热键只在 Forsion 自己在前台时收得到;在别的应用里按也要生效,得由本机助手监听按键(另一个仓,没做)。
 */
import { addCommand, MOD_PAIR } from '@lcl/engine'
import { appRefToken } from '../../../../shared/appRefs'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'cmd.refFrontWindow': { zh: '引用刚才在用的窗口', en: 'Reference the window you were just using' },
})

/** Composer2 在自己的输入卡上听这个事件(detail = AppRef)。 */
export const APPREF_EVENT = 'forsion:appref-add'
export const APPREF_TARGET_ATTR = 'data-appref-target'

export async function captureFrontWindow(): Promise<void> {
  const active = document.activeElement as HTMLElement | null
  const ref = await window.tangu?.appRefs?.frontmost().catch(() => null)
  if (!ref) return
  if (active?.isContentEditable && active.closest('.am-app')) {
    active.focus()
    document.execCommand('insertText', false, appRefToken(ref) + ' ')
    return
  }
  const cards = [...document.querySelectorAll<HTMLElement>(`[${APPREF_TARGET_ATTR}]`)]
  const target = cards.find((el) => el.contains(active)) ?? cards.find((el) => el.getClientRects().length > 0)
  target?.dispatchEvent(new CustomEvent(APPREF_EVENT, { detail: ref }))
}

let installed = false
export function ensureAppRefCommand(): void {
  if (installed || !window.tangu?.appRefs) return
  installed = true
  addCommand({ id: 'chat.reference-front-window', title: () => translate('cmd.refFrontWindow'), hotkey: MOD_PAIR, run: () => { void captureFrontWindow() } })
}
