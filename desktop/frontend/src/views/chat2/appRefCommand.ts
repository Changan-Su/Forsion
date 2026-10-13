/**
 * 「引用刚才在用的窗口」命令:默认热键是同时按下左右两个 ⌘(mac)/ 两个 Ctrl(其它),设置 → 快捷键里能改、能关。
 * 取紧挨在 Forsion 后面的那扇窗口(没有带标题的窗口就退成那个应用),挂到聊天输入框的「已选择」里;
 * 光标在笔记里时直接把引用写进笔记。只在有 `window.tangu.appRefs` 的宿主上注册。
 * 两条路:Forsion 自己在前台时由窗口内的命令接(下面的 hotkey);别的应用在前台时由本机助手监听按键,经主进程把
 * 那一刻最前面的窗口送过来(electron/appRefHotkey.ts;助手太旧 / 没在跑时只剩前一条)。同一次按键只会走其中一条。
 */
import { addCommand, effectiveHotkey, MOD_PAIR, useShortcuts } from '@lcl/engine'
import { appRefToken, normalizeAppRef, type AppRef } from '../../../../shared/appRefs'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'cmd.refFrontWindow': { zh: '引用刚才在用的窗口', en: 'Reference the window you were just using' },
})

/** Composer2 在自己的输入卡上听这个事件(detail = AppRef)。 */
export const APPREF_EVENT = 'forsion:appref-add'
export const APPREF_TARGET_ATTR = 'data-appref-target'

/** given = 主进程送来的那扇窗口(全局快捷键:这时最前面已经是 Forsion 自己,不能再去问「最前面是谁」)。 */
export async function captureFrontWindow(given?: AppRef): Promise<void> {
  const active = document.activeElement as HTMLElement | null
  const ref = given ?? await window.tangu?.appRefs?.frontmost().catch(() => null)
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
  const cmd = { id: 'chat.reference-front-window', title: () => translate('cmd.refFrontWindow'), hotkey: MOD_PAIR, run: () => { void captureFrontWindow() } }
  addCommand(cmd)
  const api = window.tangu.appRefs
  api.onHotkey?.((raw) => { const ref = normalizeAppRef(raw); if (ref) void captureFrontWindow(ref) })
  // 全局监听只在快捷键还是「双 ⌘」时要:用户在设置里改成别的键 / 解绑了,就让主进程断开那条订阅
  const sync = (): void => api.setGlobalHotkey?.(effectiveHotkey(cmd) === MOD_PAIR)
  sync()
  useShortcuts.subscribe(sync)
}
