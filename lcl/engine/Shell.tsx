/**
 * 引擎外壳:ribbon(左固定条) | WorkspaceHost(Dockview 三区) 上叠 命令面板浮层。
 * 纯呈现:dark/soft 由 app 从主题状态传入(引擎不 import feature 代码);挂载时装全局热键。
 */
import { useEffect } from 'react'
import { Ribbon } from './Ribbon'
import { CommandPalette } from './CommandPalette'
import { WorkspaceHost } from './WorkspaceHost'
import { installHotkeys } from './commandRegistry'
import { installSashAffordance } from './sashAffordance'
import { UI_MODE } from './uiMode'
import { SingleColumnHost } from './SingleColumnHost'
import './engine.css'

export const Shell: React.FC<{
  dark: boolean
  soft: boolean
  buildDefault?: () => void
  /** 顶部头条(feature 层注入,引擎不 import feature 代码);兼作 macOS hiddenInset 可拖拽标题区。 */
  header?: React.ReactNode
  /** 独立窗口:不渲染左侧 ribbon 活动栏(以区别主窗;WorkspaceHost 占满宽度)。 */
  noRibbon?: boolean
  /** 底部条(feature 层注入,如 StatusBar;引擎不 import feature 代码)。mobile 单列壳不渲染。 */
  footer?: React.ReactNode
}> = ({ dark, soft, buildDefault, header, noRibbon, footer }) => {
  useEffect(() => installHotkeys(), [])
  useEffect(() => installSashAffordance(), [])
  // UI_MODE==='mobile'(开发者预览):渲染单列壳 + 命令面板(Cmd/K = 切回桌面 UI 的逃生口)。「手机框」由
  // Root 套在整个 app 外(含设置/商店/成就等二级界面浮层),故这里只出裸壳。真机不经 Shell(emptyHost)。
  if (UI_MODE === 'mobile') {
    return (
      <>
        <SingleColumnHost dark={dark} soft={soft} buildDefault={buildDefault} />
        <CommandPalette />
      </>
    )
  }
  return (
    <div className="shell">
      {header}
      <div className="shell-top">
        {!noRibbon && <Ribbon />}
        <div className="shell-work">
          <WorkspaceHost dark={dark} soft={soft} buildDefault={buildDefault} />
          {/* 状态栏占 .shell-work 底部一条(顶起 dockview 的 main/left/right,不占 .shell-top→ribbon 满高不抬)。 */}
          {footer}
        </div>
      </div>
      <CommandPalette />
    </div>
  )
}
