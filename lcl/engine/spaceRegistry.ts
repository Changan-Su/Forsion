/** Space 注册表 + 单选切换。zustand store,Ribbon 顶部成组订阅。
 *  Space = 取代「App」的功能组合(见 types.SpaceDefinition)。切换 = 整体换布局:
 *  存出当前 Space 的命名布局 → 设新 Space 侧栏默认 → 还原其命名布局(无则 build)。
 *  只依赖引擎自身(useWorkspace),不 import feature 代码。 */
import { create } from 'zustand'
import { IS_MINI_PANEL, IS_TRANSIENT_MINI_PANEL } from './uiMode'
import { supportsMiniPanel } from './miniPanel'
import type { SpaceDefinition } from './types'
import { useWorkspace, liveLayoutOwner } from './workspaceStore'
import { loadLayout, saveLayout, clearLayout, loadNamedLayout, saveNamedLayout, listNamedLayouts, deleteNamedLayout } from './layoutPersist'
import { clearSingleColumnLayouts } from './singleColumnStore'

const ACTIVE_KEY = IS_MINI_PANEL ? 'forsion_mini_active_space' : 'forsion_tangu_active_space'
/** 每个 Space 的布局存进既有命名布局表,用此前缀的保留名。 */
export const spaceLayoutName = (id: string): string => `space:${id}`

function loadActive(): string {
  if (IS_TRANSIENT_MINI_PANEL) return 'tangu'
  try { return localStorage.getItem(ACTIVE_KEY) || 'tangu' } catch { return 'tangu' }
}

/** 模块装载那一刻的活动 Space id = 「上次退出时在哪」的**原样**快照。
 *  ⚠️ 冷启动的布局归档必须用它,不能用 `useSpaceStore.getState().activeSpaceId` —— `registerSpaces()`
 *  会把「此刻尚未注册」的 id 就地归一成产品默认(用户 L0 Space 走异步装载、或该 Space 已被删),
 *  它跑在 installEngine 的启动策略**之前**。读归一后的值 = 把上一程的布局归档到别人名下:
 *  上次退出在用户 Space U → 归一成 tangu → U 的现场被写进 `space:tangu`,U 自己的槽还停在上上次
 *  (Codex 评审 2026-08-13 抓的 High)。
 *  这份快照可信的前提:归一后的值**从不落盘**(registerSpaces 只改内存)。落了盘,下一程的快照就是回落 Space,
 *  等于把上面那个坑挪到下次启动再踩。 */
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
    if (IS_MINI_PANEL && !supportsMiniPanel(toSpace)) return
    const ws = useWorkspace.getState()

    // 1. 存出当前布局,存进**它的主人**的槽。平时主人就是 fromId;启动还原出异步 Space 的现场、而它还没就位时
    //    (内存里的活动 id 是回落 Space),屏上是那个 Space 的,按 fromId 存就写进了回落 Space 的槽。
    if (!IS_MINI_PANEL) ws.saveNamed(spaceLayoutName(liveLayoutOwner() ?? fromId))
    set({ activeSpaceId: toId })           // 2. 先切 id(defaultBuilder 经 getActiveSpace 取新 Space)
    try { if (!IS_TRANSIENT_MINI_PANEL) localStorage.setItem(ACTIVE_KEY, toId) } catch { /* ignore */ }
    if (IS_MINI_PANEL) {
      // Never restore the old Mini/mobile workspace blob or build desktop sidebars.
      ws.resetLayout()
      return
    }
    ws.setSidebarDefaults(toSpace.sidebarDefaults) // 3. 两路都需(applyNamed 不跑 build)
    ws.setSideProfile(toId, toSpace.resizableSides ?? {}, toSpace.sideDefaultScale, toSpace.bottomSpan) // 载入该 Space 记住的可拖宽侧栏宽度(须先于 applyNamed/build 的 pinSides)
    ws.setPinned(toSpace.pinned)

    // 4. 还原目标 Space:有命名布局则应用(applyNamed 不持久化,补 saveCurrent);否则 resetLayout 重建+持久化
    const saved = ws.namedLayouts().includes(spaceLayoutName(toId))
    // per-tab 历史由 applyNamed / resetLayout 各自在换布局时清(两种 store 都是)。⚠️ 这里别再补一次 reset:
    // 它跑在重建之后,会把还原出来的前台文件视图刚记下的栈底一起清掉 → 后退恒灰(09-16 active-tab.e2e)。
    // 已存布局里缺了固定 View(插件停用时被清场、Space 后来新增了固定项…)→ 补回来;resetLayout 那一路由 build() 负责。
    if (saved && ws.applyNamed(spaceLayoutName(toId))) { ws.ensurePinned(); ws.saveCurrent() }
    else ws.resetLayout()
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
  try { if (!IS_TRANSIENT_MINI_PANEL) localStorage.setItem(ACTIVE_KEY, id) } catch { /* ignore */ }
}

/** 冷启动的每-Space 布局交接。**纯 Storage 搬运**,故可以跑在 Dockview api 就绪之前(onReady 之前
 *  没有 api,saveNamed/applyNamed 都是空转)。
 *  ① 先把本窗布局键归档进「上次退出的那个 Space」的命名槽 —— 会话中只有**切走**才写命名槽,
 *     直接退出的那个 Space 槽里还是上上次的样子,不补这一手就等于每次退出都丢一次。
 *  ② 再把目标 Space 的命名布局搬进布局键,交给 onReady 的 tryRestoreLayout 自然吃到;没有则清空,
 *     落空 → buildDefault 建该 Space 的干净默认。
 *  from === to(最常见:固定启动 Space 恰好就是上次退出那个)只归档,布局键原样留着。
 *
 *  布局键是给谁摆的,认**信封自己记的归属**(layout.space,与布局同一次写盘),老存档没记才信 fromId。
 *  两者对不上 = 上一程目标 Space 始终没就位(插件没装上 / 配方没过闸 / 没等到它就退出了),屏上一直是回落 Space、
 *  从它的默认布局起步:fromId 仍是目标 Space,布局键却是回落 Space 的。只信 fromId 就会把它归档进目标 Space 的槽。 */
export function adoptSpaceLayoutCold(fromId: string, toId: string): void {
  const cur = loadLayout()
  const owner = cur?.space || fromId
  // 归属对不上的那份不归档:进 space:<fromId> 是记到别人名下;进 space:<owner> 会拿一份「默认布局起步」的东西盖掉
  // 回落 Space 自己攒下的存档(正常启动里插件就位前那一两秒退出,布局键里就是一份原样的默认)。
  // ponytail: 于是那一程在回落 Space 里开的标签只活在布局键里,目标 Space 回来 / 改成固定启动别的 Space 时随之丢掉
  // (期间切过一次 Space 就已由 setActiveSpace 存进槽)。要保住得先能分清「原样的默认」和「用户动过的」。
  const provisional = owner !== fromId
  if (cur && !provisional) saveNamedLayout(spaceLayoutName(fromId), cur)
  if (owner === toId) {
    if (cur && !cur.space) saveLayout({ ...cur, space: owner }) // 老存档补记归属:onReady 还原后存盘据此认主
    return
  }
  // 布局键正是此刻内存里的活动 Space 自己的(目标还没注册 → 活动的是回落 Space,onReady 给它摆)→ 留着原样还原,
  // 目标就位后由 settleAsyncStartupSpace 换过去。目标永远不来(插件已删 / 单品变体存着别家的 id)就一直这样用、照常存。
  if (provisional && owner === useSpaceStore.getState().activeSpaceId) return
  // ⚠️ 归档没真落盘(配额满 / 私密模式 —— saveNamedLayout 是吞掉异常的 void)就别再动布局键:
  // 那是这份布局**仅存的一份**,搬走或清掉即等于直接丢。读回来确认过再往下(Codex 评审抓的 Medium)。
  if (cur && !provisional && !loadNamedLayout(spaceLayoutName(fromId))) return
  const next = loadNamedLayout(spaceLayoutName(toId))
  if (next) saveLayout({ ...next, space: toId }) // 槽里的就是 toId 的:归属以槽名为准(老存档没记 / 记的是别人)
  else clearLayout()
}

/** 丢掉**全部** Space 的已存布局 + 本窗当前布局,下次进入各自按默认重建。布局规则换代时的一次性迁移用
 *  (2026-10-03 固定 View:此前的布局里固定项可能早被关掉 / 顶掉 / 拖走)。按前缀清而不是按已注册的 Space 清:
 *  插件 / 用户 Space 异步注册,启动这一刻还不在表里。桌面与单列两套存档一起清(同源可能两种壳都跑过)。 */
let layoutsResetThisBoot = false
/** 本次启动做过 resetSpaceLayouts():当前布局键是空的,onReady 摆出来的是回落 Space 的默认布局而不是「上次退出」那个
 *  Space 的现场 —— 异步就位的 Space 据此重建自己的默认布局,而不是把回落 Space 的内容认成自己的。 */
export const spaceLayoutsWereReset = (): boolean => layoutsResetThisBoot

export function resetSpaceLayouts(): void {
  layoutsResetThisBoot = true
  for (const name of Object.keys(listNamedLayouts())) if (name.startsWith('space:')) deleteNamedLayout(name)
  clearLayout()
  clearSingleColumnLayouts()
}

/** 「把这个 Space 固定到系统桌面」的宿主接缝(2026-08-20)。引擎不认识 Capacitor / 安卓,
 *  由 mobile 侧在启动时注册实现;没注册(桌面 / web)时 pinSpaceToHome 返回 false,调用方当无事发生。
 *  接缝形态与 setRibbonActions / setEngineI18n 同款:引擎只留一个口子,绝不 import feature。 */
let spacePin: ((id: string, name: string) => void) | null = null
export function setSpacePinHandler(fn: ((id: string, name: string) => void) | null): void { spacePin = fn }
/** 有宿主实现则请求固定(系统自己弹确认框),返回是否发出了请求。 */
export function pinSpaceToHome(id: string, name: string): boolean {
  if (!spacePin) return false
  spacePin(id, name)
  return true
}

export const registerSpace = (def: SpaceDefinition): void => useSpaceStore.getState().registerSpace(def)
export const unregisterSpace = (id: string): void => useSpaceStore.getState().unregisterSpace(id)
export const setActiveSpace = (id: string): void => useSpaceStore.getState().setActiveSpace(id)
