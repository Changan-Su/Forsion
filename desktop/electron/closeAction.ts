/**
 * 点主窗 X(Windows 关闭钮 / Alt+F4、mac 红灯 / ⌘W)时做什么(config.closeAction,设置 → 通用 → 基本可改)。
 * 'ask'(缺省)= 弹框:退出 Forsion / 在后台运行 / 取消,带「不再询问」;'tray' = 只隐藏(旧行为);'quit' = 真退出。
 * 值读不到 / 不认识一律当 'ask',绝不当 'quit'。纯逻辑零 electron 依赖(对话框由 main 弹),vitest 直测。
 */
import { defineMainMessages, mt } from './mainI18n'

export type CloseAction = 'ask' | 'tray' | 'quit'

defineMainMessages({
  'main.closeConfirm.message': { zh: '要退出 Forsion 吗？', en: 'Quit Forsion?' },
  'main.closeConfirm.detail': {
    zh: '在后台运行时，会话、Muse 和同步不会中断，可从托盘图标重新打开。',
    en: 'In the background, sessions, Muse and sync keep running. Reopen Forsion from the tray icon.',
  },
  'main.closeConfirm.quit': { zh: '退出', en: 'Quit' },
  'main.closeConfirm.tray': { zh: '在后台运行', en: 'Keep running in background' },
  'main.closeConfirm.cancel': { zh: '取消', en: 'Cancel' },
  'main.closeConfirm.remember': { zh: '不再询问（可在设置中更改）', en: 'Don\'t ask again (change it in Settings)' },
})

export function storedCloseAction(v: unknown): CloseAction {
  return v === 'tray' || v === 'quit' ? v : 'ask'
}

/** 按钮顺序固定:0 退出 / 1 在后台运行 / 2 取消(Esc)。缺省焦点给「在后台运行」:手滑回车不至于把在跑的会话停掉。 */
export function closeDialogOptions() {
  return {
    type: 'question' as const,
    message: mt('main.closeConfirm.message'),
    detail: mt('main.closeConfirm.detail'),
    buttons: [mt('main.closeConfirm.quit'), mt('main.closeConfirm.tray'), mt('main.closeConfirm.cancel')],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
    checkboxLabel: mt('main.closeConfirm.remember'),
    checkboxChecked: false,
  }
}

/** 对话框结果 → 这次做什么 + 要不要记住。取消(或不认识的按钮)= 什么都不做,勾了也不记。 */
export function closeDialogPick(response: number, checked: boolean): { action: 'tray' | 'quit' | null; remember: boolean } {
  const action = response === 0 ? 'quit' : response === 1 ? 'tray' : null
  return { action, remember: action !== null && checked }
}
