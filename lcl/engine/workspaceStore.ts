/**
 * workspace store「选择器」:按启动时定格的 UI_MODE,决定 @lcl/engine barrel 的 `useWorkspace`
 * 指向桌面 Dockview store(./dockviewStore)还是单列 store(./singleColumnStore)。
 * views / spaces / 命令全经 barrel 拿到选中的那一个,**零改**即可整体跑单列。
 *
 * 注:mobile 构建的 vite engineSwap 把「本文件」整体换成 ./singleColumnStore,故 mobile 根本不经
 * 本选择器(也就不会把 Dockview 拽进移动包);本文件只服务 desktop/web。
 */
import { UI_MODE, IS_MINI_PANEL } from './uiMode'
import { useWorkspace as dockUseWorkspace } from './dockviewStore'
import { useWorkspace as singleUseWorkspace } from './singleColumnStore'

// 单列 store 实现了单列态下被真正调用的方法子集;对外以桌面 store 的类型(最全公共契约)呈现,
// 运行时按模式取真身。Dockview 专属方法在单列态由调用方的 `api ? …` 守卫短路,不会触达。
export const useWorkspace = (UI_MODE === 'mobile' || IS_MINI_PANEL ? singleUseWorkspace : dockUseWorkspace) as typeof dockUseWorkspace

// activeMainPanel(api) 恒由调用方以 `api ? …` 守卫,单列态 api=null 不调用 → 始终导出桌面版。
// scheduleWorkspaceSave 内部 saveCurrent 以 api 守卫,单列态无 api → no-op,安全。
export { activeMainPanel, scheduleWorkspaceSave } from './dockviewStore'
export type { MainTab, SideTab } from './dockviewStore'
