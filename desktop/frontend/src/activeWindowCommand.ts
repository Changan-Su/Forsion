/**
 * 「前台窗口采样」调试面板命令的注册/注销(照 activityViewCommand 同款模式)。
 * - bootstrapEngine 启动时按**主进程开关** config.activeWindowEnabled 注册(不另设一个 localStorage 旋钮:
 *   采样本身默认关且只在开发者选项里能开,开了就该看得到面板);
 * - SettingsModal 里拨开关时同步增删(免 reload)。
 * - 视图本体 active-window 恒注册,这里只控制 ⌘K 入口。
 */
import { addCommand, removeCommand, useWorkspace } from '@lcl/engine'
import { useApp } from './stores/appStore'

export function setActiveWindowCommand(enabled: boolean): void {
  if (enabled) {
    addCommand({
      id: 'open-active-window',
      title: () => useApp.getState().tr('command.openActiveWindow'),
      keywords: 'active window focus 前台 窗口 采样 焦点 调试 debug',
      run: () => { useWorkspace.getState().openView('active-window', {}, 'main') },
    })
  } else {
    removeCommand('open-active-window')
  }
}
