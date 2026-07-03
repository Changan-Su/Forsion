/** 主区导航历史(per-tab,浏览器式前进/后退)。**每个主区 leaf 一份独立栈** —— 前进/后退只影响
 *  当前活动 tab 的视图,不影响别的 tab。与具体 view 无关:各 feature(对话会话 / Amadeus 笔记 /
 *  特殊视图)在其「页面」到达时调 recordNav(leafId, …);restore 闭包负责把**该 leaf**复原到该页
 *  (必要时先 navigateLeaf 切回视图类型)。箭头由引擎在主区标签栏左上角常驻渲染(WorkspaceHost)。 */
import { create } from 'zustand'

export interface NavEntry {
  /** 去重键(同一页面不重复记),如 `chat:<id>` / `amadeus:<path>` / `special:<kind>`。 */
  key: string
  /** 前进/后退到此项时执行(可异步:如 loadPage);须作用于所属 leaf 自身。 */
  restore: () => unknown
}

interface LeafStack { entries: NavEntry[]; idx: number }

interface NavState {
  /** leafId → 该 tab 的历史栈。leaf 关闭/布局重建时清理。 */
  stacks: Record<string, LeafStack>
  record(leafId: string, entry: NavEntry): void
  back(leafId: string): void
  forward(leafId: string): void
  /** leaf 关闭 → 删其栈。 */
  drop(leafId: string): void
  /** 布局整体更换(Space 切换/resetLayout/applyNamed)→ 全清(旧 leaf id 均已失效)。 */
  reset(): void
}

let navigating = false // back/forward 期间置真 → restore 引发的页面变化不被重新记录

function go(get: () => NavState, set: (p: Partial<NavState>) => void, leafId: string, j: number): void {
  const st = get().stacks[leafId]
  if (!st || j === st.idx || j < 0 || j >= st.entries.length) return
  set({ stacks: { ...get().stacks, [leafId]: { ...st, idx: j } } })
  navigating = true
  Promise.resolve(st.entries[j].restore()).finally(() => { navigating = false })
}

export const useNav = create<NavState>((set, get) => ({
  stacks: {},
  record(leafId, entry) {
    if (navigating || !leafId) return
    const st = get().stacks[leafId] ?? { entries: [], idx: -1 }
    if (st.entries[st.idx]?.key === entry.key) return // 同页去重
    const entries = [...st.entries.slice(0, st.idx + 1), entry].slice(-100) // 截断 forward + 压入 + 封顶 100
    set({ stacks: { ...get().stacks, [leafId]: { entries, idx: entries.length - 1 } } })
  },
  back(leafId) { go(get, set, leafId, (get().stacks[leafId]?.idx ?? 0) - 1) },
  forward(leafId) { go(get, set, leafId, (get().stacks[leafId]?.idx ?? -1) + 1) },
  drop(leafId) {
    if (!(leafId in get().stacks)) return
    const stacks = { ...get().stacks }
    delete stacks[leafId]
    set({ stacks })
  },
  reset() { set({ stacks: {} }) },
}))

/** feature 在其页面「到达」某 leaf 时调用。leafId 为空(如焦点尚未落到目标 leaf)则跳过。 */
export const recordNav = (leafId: string | null | undefined, key: string, restore: () => unknown): void => {
  if (leafId) useNav.getState().record(leafId, { key, restore })
}
