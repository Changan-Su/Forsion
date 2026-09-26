/** LCL 引擎自带的界面文案(zh/en 成对)。
 *
 *  为什么引擎自己带一份:引擎不依赖宿主的 i18n 实现(见 i18nSeam),但 Ribbon / 标签条 / 浮钮组这些
 *  文案是引擎自己的。宿主装配期把这份表 `registerMessages` 进自己的字典(desktop 的 installEngine),
 *  于是切语言走宿主的 context 当场生效;没有宿主(测试、vite 台架、未装配的独立窗口)时 i18nSeam
 *  用这份表按 `<html lang>` 兜底,不会渲染出裸键。
 *
 *  ⚠️ 纯字面量:desktop 的 i18nCoverage.test 直接 import 它做 zh/en 键集比对,别在这里写表达式。
 *  键一律 `lcl.` 命名空间(`engine.*` 已被 Tangu 引擎选择器占用)。 */
export const LCL_MESSAGES: Record<string, { zh: string; en: string }> = {
  // 通用:「名称(快捷键)」拼接,快捷键按平台格式化后填入 {key}
  'lcl.withHotkey': { zh: '{label}（{key}）', en: '{label} ({key})' },

  // Ribbon
  'lcl.ribbon.showLabels': { zh: '显示名称', en: 'Show labels' },
  'lcl.ribbon.iconsOnly': { zh: '只显示图标', en: 'Icons only' },
  'lcl.ribbon.addSpaceOrFolder': { zh: '新建 Space 或收纳夹', en: 'New Space or folder' },
  'lcl.ribbon.addCommand': { zh: '添加命令', en: 'Add command' },
  'lcl.ribbon.more': { zh: '更多', en: 'More' },
  'lcl.ribbon.switchSpace': { zh: '切到第 {n} 个 Space', en: 'Switch to Space {n}' },
  'lcl.ribbon.newSpace': { zh: '新建 Space', en: 'New Space' },
  'lcl.ribbon.newFolder': { zh: '新建收纳夹', en: 'New folder' },
  'lcl.ribbon.folderDefaultName': { zh: '收纳夹', en: 'Folder' },
  'lcl.ribbon.newFolderSpaces': { zh: '新建收纳夹（Space 区）', en: 'New folder (Spaces)' },
  'lcl.ribbon.newFolderCommands': { zh: '新建收纳夹（命令区）', en: 'New folder (commands)' },
  'lcl.ribbon.changeIcon': { zh: '更换图标', en: 'Change icon' },
  'lcl.ribbon.rename': { zh: '重命名', en: 'Rename' },
  'lcl.ribbon.renameFolder': { zh: '重命名收纳夹', en: 'Rename folder' },
  'lcl.ribbon.dissolveFolder': { zh: '解散收纳夹', en: 'Dissolve folder' },
  'lcl.ribbon.setIcon': { zh: '设置图标', en: 'Set icon' },
  'lcl.ribbon.removeCommand': { zh: '从 Ribbon 移除', en: 'Remove from ribbon' },
  'lcl.ribbon.moveOut': { zh: '移出收纳夹', en: 'Move out of folder' },
  'lcl.ribbon.folderEmpty': { zh: '把图标拖到收纳夹图标上即可放入', en: 'Drag icons onto the folder to collect them' },
  'lcl.ribbon.defaultIcon': { zh: '默认图标', en: 'Default icon' },

  // 标签条 / 主区前后缀 / 右上角浮钮组
  'lcl.tab.close': { zh: '关闭', en: 'Close' },
  'lcl.tab.moveToWindow': { zh: '移到新窗口', en: 'Move to new window' },
  'lcl.tab.new': { zh: '新建标签页', en: 'New tab' },
  'lcl.nav.back': { zh: '后退', en: 'Back' },
  'lcl.nav.forward': { zh: '前进', en: 'Forward' },
  'lcl.edge.left': { zh: '左侧栏', en: 'Toggle left panel' },
  'lcl.edge.right': { zh: '右侧栏', en: 'Toggle right panel' },
  'lcl.edge.bottom': { zh: '底部面板', en: 'Toggle bottom panel' },
  'lcl.edge.reset': { zh: '恢复本 Space 默认布局', en: 'Restore default layout for this Space' },
  'lcl.layout.restored': { zh: '已恢复本 Space 默认布局', en: 'Restored the default layout' },
  'lcl.layout.undo': { zh: '撤销', en: 'Undo' },

  // 视图错误边界
  'lcl.view.loadFailed': { zh: '此视图加载失败', en: 'Failed to load this view' },
  'lcl.view.retry': { zh: '重试', en: 'Retry' },

  // 命令面板 / Mini Panel / 移动单列壳
  'lcl.palette.pickCommand': { zh: '选择要添加的命令…', en: 'Pick a command to add…' },
  'lcl.mini.switchSpace': { zh: '切换 Space', en: 'Switch Space' },
  'lcl.mini.showMain': { zh: '在主面板显示', en: 'Show in main panel' },
  'lcl.mini.close': { zh: '关闭 Mini Panel', en: 'Close Mini Panel' },
  'lcl.mini.empty': { zh: '暂无已适配的 Space', en: 'No Mini Panel Spaces available' },
  'lcl.mini.closeMenu': { zh: '关闭菜单', en: 'Close menu' },
  'lcl.mobile.closeTab': { zh: '关闭标签页', en: 'Close tab' },
}
