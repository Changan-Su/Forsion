/** Space 注册表 + 单选切换。zustand store,Ribbon 顶部成组订阅。
 *  Space = 取代「App」的功能组合(见 types.SpaceDefinition)。切换 = 整体换布局:
 *  存出当前 Space 的命名布局 → 设新 Space 侧栏默认 → 还原其命名布局(无则 build)。
 *  只依赖引擎自身(useWorkspace),不 import feature 代码。 */
import { create } from 'zustand'
import type { SpaceDefinition } from './types'
import { useWorkspace } from './workspaceStore'
import { useNav } from './navStore'

const ACTIVE_KEY = 'forsion_tangu_active_space'
/** 每个 Space 的布局存进既有命名布局表,用此前缀的保留名。 */
export const spaceLayoutName = (id: string): string => `space:${id}`

function loadActive(): string {
  try { return localStorage.getItem(ACTIVE_KEY) || 'tangu' } catch { return 'tangu' }
}

interface SpaceState {
  spaces: SpaceDefinition[]
  activeSpaceId: string
  /** 注册一个 Space(按 id upsert,保持注册序)。 */
  registerSpace(def: SpaceDefinition): void
  /** 切到某 Space(整体换布局)。同 id 则 no-op。 */
  setActiveSpace(id: string): void
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  activeSpaceId: loadActive(),

  registerSpace: (def) =>
    set((s) => ({ spaces: [...s.spaces.filter((x) => x.id !== def.id), def] })),

  setActiveSpace: (toId) => {
    const { spaces, activeSpaceId: fromId } = get()
    if (toId === fromId) return
    const toSpace = spaces.find((s) => s.id === toId)
    if (!toSpace) return
    const ws = useWorkspace.getState()

    ws.saveNamed(spaceLayoutName(fromId)) // 1. 存出当前 Space 布局
    set({ activeSpaceId: toId })           // 2. 先切 id(defaultBuilder 经 getActiveSpace 取新 Space)
    try { localStorage.setItem(ACTIVE_KEY, toId) } catch { /* ignore */ }
    ws.setSidebarDefaults(toSpace.sidebarDefaults) // 3. 两路都需(applyNamed 不跑 build)

    // 4. 还原目标 Space:有命名布局则应用(applyNamed 不持久化,补 saveCurrent);否则 resetLayout 重建+持久化
    const saved = ws.namedLayouts().includes(spaceLayoutName(toId))
    if (saved && ws.applyNamed(spaceLayoutName(toId))) ws.saveCurrent()
    else ws.resetLayout()

    useNav.getState().reset() // 布局整体更换,旧 leaf id 全失效 → 清全部 per-tab 历史
  },
}))

/** 当前活动 Space(找不到回退首个;无 Space 时 undefined)。 */
export const getActiveSpace = (): SpaceDefinition | undefined => {
  const { spaces, activeSpaceId } = useSpaceStore.getState()
  return spaces.find((s) => s.id === activeSpaceId) ?? spaces[0]
}

export const registerSpace = (def: SpaceDefinition): void => useSpaceStore.getState().registerSpace(def)
export const setActiveSpace = (id: string): void => useSpaceStore.getState().setActiveSpace(id)
