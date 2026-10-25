/** 引擎公共 API。app/视图/插件只从这里 import,不深入引擎内部文件。 */
export type {
  ViewDefinition,
  ViewProps,
  ViewLocation,
  DashboardCardSize,
  DashboardCardSurface,
  DashboardCardContext,
  DashboardCardDefinition,
  Leaf,
  Command,
  RibbonItem,
  RibbonMenuEntry,
  StatusItem,
  PluginContext,
  SpaceDefinition,
  SpaceIcon,
  SidebarDefaults,
} from './types'
export { label } from './types'

export { Shell } from './Shell'
export { startOpenDrag } from './WorkspaceHost'
export { useViewModes, useViewModesOf, viewModesOf, viewModeTarget, nextViewMode, installViewModeCommands, inSingleColumnShell, ViewModeSwitch, ViewHead, VIEW_MODE_NEXT } from './viewModes'
export type { ViewModeOption, ViewModesSpec } from './viewModes'
export { openMainBesideThisTask, mainOpensBeside } from './openBeside'
export { SingleColumnHost, accountMenuRows, drawerPreview, useWideLayout } from './SingleColumnHost'
export { listFirstNow, useListFirst } from './listFirst'
export { MiniColumnHost } from './MiniColumnHost'
export { useMiniChrome } from './miniChrome'
export type { MiniChromePicker } from './miniChrome'
export { supportsMiniPanel, setMiniMainHandler, showInMainPanel, setMiniViewRouter } from './miniPanel'
export type { MiniPanelDefinition, MiniViewTarget, MainPanelTarget } from './miniPanel'
export { UI_MODE, setUiMode, WINDOW_SPACE_ID } from './uiMode'
export type { UiMode } from './uiMode'
export { registerView, unregisterView, getView, allViews, subscribeViews } from './viewRegistry'
export { useWorkspace, activeMainPanel, scheduleWorkspaceSave, bootLayoutFellThrough, namedLayoutRestorable, liveLayoutOwner, savedLayoutRestorable } from './workspaceStore'
export type { MainTab, SideTab } from './workspaceStore'
export { useCommandStore, addCommand, removeCommand, openCommandPalette, openCommandPicker, installHotkeys, commandHotkeyText } from './commandRegistry'
export { useShortcuts, effectiveHotkey, eventToHotkey, formatHotkey, isMacPlatform, isPairHotkey, pairHotkeyOf, trackPair, MOD_PAIR } from './shortcutStore'
export { useRibbonStore, addRibbonIcon, removeRibbonIcon, setRibbonActions, RIBBON_RECENT_MAX } from './ribbonRegistry'
/** 拖拽重排的公共语义(悬停谁就顶掉谁);侧栏等 app 层的可排序列表复用同一个,别再各写一份 splice。 */
export { moveTo, rankIds } from './ribbonRegistry'
export type { RibbonFolder, RibbonZone } from './ribbonRegistry'
export { useSpaceStore, registerSpace, unregisterSpace, setActiveSpace, setActiveSpaceCold, adoptSpaceLayoutCold, seedSpaceWindowLayout, resetSpaceLayouts, spaceLayoutsWereReset, BOOT_ACTIVE_SPACE_ID, getActiveSpace, spaceLayoutName, setSpacePinHandler, pinSpaceToHome, openRedirectType, landOnMainPage } from './spaceRegistry'
export { isPinned } from './pinnedViews'
export type { PinnedViews } from './pinnedViews'
export { useNav, recordNav } from './navStore'
export type { NavEntry } from './navStore'
export { useStatusStore, addStatusItem, removeStatusItem } from './statusRegistry'
export { StatusBar, arrangeStatusItems } from './StatusBar'
export {
  loadLayout,
  saveLayout,
  saveNamedLayout,
  loadNamedLayout,
  listNamedLayouts,
  deleteNamedLayout,
  clearLayout,
} from './layoutPersist'
export type { PersistedPanel, LayoutBlob } from './layoutPersist'
/** 视口锚定的 fixed 浮层(右键菜单/补全/弹出层):自带 CSS zoom 反补偿 + 越界翻面。别再手写 left/top。 */
export { OverlayAt, useExitGhost, useClampedMenu, clampMenu, useEdgeNudge, nestedPanelPlacement, nestedPanelTop, zoomOf, UI_ZOOM_EVENT } from './menuAnchor'
export type { NestedPanelPlacement } from './menuAnchor'
export type { AnchorOpts } from './menuAnchor'
/** 落点提示(拖动时的落点线 / 放进去的描边):换落点原地淡出淡入。见 dropIndicator.ts 顶注。 */
export { createDropIndicator, dropRetarget, dropHide, DROP_IN_MS, DROP_OUT_MS, land, landCancel, landWhenMoved, landOffset, dragGrab, releasePoint, LAND_MS } from './dropIndicator'
export type { DropIndicator, DropRect, DropShape, DropRetargetOptions, LandPoint, LandOptions } from './dropIndicator'
export { setEngineI18n, useEngineI18n, engineTr } from './i18nSeam'
/** 输入法组字守卫:面板输入框的 onKeyDown 第一行问它,组字中的 Enter/↑↓/Esc 归输入法(评审 G4-02)。 */
export { isImeKeyEvent } from './ime'
export { LCL_MESSAGES } from './engineMessages'
/** 骨架屏(list/document/chat 三变体)+ 面板级错误边界:加载分支/懒视图兜底统一用它,别再各写空白或转圈。 */
export { Skeleton, ViewErrorBoundary, skeletonVariantOf } from './Skeleton'
export type { SkeletonVariant } from './Skeleton'
/** Shared collapsed-rail / expanded-list table of contents for scrollable feature surfaces. */
export { FloatingToc, defaultFloatingTocItem, scrollToElement, cancelScrollToElement } from './FloatingToc'
export type {
  FloatingTocElementSource,
  FloatingTocItemDescriptor,
  FloatingTocItemReader,
  FloatingTocOptions,
  FloatingTocProps,
} from './FloatingToc'
export { setDetachApi, getDetachApi } from './detachSeam'
export type { DetachApi, ViewRef } from './detachSeam'

export type { ExtendViewController, ExtendViewOptions, ExtendViewHandle, ExtendViewSide, ExtendViewCloseReason } from './extendView'
export { ExtendViewHost } from './ExtendViewHost'

export { contentStorageKey } from './contentStorageScope'

export { switchSpace, setSpaceBarOrder, spaceSwitchDirection, type SpaceSwitchMotion } from './spaceTransition'
export { SPRING_PAGE, SPRING_ROW, reducedMotion, springAt, springEasing, springMotion, type Spring } from './spring'

/** Optional native presentation hosts (Android Compose). Absent host ⇒ callers keep their web UI. */
export {
  installNativeSheetPresenter, nativeSheetPresenter, presentNativeMenu, presentNativeChecklist, presentNativePrompt, presentNativeConfirm,
  pickNativeCtxItem, runNativeCtxMenu, readNativeTheme, menuResult, checklistResult, promptResult, confirmResult, clipNativeText, NATIVE_MENU_MAX_ITEMS,
} from './nativeSheet'
export type {
  NativeSheetTheme, NativeSheetRequest, NativeSheetPayload, NativeSheetPresenter, NativeSheetOutcome,
  NativeMenuRequest, NativeMenuSection, NativeMenuItem, NativeMenuTrailing, NativeMenuResult, NativeMenuSearch,
  NativeChecklistRequest, NativeChecklistResult, NativePromptRequest, NativePromptResult, NativeConfirmRequest, NativeConfirmResult, NativeCtxItem,
} from './nativeSheet'
export { runNativeSheetMenu, openNativeSheetMenu, useNativeSheetMenu } from './nativeSheetMenu'
export type { SheetMenu, SheetMenuSection, SheetMenuItem } from './nativeSheetMenu'
export { installNativeSelect } from './nativeSelect'
export type { NativeSelectOptions } from './nativeSelect'
export { renderNativeIcons } from './nativeIcon'
export type { NativeIcon, NativeIconSource, NativeVectorPath } from './nativeIcon'
export {
  installNativeChromeHost, nativeChromeInstalled, useNativeChromeInstalled, setNativeChromeShell,
  claimNativeChrome, useNativeChromeClaim, dispatchNativeChromeAction, nativeChromeState,
  nativeChromeDrawsSpaces, useNativeChromeSpaces, dispatchNativeChromeSpace, nativeHaptic, nativeHapticAvailable,
  useNativeChromeExtras, nativeChromeExtras, subscribeNativeChromeExtras, nativeRailCells, NATIVE_RAIL_WIDTH,
} from './nativeChrome'
export type {
  NativeChromeAction, NativeChromeState, NativeChromeShellState, NativeChromePageState, NativeChromeHiddenState,
  NativeChromeHost, NativeChromeClaim, NativeChromeClaimHandle, NativeChromeShellLabels, NativeChromeShellHandlers,
  NativeChromeSpace, NativeHaptic,
} from './nativeChrome'
