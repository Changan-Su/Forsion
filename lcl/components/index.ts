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
