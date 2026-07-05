/**
 * 移动端 workspace store：桌面 engine/workspaceStore.ts(Dockview 驱动)的**单列替身**。
 * vite resolveId 插件把 desktop 的 `engine/workspaceStore` 解析到本文件 → 复用的 views / spaceRegistry
 * 拿到的 `useWorkspace` 就是这个单列实现,desktop 源零改。
 *
 * 模型:三桶 leaf(main / left / right) + 各自 activeId;主区一次显示一个 active leaf(全屏),
 * 左右侧栏 = 侧滑抽屉(visible 控制)。`navigateLeaf` = 原地换视图(一屏换一屏),`splitActive` = 开新主 leaf。
 * 只实现被 views / spaceRegistry / bootstrapEngine / spaces.build 真正消费的方法;桌面独有的
 * 布局序列化 / 命名布局 / Dockview api 在移动端退化为 no-op / 空(见各方法注释)。
 */
import { create } from 'zustand'
import type { Leaf, ViewLocation } from '@/engine/types'
import { label } from '@/engine/types'
import { getView } from '@/engine/viewRegistry'
import type { PersistedPanel } from '@/engine/layoutPersist'

/** 主区 leaf 快照(供顶栏/读者)。字段与桌面同名以兼容读者。 */
export interface MainTab { id: string; type: string; title: string; active: boolean; closable: boolean; sessionId?: string; followActive: boolean }
/** 侧栏视图快照。 */
export interface SideTab { type: string; title: string; active: boolean; closable: boolean }

interface LeafRec { id: string; type: string; loc: ViewLocation; params: Record<string, unknown>; title: string }

function bucketOf(loc: ViewLocation): 'mainLeaves' | 'leftLeaves' | 'rightLeaves' {
  return loc === 'left' ? 'leftLeaves' : loc === 'right' ? 'rightLeaves' : 'mainLeaves'
}
function activeKeyOf(loc: ViewLocation): 'activeMainId' | 'leftActiveId' | 'rightActiveId' {
  return loc === 'left' ? 'leftActiveId' : loc === 'right' ? 'rightActiveId' : 'activeMainId'
}

function makeId(type: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  let n = 1
  while (used.has(`${type}#${n}`)) n++
  return `${type}#${n}`
}

/** scheduleWorkspaceSave:移动端 v1 不持久化布局(启动/切 Space 由 build() 重建)。保留导出以满足 barrel。 */
export function scheduleWorkspaceSave(): void { /* v1 no-op */ }

/** activeMainPanel:桌面签名 (DockviewApi)=>panel;移动端 api 恒 null,bootstrapEngine 的 navGo 以
 *  `api ?` 守卫故从不真正调用。保留导出以满足 barrel / bootstrapEngine 的 import。 */
export function activeMainPanel(): null { return null }

interface WS {
  api: null
  mainLeaves: LeafRec[]
  leftLeaves: LeafRec[]
  rightLeaves: LeafRec[]
  activeMainId: string | null
  leftActiveId: string | null
  rightActiveId: string | null
  leftVisible: boolean
  rightVisible: boolean
  focusedChatLeafId: string | null
  chatSurfaces: Record<string, HTMLDivElement>
  sidebarDefaults: Record<'left' | 'right', PersistedPanel[]>
  mainTabs: MainTab[]
  leftTabs: SideTab[]
  rightTabs: SideTab[]
  defaultBuilder: (() => void) | null

  setApi(api: unknown): void
  setDefaultBuilder(fn: () => void): void
  setSidebarDefaults(d: Record<'left' | 'right', PersistedPanel[]>): void
  initializeSidebar(side: 'left' | 'right', visible: boolean): void
  registerChatSurface(id: string, el: HTMLDivElement | null): void
  syncPanelState(): void
  refreshTabs(): void
  openView(type: string, params?: Record<string, unknown>, loc?: ViewLocation, opts?: { newTab?: boolean }): Leaf | null
  navigateLeaf(leafId: string, type: string, params?: Record<string, unknown>): Leaf | null
  getActiveLeaf(): Leaf | null
  getActiveSideLeaf(side: 'left' | 'right'): Leaf | null
  leafById(id: string): Leaf | null
  splitActive(direction: 'right' | 'down', paramsOverride?: Record<string, unknown>): Leaf | null
  toggleSidebar(side: 'left' | 'right'): void
  showSideView(side: 'left' | 'right', type: string): void
  activateLeaf(id: string): void
  closeLeaf(id: string): void
  resetLayout(): void
  saveCurrent(): void
  saveNamed(name: string): void
  applyNamed(name: string): boolean
  namedLayouts(): string[]
}

export const useWorkspace = create<WS>((set, get) => {
  const allRecs = (): LeafRec[] => [...get().mainLeaves, ...get().leftLeaves, ...get().rightLeaves]
  const find = (id: string): LeafRec | undefined => allRecs().find((r) => r.id === id)

  const leaf = (rec: LeafRec): Leaf => ({
    id: rec.id,
    type: rec.type,
    loc: rec.loc,
    get params() { return find(rec.id)?.params ?? rec.params },
    // 幂等:标题/参数未变不 set()——桌面版 panel.api.setTitle 天生幂等,移动版若无条件 set 会让
    // 订阅方重渲染→视图再调 setTitle→无限循环(React #185)。
    setTitle: (t: string) => {
      const cur = find(rec.id)
      if (!cur || cur.title === t) return
      set((s) => ({ [bucketOf(rec.loc)]: s[bucketOf(rec.loc)].map((r) => r.id === rec.id ? { ...r, title: t } : r) } as Partial<WS>))
    },
    setParams: (p: Record<string, unknown>) => {
      const cur = find(rec.id)
      if (!cur) return
      const merged = { ...cur.params, ...p }
      const keys = new Set([...Object.keys(cur.params), ...Object.keys(merged)])
      let changed = false
      for (const k of keys) if (cur.params[k] !== merged[k]) { changed = true; break }
      if (!changed) return
      set((s) => ({ [bucketOf(rec.loc)]: s[bucketOf(rec.loc)].map((r) => r.id === rec.id ? { ...r, params: merged } : r) } as Partial<WS>))
      get().refreshTabs()
    },
    close: () => get().closeLeaf(rec.id),
  })

  /** 把某 loc 桶里某 id 设为该桶 active(主区=切主屏;侧栏=切抽屉当前视图)。 */
  const setActive = (loc: ViewLocation, id: string): void => {
    set({ [activeKeyOf(loc)]: id } as Partial<WS>)
    if (loc === 'main') {
      const rec = find(id)
      if (rec?.type === 'chat') set({ focusedChatLeafId: id })
    }
  }

  return {
    api: null,
    mainLeaves: [],
    leftLeaves: [],
    rightLeaves: [],
    activeMainId: null,
    leftActiveId: null,
    rightActiveId: null,
    leftVisible: false,
    rightVisible: false,
    focusedChatLeafId: null,
    chatSurfaces: {},
    sidebarDefaults: { left: [], right: [] },
    mainTabs: [],
    leftTabs: [],
    rightTabs: [],
    defaultBuilder: null,

    setApi: () => { /* 移动端无 Dockview api，恒 null */ },
    setDefaultBuilder: (fn) => set({ defaultBuilder: fn }),
    setSidebarDefaults: (d) => set({ sidebarDefaults: d }),
    initializeSidebar: (side, visible) => set({ [side === 'left' ? 'leftVisible' : 'rightVisible']: visible } as Partial<WS>),
    registerChatSurface: (id, el) => set((s) => {
      const next = { ...s.chatSurfaces }
      if (el) next[id] = el; else delete next[id]
      return { chatSurfaces: next }
    }),
    syncPanelState: () => { /* 无 Dockview 异步布局，无需回同步 */ },

    refreshTabs: () => {
      const s = get()
      const mk = (r: LeafRec, active: boolean): MainTab => {
        const def = getView(r.type)
        return {
          id: r.id, type: r.type,
          title: r.title || (def ? label(def.displayName) : r.type),
          active, closable: def?.closable !== false,
          sessionId: typeof r.params.sessionId === 'string' ? r.params.sessionId : undefined,
          followActive: r.params.followActive !== false,
        }
      }
      const side = (arr: LeafRec[], activeId: string | null): SideTab[] => arr.map((r) => {
        const def = getView(r.type)
        return { type: r.type, title: r.title || (def ? label(def.displayName) : r.type), active: r.id === activeId, closable: def?.closable !== false }
      })
      set({
        mainTabs: s.mainLeaves.map((r) => mk(r, r.id === s.activeMainId)),
        leftTabs: side(s.leftLeaves, s.leftActiveId),
        rightTabs: side(s.rightLeaves, s.rightActiveId),
      })
    },

    openView(type, params = {}, loc = 'main', opts) {
      const def = getView(type)
      // singleton 复用(跨桶;reuseKey 语义对齐桌面)
      if (def?.singleton) {
        const reuseKey = params.reuseKey
        const existing = allRecs().find((r) => {
          if (r.type !== type) return false
          if (reuseKey === undefined) return true
          return r.params.reuseKey === reuseKey || (reuseKey === 'primary' && r.params.reuseKey === undefined && r.params.followActive !== false)
        })
        if (existing) {
          if (reuseKey === 'primary') { set((s) => ({ [bucketOf(existing.loc)]: s[bucketOf(existing.loc)].map((r) => r.id === existing.id ? { ...r, params: { ...r.params, ...params } } : r) } as Partial<WS>)) }
          setActive(existing.loc, existing.id)
          get().refreshTabs()
          return leaf(existing)
        }
      }
      // 主区默认「就地导航」:替换当前 active 主 leaf(浏览器/Obsidian 式;newTab 显式新建)。
      if (loc === 'main' && !opts?.newTab && get().activeMainId) {
        return get().navigateLeaf(get().activeMainId as string, type, params)
      }
      // 侧栏同侧同类型复用
      if (loc !== 'main') {
        const bucket = get()[bucketOf(loc)]
        const ex = bucket.find((r) => r.type === type)
        if (ex) { setActive(loc, ex.id); get().refreshTabs(); return leaf(ex) }
      }
      // 新建 leaf
      const rec: LeafRec = {
        id: def?.singleton ? type : makeId(type, allRecs().map((r) => r.id)),
        type, loc, params, title: def ? label(def.displayName) : type,
      }
      set((s) => ({ [bucketOf(loc)]: [...s[bucketOf(loc)], rec] } as Partial<WS>))
      set({ [activeKeyOf(loc)]: rec.id } as Partial<WS>)
      if (type === 'chat') set({ focusedChatLeafId: rec.id })
      get().refreshTabs()
      return leaf(rec)
    },

    navigateLeaf(leafId, type, params = {}) {
      const rec = find(leafId)
      const def = getView(type)
      if (!rec || !def) return null
      const wasChat = rec.type === 'chat'
      const nextRec: LeafRec = { ...rec, type, params: { ...params }, title: label(def.displayName) }
      set((s) => ({ [bucketOf(rec.loc)]: s[bucketOf(rec.loc)].map((r) => r.id === leafId ? nextRec : r) } as Partial<WS>))
      if (type === 'chat') set({ focusedChatLeafId: leafId })
      else if (wasChat && get().focusedChatLeafId === leafId) {
        const otherChat = get().mainLeaves.find((r) => r.id !== leafId && r.type === 'chat')
        set({ focusedChatLeafId: otherChat?.id ?? null })
      }
      get().refreshTabs()
      return leaf(nextRec)
    },

    getActiveLeaf() {
      const id = get().activeMainId
      const rec = id ? find(id) : undefined
      return rec ? leaf(rec) : null
    },
    getActiveSideLeaf(sideName) {
      const id = sideName === 'left' ? get().leftActiveId : get().rightActiveId
      const rec = id ? find(id) : undefined
      // 抽屉当前视图缺 active 指针时回退该侧第一个
      const first = (sideName === 'left' ? get().leftLeaves : get().rightLeaves)[0]
      const r = rec ?? first
      return r ? leaf(r) : null
    },
    leafById(id) { const r = find(id); return r ? leaf(r) : null },

    splitActive(_direction, paramsOverride) {
      // 移动端「分屏」= 开一个新主 leaf(全屏),复制当前 active 主 leaf 的 type+params。
      const cur = get().activeMainId ? find(get().activeMainId as string) : undefined
      if (!cur) return null
      return get().openView(cur.type, { ...cur.params, ...paramsOverride }, 'main', { newTab: true })
    },

    toggleSidebar(sideName) {
      const visKey = sideName === 'left' ? 'leftVisible' : 'rightVisible'
      const visible = get()[visKey]
      if (visible) { set({ [visKey]: false } as Partial<WS>); return }
      // 打开:桶空则按 sidebarDefaults 填充
      const bucket = get()[bucketOf(sideName)]
      if (bucket.length === 0) {
        for (const v of get().sidebarDefaults[sideName]) get().openView(v.type, v.params, sideName)
      }
      set({ [visKey]: true } as Partial<WS>)
      get().refreshTabs()
    },
    showSideView(sideName, type) {
      const visKey = sideName === 'left' ? 'leftVisible' : 'rightVisible'
      if (!get()[visKey]) get().toggleSidebar(sideName)
      const rec = get()[bucketOf(sideName)].find((r) => r.type === type)
      if (rec) setActive(sideName, rec.id); else get().openView(type, {}, sideName)
      get().refreshTabs()
    },

    activateLeaf(id) {
      const rec = find(id)
      if (!rec) return
      setActive(rec.loc, id)
      get().refreshTabs()
    },

    closeLeaf(id) {
      const rec = find(id)
      if (!rec) return
      if (rec.type === 'home') return // 主区空态占位,不可关
      // 主区关掉最后一个 → 就地变 home 空态(不销毁主屏)
      if (rec.loc === 'main' && get().mainLeaves.length <= 1) { get().navigateLeaf(id, 'home'); return }
      const bkey = bucketOf(rec.loc)
      const rest = get()[bkey].filter((r) => r.id !== id)
      set({ [bkey]: rest } as Partial<WS>)
      // 重挑该桶 active
      const akey = activeKeyOf(rec.loc)
      if (get()[akey] === id) set({ [akey]: rest[rest.length - 1]?.id ?? null } as Partial<WS>)
      if (get().focusedChatLeafId === id) {
        const otherChat = get().mainLeaves.find((r) => r.type === 'chat')
        set({ focusedChatLeafId: otherChat?.id ?? null })
      }
      get().refreshTabs()
    },

    resetLayout() {
      set({
        mainLeaves: [], leftLeaves: [], rightLeaves: [],
        activeMainId: null, leftActiveId: null, rightActiveId: null,
        leftVisible: false, rightVisible: false, focusedChatLeafId: null,
      })
      get().defaultBuilder?.() // = getActiveSpace().build()（切 Space 时 spaceRegistry 已先切 id）
      get().refreshTabs()
    },

    // 移动端 v1 不做布局序列化 / 命名布局:saveNamed→false 使 spaceRegistry.setActiveSpace 落到 resetLayout→build()。
    saveCurrent() { /* no-op */ },
    saveNamed() { /* no-op */ },
    applyNamed() { return false },
    namedLayouts() { return [] },
  }
})
