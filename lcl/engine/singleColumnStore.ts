/**
 * 单列 workspace store：桌面 Dockview store(./dockviewStore)的**单列替身**,住在引擎里。
 * 两条路都用它:① mobile 构建 vite engineSwap 把 `engine/workspaceStore` 换成本文件;
 * ② desktop/web 的 workspaceStore 选择器在 UI_MODE==='mobile' 时指向本文件。views/spaceRegistry
 * 经 barrel 拿到的 `useWorkspace` 即本单列实现,上层源零改。
 *
 * 模型:三桶 leaf(main / left / right) + 各自 activeId;主区一次显示一个 active leaf(全屏),
 * 左右侧栏 = 侧滑抽屉(visible 控制)。`navigateLeaf` = 原地换视图(一屏换一屏),`splitActive` = 开新主 leaf。
 * 只实现被 views / spaceRegistry / bootstrapEngine / spaces.build 真正消费的方法;桌面独有的
 * 布局序列化 / 命名布局 / Dockview api 在移动端退化为 no-op / 空(见各方法注释)。
 */
import { create } from 'zustand'
import type { Leaf, ViewLocation } from './types'
import { label } from './types'
import { getView } from './viewRegistry'
import type { PersistedPanel } from './layoutPersist'

/** 主区 leaf 快照(供顶栏/读者)。字段与桌面同名以兼容读者 —— ⚠️ 桌面 dockviewStore 那份加字段时
 *  这里必须同步:移动构建把整个 workspaceStore 换成本文件,漏一个字段就是静默少功能(typecheck 也不红,
 *  因为读者读的是可选属性)。`filePath` 见桌面版同名字段的注释。 */
export interface MainTab { id: string; type: string; title: string; active: boolean; closable: boolean; sessionId?: string; followActive: boolean; filePath?: string; front: boolean }
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

/* ── 布局持久化 ────────────────────────────────────────────────────────────────
 * 桌面靠 Dockview 的 toJSON/fromJSON,单列这边没有 api —— 三桶 leaf 本身就是纯数据,直接序列化。
 * **不与桌面共用键**:两边的 blob 形状互不兼容,而 layoutPersist 的命名表在写入时会把校验不过的
 * 条目顺手丢掉(同源同 origin 的 web 端可能两种壳都跑过)→ 各用各的键,谁也别踩谁。
 */
/** 卫星窗(mini 悬浮卡 / detached)按 `?window=` 各自命名空间 —— 与 layoutPersist.computeLayoutKey
 *  同一套语义。不隔离的话:主窗切到 mobile UI 预览时和 mini 卡共用一份存档,两个 realm 各 200ms
 *  节流写同一个键,后写的整份盖掉前一个(Codex 评审抓的 Medium)。同 origin 开两个普通标签页仍共用
 *  —— 那和桌面 LAYOUT_KEY 的天花板一样(没有可区分的窗口 id),不另造。 */
function scKey(base: string): string {
  try {
    const w = new URLSearchParams(location.search).get('window')
    return w && w !== 'main' ? `${base}_${w}` : base
  } catch { return base } // node 测试无 location
}
const SC_LAYOUT_KEY = scKey('lcl_sc_layout_v1')
const SC_NAMED_KEY = scKey('lcl_sc_named_layouts_v1')

interface SCBlob {
  v: 1
  main: LeafRec[]
  left: LeafRec[]
  right: LeafRec[]
  activeMainId: string | null
  leftActiveId: string | null
  rightActiveId: string | null
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch { return null } // 私密模式 / 坏 JSON
}
function writeJSON(key: string, value: unknown): void {
  // 出声再吞:配额满 / 私密模式 / 某个 leaf 的 params 塞了循环引用 —— 任一情形都是「布局从此不再持久化」,
  // 静默失败的话下次只会收到一句「进去又是新页」,查无对证。
  try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { console.warn('[lcl] 单列布局存盘失败', key, e) }
}

function isBlob(v: unknown): v is SCBlob {
  const b = v as Partial<SCBlob> | null
  return !!b && b.v === 1 && Array.isArray(b.main) && Array.isArray(b.left) && Array.isArray(b.right)
}

/** 逐个剔除不能用的 leaf:①结构坏的(手改 localStorage、旧版本残留 —— `isBlob` 只查三个桶是不是
 *  数组,桶里塞了 `null` 就会在这炸,而这里没有 catch,壳会进错误边界而不是回落默认布局);
 *  ②视图未注册的(端间差异:Tangu Web 没有 amadeus-*;插件视图可能已卸载)。
 *  桌面那边是「有一个未注册就整份回退」,单列这边逐个剔更稳:剩下的还能用。 */
const knownLeaves = (arr: LeafRec[]): LeafRec[] =>
  arr.filter((r): r is LeafRec =>
    !!r && typeof r === 'object'
    && typeof r.id === 'string' && typeof r.type === 'string'
    && !!r.params && typeof r.params === 'object'
    && !!getView(r.type))

let autoSaveArmed = false

/** 冷启动还原上次的三桶 leaf + 各自激活项。成功 true;首启/整份不可用返回 false,调用方 build 默认布局。
 *  同时是自动存盘的**发令枪** —— 还原之前 bootstrap 的那些 setSidebarDefaults 之类的 set() 不该
 *  把一份空布局先写回去,把真正要还原的东西冲掉。 */
export function restoreSingleColumnLayout(): boolean {
  const ok = applySCBlob(readJSON<unknown>(SC_LAYOUT_KEY))
  autoSaveArmed = true
  return ok
}

function applySCBlob(raw: unknown): boolean {
  if (!isBlob(raw)) return false
  const main = knownLeaves(raw.main)
  if (main.length === 0) return false // 主区空 = 没什么可还原的,交回 buildDefault
  const left = knownLeaves(raw.left)
  const right = knownLeaves(raw.right)
  const pick = (want: string | null, pool: LeafRec[]): string | null =>
    pool.some((r) => r.id === want) ? want : pool[pool.length - 1]?.id ?? null
  useWorkspace.setState({
    mainLeaves: main, leftLeaves: left, rightLeaves: right,
    activeMainId: pick(raw.activeMainId, main),
    leftActiveId: pick(raw.leftActiveId, left),
    rightActiveId: pick(raw.rightActiveId, right),
    // ponytail: 抽屉开合不还原,冷启动一律收起 —— 单列的侧栏是全屏浮层不是版面的一部分,
    // 「上次退出时抽屉开着」还原成开着 = 一进 app 先看到侧栏。
    leftVisible: false, rightVisible: false,
    focusedChatLeafId: main.find((r) => r.type === 'chat')?.id ?? null,
  })
  useWorkspace.getState().refreshTabs()
  return true
}

function snapshot(): SCBlob {
  const s = useWorkspace.getState()
  return {
    v: 1,
    main: s.mainLeaves, left: s.leftLeaves, right: s.rightLeaves,
    activeMainId: s.activeMainId, leftActiveId: s.leftActiveId, rightActiveId: s.rightActiveId,
  }
}

/** scheduleWorkspaceSave:桌面由 Dockview 的 onDidLayoutChange 驱动,单列这边**订阅 store**
 *  (见文件末尾)—— 少一个「新加的 mutation 忘了调 save」的坑。保留导出以满足 barrel。 */
export function scheduleWorkspaceSave(): void { saveSoon() }

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveSoon(): void {
  if (!autoSaveArmed || saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; useWorkspace.getState().saveCurrent() }, 200)
}
/** 节流窗口内关掉页面/卡片 = 这一下改动没落盘(「开了个新标签立刻退出,回来它不在」)。
 *  `pagehide` 是移动端唯一可靠的收尾事件(iOS 后台化不发 beforeunload/unload)。 */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (!autoSaveArmed || !saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    useWorkspace.getState().saveCurrent()
  })
}

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
  setSideProfile(key: string, free: { left?: boolean; right?: boolean }, scale?: { left?: number; right?: number }): void
  initializeSidebar(side: 'left' | 'right', visible: boolean): void
  registerChatSurface(id: string, el: HTMLDivElement | null): void
  syncPanelState(): void
  refreshTabs(): void
  openView(type: string, params?: Record<string, unknown>, loc?: ViewLocation, opts?: { newTab?: boolean }): Leaf | null
  navigateLeaf(leafId: string, type: string, params?: Record<string, unknown>): Leaf | null
  getActiveLeaf(): Leaf | null
  getActiveSideLeaf(side: 'left' | 'right'): Leaf | null
  leafById(id: string): Leaf | null
  /** 宽屏(≥4:3)并排形态标记(Host 按 useWideAspect 同步)。窄屏抽屉=全屏接管,主区导航时自动收回;宽屏 docked 左栏不收。 */
  wideMode: boolean
  setWideMode(v: boolean): void
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
      // 让 mainTabs 标题跟随(主视图 tab 条按 mainTabs 渲染)。仅真变更时到这(上面幂等守卫已 return),
      // 且 refreshTabs 只重渲订阅 mainTabs 的 MainTabs、不碰 LeafHost/视图,故不会回激 setTitle 循环。
      get().refreshTabs()
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

  /** 主区导航/激活后自动收抽屉:窄屏抽屉=全屏接管,选中条目即收回(用户拍板);
   *  宽屏 docked 左栏不收(wideMode 由 Host 同步),右栏恒浮层恒收。 */
  const autoCloseDrawers = (): void => {
    const s = get()
    const patch: Partial<WS> = {}
    if (!s.wideMode && s.leftVisible) patch.leftVisible = false
    if (s.rightVisible) patch.rightVisible = false
    if (Object.keys(patch).length) set(patch)
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
    wideMode: false,
    focusedChatLeafId: null,
    chatSurfaces: {},
    sidebarDefaults: { left: [], right: [] },
    mainTabs: [],
    leftTabs: [],
    rightTabs: [],
    defaultBuilder: null,

    setApi: () => { /* 移动端无 Dockview api，恒 null */ },
    setWideMode: (v) => set({ wideMode: v }),
    setDefaultBuilder: (fn) => set({ defaultBuilder: fn }),
    setSidebarDefaults: (d) => set({ sidebarDefaults: d }),
    // Dockview「可拖宽侧栏画像」;单列无侧栏宽度概念 → no-op(补齐 store 契约,否则 spaceRegistry/bootstrap 调用即崩)。
    setSideProfile: () => { /* no-op */ },
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
          filePath: typeof r.params.notePath === 'string' ? r.params.notePath : typeof r.params.path === 'string' ? r.params.path : undefined,
          front: active, // 单列壳同一时刻只显示一个主区 leaf → 前台即活动
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
          if (existing.loc === 'main') autoCloseDrawers()
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
      if (loc === 'main') autoCloseDrawers()
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
      if (rec.loc === 'main') autoCloseDrawers()
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
      if (rec.loc === 'main') autoCloseDrawers()
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

    saveCurrent() { writeJSON(SC_LAYOUT_KEY, snapshot()) },
    // 命名布局 = spaceRegistry 的每-Space 布局槽(`space:<id>`):切走时存、切回来时还原。
    saveNamed(name) {
      const all = readJSON<Record<string, SCBlob>>(SC_NAMED_KEY) ?? {}
      all[name] = snapshot()
      writeJSON(SC_NAMED_KEY, all)
    },
    applyNamed(name) {
      return applySCBlob((readJSON<Record<string, unknown>>(SC_NAMED_KEY) ?? {})[name])
    },
    namedLayouts() { return Object.keys(readJSON<Record<string, SCBlob>>(SC_NAMED_KEY) ?? {}) },
  }
})

// 自动存盘:订阅整个 store(节流 200ms),而不是往每个 mutation 里插一行 save。
// 发令枪是 restoreSingleColumnLayout(),见其注释。
useWorkspace.subscribe(saveSoon)
