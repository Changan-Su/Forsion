/**
 * 底部面板(第四个 ViewLocation)的仪器。跑的是**真的 dockviewStore**,只把 Dockview 换成最小桩
 * (同 pinSides.test.ts 先例:真 dockview 进不了 node)。锁住的是「与左右栏对等」那几条契约:
 *   ① 折叠/展开走 stash,空内容时开占位(展开必须开出东西,否则 syncPanelState 把 visible 复位 = 死键)
 *   ② 高度记忆:用户拖出来的高会被记住并在下次展开生效;系统自己设的高不记
 *   ③ 明确关掉最后一个底部视图 = 关掉面板,且 **stash 清空**(不复活已关视图)——左右栏有占位撑着
 *      走不到这条路,底部是独有的坑
 *   ④ 布局信封:bottom 是可选字段,老布局(无 bottom)照样合法且读成「收起」
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorkspace, captureSideWidths, tryRestoreLayout } from './dockviewStore'
import { computeBottomHeight, BOTTOM_MIN_HEIGHT } from './sideWidth'
import { isLayoutEnvelopeV4, LAYOUT_KEY } from './layoutPersist'
import { registerView, unregisterView } from './viewRegistry'
import type { DockviewApi } from 'dockview-react'

type Con = { minimumWidth?: number; maximumWidth?: number; minimumHeight?: number; maximumHeight?: number } | null

/** 最小 Dockview 桩:group 的 width/height 可读写,panels 可增删。 */
function mkApi(width: number, height: number) {
  const mkGroup = () => ({
    api: {
      width: 0,
      height: 0,
      setSize(s: { width?: number; height?: number }) {
        if (typeof s.width === 'number') this.width = s.width
        if (typeof s.height === 'number') this.height = s.height
      },
      constraints: null as Con,
      setConstraints(c: Con) { this.constraints = c },
      activePanel: null,
    },
  })
  const panels: Array<{ id: string; title: string; params: Record<string, unknown>; group: ReturnType<typeof mkGroup>; api: Record<string, unknown> }> = []
  const mkP = (id: string, params: Record<string, unknown>) => {
    const p = {
      id, title: id, params, group: mkGroup(),
      api: {
        close: () => { const i = panels.findIndex((x) => x.id === id); if (i >= 0) panels.splice(i, 1) },
        setActive: () => { }, setTitle: () => { },
        updateParameters: (np: Record<string, unknown>) => { p.params = { ...p.params, ...np } },
      },
    }
    return p
  }
  const api = {
    width, height, panels,
    getPanel: (id: string) => panels.find((p) => p.id === id),
    activePanel: null,
    toJSON: () => ({}),
    fromJSON: (blob: { panels?: Record<string, { params?: Record<string, unknown> }> }) => {
      panels.length = 0 // 真 Dockview:整份换掉,按 blob 重建 panel
      for (const [id, p] of Object.entries(blob?.panels ?? {})) panels.push(mkP(id, p.params ?? {}))
    },
    addPanel: (o: { id: string; params: Record<string, unknown> }) => { const p = mkP(o.id, o.params); panels.push(p); return p },
  } as unknown as DockviewApi
  return { api, panels }
}

const bottoms = (panels: { params: Record<string, unknown> }[]): { params: Record<string, unknown> }[] =>
  panels.filter((p) => p.params.__loc === 'bottom')
const typesOf = (panels: { params: Record<string, unknown> }[]): unknown[] => bottoms(panels).map((p) => p.params.__type)

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  vi.useFakeTimers() // settleBottomHeight 的 setTimeout(60) 手动推进;node 无 rAF → 兜底同步
  registerView({ type: 'termv', displayName: 'Term', factory: () => null })
  registerView({ type: 'logv', displayName: 'Log', factory: () => null })
  useWorkspace.setState({
    stash: { left: [], right: [], bottom: [] },
    stashActive: { left: null, right: null, bottom: null },
    sidebarDefaults: { left: [], right: [], bottom: [] },
    bottomVisible: false,
  })
})
afterEach(() => {
  unregisterView('termv'); unregisterView('logv')
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('底部面板:几何', () => {
  it('无记忆 = 容器高 32%;记忆优先;钳在 [120, 60%]', () => {
    expect(computeBottomHeight(1000, null)).toBe(320)
    expect(computeBottomHeight(1000, 450)).toBe(450)      // 记忆优先,不被 32% 顶掉
    expect(computeBottomHeight(1000, 900)).toBe(600)      // 上限 60%
    expect(computeBottomHeight(1000, 40)).toBe(BOTTOM_MIN_HEIGHT) // 下限
    expect(computeBottomHeight(150, null)).toBe(BOTTOM_MIN_HEIGHT) // 极矮窗口:下限赢过 32%
  })
})

describe('底部面板:折叠 / 展开', () => {
  it('展开空面板 → 开占位(不是死键)+ bottomVisible;再 toggle → 收干净', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})

    useWorkspace.getState().toggleSidebar('bottom')
    // 「通用停靠区,默认空」:stash 与 defaults 都空 → 必须开出占位,否则 syncPanelState 会把
    // bottomVisible 复位成 false,折叠钮变成永远空转的死键。
    expect(typesOf(panels)).toEqual(['sidebar-empty'])
    expect(useWorkspace.getState().bottomVisible).toBe(true)
    vi.runAllTimers()

    useWorkspace.getState().toggleSidebar('bottom')
    expect(bottoms(panels)).toHaveLength(0)
    expect(useWorkspace.getState().bottomVisible).toBe(false)
    vi.runAllTimers()
  })

  it('折叠暂存 → 展开原样还原(占位不入 stash)', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().openView('termv', {}, 'bottom')
    useWorkspace.getState().openView('logv', {}, 'bottom')
    vi.runAllTimers()

    useWorkspace.getState().toggleSidebar('bottom')
    expect(useWorkspace.getState().stash.bottom.map((v) => v.type)).toEqual(['termv', 'logv'])
    vi.runAllTimers()

    useWorkspace.getState().toggleSidebar('bottom')
    expect(typesOf(panels)).toEqual(['termv', 'logv'])
    vi.runAllTimers()
  })

  it('展开时左右栏宽度纹丝不动(底部吞吐的高只在主区那一列内流动 → 不锁对侧、也不该动它们)', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().openView('termv', {}, 'left')
    useWorkspace.getState().openView('logv', {}, 'right')
    vi.runAllTimers()
    const widths = panels.map((p) => p.group.api.width)

    useWorkspace.getState().toggleSidebar('bottom')
    vi.runAllTimers()
    expect(panels.slice(0, 2).map((p) => p.group.api.width)).toEqual(widths.slice(0, 2))
  })
})

describe('底部面板:高度记忆', () => {
  it('用户拖出来的高被记住,并在下次展开时生效;系统自己设的目标高不记', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().openView('termv', {}, 'bottom')
    vi.runAllTimers()

    // 此刻高 = 目标高(320,系统设的)→ 不该记(否则窗口变高后底部再也不自适应)
    captureSideWidths(api)
    expect(localStorage.getItem('lcl.sideWidth2.sp')).toBeNull()

    // 用户把 sash 拖到 420
    panels[0].group.api.height = 420
    captureSideWidths(api)
    expect(JSON.parse(localStorage.getItem('lcl.sideWidth2.sp')!).bottom).toBe(420)

    // 折叠再展开:回到记住的 420,而不是 32% 默认的 320
    useWorkspace.getState().toggleSidebar('bottom')
    vi.runAllTimers()
    useWorkspace.getState().toggleSidebar('bottom')
    vi.runAllTimers()
    expect(bottoms(panels)).toHaveLength(1)
    expect((panels.find((p) => p.params.__loc === 'bottom') as typeof panels[number]).group.api.height).toBe(420)
  })

  it('收起补间途中的中间高不入记忆(<120 一律当过渡态)', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().openView('termv', {}, 'bottom')
    vi.runAllTimers()
    panels[0].group.api.height = 60 // 补间中间帧
    captureSideWidths(api)
    expect(localStorage.getItem('lcl.sideWidth2.sp')).toBeNull()
  })
})

describe('底部面板:明确关闭 ≠ 折叠', () => {
  it('× 关掉最后一个底部视图 = 关掉面板,且 stash 清空(不会在下次展开时复活)', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().openView('termv', {}, 'main') // 主区留一个,免走「主区空态」分支
    const leaf = useWorkspace.getState().openView('logv', {}, 'bottom')!
    vi.runAllTimers()

    // 先折叠再展开一轮:让 stash 里确实存过东西(这正是复活 bug 的前置条件)
    useWorkspace.getState().toggleSidebar('bottom'); vi.runAllTimers()
    useWorkspace.getState().toggleSidebar('bottom'); vi.runAllTimers()
    expect(useWorkspace.getState().stash.bottom.map((v) => v.type)).toEqual(['logv'])

    const live = panels.find((p) => p.params.__loc === 'bottom')!
    useWorkspace.getState().closeLeaf(live.id)
    vi.runAllTimers()
    expect(bottoms(panels)).toHaveLength(0)                       // 面板整个关掉,不补占位
    expect(useWorkspace.getState().bottomVisible).toBe(false)
    expect(useWorkspace.getState().stash.bottom).toEqual([])      // ← 核心:已关的视图不许留在 stash

    // 再展开:开出的是空占位,不是复活的 logv
    useWorkspace.getState().toggleSidebar('bottom')
    expect(typesOf(panels)).toEqual(['sidebar-empty'])
    vi.runAllTimers()
    void leaf
  })
})

describe('底部面板:Space 可以预置内容(Tangu = 终端,默认折叠)', () => {
  it('sidebarDefaults.bottom + initializeSidebar(false) → 默认折叠,一展开就是预置的那个视图', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    // Tangu Space 的配方形状:底部预置一个视图(产品里是 'terminal')
    useWorkspace.getState().setSidebarDefaults({ left: [], right: [], bottom: [{ type: 'termv', params: {} }] })
    useWorkspace.getState().initializeSidebar('bottom', false)

    expect(useWorkspace.getState().bottomVisible).toBe(false)          // 默认折叠
    expect(bottoms(panels)).toHaveLength(0)                            // 真的没开出面板
    expect(useWorkspace.getState().stash.bottom.map((v) => v.type)).toEqual(['termv']) // 内容已入 stash

    useWorkspace.getState().toggleSidebar('bottom')
    expect(typesOf(panels)).toEqual(['termv'])                         // 展开即预置视图,不是空占位
    vi.runAllTimers()
  })

  // 终端是 host-gated 的内置视图(available: !!window.tangu?.pty):web / 关掉内置终端时它压根没注册。
  // 展开路径的 known 过滤必须把它跳过并退回空占位,而不是拿一个不存在的组件去 addPanel(那会当场抛)。
  it('⚠️预置视图未注册时(如 web 无终端)退回空占位,不是开出死面板', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().setSidebarDefaults({ left: [], right: [], bottom: [{ type: 'no-such-view', params: {} }] })
    useWorkspace.getState().initializeSidebar('bottom', false)

    useWorkspace.getState().toggleSidebar('bottom')
    expect(typesOf(panels)).toEqual(['sidebar-empty'])
    vi.runAllTimers()
  })

  it('不写 bottom 的 Space(绝大多数)照旧 = 空停靠区', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().setSidebarDefaults({ left: [{ type: 'logv', params: {} }], right: [] })
    expect(useWorkspace.getState().sidebarDefaults.bottom).toEqual([]) // 兜底成 [],不是 undefined
    useWorkspace.getState().toggleSidebar('bottom')
    expect(typesOf(panels)).toEqual(['sidebar-empty'])
    vi.runAllTimers()
  })
})

describe('底部面板:反注册前的清场必须覆盖它', () => {
  // Codex review 实报:插件/内置视图被禁用时,清场旧写法只枚举 mainTabs + left + right,漏掉停在
  // bottom 的实例 → unregisterView 之后 panel 还活着(cleanup 不跑),而且这个已不存在的类型留在持久化
  // 布局里,下次启动 layoutViewsAllRegistered 判定失败 → **整份布局被丢弃回默认**。终端正是最可能被
  // 拖进底部的视图,所以这条不是理论风险。
  it('⚠️closeViewsOfType 关得掉停在 bottom 的实例(不只是 main/left/right)', () => {
    const { api, panels } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})
    useWorkspace.getState().openView('logv', {}, 'main')
    useWorkspace.getState().openView('termv', {}, 'left')
    useWorkspace.getState().openView('termv', {}, 'bottom')
    vi.runAllTimers()
    expect(panels.filter((p) => p.params.__type === 'termv')).toHaveLength(2)

    useWorkspace.getState().closeViewsOfType('termv')
    vi.runAllTimers()
    expect(panels.filter((p) => p.params.__type === 'termv')).toHaveLength(0) // 两个区都清干净
    expect(bottoms(panels)).toHaveLength(0)                                   // 底部随之收起
    expect(useWorkspace.getState().stash.bottom).toEqual([])                  // 也不许留在 stash 里复活
  })
})

describe('底部面板:布局信封向后兼容', () => {
  it('bottom 可选:老布局(无 bottom)合法;有 bottom 也合法;bottom 畸形则整份判废', () => {
    const base = {
      version: 4, dockview: {},
      sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } },
    }
    expect(isLayoutEnvelopeV4(base)).toBe(true) // 老布局:不带 bottom 照样读得进(故意不升 v5)
    expect(isLayoutEnvelopeV4({ ...base, sidebars: { ...base.sidebars, bottom: { visible: true, stash: [{ type: 'termv', params: {} }] } } })).toBe(true)
    expect(isLayoutEnvelopeV4({ ...base, sidebars: { ...base.sidebars, bottom: { visible: 'yes', stash: [] } } })).toBe(false)
  })

  it('老布局(无 bottom)经 tryRestoreLayout 恢复 ⇒ 底部收起 + stash 空', () => {
    // 真跑恢复路径,不在测试里重抄一遍读法(否则断言的是自己)。
    const { api } = mkApi(1600, 1000)
    useWorkspace.getState().setApi(api)
    // 先把状态弄脏成「底部开着且有内容」,恢复后必须被老布局覆盖掉
    useWorkspace.setState({ bottomVisible: true, stash: { left: [], right: [], bottom: [{ type: 'termv', params: {} }] } })
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      version: 4, dockview: { panels: { p1: { contentComponent: 'termv', params: { __loc: 'main', __type: 'termv' } } } },
      sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } },
    }))
    expect(tryRestoreLayout(api)).toBe(true)
    expect(useWorkspace.getState().bottomVisible).toBe(false)
    expect(useWorkspace.getState().stash.bottom).toEqual([])
    vi.runAllTimers()
  })
})
