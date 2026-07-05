/**
 * Workspace store(≈ Obsidian workspace)。在已集成的 Dockview 之上建薄 API:
 * openView / getActiveLeaf / splitActive / toggleSidebar / saveLayout↔restore / 命名布局。
 * 单个 Dockview 实例托管三区:左侧栏 / 主区 / 右侧栏,由 panel.params.__loc 标记区分。
 * 视图「参数驱动可重建」:panel 存 {component:type, params} → 刷新/恢复时 Dockview 据此重建。
 */
import { create } from 'zustand'
import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import type { Leaf, ViewLocation } from './types'
import { getView } from './viewRegistry'
import { label } from './types'
import { locOf, type DropTarget } from './dropModel'
import { useNav } from './navStore'
import {
  LAYOUT_KEY, saveLayout, loadLayout, clearLayout, saveNamedLayout, loadNamedLayout, listNamedLayouts,
  type LayoutEnvelopeV4, type PersistedPanel,
} from './layoutPersist'

/** Dockview panel.params 里引擎私有字段(双下划线避免与视图 params 撞名)。 */
interface PanelMeta {
  __loc?: ViewLocation
  __type?: string
}

/** 恢复布局后也必须扫描现有 id；模块级 seq 会在重启后回零并撞上 chat#1。 */
export function nextPanelId(ids: Iterable<string>, type: string): string {
  const used = new Set(ids)
  let n = 1
  while (used.has(`${type}#${n}`)) n++
  return `${type}#${n}`
}

function nextId(api: DockviewApi, type: string): string {
  return nextPanelId(api.panels.map((p) => p.id), type)
}

/** 黄金分割默认:中间 0.618,两侧每侧 0.382/2 = 0.191(= 1 - 0.618 平分)。 */
const SIDE_FRACTION = 0.191

/** 侧栏开合补间动画期间,pinSides 跳过该侧 —— 让 tween 独占其宽度,免被钉宽 setSize 打断。 */
const sidebarAnimating: Record<'left' | 'right', boolean> = { left: false, right: false }

/** 某侧栏的黄金分割目标宽(与 pinSides 同样钳制)。 */
function sideTargetWidth(api: DockviewApi, loc: 'left' | 'right'): number {
  const min = loc === 'left' ? 220 : 240
  const max = loc === 'left' ? 280 : 300
  return Math.round(Math.min(max, Math.max(min, api.width * SIDE_FRACTION)))
}

type SizableGroup = { api: { setSize: (s: { width: number }) => void; width?: number; setConstraints?: (c: { minimumWidth?: number; maximumWidth?: number }) => void } }

/** 收起一侧期间临时锁住另一侧宽度(min=max=目标宽),让 close 释放的空白只被中间主区吸收。
 *  否则另一侧会瞬间吞掉空白「突然变宽」再被 pinSides 弹回 = 收栏闪屏。返回释放函数(沉降后调)。 */
function lockOtherSide(api: DockviewApi, side: 'left' | 'right'): () => void {
  const other = side === 'left' ? 'right' : 'left'
  const og = (panelsAt(api, other)[0] as { group?: SizableGroup } | undefined)?.group
  if (!og) return () => {}
  const w = sideTargetWidth(api, other)
  try { og.api.setConstraints?.({ minimumWidth: w, maximumWidth: w }) } catch { /* 跨版本兜底 */ }
  return () => { try { og.api.setConstraints?.({ minimumWidth: 0, maximumWidth: Number.MAX_SAFE_INTEGER }) } catch { /* ignore */ } }
}

/** rAF 把某组宽度从 from 平滑补间到 to(ease-out cubic),done 收尾。无 rAF(测试)时直接收尾。 */
function tweenGroupWidth(group: SizableGroup, from: number, to: number, done: () => void): void {
  if (typeof requestAnimationFrame !== 'function') { try { group.api.setSize({ width: to }) } catch { /* ignore */ } done(); return }
  const DURATION = 200
  const ease = (k: number): number => 1 - Math.pow(1 - k, 3)
  let startTs = 0
  const step = (ts: number): void => {
    if (!startTs) startTs = ts
    const k = Math.min(1, (ts - startTs) / DURATION)
    try { group.api.setSize({ width: Math.round(from + (to - from) * ease(k)) }) } catch { /* 跨版本兜底 */ }
    if (k < 1) requestAnimationFrame(step)
    else done()
  }
  requestAnimationFrame(step)
}

/** 把**两侧**侧栏组宽度都钉为 0.191×容器宽(黄金分割;中间自得 0.618)。
 *  必须两侧一起钉:只钉一侧时,另一侧 toggle 释放/重建会让这一侧吃掉空白而漂移(0.191→0.333)。
 *  Dockview split/setSize 异步竞争 → rAF + setTimeout 双重兜底,在布局沉降后再钉。
 *  正在补间动画的一侧跳过(sidebarAnimating),避免钉宽打断丝滑过渡。 */
function pinSides(api: DockviewApi): void {
  const apply = (): void => {
    const W = api.width
    if (!W) return
    for (const loc of ['left', 'right'] as const) {
      if (sidebarAnimating[loc]) continue
      try { panelsAt(api, loc)[0]?.group.api.setSize({ width: sideTargetWidth(api, loc) }) } catch { /* 跨版本兜底 */ }
    }
  }
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => f()
  raf(() => raf(apply))
  setTimeout(apply, 60) // Dockview 布局沉降后再钉一次(rAF 偶尔早于其内部 resize)
}

/** 读 panel 的视图类型:优先 params.__type(可靠),回退 Dockview 的 component(跨版本不保证暴露,
 *  曾因其 undefined 导致 toggle 暂存出空 type → 重开 addPanel('') 报错+白屏)。 */
function panelType(p: IDockviewPanel): string {
  const t = ((p.params ?? {}) as PanelMeta).__type
  return t || (p as { component?: string }).component || ''
}

/** 把一个 Dockview panel 包装为引擎 Leaf。 */
function makeLeaf(panel: IDockviewPanel): Leaf {
  const raw = (panel.params ?? {}) as Record<string, unknown>
  const { __loc, __type, ...userParams } = raw as PanelMeta & Record<string, unknown>
  void __type
  return {
    id: panel.id,
    type: panelType(panel),
    loc: __loc ?? 'main',
    params: userParams,
    setTitle: (t) => panel.api.setTitle(t),
    setParams: (p) => panel.api.updateParameters({ ...(panel.params ?? {}), ...p }),
    close: () => panel.api.close(),
  }
}

function panelsAt(api: DockviewApi, loc: ViewLocation): IDockviewPanel[] {
  return api.panels.filter((p) => ((p.params ?? {}) as PanelMeta).__loc === loc)
}

/** 主区「当前显示」的 panel:全局 activePanel 若在主区用它;否则(焦点在侧栏,最常见于点侧栏列表项)
 *  取主区组内的 activePanel。就地导航/前进后退都以它为作用对象。 */
export function activeMainPanel(api: DockviewApi): IDockviewPanel | null {
  const mains = panelsAt(api, 'main')
  const global = api.activePanel
  if (global && mains.some((p) => p.id === global.id)) return global
  return mains.find((p) => (p as { group?: { activePanel?: { id?: string } } }).group?.activePanel?.id === p.id) ?? mains[0] ?? null
}

/** 给某 location 计算新 panel 的放置位置。 */
function positionFor(api: DockviewApi, loc: ViewLocation): Record<string, unknown> | undefined {
  const sameLoc = panelsAt(api, loc)
  if (sameLoc.length) return { referencePanel: sameLoc[0].id, direction: 'within' }
  if (loc === 'main') return undefined // 首个主区 panel
  const main = panelsAt(api, 'main')[0] ?? api.panels[0]
  if (main) return { referencePanel: main.id, direction: loc === 'left' ? 'left' : 'right' }
  return undefined
}

type Stashed = PersistedPanel

function envelope(api: DockviewApi, state: Pick<WorkspaceState, 'leftVisible' | 'rightVisible' | 'stash'>): LayoutEnvelopeV4 {
  return {
    version: 4,
    dockview: api.toJSON(),
    sidebars: {
      // 真实 panel 是唯一真源；状态事件可能落后于 Dockview 的异步布局沉降。
      left: { visible: panelsAt(api, 'left').length > 0, stash: state.stash.left },
      right: { visible: panelsAt(api, 'right').length > 0, stash: state.stash.right },
    },
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleWorkspaceSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    useWorkspace.getState().saveCurrent()
  }, 100)
}

/** 主区 leaf 的轻量快照,供顶栏内嵌标签条渲染(Obsidian 式单行标签)。 */
export interface MainTab {
  id: string
  type: string
  title: string
  active: boolean
  closable: boolean
  sessionId?: string
  followActive: boolean
}

/** 侧栏视图的轻量快照,供顶栏两侧的视图图标渲染。收起态也列(从 stash),点击可重开。 */
export interface SideTab {
  type: string
  title: string
  active: boolean
  closable: boolean
}

interface WorkspaceState {
  api: DockviewApi | null
  /** 最近聚焦的 Chat leaf；点击右栏 tab 时仍保持其上下文。 */
  focusedChatLeafId: string | null
  /** 主区打开的 leaf(顶栏标签条用);随布局/激活变化刷新。 */
  mainTabs: MainTab[]
  /** 左右侧栏的视图图标(顶栏两侧用);收起态从 stash 取。 */
  leftTabs: SideTab[]
  rightTabs: SideTab[]
  /** Chat DOM 只登记在 workspace 引擎，不进入业务 app state。 */
  chatSurfaces: Record<string, HTMLDivElement>
  leftVisible: boolean
  rightVisible: boolean
  /** 收起侧栏时暂存其内容,展开时还原。 */
  stash: Record<'left' | 'right', Stashed[]>
  sidebarDefaults: Record<'left' | 'right', Stashed[]>
  /** 默认布局构建器(WorkspaceHost 从 buildDefault prop 注入,供 resetLayout 复用)。 */
  defaultBuilder: (() => void) | null
  setApi(api: DockviewApi | null): void
  setDefaultBuilder(fn: () => void): void
  setSidebarDefaults(defaults: Record<'left' | 'right', Stashed[]>): void
  initializeSidebar(side: 'left' | 'right', visible: boolean): void
  setFocusedLeaf(panel: IDockviewPanel | null | undefined): void
  registerChatSurface(leafId: string, el: HTMLDivElement | null): void
  syncPanelState(): void
  /** 重算主区标签条 + 两侧侧栏图标(布局/激活变化时调)。 */
  refreshTabs(): void
  /** 顶栏标签点击 → 激活该 leaf。 */
  activateLeaf(id: string): void
  /** 顶栏标签关闭。 */
  closeLeaf(id: string): void
  /** 受控拖放落子:把 panelId 视图按 computeDropTarget 的结果并入/分屏到目标组,并继承目标面板身份(__loc)。 */
  dropView(panelId: string, target: DropTarget): void
  /** 顶栏侧栏图标点击 → 展开该侧(若收起)并显示该视图。 */
  showSideView(side: 'left' | 'right', type: string): void
  /** 关闭某侧的某视图(右键菜单)。 */
  closeSideView(side: 'left' | 'right', type: string): void
  /** 恢复默认布局:清空 → 重建默认(黄金分割 中 0.618 / 两侧各 0.191)→ 清持久化。 */
  resetLayout(): void
  /** 开/聚焦一个视图。singleton 已存在则聚焦;主区默认**就地替换**当前活动 leaf(浏览器/Obsidian 式,
   *  opts.newTab 显式新建);侧栏同侧同类型复用。返回 leaf。 */
  openView(type: string, params?: Record<string, unknown>, loc?: ViewLocation, opts?: { newTab?: boolean }): Leaf | null
  /** 就地把某 leaf 切换为另一视图类型(同 tab 内导航的原语)。旧视图参数全清,不残留。 */
  navigateLeaf(leafId: string, type: string, params?: Record<string, unknown>): Leaf | null
  getActiveLeaf(): Leaf | null
  /** 把当前活动视图分屏到一侧(同 type+params 复制一份)。 */
  splitActive(direction: 'right' | 'down', paramsOverride?: Record<string, unknown>): Leaf | null
  toggleSidebar(side: 'left' | 'right'): void
  saveCurrent(): void
  saveNamed(name: string): void
  /** 应用命名布局。成功 true;缺失/损坏返回 false(调用方可回退 resetLayout)。 */
  applyNamed(name: string): boolean
  namedLayouts(): string[]
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  api: null,
  focusedChatLeafId: null,
  mainTabs: [],
  leftTabs: [],
  rightTabs: [],
  chatSurfaces: {},
  leftVisible: true,
  rightVisible: true,
  stash: { left: [], right: [] },
  sidebarDefaults: { left: [], right: [] },
  defaultBuilder: null,

  setApi: (api) => set({ api }),
  setDefaultBuilder: (fn) => set({ defaultBuilder: fn }),
  setSidebarDefaults: (defaults) => set({ sidebarDefaults: defaults }),
  initializeSidebar: (side, visible) => set((s) => ({
    [side === 'left' ? 'leftVisible' : 'rightVisible']: visible,
    stash: visible ? s.stash : { ...s.stash, [side]: s.sidebarDefaults[side] },
  } as Partial<WorkspaceState>)),
  setFocusedLeaf: (panel) => {
    if (panel && panelType(panel) === 'chat') set({ focusedChatLeafId: panel.id })
  },
  registerChatSurface: (leafId, el) => set((s) => {
    const next = { ...s.chatSurfaces }
    if (el) next[leafId] = el
    else delete next[leafId]
    return { chatSurfaces: next }
  }),
  syncPanelState: () => {
    const api = get().api
    if (!api) return
    const leftVisible = panelsAt(api, 'left').length > 0
    const rightVisible = panelsAt(api, 'right').length > 0
    if (leftVisible !== get().leftVisible || rightVisible !== get().rightVisible) set({ leftVisible, rightVisible })
  },

  refreshTabs: () => {
    const api = get().api
    if (!api) { if (get().mainTabs.length) set({ mainTabs: [] }); return }
    const activeId = api.activePanel?.id
    const tabs: MainTab[] = panelsAt(api, 'main').map((p) => {
      const type = panelType(p)
      const params = (p.params ?? {}) as Record<string, unknown>
      const def = getView(type)
      return {
        id: p.id,
        type,
        title: p.title || (def ? label(def.displayName) : type),
        active: p.id === activeId,
        closable: def?.closable !== false,
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        followActive: params.followActive !== false,
      }
    })
    const prev = get().mainTabs
    const same = prev.length === tabs.length && prev.every((t, i) =>
      t.id === tabs[i].id && t.active === tabs[i].active && t.title === tabs[i].title)
    if (!same) set({ mainTabs: tabs })

    // 两侧侧栏图标:可见时从 live panel(active=组内当前显示),收起时从 stash(无 active)。
    const sideTabsFor = (side: 'left' | 'right'): SideTab[] => {
      const visible = side === 'left' ? get().leftVisible : get().rightVisible
      const mk = (type: string, active: boolean): SideTab => {
        const def = getView(type)
        return { type, title: def ? label(def.displayName) : type, active, closable: def?.closable !== false }
      }
      if (visible) {
        return panelsAt(api, side).map((p) => {
          const grp = (p as { group?: { activePanel?: { id?: string } } }).group
          return mk(panelType(p), grp?.activePanel?.id === p.id)
        })
      }
      const stashed = get().stash[side].length ? get().stash[side] : get().sidebarDefaults[side]
      return stashed.map((v) => mk(v.type, false))
    }
    const sideEq = (a: SideTab[], b: SideTab[]): boolean =>
      a.length === b.length && a.every((t, i) => t.type === b[i].type && t.active === b[i].active)
    const left = sideTabsFor('left')
    const right = sideTabsFor('right')
    if (!sideEq(get().leftTabs, left)) set({ leftTabs: left })
    if (!sideEq(get().rightTabs, right)) set({ rightTabs: right })
  },
  activateLeaf: (id) => {
    get().api?.getPanel(id)?.api.setActive()
    get().refreshTabs()
  },
  closeLeaf: (id) => {
    const api = get().api
    const panel = api?.getPanel(id)
    if (!api || !panel) return
    if (panelType(panel) === 'home') return // home 是主区空态占位,不可关(无 close 入口,防御性)
    const loc = ((panel.params ?? {}) as PanelMeta).__loc ?? 'main'
    // 主区关掉「最后一个」view → 就地把它变成 home 空态占位(Forsion 品牌图 + 新建),而非
    // close→addPanel。后者会销毁主区组,让侧栏瞬间回流吞掉主区宽再弹回 = 侧栏「被关」+卡顿(本次修复的 bug)。
    // navigateLeaf 复用同一 panel/组,只换 __type → 零组结构变化,侧栏纹丝不动。
    // 分屏 / 多 tab(主区还有别的 panel)走默认 close:Dockview 自动移除空组 = 关掉那个分屏 panel。
    if (loc === 'main' && panelsAt(api, 'main').length <= 1) {
      useNav.getState().drop(id)      // 旧 tab 导航史销毁(panel 复用,仅清栈)
      get().navigateLeaf(id, 'home')  // 内部已 refreshTabs
      return
    }
    // 侧栏关空 → 补「空侧栏」占位(保住 group 作拖放靶;toggleSidebar 折叠不走 closeLeaf,不受影响)。
    const wasLastSide = (loc === 'left' || loc === 'right')
      && panelType(panel) !== 'sidebar-empty' && panelsAt(api, loc).length <= 1
    // 先关再填:占位可能与被关视图同 type,open-first 会复用到正被关的那个。
    panel.api.close()
    if (wasLastSide) get().openView('sidebar-empty', {}, loc)
    useNav.getState().drop(id) // 该 tab 的导航历史随之销毁
    get().refreshTabs()
  },
  dropView: (panelId, target) => {
    const api = get().api
    const panel = api?.getPanel(panelId)
    if (!api || !panel) return
    const loc = locOf(target.group) // 目标面板身份 → 落子后视图继承(侧栏=图标 / 主区=tab+标题)
    // 拖动前各侧计数:占位进退判定不能依赖 visible 标志(moveTo 触发的 syncPanelState 可能已翻转它)。
    const sideBefore = { left: panelsAt(api, 'left').length, right: panelsAt(api, 'right').length }
    try {
      if (target.mode === 'tab') panel.api.moveTo({ group: target.group, position: 'center', index: target.index })
      else panel.api.moveTo({ group: target.group, position: target.dir }) // 方向 = 面板内分屏并新建组
    } catch { return }
    panel.api.updateParameters({ ...(panel.params ?? {}), __loc: loc })
    // 把最后一个主区 view 拖去侧栏 → 主区空:补 home 空态占位(与关掉最后一个 tab 同观感,不留空白)。
    if (panelsAt(api, 'main').length === 0) get().openView('home', {}, 'main')
    // 侧栏占位进退:某侧被拖空 → 补占位(保住 drop 靶);拖入真实 tab 的一侧若有占位 → 占位退位。
    for (const side of ['left', 'right'] as const) {
      const now = panelsAt(api, side)
      if (sideBefore[side] > 0 && now.length === 0) get().openView('sidebar-empty', {}, side)
      else if (now.length > 1) now.filter((p) => panelType(p) === 'sidebar-empty').forEach((p) => p.api.close())
    }
    pinSides(api) // 侧栏可能变动 → 重钉黄金分割宽
    get().refreshTabs()
    scheduleWorkspaceSave()
  },
  showSideView: (side, type) => {
    const api = get().api
    if (!api) return
    const visible = side === 'left' ? get().leftVisible : get().rightVisible
    // 已显示该视图时再点 = 收起该侧(开合切换);否则展开(若收起)并激活该视图。
    if (visible) {
      const cur = panelsAt(api, side).find((p) => {
        const grp = (p as { group?: { activePanel?: { id?: string } } }).group
        return grp?.activePanel?.id === p.id
      })
      if (cur && panelType(cur) === type) { get().toggleSidebar(side); get().refreshTabs(); return }
    } else {
      get().toggleSidebar(side) // 展开 → openView 同步还原 stash
    }
    panelsAt(get().api!, side).find((p) => panelType(p) === type)?.api.setActive()
    get().refreshTabs()
  },
  closeSideView: (side, type) => {
    const api = get().api
    if (!api) return
    panelsAt(api, side).find((p) => panelType(p) === type)?.api.close()
    get().refreshTabs()
  },

  resetLayout() {
    const api = get().api
    if (!api) return
    try { api.clear() } catch { /* ignore */ }
    clearLayout()
    useNav.getState().reset() // 布局重建,旧 leaf id 全失效
    set({ stash: { left: [], right: [] }, leftVisible: true, rightVisible: true, focusedChatLeafId: null })
    get().defaultBuilder?.() // 重建默认;openView 的 firstOfSide → sizeSide 按黄金分割钉宽
    scheduleWorkspaceSave()
  },

  openView(type, params = {}, loc = 'main', opts) {
    const api = get().api
    if (!api) return null
    const def = getView(type)
    if (def?.singleton) {
      const reuseKey = params.reuseKey
      const existing = api.panels.find((p) => {
        if (panelType(p) !== type) return false
        if (reuseKey === undefined) return true
        const panelParams = (p.params ?? {}) as Record<string, unknown>
        return panelParams.reuseKey === reuseKey
          || (reuseKey === 'primary' && panelParams.reuseKey === undefined && panelParams.followActive !== false)
      })
      if (existing) {
        if (reuseKey === 'primary') existing.api.updateParameters({ ...(existing.params ?? {}), ...params })
        existing.api.setActive()
        return makeLeaf(existing)
      }
    }
    if (loc === 'main' && !opts?.newTab) {
      // 主区默认「就地导航」:替换当前活动主 leaf(浏览器/Obsidian 式;singleton 已在上方被捕获激活)。
      // ＋按钮/兜底填充等显式 newTab;主区为空(Space build 期)时自然落到下方新建。
      const cur = activeMainPanel(api)
      if (cur) return get().navigateLeaf(cur.id, type, params)
    }
    if (loc !== 'main') {
      // 侧栏同侧同类型复用(非 singleton 也复用):侧栏 tab 按类型唯一,如左右各一个「工作区」视图。
      const existingSide = panelsAt(api, loc).find((p) => panelType(p) === type)
      if (existingSide) {
        existingSide.api.setActive()
        return makeLeaf(existingSide)
      }
    }
    const id = def?.singleton ? type : nextId(api, type)
    const title = def ? label(def.displayName) : type
    const firstOfSide = loc !== 'main' && panelsAt(api, loc).length === 0
    const panel = api.addPanel({
      id,
      // 主区 panel 一律挂 __frame 宿主(就地切视图靠 updateParameters 换 __type);侧栏保持 per-type 组件。
      component: loc === 'main' ? '__frame' : type,
      title,
      params: { ...params, __loc: loc, __type: type },
      position: positionFor(api, loc) as never,
    })
    // 侧栏首个 panel 创建了新组 → Dockview 默认 ~50/50 太宽,按黄金分割钉两侧 0.191×容器宽。
    if (firstOfSide) pinSides(api)
    if (loc === 'left') set({ leftVisible: true })
    if (loc === 'right') set({ rightVisible: true })
    if (type === 'chat') set({ focusedChatLeafId: panel.id })
    scheduleWorkspaceSave()
    return makeLeaf(panel)
  },

  navigateLeaf(leafId, type, params = {}) {
    const api = get().api
    const panel = api?.getPanel(leafId)
    const def = getView(type)
    if (!api || !panel || !def) return null
    const old = (panel.params ?? {}) as PanelMeta & Record<string, unknown>
    const sameType = panelType(panel) === type
    // dockview updateParameters 是 merge 语义,但值为 undefined 的键会被显式删除(dockviewPanel.update)
    // → 旧视图参数全部映射为 undefined,防 followActive/reuseKey 之类残留污染新视图。
    const cleared: Record<string, unknown> = {}
    for (const k of Object.keys(old)) cleared[k] = undefined
    panel.api.updateParameters({ ...cleared, ...params, __loc: old.__loc ?? 'main', __type: type })
    panel.api.setTitle(label(def.displayName))
    panel.api.setActive()
    // 就地切换不触发 onDidActivePanelChange(panel 未变)→ 自补簿记。
    if (type === 'chat') set({ focusedChatLeafId: panel.id })
    else if (!sameType && get().focusedChatLeafId === panel.id) {
      // 本 leaf 从 chat 切走 → 焦点会话 leaf 移交给其他 chat panel(无则清空,右栏目录等显示空态)。
      const otherChat = panelsAt(api, 'main').find((p) => p.id !== panel.id && panelType(p) === 'chat')
      set({ focusedChatLeafId: otherChat?.id ?? null })
    }
    get().refreshTabs()
    scheduleWorkspaceSave()
    return makeLeaf(panel)
  },

  getActiveLeaf() {
    const api = get().api
    const active = api?.activePanel
    return active ? makeLeaf(active) : null
  },

  splitActive(direction, paramsOverride) {
    const api = get().api
    const active = api?.activePanel
    if (!api || !active) return null
    const type = panelType(active)
    const { __loc, __type, ...userParams } = (active.params ?? {}) as PanelMeta & Record<string, unknown>
    void __type
    // 侧栏严禁左右分屏(与拖拽路径 dropModel.splitDirection 同一铁律):焦点在侧栏时向右分一律折叠成向下。
    const inSidebar = __loc === 'left' || __loc === 'right'
    const panel = api.addPanel({
      id: nextId(api, type),
      component: inSidebar ? type : '__frame', // 主区分屏 panel 同样挂 frame 宿主(支持就地切视图)
      title: active.title ?? type,
      params: { ...userParams, ...paramsOverride, __loc: __loc ?? 'main', __type: type },
      position: { referencePanel: active.id, direction: direction === 'right' && !inSidebar ? 'right' : 'below' } as never,
    })
    if (type === 'chat') set({ focusedChatLeafId: panel.id })
    scheduleWorkspaceSave()
    return makeLeaf(panel)
  },

  toggleSidebar(side) {
    const api = get().api
    if (!api) return
    const visKey = side === 'left' ? 'leftVisible' : 'rightVisible'
    const panels = panelsAt(api, side)
    const visible = panels.length > 0
    if (visible) {
      // 收起:暂存内容,先把该侧宽度补间到 0(丝滑),动画结束再移除 panel。占位不入 stash
      // (空 stash 展开时回落 sidebarDefaults —— 折叠空侧栏再展开会复活默认视图,有意为之)。
      const stashed: Stashed[] = panels.filter((p) => panelType(p) !== 'sidebar-empty').map((p) => {
        const { __loc, __type, ...userParams } = (p.params ?? {}) as PanelMeta & Record<string, unknown>
        void __loc
        void __type
        return { type: panelType(p), params: userParams }
      })
      set((s) => ({ stash: { ...s.stash, [side]: stashed }, [visKey]: false } as Partial<WorkspaceState>))
      const group = (panels[0] as { group?: SizableGroup }).group
      if (group) {
        sidebarAnimating[side] = true
        try { group.api.setConstraints?.({ minimumWidth: 0 }) } catch { /* ignore */ } // 放开最小宽,补间能到 0
        const from = group.api.width ?? sideTargetWidth(api, side)
        tweenGroupWidth(group, from, 0, () => {
          sidebarAnimating[side] = false
          const release = lockOtherSide(api, side) // 锁住另一侧,close 释放的空白只给主区,防「突然变宽再弹回」
          panels.forEach((p) => p.api.close())
          pinSides(api) // 收起后另一侧会吃掉空白漂移 → 重新钉回 0.191
          setTimeout(release, 180) // 布局沉降后释放,恢复可手动拖宽
          scheduleWorkspaceSave()
        })
      } else {
        const release = lockOtherSide(api, side)
        panels.forEach((p) => p.api.close())
        pinSides(api)
        setTimeout(release, 180)
        scheduleWorkspaceSave()
      }
    } else {
      // 展开:还原暂存内容(pinSides 跳过本侧),把该侧宽度从 ~0 补间到黄金分割目标宽。
      // stash 与 defaults 都为空(如无该侧默认的自定义 Space)→ 开占位:否则不建任何 panel,
      // syncPanelState 又按「无 panel」把 visible 复位,toggle 变成永远空转的死键。
      const restored = get().stash[side].length ? get().stash[side] : get().sidebarDefaults[side]
      const stashed: Stashed[] = restored.length ? restored : [{ type: 'sidebar-empty', params: {} }]
      set({ [visKey]: true } as Partial<WorkspaceState>)
      sidebarAnimating[side] = true
      stashed.forEach((v) => get().openView(v.type, v.params, side))
      const group = (panelsAt(api, side)[0] as { group?: SizableGroup } | undefined)?.group
      if (group) {
        try { group.api.setSize({ width: 1 }) } catch { /* ignore */ } // 起点贴 0,免首帧闪到默认宽
        tweenGroupWidth(group, 1, sideTargetWidth(api, side), () => {
          sidebarAnimating[side] = false
          pinSides(api)
          scheduleWorkspaceSave()
        })
      } else {
        sidebarAnimating[side] = false
        pinSides(api)
        scheduleWorkspaceSave()
      }
    }
  },

  saveCurrent() {
    const api = get().api
    if (api) saveLayout(envelope(api, get()))
  },

  saveNamed(name) {
    const api = get().api
    if (api) saveNamedLayout(name, envelope(api, get()))
  },

  applyNamed(name) {
    const api = get().api
    const blob = loadNamedLayout(name)
    if (!api || !blob) return false
    try {
      migrateLayoutBlob(blob)
      api.fromJSON(blob.dockview as never)
      useNav.getState().reset() // 布局整体更换,旧 leaf id 全失效
      set({
        leftVisible: blob.sidebars.left.visible,
        rightVisible: blob.sidebars.right.visible,
        stash: { left: blob.sidebars.left.stash, right: blob.sidebars.right.stash },
      })
      pinSides(api)
      return true
    } catch {
      return false // 损坏布局:调用方回退 resetLayout
    }
  },

  namedLayouts: () => Object.keys(listNamedLayouts()),
}))

/** 启动时尝试恢复上次布局(给 WorkspaceHost.onReady 用)。成功返回 true。 */
/** 布局引用的所有视图当前是否都已注册。Tangu Web 无 window.amadeus → amadeus-* 未注册;
 *  若旧布局引用了它们,dockview.fromJSON 会异步挂载未知组件、在其 effect 里 deref undefined 崩溃
 *  (越过下面的 try/catch)。故先校验:有未注册视图即丢弃整份布局 → 回退默认布局。 */
function layoutViewsAllRegistered(dockview: unknown): boolean {
  const panels = (dockview as { panels?: Record<string, { params?: { __type?: string } }> } | null)?.panels
  if (!panels) return true
  for (const p of Object.values(panels)) {
    const t = p?.params?.__type
    if (t && !getView(t)) return false
  }
  return true
}

/** 退役视图 → 统一视图(2026-07-03):会话列表/工作区文件/笔记库 并入 'workspace',
 *  目录/Amadeus 大纲 并入 'outline'。迁移后旧注册删除,launcher/palette 不再出现旧名。 */
const RETIRED_VIEW_MAP: Record<string, string> = {
  sessions: 'workspace',
  files: 'workspace',
  'amadeus-pages': 'workspace',
  toc: 'outline',
  'amadeus-outline': 'outline',
}

/** 历史布局就地迁移(幂等,载入时跑):①退役视图改名(dockview panels + 侧栏 stash;同侧重复由
 *  openView 的「同侧同类型复用」自然合并);②主区 panel 组件统一为 '__frame' 宿主(params.__type
 *  早已持久化,v3→v4 迁移即为此铺垫)。新代码保存的布局天然已是终态。 */
export function migrateLayoutBlob(layout: Pick<LayoutEnvelopeV4, 'dockview' | 'sidebars'>): void {
  const panels = (layout.dockview as { panels?: Record<string, { contentComponent?: string; params?: { __loc?: string; __type?: string } }> } | null)?.panels
  if (panels) {
    for (const p of Object.values(panels)) {
      if (!p || typeof p !== 'object') continue
      const params = p.params ?? {}
      const next = params.__type && RETIRED_VIEW_MAP[params.__type]
      if (next) {
        params.__type = next
        p.contentComponent = next
      }
      if ((params.__loc ?? 'main') === 'main') p.contentComponent = '__frame'
    }
  }
  for (const side of ['left', 'right'] as const) {
    const sb = layout.sidebars?.[side]
    if (!sb) continue
    sb.stash = sb.stash.map((v) => (RETIRED_VIEW_MAP[v.type] ? { ...v, type: RETIRED_VIEW_MAP[v.type] } : v))
  }
}

export function tryRestoreLayout(api: DockviewApi): boolean {
  const layout = loadLayout()
  if (!layout) return false
  migrateLayoutBlob(layout) // 必须先迁移再校验:退役视图(sessions 等)已无注册,迁移前校验会误丢整份布局
  if (!layoutViewsAllRegistered(layout.dockview)) return false
  const known = (v: PersistedPanel): boolean => !!getView(v.type) // 收起态 stash 也剔除未注册视图,防展开时重开死视图
  try {
    api.fromJSON(layout.dockview as never)
    useWorkspace.setState({
      leftVisible: layout.sidebars.left.visible,
      rightVisible: layout.sidebars.right.visible,
      stash: { left: layout.sidebars.left.stash.filter(known), right: layout.sidebars.right.stash.filter(known) },
    })
    const focused = api.activePanel && panelType(api.activePanel) === 'chat'
      ? api.activePanel
      : api.panels.find((p) => panelType(p) === 'chat')
    useWorkspace.getState().setFocusedLeaf(focused)
    pinSides(api)
    return api.panels.length > 0
  } catch {
    return false
  }
}

export { LAYOUT_KEY }
