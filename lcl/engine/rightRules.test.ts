/**
 * 右栏主视图规则的仪器。判定是纯函数(rightRules.ts);接线跑的是**真的两份 store**,Dockview 换成最小桩(同 pinnedViews.test)。
 * 锁住方案页 B 的细则:规则组替代 Space 缺省、用户自带的不动、组没变不动、收着只改暂存、过渡页不算、焦点不被拽到右栏。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorkspace } from './dockviewStore'
import { useWorkspace as useSingle } from './singleColumnStore'
import { planRight, rightGroupFor, MAX_COMPANIONS, RULE_TAG } from './rightRules'
import { registerView, unregisterView } from './viewRegistry'
import type { ViewDefinition } from './types'
import type { DockviewApi } from 'dockview-react'

type G = { id: string; panels: P[]; activePanel?: P; api: Record<string, unknown> }
type P = { id: string; title: string; params: Record<string, unknown>; group: G; api: Record<string, (...a: never[]) => unknown> }

/** 最小 Dockview 桩(pinnedViews.test 同款):组内顺序、index 落位、inactive 不抢焦点、切活动组 = 该组前台成为活动 panel。 */
function mkApi() {
  const panels: P[] = []
  let gid = 0
  let active: P | null = null
  const mkGroup = (): G => {
    const g: G = { id: `g${++gid}`, panels: [], api: { width: 300, height: 300, setActive() { if (g.activePanel) active = g.activePanel as P }, setSize() { }, setConstraints() { } } }
    return g
  }
  const remove = (p: P): void => {
    const i = panels.indexOf(p)
    if (i < 0) return
    panels.splice(i, 1)
    p.group.panels.splice(p.group.panels.indexOf(p), 1)
    // 同 Dockview:关掉组的前台 = 组里下一个开到前台,并把这个组设成活动组(全局 activePanel 跟着过去)
    if (p.group.activePanel === p) { p.group.activePanel = p.group.panels[0]; if (p.group.activePanel) active = p.group.activePanel }
    if (active === p) active = panels[0] ?? null
  }
  const api = {
    width: 1600, height: 900, panels,
    get activePanel() { return active },
    getPanel: (id: string) => panels.find((p) => p.id === id),
    toJSON: () => ({}),
    removePanel: (p: P) => remove(p),
    addPanel: (o: { id: string; params: Record<string, unknown>; position?: { referencePanel?: string | P; index?: number }; inactive?: boolean }) => {
      if (panels.some((p) => p.id === o.id)) throw new Error(`duplicate panel id ${o.id}`)
      const ref = typeof o.position?.referencePanel === 'string' ? panels.find((p) => p.id === o.position!.referencePanel) : o.position?.referencePanel
      const group = ref ? ref.group : mkGroup()
      const p: P = {
        id: o.id, title: o.id, params: o.params, group,
        api: {
          close: () => remove(p),
          setActive: () => { active = p; p.group.activePanel = p },
          setTitle: (t: string) => { p.title = t },
          updateParameters: (np: Record<string, unknown>) => {
            const next = { ...p.params, ...np }
            for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
            p.params = next
          },
        } as never,
      }
      group.panels.splice(o.position?.index ?? group.panels.length, 0, p)
      panels.push(p)
      if (!o.inactive) { active = p; group.activePanel = p } else group.activePanel ??= p
      return p
    },
  }
  return { api: api as unknown as DockviewApi, panels }
}

/** 右栏标签(按组内顺序)与前台。 */
const right = (panels: P[]): { tabs: string[]; front: string | undefined } => {
  const g = panels.find((p) => p.params.__loc === 'right')?.group
  return { tabs: (g?.panels ?? []).map((p) => p.params.__type as string), front: g?.activePanel?.params.__type as string | undefined }
}
/** 真宿主里 Dockview 的 onDidActivePanelChange 会调 refreshTabs(WorkspaceHost);桩不发事件,这里补上,再等微任务里的对账。 */
const flush = async (): Promise<void> => { useWorkspace.getState().refreshTabs(); for (let i = 0; i < 3; i++) await Promise.resolve() }

// Tangu 形态:Space 右栏缺省 = 详情 / 文件 / 大纲;对话声明同一组,笔记 / PDF 各自声明自己的
const DEFAULTS = [{ type: 'det', params: {} }, { type: 'files', params: { mode: 'files' } }, { type: 'outline', params: {} }]
const V = (type: string, extra: Partial<ViewDefinition> = {}): ViewDefinition => ({ type, displayName: type, factory: () => null, ...extra })
const VIEWS: ViewDefinition[] = [
  V('chatv', { kind: 'entity', rightCompanions: DEFAULTS }),
  V('notev', { kind: 'entity', rightCompanions: [{ type: 'side', params: { followActive: true } }, { type: 'outline', params: {} }, { type: 'back', params: {} }] }),
  V('pdfv', { kind: 'entity', rightCompanions: [{ type: 'side', params: { followActive: true } }] }),
  V('plainv', { kind: 'page' }),
  ...['det', 'outline', 'side', 'back', 'userx'].map((type) => V(type, { kind: 'aux', singleton: true })),
  V('files', { kind: 'collection' }), // 同工作区:非单例,左栏也开着一份
  V('launcher', { kind: 'page' }), V('home', { kind: 'page', closable: false }), V('sidebar-empty', { kind: 'page', closable: false }),
]

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  for (const v of VIEWS) registerView(v)
})
afterEach(() => {
  for (const v of VIEWS) unregisterView(v.type)
  vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('rightRules:判定(纯函数)', () => {
  const usable = (t: string): boolean => t !== 'gone'
  it('组 = 主视图声明的;没声明落 Space 缺省;过渡页不算;去重、滤掉不能用的、声明的最多 4 项', () => {
    expect(rightGroupFor('chatv', [{ type: 'a', params: {} }], DEFAULTS, usable)?.key).toBe('a')
    expect(rightGroupFor('plainv', undefined, DEFAULTS, usable)?.key).toBe('det|files|outline')
    expect(rightGroupFor('plainv', [], DEFAULTS, usable)?.key).toBe(rightGroupFor('plainv', undefined, DEFAULTS, usable)?.key) // 空组 = 没声明
    for (const t of ['launcher', 'home', 'sidebar-empty', null]) expect(rightGroupFor(t, undefined, DEFAULTS, usable)).toBeNull()
    const many = ['a', 'a', 'gone', 'b', 'c', 'd', 'e'].map((type) => ({ type, params: {} }))
    expect(rightGroupFor('x', many, [], usable)?.group.map((p) => p.type)).toEqual(['a', 'b', 'c', 'd'].slice(0, MAX_COMPANIONS))
  })

  it('规则管的 = 打了标的 + Space 缺省里那几种;用户自带与 pinned 不关;新组排在最前', () => {
    const plan = planRight({
      group: [{ type: 'side', params: {} }, { type: 'outline', params: {} }],
      pinned: [{ type: 'pin', params: {} }],
      spaceDefaults: DEFAULTS,
      current: [
        { id: '1', type: 'det', tagged: false, active: true }, // Space 缺省 → 规则管
        { id: '2', type: 'userx', tagged: false, active: false }, // 用户自带
        { id: '3', type: 'back', tagged: true, active: false }, // 规则开的
        { id: '4', type: 'pin', tagged: true, active: false }, // pinned
        { id: '5', type: 'outline', tagged: false, active: false },
      ],
      changed: true,
    })
    expect(plan.close).toEqual(['1', '3'])
    expect(plan.open.map((o) => [o.type, o.after])).toEqual([['side', null]])
    expect(plan.order).toEqual(['side', 'outline', 'userx', 'pin'])
    expect(plan.activate).toBe('side')
  })

  it('前台:组变了顶新组第一项;还原后第一次对账不抢前台,除非前台那个被关;已在前台不动;开在别处的不重开', () => {
    const cur = [{ id: '1', type: 'det', tagged: false, active: true }, { id: '2', type: 'outline', tagged: false, active: false }]
    const g = [{ type: 'outline', params: {} }, { type: 'det', params: {} }]
    expect(planRight({ group: g, pinned: [], spaceDefaults: DEFAULTS, current: cur, changed: true }).activate).toBe('outline')
    expect(planRight({ group: g, pinned: [], spaceDefaults: DEFAULTS, current: cur, changed: false }).activate).toBeNull()
    const g2 = [{ type: 'side', params: {} }]
    expect(planRight({ group: g2, pinned: [], spaceDefaults: DEFAULTS, current: cur, changed: false }).activate).toBe('side') // 前台的 det 被关
    expect(planRight({ group: [{ type: 'det', params: {} }], pinned: [], spaceDefaults: DEFAULTS, current: cur, changed: true }).activate).toBeNull()
    const away = planRight({ group: g2, pinned: [], spaceDefaults: DEFAULTS, current: cur, changed: true, elsewhere: new Set(['side']) })
    expect(away.open).toEqual([])
    expect(away.activate).toBeNull()
  })
})

describe('右栏主视图规则:桌面 store', () => {
  async function boot() {
    const m = mkApi()
    const ws = useWorkspace.getState()
    ws.setApi(m.api)
    ws.setPinned({})
    ws.setSidebarDefaults({ left: [], right: DEFAULTS, bottom: [] })
    ws.setDefaultBuilder(() => {
      const w = useWorkspace.getState()
      w.openView('chatv', {}, 'main')
      for (const v of DEFAULTS) w.openView(v.type, v.params, 'right')
      const det = m.panels.find((p) => p.params.__type === 'det')!
      det.api.setActive()
      w.activateLeaf(m.panels.find((p) => p.params.__type === 'chatv')!.id)
    })
    ws.resetLayout()
    await flush()
    return m
  }
  const mainId = (panels: P[], type: string): string => panels.find((p) => p.params.__loc === 'main' && p.params.__type === type)!.id

  it('对话 → 笔记 → PDF → 回到对话:组替代缺省、退场的是规则管的、焦点留在主区', async () => {
    const { panels, api } = await boot()
    expect(right(panels)).toEqual({ tabs: ['det', 'files', 'outline'], front: 'det' }) // 默认布局本来就是对话那组

    useWorkspace.getState().openView('notev', { notePath: 'a.md' }, 'main', { newTab: true })
    await flush()
    expect(right(panels)).toEqual({ tabs: ['side', 'outline', 'back'], front: 'side' })
    expect(panels.find((p) => p.params.__type === 'side')!.params.__by).toBe(RULE_TAG)
    expect(api.activePanel?.params).toMatchObject({ __type: 'notev' }) // 前台换了,焦点没被拽到右栏

    useWorkspace.getState().openView('pdfv', { pdfPath: 'a.pdf' }, 'main') // 就地导航
    await flush()
    expect(right(panels)).toEqual({ tabs: ['side'], front: 'side' })

    useWorkspace.getState().activateLeaf(mainId(panels, 'chatv'))
    await flush()
    expect(right(panels)).toEqual({ tabs: ['det', 'files', 'outline'], front: 'det' })
    expect(api.activePanel?.params).toMatchObject({ __type: 'chatv' })
  })

  it('视图拿到的 params 里没有来源标记', async () => {
    const { panels } = await boot()
    useWorkspace.getState().openView('notev', { notePath: 'a.md' }, 'main', { newTab: true })
    await flush()
    const side = panels.find((p) => p.params.__type === 'side')!
    expect(useWorkspace.getState().leafById(side.id)!.params).toEqual({ followActive: true })
  })

  it('组没变不动:同组换文件时用户关掉的那个不补回来;用户自带的跟着走、不被关', async () => {
    const { panels } = await boot()
    const ws = useWorkspace.getState()
    ws.openView('userx', {}, 'right')
    ws.openView('pdfv', { pdfPath: 'a.pdf' }, 'main', { newTab: true })
    await flush()
    expect(right(panels).tabs).toEqual(['side', 'userx'])
    ws.closeLeaf(panels.find((p) => p.params.__type === 'side')!.id)
    ws.openView('pdfv', { pdfPath: 'b.pdf' }, 'main')
    await flush()
    expect(right(panels).tabs).toEqual(['userx'])
    ws.activateLeaf(mainId(panels, 'chatv'))
    await flush()
    expect(right(panels).tabs).toEqual(['det', 'files', 'outline', 'userx'])
  })

  it('过渡页(新建标签页)不算;没声明的主视图落 Space 缺省', async () => {
    const { panels } = await boot()
    const ws = useWorkspace.getState()
    ws.openView('notev', { notePath: 'a.md' }, 'main', { newTab: true })
    await flush()
    ws.openView('launcher', {}, 'main', { newTab: true })
    await flush()
    expect(right(panels).tabs).toEqual(['side', 'outline', 'back'])
    ws.openView('plainv', {}, 'main') // 启动器里点了个没声明的页面
    await flush()
    expect(right(panels).tabs).toEqual(['det', 'files', 'outline'])
  })

  it('右栏收着:只改暂存与展开后的前台,不弹出来;展开看到的就是新组', async () => {
    const { panels } = await boot()
    const ws = useWorkspace.getState()
    ws.toggleSidebar('right')
    vi.runAllTimers()
    expect(right(panels).tabs).toEqual([])
    ws.openView('notev', { notePath: 'a.md' }, 'main', { newTab: true })
    await flush()
    expect(right(panels).tabs).toEqual([])
    expect(useWorkspace.getState().rightVisible).toBe(false)
    expect(useWorkspace.getState().stash.right.map((v) => v.type)).toEqual(['side', 'outline', 'back'])
    expect(useWorkspace.getState().stashActive.right).toBe('side')
    useWorkspace.getState().toggleSidebar('right')
    vi.runAllTimers()
    expect(right(panels)).toEqual({ tabs: ['side', 'outline', 'back'], front: 'side' })
  })

  it('收着时对账:暂存里没注册的(插件停用)、同类型的两份用户自带都留着', async () => {
    await boot()
    const ws = useWorkspace.getState()
    ws.toggleSidebar('right')
    vi.runAllTimers()
    const extra = [{ type: 'plugin:gone:inspector', params: { id: 7 } }, { type: 'userx', params: { n: 1 } }, { type: 'userx', params: { n: 2 } }]
    useWorkspace.setState({ stash: { ...useWorkspace.getState().stash, right: [...useWorkspace.getState().stash.right, ...extra] } })
    ws.openView('notev', { notePath: 'a.md' }, 'main', { newTab: true })
    await flush()
    expect(useWorkspace.getState().stash.right.map((v) => v.type)).toEqual(['side', 'outline', 'back', 'plugin:gone:inspector', 'userx', 'userx'])
    expect(useWorkspace.getState().stash.right.slice(3).map((v) => v.params)).toEqual([{ id: 7 }, { n: 1 }, { n: 2 }])
  })

  it('非单例的同类型开在左栏(左栏会话 / 右栏文件都是工作区)不妨碍右栏补上它', async () => {
    const { panels } = await boot()
    const ws = useWorkspace.getState()
    ws.openView('files', { mode: 'orbits' }, 'left')
    ws.openView('notev', { notePath: 'a.md' }, 'main', { newTab: true })
    await flush()
    ws.activateLeaf(mainId(panels, 'chatv'))
    await flush()
    expect(right(panels).tabs).toEqual(['det', 'files', 'outline'])
  })

  it('展开着、只剩「侧栏是空的」占位:换主视图照样开新组(不当成收着只改暂存)', async () => {
    const { panels } = await boot()
    const ws = useWorkspace.getState()
    for (const t of ['det', 'files', 'outline']) ws.closeLeaf(panels.find((p) => p.params.__loc === 'right' && p.params.__type === t)!.id)
    await flush()
    expect(right(panels).tabs).toEqual(['sidebar-empty'])
    ws.openView('notev', { notePath: 'a.md' }, 'main', { newTab: true })
    await flush()
    expect(right(panels)).toEqual({ tabs: ['side', 'outline', 'back'], front: 'side' })
  })

  it('已经开在主区的单例不在右栏再开一份', async () => {
    const { panels } = await boot()
    const ws = useWorkspace.getState()
    ws.openView('side', {}, 'main', { newTab: true }) // 用户把侧栏对话拖进了主区(这里直接开)
    ws.openView('pdfv', { pdfPath: 'a.pdf' }, 'main', { newTab: true })
    await flush()
    expect(right(panels).tabs).toEqual(['sidebar-empty'])
  })
})

describe('右栏主视图规则:单列 store(手机右抽屉)', () => {
  async function boot() {
    const ws = useSingle.getState()
    ws.setPinned({})
    ws.setSidebarDefaults({ left: [], right: DEFAULTS })
    ws.setDefaultBuilder(() => { useSingle.getState().openView('chatv', {}, 'main') })
    ws.resetLayout()
    await flush()
  }
  const drawer = (): { tabs: string[]; front: string | undefined } => {
    const s = useSingle.getState()
    return { tabs: s.rightLeaves.map((r) => r.type), front: s.rightLeaves.find((r) => r.id === s.rightActiveId)?.type }
  }

  it('抽屉没打开过:组和缺省一样就不填桶;换成笔记那组填进桶、抽屉不弹出来;回对话换回来', async () => {
    await boot()
    expect(drawer().tabs).toEqual([]) // 桶空 = 打开时按缺省填
    useSingle.getState().openView('notev', { notePath: 'a.md' }, 'main')
    await flush()
    expect(drawer()).toEqual({ tabs: ['side', 'outline', 'back'], front: 'side' })
    expect(useSingle.getState().rightVisible).toBe(false)
    expect(useSingle.getState().rightLeaves[0].params).toEqual({ followActive: true }) // 标记不进 params
    useSingle.getState().openView('chatv', {}, 'main')
    await flush()
    expect(drawer()).toEqual({ tabs: ['det', 'files', 'outline'], front: 'det' })
  })
})
