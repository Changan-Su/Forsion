/**
 * 引擎外壳:ribbon(左固定条) | WorkspaceHost(Dockview 三区) 上叠 命令面板浮层。
 * 纯呈现:dark/soft 由 app 从主题状态传入(引擎不 import feature 代码);挂载时装全局热键。
 */
import { useEffect } from 'react'
import { Ribbon } from './Ribbon'
import { CommandPalette } from './CommandPalette'
import { WorkspaceHost } from './WorkspaceHost'
import { installHotkeys } from './commandRegistry'
import './engine.css'

export const Shell: React.FC<{
  dark: boolean
  soft: boolean
  buildDefault?: () => void
  /** 顶部头条(feature 层注入,引擎不 import feature 代码);兼作 macOS hiddenInset 可拖拽标题区。 */
  header?: React.ReactNode
}> = ({ dark, soft, buildDefault, header }) => {
  useEffect(() => installHotkeys(), [])
  return (
    <div className="shell">
      {header}
      <div className="shell-top">
        <Ribbon />
        <div className="shell-work">
          <WorkspaceHost dark={dark} soft={soft} buildDefault={buildDefault} />
        </div>
      </div>
      <CommandPalette />
    </div>
  )
}
