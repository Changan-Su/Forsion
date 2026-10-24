/** UI within a View. Import this entry point rather than a View's private implementation. */
export { ChatBox, ChatBoxSurface, ChatBoxInput, ChatBoxToolbar, ChatBoxSubmit } from './ChatBox'
export type { ChatBoxProps, ChatBoxInputProps } from './ChatBox'
export { mountHostReact, claimHostMount } from './mountHostReact'
export type { HostReactMount } from './mountHostReact'
export { SelectionBar, SelectionBarActions } from './SelectionBar'
export type { SelectionBarAction, SelectionBarTool, SelectionBarOrder } from './SelectionBar'
/** 看法胶囊 / 视图头行(真身在引擎:手机顶栏也要画它)。标准见 viewModes.tsx 顶注。 */
export { ViewModeSwitch, ViewHead } from '../engine/viewModes'
export type { ViewModeOption, ViewModesSpec } from '../engine/viewModes'
/** 提示框 / 悬停卡:300ms 才出、相邻接力不重播、键盘聚焦不做动画(真身在引擎 hoverSurface.ts)。插件走 ctx.ui.attachTooltip。 */
export { tooltipProps, attachTooltip, hideTooltip, useHoverCard } from './Tooltip'
export type { TooltipContent, TooltipLines, TooltipOptions, HoverCardOptions, HoverSide } from './Tooltip'
/** 落点提示:拖动排序 / 拖入时的那根线、那圈描边,换落点原地淡出淡入(真身在引擎 dropIndicator.ts)。插件走 ctx.ui.dropIndicator。 */
export { createDropIndicator, dropRetarget, dropHide } from '../engine/dropIndicator'
export type { DropIndicator, DropRect, DropShape, DropRetargetOptions } from '../engine/dropIndicator'
