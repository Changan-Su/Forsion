/** 引擎公共 API。app/视图/插件只从这里 import,不深入引擎内部文件。 */
export type {
  ViewDefinition,
  ViewProps,
  ViewLocation,
  Leaf,
  Command,
  RibbonItem,
  StatusItem,
  PluginContext,
  SpaceDefinition,
} from './types'
export { label } from './types'

export { Shell } from './Shell'
export { startOpenDrag } from './WorkspaceHost'
export { SingleColumnHost } from './SingleColumnHost'
export { MiniColumnHost } from './MiniColumnHost'
export { UI_MODE, setUiMode } from './uiMode'
export type { UiMode } from './uiMode'
export { registerView, unregisterView, getView, allViews, subscribeViews } from './viewRegistry'
export { useWorkspace, activeMainPanel, scheduleWorkspaceSave } from './workspaceStore'
export type { MainTab, SideTab } from './workspaceStore'
export { useCommandStore, addCommand, removeCommand, openCommandPalette, openCommandPicker, installHotkeys } from './commandRegistry'
export { useShortcuts, effectiveHotkey, eventToHotkey, formatHotkey } from './shortcutStore'
export { useRibbonStore, addRibbonIcon, removeRibbonIcon, setRibbonActions } from './ribbonRegistry'
/** 拖拽重排的公共语义(悬停谁就顶掉谁);侧栏等 app 层的可排序列表复用同一个,别再各写一份 splice。 */
export { moveTo } from './ribbonRegistry'
export type { RibbonFolder, RibbonZone } from './ribbonRegistry'
export { useSpaceStore, registerSpace, unregisterSpace, setActiveSpace, setActiveSpaceCold, adoptSpaceLayoutCold, BOOT_ACTIVE_SPACE_ID, getActiveSpace, spaceLayoutName } from './spaceRegistry'
export { useNav, recordNav } from './navStore'
export type { NavEntry } from './navStore'
export { useStatusStore, addStatusItem, removeStatusItem } from './statusRegistry'
export { StatusBar, arrangeStatusItems } from './StatusBar'
export {
  saveNamedLayout,
  loadNamedLayout,
  listNamedLayouts,
  deleteNamedLayout,
  clearLayout,
} from './layoutPersist'
export type { PersistedPanel } from './layoutPersist'
/** 视口锚定的 fixed 浮层(右键菜单/补全/弹出层):自带 CSS zoom 反补偿 + 越界翻面。别再手写 left/top。 */
export { OverlayAt, useClampedMenu, clampMenu, useEdgeNudge, zoomOf, UI_ZOOM_EVENT } from './menuAnchor'
export type { AnchorOpts } from './menuAnchor'
export { setEngineI18n, useEngineI18n } from './i18nSeam'
/** 骨架屏(list/document/chat 三变体)+ 面板级错误边界:加载分支/懒视图兜底统一用它,别再各写空白或转圈。 */
export { Skeleton, ViewErrorBoundary, skeletonVariantOf } from './Skeleton'
export type { SkeletonVariant } from './Skeleton'
export { setDetachApi, getDetachApi } from './detachSeam'
export type { DetachApi, ViewRef } from './detachSeam'
