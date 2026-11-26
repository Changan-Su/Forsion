/**
 * 插件桌面小窗的第一次询问(方案页第七节第 2 件,用户 11-26 按建议定:每个插件第一次开时问一次,记住答案)。
 * 照演示舞台(pluginStage.ts)的口径:挂主窗的系统对话框,两个按钮;答案由 pluginDesktopWindows.ts 记。
 */
import { dialog, type BrowserWindow } from 'electron'
import { defineMainMessages, mt } from './mainI18n'

defineMainMessages({
  'main.desktopWindow.confirm.message': { zh: '允许「{name}」在桌面上显示小窗吗？', en: 'Allow "{name}" to show windows on your desktop?' },
  'main.desktopWindow.confirm.detail': {
    zh: '这个插件想在桌面上放小窗，浮在其他应用上面，Forsion 最小化时也在。小窗随时可以在托盘菜单的「桌面小窗」里关掉，也可以在设置 → 插件里收回这项授权。只问这一次。',
    en: 'This plugin wants to put small windows on your desktop, above other apps, even while Forsion is minimized. You can close them anytime from "Desktop windows" in the tray menu, or take this permission back in Settings → Plugins. You will only be asked once.',
  },
  'main.desktopWindow.confirm.allow': { zh: '允许', en: 'Allow' },
  'main.desktopWindow.confirm.deny': { zh: '不允许', en: "Don't allow" },
})

export async function confirmDesktopWindow(parent: BrowserWindow | null, plugin: { id: string; name: string }): Promise<boolean> {
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    message: mt('main.desktopWindow.confirm.message', { name: plugin.name }),
    detail: mt('main.desktopWindow.confirm.detail'),
    buttons: [mt('main.desktopWindow.confirm.allow'), mt('main.desktopWindow.confirm.deny')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  return r.response === 0
}
