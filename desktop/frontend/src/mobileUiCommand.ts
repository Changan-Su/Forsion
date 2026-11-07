/**
 * 「移动端 UI 预览」命令的注册/注销 + 开关持久化键。
 * - bootstrapEngine 启动时按开关(MOBILE_UI_KEY)注册;
 * - SettingsModal 开发者选项切换时即时增删(免 reload 就能在命令面板看到)。
 * 命令 run = 写下次 UI 模式 + 整窗重载(reloadWindow.ts;见 @lcl/engine/uiMode)。
 */
import { addCommand, removeCommand, UI_MODE, setUiMode } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { reloadWindow } from './reloadWindow'

export const MOBILE_UI_KEY = 'forsion_tangu_mobile_ui'

/** enabled=开关态。已处于移动模式时命令强制保留(否则单列态无从切回)。 */
export function setMobileUiCommand(enabled: boolean): void {
  if (enabled || UI_MODE === 'mobile') {
    addCommand({
      id: 'switch-ui-mode',
      title: () =>
        useApp.getState().tr(UI_MODE === 'mobile' ? 'command.switchToDesktopUi' : 'command.switchToMobileUi'),
      keywords: 'mobile desktop ui 移动 桌面 单列 预览',
      run: () => {
        setUiMode(UI_MODE === 'mobile' ? 'desktop' : 'mobile')
        reloadWindow()
      },
    })
  } else {
    removeCommand('switch-ui-mode')
  }
}
