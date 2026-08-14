/** Space 注册表 + 单选切换。zustand store,Ribbon 顶部成组订阅。
 *  Space = 取代「App」的功能组合(见 types.SpaceDefinition)。切换 = 整体换布局:
 *  存出当前 Space 的命名布局 → 设新 Space 侧栏默认 → 还原其命名布局(无则 build)。
 *  只依赖引擎自身(useWorkspace),不 import feature 代码。 */
import { create } from 'zustand'
import type { SpaceDefinition } from './types'
import { useWorkspace } from './workspaceStore'
import { useNav } from './navStore'
import { loadLayout, saveLayout, clearLayout, loadNamedLayout, saveNamedLayout } from './layoutPersist'

const ACTIVE_KEY = 'forsion_tangu_active_space'
/** 每个 Space 的布局存进既有命名布局表,用此前缀的保留名。 */
export const spaceLayoutName = (id: string): string => `space:${id}`

function loadActive(): string {
  try { return localStorage.getItem(ACTIVE_KEY) || 'tangu' } catch { return 'tangu' }
}

/** 模块装载那一刻的活动 Space id = 「上次退出时在哪」的**原样**快照。
 *  ⚠️ 冷启动的布局归档必须用它,不能用 `useSpaceStore.getState().activeSpaceId` —— `registerSpaces()`
 *  会把「此刻尚未注册」的 id 就地归一成产品默认(用户 L0 Space 走异步装载、或该 Space 已被删),
 *  它跑在 installEngine 的启动策略**之前**。读归一后的值 = 把上一程的布局归档到别人名下:
 *  上次退出在用户 Space U → 归一成 tangu → U 的现场被写进 `space:tangu`,U 自己的槽还停在上上次
 *  (Codex 评审 2026-08-13 抓的 High)。 */
export const BOOT_ACTIVE_SPACE_ID: string = loadActive()

interface SpaceState {
  spaces: SpaceDefinition[]
  activeSpaceId: string
  /** 注册一个 Space(按 id upsert,保持注册序)。 */
  registerSpace(def: SpaceDefinition): void
  /** 注销一个 Space(用户自定义 Space 删除用)。调用方须先切走活动 Space,再清 ribbon/命名布局。 */
  unregisterSpace(id: string): void
  /** 切到某 Space(整体换布局)。同 id 则 no-op。 */
  setActiveSpace(id: string): void
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  activeSpaceId: loadActive(),

  registerSpace: (def) =>
    set((s) => ({ spaces: [...s.spaces.filter((x) => x.id !== def.id), def] })),

  unregisterSpace: (id) => set((s) => ({ spaces: s.spaces.filter((x) => x.id !== id) })),

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
    ws.setSideProfile(toId, toSpace.resizableSides ?? {}, toSpace.sideDefaultScale) // 载入该 Space 记住的可拖宽侧栏宽度(须先于 applyNamed/build 的 pinSides)

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

/** 冷启动定位:直接把活动 Space 钉到 id + 写 ACTIVE_KEY,不存旧布局、不套命名布局 ——
 *  布局交给 onReady 的 buildDefault 重建成该 Space 的干净默认(「默认 Space」启动设置用)。
 *  id 未注册(如用户 L0 Space 尚未异步装载)则不动,调用方自行回退。 */
export function setActiveSpaceCold(id: string): void {
  const { spaces } = useSpaceStore.getState()
  if (!spaces.some((s) => s.id === id)) return
  useSpaceStore.setState({ activeSpaceId: id })
  try { localStorage.setItem(ACTIVE_KEY, id) } catch { /* ignore */ }
}

/** 冷启动的每-Space 布局交接。**纯 Storage 搬运**,故可以跑在 Dockview api 就绪之前(onReady 之前
 *  没有 api,saveNamed/applyNamed 都是空转)。
 *  ① 先把本窗布局键归档进「上次退出的那个 Space」的命名槽 —— 会话中只有**切走**才写命名槽,
 *     直接退出的那个 Space 槽里还是上上次的样子,不补这一手就等于每次退出都丢一次。
 *  ② 再把目标 Space 的命名布局搬进布局键,交给 onReady 的 tryRestoreLayout 自然吃到;没有则清空,
 *     落空 → buildDefault 建该 Space 的干净默认。
 *  from === to(最常见:固定启动 Space 恰好就是上次退出那个)只归档,布局键原样留着。 */
export function adoptSpaceLayoutCold(fromId: string, toId: string): void {
  const cur = loadLayout()
  if (cur) saveNamedLayout(spaceLayoutName(fromId), cur)
  if (fromId === toId) return
  // ⚠️ 归档没真落盘(配额满 / 私密模式 —— saveNamedLayout 是吞掉异常的 void)就别再动布局键:
  // 那是这份布局**仅存的一份**,搬走或清掉即等于直接丢。读回来确认过再往下(Codex 评审抓的 Medium)。
  if (cur && !loadNamedLayout(spaceLayoutName(fromId))) return
  const next = loadNamedLayout(spaceLayoutName(toId))
  if (next) saveLayout(next)
  else clearLayout()
}

export const registerSpace = (def: SpaceDefinition): void => useSpaceStore.getState().registerSpace(def)
export const unregisterSpace = (id: string): void => useSpaceStore.getState().unregisterSpace(id)
export const setActiveSpace = (id: string): void => useSpaceStore.getState().setActiveSpace(id)
