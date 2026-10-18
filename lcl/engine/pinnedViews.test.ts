/**
 * 固定 View 的仪器。判定是纯函数(pinnedViews.ts);接线跑的是**真的两份 store**,Dockview 换成最小桩
 * (同 pinSides / bottomPanel 先例)。锁住的是那条不变量 ——「该区内始终至少留一个这种 View」——
 * 在每一条能把视图弄丢的路径上都成立:关闭、就地导航、拖放、替换视图、清场、文件被删,以及缺了之后补回。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorkspace, dropAllowed } from './dockviewStore'
import { useWorkspace as useSingle } from './singleColumnStore'
import { isPinned, isLastPinned, missingPinned, onePageLanding, onePageRedirect, mainPageLanding, type PinnedViews } from './pinnedViews'
import { registerView, unregisterView } from './viewRegistry'
import type { DropTarget } from './dropModel'
import { resetSpaceLayouts, spaceLayoutsWereReset, useSpaceStore, landOnMainPage } from './spaceRegistry'
import { deleteNamedLayout, listNamedLayouts, loadLayout, saveLayout, saveNamedLayout, type LayoutEnvelopeV4 } from './layoutPersist'
import type { DockviewApi } from 'dockview-react'

type G = { id: string; panels: P[]; activePanel?: P; api: Record<string, unknown> }
type P = { id: string; title: string; params: Record<string, unknown>; group: G; api: Record<string, (...a: never[]) => unknown> }

/** 最小 Dockview 桩:组内标签顺序、活动面板、'within' 进组、inactive 不抢焦点、undefined 参数即删键。 */
function mkApi() {
  const panels: P[] = []
  const added: Array<{ id: string; position?: Record<string, unknown>; inactive?: boolean }> = []
  let gid = 0
  let active: P | null = null
  const mkGroup = (): G => {
    // 真 Dockview:切活动组 = 该组的前台 panel 成为活动 panel(replaceViewsOfType 靠它把焦点还给原主人)
    const g: G = { id: `g${++gid}`, panels: [], api: { width: 300, height: 300, setActive() { if (g.activePanel) active = g.activePanel as P }, setSize() { }, setConstraints() { } } }
    return g
  }
  const remove = (p: P): void => {
    const i = panels.indexOf(p)
    if (i < 0) return
    panels.splice(i, 1)
    p.group.panels.splice(p.group.panels.indexOf(p), 1)
    if (p.group.activePanel === p) p.group.activePanel = p.group.panels[0]
    if (active === p) active = panels[0] ?? null
  }
  const api = {
    width: 1600, height: 900, panels,
    get activePanel() { return active },
    getPanel: (id: string) => panels.find((p) => p.id === id),
    toJSON: () => ({}),
    removePanel: (p: P) => remove(p),
    addPanel: (o: { id: string; params: Record<string, unknown>; position?: { referencePanel?: string | P; index?: number }; inactive?: boolean }) => {
      if (panels.some((p) => p.id === o.id)) throw new Error(`duplicate panel id ${o.id}`) // 真 Dockview 也炸
      added.push({ id: o.id, position: o.position as Record<string, unknown> | undefined, inactive: o.inactive })
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
          moveTo: (m: { group: G }) => {
            p.group.panels.splice(p.group.panels.indexOf(p), 1)
            p.group = m.group
            m.group.panels.push(p)
          },
        } as never,
      }
      group.panels.splice(o.position?.index ?? group.panels.length, 0, p)
      panels.push(p)
      if (!o.inactive) { active = p; group.activePanel = p } else group.activePanel ??= p
      return p
    },
  }
  return { api: api as unknown as DockviewApi, panels, added }
}

const at = (panels: P[], loc: string): string[] => panels.filter((p) => (p.params.__loc ?? 'main') === loc).map((p) => p.params.__type as string)
const idOf = (panels: P[], loc: string, type: string): string => panels.find((p) => p.params.__loc === loc && p.params.__type === type)!.id

const PINS: PinnedViews = {
  main: [{ type: 'chatv', params: { followActive: true } }],
  left: [{ type: 'listv', params: { mode: 'orbits' } }],
  right: [{ type: 'detailv', params: {} }],
}
const VIEWS = ['chatv', 'filev', 'listv', 'detailv', 'assetv', 'home', 'sidebar-empty']

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  vi.useFakeTimers()
  for (const type of VIEWS) registerView({ type, displayName: type, factory: () => null, ...(type === 'home' || type === 'sidebar-empty' ? { closable: false } : {}) })
})
afterEach(() => {
  for (const type of VIEWS) unregisterView(type)
  vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('pinnedViews:判定(纯函数)', () => {
  it('固定按 (区, 类型) 认;底部与没声明的区不固定', () => {
    expect(isPinned(PINS, 'main', 'chatv')).toBe(true)
    expect(isPinned(PINS, 'left', 'chatv')).toBe(false)
    expect(isPinned(PINS, 'bottom', 'chatv')).toBe(false)
    expect(isPinned({}, 'main', 'chatv')).toBe(false)
  })
  it('受保护 = 区内只剩这一个;多开的同类标签不受保护', () => {
    const one = [{ loc: 'main', type: 'chatv' }, { loc: 'left', type: 'chatv' }]
    expect(isLastPinned(PINS, one, 'main', 'chatv')).toBe(true) // 左栏那个不算主区的
    expect(isLastPinned(PINS, [...one, { loc: 'main', type: 'chatv' }], 'main', 'chatv')).toBe(false)
    expect(isLastPinned(PINS, one, 'main', 'filev')).toBe(false)
  })
  it('缺哪些:没注册的类型跳过(插件停用着),注册上再补', () => {
    const panels = [{ loc: 'main', type: 'chatv' }]
    expect(missingPinned(PINS, panels, () => true).map((p) => `${p.loc}:${p.type}`)).toEqual(['left:listv', 'right:detailv'])
    expect(missingPinned(PINS, panels, (t) => t !== 'detailv').map((p) => p.type)).toEqual(['listv'])
  })
})

describe('固定 View:桌面 store', () => {
  /** 默认布局:主区聊天、左栏列表、右栏详情,全部固定。 */
  function build() {
    const m = mkApi()
    const ws = useWorkspace.getState()
    ws.setApi(m.api)
    useWorkspace.setState({ stash: { left: [], right: [], bottom: [] }, stashActive: { left: null, right: null, bottom: null }, sidebarDefaults: { left: [], right: [], bottom: [] } })
    ws.setPinned({})
    ws.openView('chatv', { followActive: true }, 'main')
    ws.openView('listv', { mode: 'orbits' }, 'left')
    ws.openView('detailv', {}, 'right')
    ws.setPinned(PINS)
    return m
  }

  it('区内最后一个关不掉;多开一个之后任一个都能关,关到只剩一个又关不掉', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    const chat = idOf(panels, 'main', 'chatv')
    ws.closeLeaf(chat)
    expect(at(panels, 'main')).toEqual(['chatv'])
    expect(useWorkspace.getState().mainTabs[0].closable).toBe(false)

    ws.openView('chatv', { sessionId: 's2', followActive: false }, 'main', { newTab: true })
    ws.refreshTabs() // 真 Dockview 由 onDidActivePanelChange 触发(WorkspaceHost.onReady 接的线),桩没有这个事件
    expect(useWorkspace.getState().mainTabs.map((t) => t.closable)).toEqual([true, true])
    ws.closeLeaf(chat)
    expect(at(panels, 'main')).toEqual(['chatv'])
    ws.closeLeaf(panels.find((p) => p.params.__loc === 'main')!.id)
    expect(at(panels, 'main')).toEqual(['chatv']) // 剩下的那个接任固定
  })

  it('leaf.close() 同样被拦(原先是裸 panel.api.close(),绕过 closeLeaf)', () => {
    const { panels } = build()
    useWorkspace.getState().leafById(idOf(panels, 'main', 'chatv'))!.close()
    expect(at(panels, 'main')).toEqual(['chatv'])
  })

  it('在固定 View 上打开别的类型 → 同组新标签;同类照旧就地换', () => {
    const { panels, added } = build()
    const ws = useWorkspace.getState()
    const chat = idOf(panels, 'main', 'chatv')
    const leaf = ws.openView('filev', { path: '/a.md' }, 'main')
    expect(at(panels, 'main')).toEqual(['chatv', 'filev'])
    expect(leaf!.id).not.toBe(chat)
    expect(added.at(-1)!.position).toMatchObject({ referencePanel: chat, direction: 'within' }) // 开在聊天那一组

    // 新标签不是固定的:再开一个文件就地换它
    ws.openView('filev', { path: '/b.md' }, 'main')
    expect(at(panels, 'main')).toEqual(['chatv', 'filev'])
    expect(panels.find((p) => p.params.__type === 'filev')!.params.path).toBe('/b.md')

    // 同类:聊天换到另一个会话,还是那一个标签
    ws.navigateLeaf(chat, 'chatv', { sessionId: 's9', followActive: false })
    expect(at(panels, 'main')).toEqual(['chatv', 'filev'])
    expect(ws.leafById(chat)!.params.sessionId).toBe('s9')
  })

  it('直接调 navigateLeaf 换类型也走同一道守卫;没固定时照旧就地换(负对照)', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    const chat = idOf(panels, 'main', 'chatv')
    expect(ws.navigateLeaf(chat, 'filev', { path: '/a.md' })!.id).not.toBe(chat)
    expect(at(panels, 'main')).toEqual(['chatv', 'filev'])

    ws.setPinned({})
    expect(ws.navigateLeaf(chat, 'filev', { path: '/c.md' })!.id).toBe(chat)
    expect(at(panels, 'main')).toEqual(['filev', 'filev'])
  })

  it('拖不出本区:跨区落点不允许,区内分屏 / 排序照常', () => {
    const { api, panels } = build()
    const chat = panels.find((p) => p.params.__type === 'chatv')!
    const left = panels.find((p) => p.params.__loc === 'left')!
    const toLeft = { mode: 'tab', group: left.group, index: 0 } as unknown as DropTarget
    const within = { mode: 'split', group: chat.group, dir: 'right' } as unknown as DropTarget
    expect(dropAllowed(api, chat.id, toLeft)).toBe(false)
    expect(dropAllowed(api, chat.id, within)).toBe(true)
    useWorkspace.getState().dropView(chat.id, toLeft)
    expect(at(panels, 'main')).toEqual(['chatv'])
    expect(at(panels, 'left')).toEqual(['listv'])

    // 多开一个之后,其中一个可以拖走
    useWorkspace.getState().openView('chatv', { sessionId: 's2' }, 'main', { newTab: true })
    expect(dropAllowed(api, chat.id, toLeft)).toBe(true)
  })

  it('替换视图(插件的 ctx.replaceView / Coding 进项目):固定 View 不被顶掉,新视图开在它旁边并顶到前台;退回时只摘掉新开的', () => {
    const { panels, api } = build()
    const ws = useWorkspace.getState()
    useWorkspace.setState({ sidebarDefaults: { left: [{ type: 'listv', params: {} }], right: [], bottom: [] } })
    const list = panels.find((x) => x.params.__type === 'listv')!
    const focus = panels.find((x) => x.params.__type === 'chatv')!
    focus.api.setActive()
    expect(ws.replaceViewsOfType('listv', 'assetv', { k: 1 })).toBe(1)
    expect(list.group.panels.map((x) => x.params.__type)).toEqual(['listv', 'assetv']) // 同组,排在固定的后面
    expect(list.group.activePanel!.params).toMatchObject({ __type: 'assetv', k: 1 }) // 固定的原先在前台 → 新的顶上
    expect(api.activePanel!.id).toBe(focus.id) // 焦点还给主区
    expect(useWorkspace.getState().sidebarDefaults.left.map((v) => v.type)).toEqual(['listv'])

    // 已经在旁边了:不再新开(返回 0),只是固定的若在前台就让它顶上来
    list.api.setActive(); focus.api.setActive()
    expect(ws.replaceViewsOfType('listv', 'assetv')).toBe(0)
    expect(at(panels, 'left')).toEqual(['listv', 'assetv'])
    expect(list.group.activePanel!.params.__type).toBe('assetv')
    expect(api.activePanel!.id).toBe(focus.id)

    // 退回:新开的那个被摘掉,固定的留着
    expect(ws.replaceViewsOfType('assetv', 'listv')).toBe(1)
    expect(at(panels, 'left')).toEqual(['listv'])

    // 主区同理:固定的聊天不被顶掉,新标签开在同组
    expect(ws.replaceViewsOfType('chatv', 'filev')).toBe(1)
    expect(at(panels, 'main')).toEqual(['chatv', 'filev'])

    // 负对照:没固定的照旧原位被换
    ws.openView('assetv', {}, 'left')
    expect(ws.replaceViewsOfType('assetv', 'filev')).toBe(1)
    expect(at(panels, 'left')).toEqual(['listv', 'filev'])
  })

  it('替换视图 × 收起的侧栏:新视图只排进暂存(固定的后面)并成为展开后的前台,侧栏保持收起', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    for (const p of panels.filter((x) => x.params.__loc === 'left')) p.api.close() // 摆成收起后的样子
    useWorkspace.setState({ stash: { left: [{ type: 'listv', params: { mode: 'orbits' } }], right: [], bottom: [] }, stashActive: { left: 'listv', right: null, bottom: null }, leftVisible: false })
    expect(ws.replaceViewsOfType('listv', 'assetv', { k: 1 })).toBe(1)
    expect(at(panels, 'left')).toEqual([])
    expect(useWorkspace.getState().leftVisible).toBe(false)
    expect(useWorkspace.getState().stash.left).toEqual([{ type: 'listv', params: { mode: 'orbits' } }, { type: 'assetv', params: { k: 1 } }])
    expect(useWorkspace.getState().stashActive.left).toBe('assetv')
    expect(ws.replaceViewsOfType('listv', 'assetv')).toBe(0) // 已经在了
    expect(ws.replaceViewsOfType('assetv', 'listv')).toBe(1) // 退回:摘掉
    expect(useWorkspace.getState().stash.left.map((v) => v.type)).toEqual(['listv'])
    expect(useWorkspace.getState().stashActive.left).toBe('listv')
  })

  // ── Codex 评审(2026-10-03)复现的几条 ────────────────────────────────────────────
  it('固定的那个本身是活动 panel:换完之后新视图留在前台,不被「焦点还给原主人」又激活回去', () => {
    const { panels, api } = build()
    const ws = useWorkspace.getState()
    const list = panels.find((x) => x.params.__type === 'listv')!
    list.api.setActive()
    expect(ws.replaceViewsOfType('listv', 'assetv')).toBe(1)
    expect(api.activePanel!.params?.__type).toBe('assetv')
    // 主区同理
    const chat = panels.find((x) => x.params.__type === 'chatv')!
    chat.api.setActive()
    expect(ws.replaceViewsOfType('chatv', 'filev')).toBe(1)
    expect(api.activePanel!.params?.__type).toBe('filev')
  })

  it('主区固定 View:连换两次不重复开标签,往回换是摘掉新开的而不是把它也变成固定的那种', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    expect(ws.replaceViewsOfType('chatv', 'filev', { path: '/a' })).toBe(1)
    expect(ws.replaceViewsOfType('chatv', 'filev', { path: '/b' })).toBe(0)
    expect(at(panels, 'main')).toEqual(['chatv', 'filev'])
    expect(panels.find((x) => x.params.__type === 'filev')!.params.path).toBe('/b') // 参数并进已有的那个
    expect(ws.replaceViewsOfType('filev', 'chatv')).toBe(1)
    expect(at(panels, 'main')).toEqual(['chatv'])

    // 负对照:不牵涉固定 View 的主区照旧就地换,多开的同类标签不去重
    ws.setPinned({})
    ws.openView('filev', { path: '/x' }, 'main', { newTab: true })
    ws.openView('assetv', {}, 'main', { newTab: true })
    expect(ws.replaceViewsOfType('assetv', 'filev')).toBe(1)
    expect(at(panels, 'main')).toEqual(['chatv', 'filev', 'filev'])
  })

  it('收起的侧栏里目标视图已经在:不重复加,但新参数要并进去', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    for (const p of panels.filter((x) => x.params.__loc === 'left')) p.api.close()
    useWorkspace.setState({ stash: { left: [{ type: 'listv', params: {} }, { type: 'assetv', params: { project: 'old', keep: 1 } }], right: [], bottom: [] }, leftVisible: false })
    expect(ws.replaceViewsOfType('listv', 'assetv', { project: 'new' })).toBe(0)
    expect(useWorkspace.getState().stash.left).toEqual([{ type: 'listv', params: {} }, { type: 'assetv', params: { project: 'new', keep: 1 } }])
  })

  it('remapLeaves 摘掉收起侧栏里的固定项(它指向的文件没了)→ 补一个空白的回来,别的暂存项照旧', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    ws.setPinned({ left: [{ type: 'filev', params: {} }] })
    for (const p of panels.filter((x) => x.params.__loc === 'left')) p.api.close()
    useWorkspace.setState({ stash: { left: [{ type: 'filev', params: { path: '/gone.md' } }, { type: 'assetv', params: {} }], right: [], bottom: [] }, leftVisible: false })
    ws.remapLeaves((type, params) => (type === 'filev' && params.path === '/gone.md' ? null : undefined))
    expect(useWorkspace.getState().stash.left).toEqual([{ type: 'filev', params: {} }, { type: 'assetv', params: {} }])
  })

  it('清场:插件自己关(不带 force)留下固定的;视图注销(force)一并关掉', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    ws.closeViewsOfType('detailv')
    expect(at(panels, 'right')).toEqual(['detailv'])
    ws.closeViewsOfType('detailv', true)
    expect(at(panels, 'right')).toEqual(['sidebar-empty']) // 侧栏关空 → 占位

    ws.closeViewsOfType('chatv', true)
    expect(at(panels, 'main')).toEqual(['home']) // 主区最后一个 → 就地换空态,而不是在旁边再开一个 home
  })

  it('补回:活着的侧栏排到组首且不抢焦点;收起的侧栏只进暂存;主区空态就地换', () => {
    const { panels, added } = build()
    const ws = useWorkspace.getState()
    ws.closeViewsOfType('detailv', true)
    ws.closeViewsOfType('chatv', true)
    ws.closeViewsOfType('listv', true)
    // 左栏收起(真收起会走补间,这里直接摆成收起后的样子)
    for (const p of panels.filter((x) => x.params.__loc === 'left')) p.api.close()
    useWorkspace.setState({ stash: { left: [{ type: 'assetv', params: {} }], right: [], bottom: [] }, leftVisible: false })
    const before = panels.find((p) => p.params.__loc === 'right')!
    before.api.setActive()

    ws.ensurePinned()
    expect(at(panels, 'main')).toEqual(['chatv'])
    expect(panels.find((p) => p.params.__type === 'chatv')!.params.followActive).toBe(true) // 用声明的重建参数
    expect(at(panels, 'right')).toEqual(['detailv']) // 占位退位
    expect(added.at(-1)).toMatchObject({ inactive: true, position: { index: 0 } })
    expect(at(panels, 'left')).toEqual([]) // 没替用户展开
    expect(useWorkspace.getState().stash.left.map((v) => v.type)).toEqual(['listv', 'assetv'])
    expect(useWorkspace.getState().stash.left[0].params).toEqual({ mode: 'orbits' })

    // 幂等:都在了就什么都不做
    const count = panels.length
    ws.ensurePinned()
    expect(panels.length).toBe(count)
  })

  it('没注册的固定类型不补(停用的插件),也不报错', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    ws.closeViewsOfType('detailv', true)
    unregisterView('detailv')
    expect(() => ws.ensurePinned()).not.toThrow()
    expect(at(panels, 'right')).toEqual(['sidebar-empty'])
    registerView({ type: 'detailv', displayName: 'detailv', factory: () => null })
    ws.ensurePinned()
    expect(at(panels, 'right')).toEqual(['detailv'])
  })

  it('指向的文件没了(remapLeaves → null):固定 View 关掉后补一个空白的回来', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    ws.setPinned({ main: [{ type: 'filev', params: {} }] })
    ws.navigateLeaf(idOf(panels, 'main', 'chatv'), 'filev', { path: '/gone.md' })
    ws.remapLeaves((type, params) => (type === 'filev' && params.path === '/gone.md' ? null : undefined))
    expect(at(panels, 'main')).toEqual(['filev'])
    expect(panels.find((p) => p.params.__type === 'filev')!.params.path).toBeUndefined()
  })

  it('收起着的侧栏图标:固定的那个不可关', () => {
    build()
    useWorkspace.setState({ leftVisible: false, stash: { left: [{ type: 'listv', params: {} }, { type: 'assetv', params: {} }], right: [], bottom: [] } })
    useWorkspace.getState().refreshTabs()
    expect(useWorkspace.getState().leftTabs.map((t) => [t.type, t.closable])).toEqual([['listv', false], ['assetv', true]])
  })
})

describe('升级时的一次性重置', () => {
  const blob: LayoutEnvelopeV4 = { version: 4, dockview: { grid: {} }, sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } } }
  const scBlob = (type: string): string => JSON.stringify({ v: 1, main: [{ id: type, type, loc: 'main', params: {}, title: type }], left: [], right: [], activeMainId: type, leftActiveId: null, rightActiveId: null })

  // ⚠️排在整份重置那条之前:spaceLayoutsWereReset 是模块级的一次性旗,整份重置置过就回不去了。
  it('resetSpaceLayouts(只丢一个 Space):它的槽和归它的当前布局清掉,别的 Space 的原样留着,也不谎报「全部重置过」', () => {
    useSpaceStore.setState({ spaces: [{ id: 'image-studio', name: 'Image Studio', icon: (() => null) as never, sidebarDefaults: { left: [], right: [] }, pinned: { main: [{ type: 'image-studio', params: {} }] }, build() { } }] })
    saveNamedLayout('space:tangu', blob)
    saveNamedLayout('space:image-studio', blob)
    saveLayout({ ...blob, space: 'image-studio' })
    localStorage.setItem('lcl_sc_named_layouts_v1', JSON.stringify({ 'space:tangu': {}, 'space:image-studio': {} }))
    localStorage.setItem('lcl_sc_layout_v1', scBlob('image-studio'))
    resetSpaceLayouts('image-studio')
    expect(Object.keys(listNamedLayouts())).toContain('space:tangu')
    expect(Object.keys(listNamedLayouts())).not.toContain('space:image-studio')
    expect(loadLayout()).toBeNull()
    expect(Object.keys(JSON.parse(localStorage.getItem('lcl_sc_named_layouts_v1')!))).toEqual(['space:tangu'])
    expect(localStorage.getItem('lcl_sc_layout_v1')).toBeNull() // 主区摆着它的固定主视图 = 它的现场
    // 那面旗说的是「全部 Space 都重置了」:只丢一个时置了它,无关的异步启动 Space 会被当成要重建
    expect(spaceLayoutsWereReset()).toBe(false)
    // 当前布局是别的 Space 的现场:不动。单列那份不记归属,主区里没有这个 Space 的主视图就认不出是它的 → 留着
    saveNamedLayout('space:image-studio', blob)
    saveLayout({ ...blob, space: 'tangu' })
    localStorage.setItem('lcl_sc_layout_v1', scBlob('chatv'))
    resetSpaceLayouts('image-studio')
    expect(Object.keys(listNamedLayouts())).not.toContain('space:image-studio')
    expect(loadLayout()?.space).toBe('tangu')
    expect(localStorage.getItem('lcl_sc_layout_v1')).toBe(scBlob('chatv'))
    useSpaceStore.setState({ spaces: [] })
  })

  it('resetSpaceLayouts:各 Space 的已存布局与当前布局清掉,用户自己起名存的布局留着', () => {
    for (const name of Object.keys(listNamedLayouts())) deleteNamedLayout(name)
    saveNamedLayout('space:tangu', blob)
    saveNamedLayout('space:plugin:x', blob)
    saveNamedLayout('我的布局', blob)
    saveLayout(blob)
    resetSpaceLayouts()
    expect(Object.keys(listNamedLayouts())).toEqual(['我的布局'])
    expect(loadLayout()).toBeNull()
    expect(spaceLayoutsWereReset()).toBe(true)
  })
})

describe('固定 View:单列 store(移动端是独立重写的一份,漏接 = 静默少功能)', () => {
  function build() {
    useSingle.setState({ mainLeaves: [], leftLeaves: [], rightLeaves: [], activeMainId: null, leftActiveId: null, rightActiveId: null, sidebarDefaults: { left: [], right: [] }, pinned: {} })
    const ws = useSingle.getState()
    ws.openView('chatv', { followActive: true }, 'main')
    ws.openView('listv', {}, 'left')
    ws.setPinned(PINS)
    return ws
  }
  const types = (): string[] => useSingle.getState().mainLeaves.map((r) => r.type)

  it('最后一个关不掉、标签面板不给 ×;force 放行并落到空态', () => {
    const ws = build()
    const chat = useSingle.getState().mainLeaves[0].id
    ws.closeLeaf(chat)
    expect(types()).toEqual(['chatv'])
    expect(useSingle.getState().mainTabs[0].closable).toBe(false)
    expect(useSingle.getState().leftTabs[0].closable).toBe(false)
    ws.closeLeaf(chat, true)
    expect(types()).toEqual(['home'])
  })

  it('打开别的类型 → 新的主 leaf,固定的那个还在;同类就地换', () => {
    const ws = build()
    ws.openView('filev', { path: '/a.md' }, 'main')
    expect(types()).toEqual(['chatv', 'filev'])
    expect(useSingle.getState().mainLeaves.find((r) => r.id === useSingle.getState().activeMainId)!.type).toBe('filev')
    ws.navigateLeaf(useSingle.getState().mainLeaves[0].id, 'chatv', { sessionId: 's9' })
    expect(types()).toEqual(['chatv', 'filev'])
  })

  it('替换视图顶不掉固定的(开在旁边);缺了能补回,且不抢当前显示的那个', () => {
    const ws = build()
    // 固定的不被顶掉:新视图加进同一个抽屉(不弹开抽屉),再换一次不重复开
    expect(ws.replaceViewsOfType('listv', 'assetv')).toBe(1)
    expect(ws.replaceViewsOfType('listv', 'assetv')).toBe(0)
    expect(useSingle.getState().leftLeaves.map((r) => r.type)).toEqual(['listv', 'assetv'])
    expect(useSingle.getState().leftVisible).toBe(false)

    ws.openView('filev', { path: '/a.md' }, 'main')
    ws.closeViewsOfType('chatv', true)
    expect(types()).toEqual(['filev'])
    const showing = useSingle.getState().activeMainId
    ws.ensurePinned()
    expect(types()).toEqual(['chatv', 'filev'])
    expect(useSingle.getState().activeMainId).toBe(showing)
  })

  // ── Codex 评审(2026-10-03)复现的几条 ────────────────────────────────────────────
  it('抽屉里往回换:摘掉新开的那个,不是把它也变成固定的那种', () => {
    const ws = build()
    expect(ws.replaceViewsOfType('listv', 'assetv')).toBe(1)
    expect(ws.replaceViewsOfType('assetv', 'listv')).toBe(1)
    expect(useSingle.getState().leftLeaves.map((r) => r.type)).toEqual(['listv'])
  })

  it('主区固定 View:连换两次不重复开,往回换摘掉新开的', () => {
    const ws = build()
    expect(ws.replaceViewsOfType('chatv', 'filev')).toBe(1)
    expect(ws.replaceViewsOfType('chatv', 'filev')).toBe(0)
    expect(types()).toEqual(['chatv', 'filev'])
    expect(ws.replaceViewsOfType('filev', 'chatv')).toBe(1)
    expect(types()).toEqual(['chatv'])
  })

  it('⚠️目标是单例且主区已有一个:抽屉里照样新开一个,参数不漏到主区那个上(Coding 的 studio 参数误关主区聊天)', () => {
    registerView({ type: 'singlev', displayName: 'singlev', factory: () => null, singleton: true })
    try {
      const ws = build()
      ws.openView('singlev', { followActive: true, reuseKey: 'primary' }, 'main', { newTab: true })
      const mainSingle = (): Record<string, unknown> => useSingle.getState().mainLeaves.find((r) => r.type === 'singlev')!.params
      expect(ws.replaceViewsOfType('listv', 'singlev', { studio: true })).toBe(1)
      expect(useSingle.getState().leftLeaves.map((r) => r.type)).toEqual(['listv', 'singlev'])
      expect(mainSingle().studio).toBeUndefined()
      // 回索引:只关带 studio 的那个,主区的还在
      ws.remapLeaves((type, params) => (type === 'singlev' && params.studio ? null : undefined))
      expect(useSingle.getState().leftLeaves.map((r) => r.type)).toEqual(['listv'])
      expect(useSingle.getState().mainLeaves.some((r) => r.type === 'singlev')).toBe(true)
    } finally { unregisterView('singlev') }
  })
})

// 主页就是主页(2026-10-11 用户实报:手机上进主页,里面是别的 Space 的内容;随后定「主页不让开标签」)。判定是这两个纯函数;
// 接线在 SingleColumnHost(进 Space 的落点钩子、底栏上点它自己那格、主区开视图之前的钩子)与 spaceRegistry.redirectOpenFromOnePage,
// 真机链路由 mobile 的 emu:nativeshell「home stays home」看。
describe('一页式 Space(onePage):落点与转开', () => {
  const home = { id: 'home', onePage: true, pinned: { main: [{ type: 'homev', params: {} }] } as PinnedViews }
  const tangu = { id: 'tangu', pinned: { main: [{ type: 'chat', params: {} }] } as PinnedViews }
  const notes = { id: 'notes', launcherViews: [{ type: 'notev', params: {} }] }
  const spaces = [home, tangu, notes]
  const leaves = [{ id: 'homev', type: 'homev' }, { id: 'chat#1', type: 'chat' }]

  it('落点:它那一页到前台,多出来的标签关掉;没声明、或区里没有那一页 → 什么都不动', () => {
    expect(onePageLanding(home, leaves, 'chat#1')).toEqual({ activate: 'homev', close: ['chat#1'] })
    expect(onePageLanding(home, leaves, 'homev')).toEqual({ activate: null, close: ['chat#1'] })
    expect(onePageLanding(home, [leaves[0]], 'homev')).toEqual({ activate: null, close: [] })
    expect(onePageLanding({ pinned: home.pinned }, leaves, 'chat#1')).toEqual({ activate: null, close: [] })
    expect(onePageLanding(home, [leaves[1]], 'chat#1')).toEqual({ activate: null, close: [] }) // 没有那一页:别把别的关光
    expect(onePageLanding(undefined, leaves, 'chat#1')).toEqual({ activate: null, close: [] })
  })

  it('转开:固定在主区的、列在 launcherViews 里的,去它的主人那儿;自己那一页、占位视图、认不出主人的、不在一页式 Space 里 → 不带', () => {
    expect(onePageRedirect(spaces, 'home', 'chat')).toBe('tangu')
    expect(onePageRedirect(spaces, 'home', 'notev')).toBe('notes')
    expect(onePageRedirect(spaces, 'home', 'homev')).toBeUndefined()
    expect(onePageRedirect(spaces, 'home', 'launcher')).toBeUndefined()
    expect(onePageRedirect(spaces, 'home', 'browser')).toBeUndefined()
    expect(onePageRedirect(spaces, 'tangu', 'notev')).toBeUndefined() // Tangu 不是一页式:照旧开在它里面
    expect(onePageRedirect(spaces, 'gone', 'chat')).toBeUndefined()
  })

  it('真的单列 store:旧布局里主页多着一个标签并在前台 → 照落点处理后只剩主页那一页', () => {
    registerView({ type: 'homev', kind: 'page', displayName: 'Home', factory: () => null, singleton: true })
    registerView({ type: 'otherv', kind: 'page', displayName: 'Other', factory: () => null })
    try {
      const ws = useSingle.getState()
      ws.resetLayout()
      ws.setPinned(home.pinned)
      ws.openView('homev', {}, 'main')
      ws.openView('otherv', {}, 'main') // 没接转开钩子时:在固定视图上开别的类型 = 多一个标签并到前台(这就是「主页里是别的内容」)
      const before = useSingle.getState()
      expect(before.mainLeaves.map((r) => r.type)).toEqual(['homev', 'otherv'])
      expect(before.mainLeaves.find((r) => r.id === before.activeMainId)?.type).toBe('otherv')
      const { activate, close } = onePageLanding(home, before.mainLeaves, before.activeMainId)
      if (activate) ws.activateLeaf(activate)
      for (const id of close) ws.closeLeaf(id, true)
      const after = useSingle.getState()
      expect(after.mainLeaves.map((r) => r.type)).toEqual(['homev'])
      expect(after.activeMainId).toBe(after.mainLeaves[0].id)
      expect(onePageLanding(home, after.mainLeaves, after.activeMainId)).toEqual({ activate: null, close: [] })
    } finally { useSingle.getState().setPinned(undefined); useSingle.getState().resetLayout(); unregisterView('homev'); unregisterView('otherv') }
  })

  it('落点:两边抽屉里的面板也关(一页式 Space 没有侧栏);宿主挂的抽屉扩展不算;没有那一页时照旧什么都不动', () => {
    const sides = [{ id: 'workspace', type: 'workspace' }, { id: 'ext', type: '__extend' }, { id: 'outline', type: 'outline' }]
    expect(onePageLanding(home, leaves, 'chat#1', sides)).toEqual({ activate: 'homev', close: ['chat#1', 'workspace', 'outline'] })
    expect(onePageLanding(home, [leaves[0]], 'homev', sides)).toEqual({ activate: null, close: ['workspace', 'outline'] })
    expect(onePageLanding(home, [leaves[1]], 'chat#1', sides)).toEqual({ activate: null, close: [] })
    expect(onePageLanding({ pinned: home.pinned }, leaves, 'homev', sides)).toEqual({ activate: null, close: [] })
  })

  it('真的单列 store:启动时套上了别的 Space 的布局(主区是它的会话、左栏是它的列表)→ 落完只剩那一页,两边抽屉是空的', () => {
    registerView({ type: 'homev', kind: 'page', displayName: 'Home', factory: () => null, singleton: true })
    registerView({ type: 'otherv', kind: 'page', displayName: 'Other', factory: () => null })
    registerView({ type: 'listv', kind: 'collection', displayName: 'List', factory: () => null })
    try {
      const ws = useSingle.getState()
      ws.resetLayout(); ws.setPinned(undefined)
      ws.openView('otherv', {}, 'main')
      ws.openView('listv', {}, 'left')
      ws.openView('listv', {}, 'right')
      ws.setPinned(home.pinned)
      ws.ensurePinned()
      const got = useSingle.getState()
      expect([got.leftLeaves.length, got.rightLeaves.length]).toEqual([1, 1]) // 带进来的侧栏还在:这就是「主页里是别人的列表」
      const { activate, close } = onePageLanding(home, got.mainLeaves, got.activeMainId, [...got.leftLeaves, ...got.rightLeaves])
      if (activate) ws.activateLeaf(activate)
      for (const id of close) ws.closeLeaf(id, true)
      const after = useSingle.getState()
      expect(after.mainLeaves.map((r) => r.type)).toEqual(['homev'])
      expect([after.leftLeaves.length, after.rightLeaves.length]).toEqual([0, 0])
    } finally { useSingle.getState().setPinned(undefined); useSingle.getState().resetLayout(); unregisterView('homev'); unregisterView('otherv'); unregisterView('listv') }
  })

  it('真的单列 store:布局里压根没有那一页(整份是别的视图)→ 先补回来才有得落', () => {
    registerView({ type: 'homev', kind: 'page', displayName: 'Home', factory: () => null, singleton: true })
    registerView({ type: 'otherv', kind: 'page', displayName: 'Other', factory: () => null })
    try {
      const ws = useSingle.getState()
      ws.resetLayout()
      ws.setPinned(undefined)
      ws.openView('otherv', {}, 'main')
      ws.setPinned(home.pinned)
      expect(onePageLanding(home, useSingle.getState().mainLeaves, useSingle.getState().activeMainId)).toEqual({ activate: null, close: [] })
      ws.ensurePinned()
      const now = useSingle.getState()
      expect(now.mainLeaves.find((r) => r.id === now.activeMainId)?.type).toBe('otherv') // 补回来了,但在后台
      const homeId = now.mainLeaves.find((r) => r.type === 'homev')!.id
      expect(onePageLanding(home, now.mainLeaves, now.activeMainId)).toEqual({ activate: homeId, close: [now.activeMainId] })
    } finally { useSingle.getState().setPinned(undefined); useSingle.getState().resetLayout(); unregisterView('homev'); unregisterView('otherv') }
  })

  it('真的单列 store:被带过来开(钩子说换了 Space)时,现成的那个钉着别的会话 → 换成要开的这条;跟随档的、没换 Space 的照旧', async () => {
    const { setBeforeMainOpenHook } = await import('./singleColumnStore')
    registerView({ type: 'chatv', kind: 'entity', idParam: 'sessionId', displayName: 'Chat', factory: () => null, singleton: true })
    const shown = (): Record<string, unknown> => useSingle.getState().mainLeaves.find((r) => r.type === 'chatv')!.params
    const want = { sessionId: 'B', followActive: false }
    try {
      const ws = useSingle.getState()
      ws.resetLayout(); ws.setPinned(undefined)
      ws.openView('chatv', { sessionId: 'A', followActive: false }, 'main')
      // 没换 Space:只切过去、不动它。这是单列壳一直以来的行为(聊天是单例,手机上「在新标签页打开」开不出第二个聊天),
      // 不是这次要的效果,也不在这次的范围里 —— 这里只钉「转开这条规则没有波及它」。
      ws.openView('chatv', want, 'main', { newTab: true })
      expect(shown()).toEqual({ sessionId: 'A', followActive: false })
      setBeforeMainOpenHook(() => true)
      ws.openView('chatv', want, 'main', { newTab: true })
      expect(shown()).toEqual(want)
      expect(useSingle.getState().mainLeaves.filter((r) => r.type === 'chatv')).toHaveLength(1)
      // 跟随档:它随「当前会话」显示要开的那条,不该被钉死
      ws.navigateLeaf(useSingle.getState().activeMainId!, 'chatv', { followActive: true, reuseKey: 'primary' })
      ws.openView('chatv', want, 'main', { newTab: true })
      expect(shown()).toEqual({ followActive: true, reuseKey: 'primary' })
    } finally { setBeforeMainOpenHook(null); useSingle.getState().resetLayout(); unregisterView('chatv') }
  })

  it('真的单列 store:标签关掉,它的导航历史一并销毁(leaf id 会被下一个同类标签复用)', async () => {
    const { useNav } = await import('./navStore')
    registerView({ type: 'homev', kind: 'page', displayName: 'Home', factory: () => null, singleton: true })
    registerView({ type: 'otherv', kind: 'page', displayName: 'Other', factory: () => null })
    try {
      const ws = useSingle.getState()
      ws.resetLayout(); ws.setPinned(home.pinned)
      ws.openView('homev', {}, 'main')
      ws.openView('otherv', {}, 'main')
      const id = useSingle.getState().activeMainId!
      useNav.getState().record(id, { key: 'k1' } as never)
      expect(id in useNav.getState().stacks).toBe(true)
      ws.closeLeaf(id, true)
      expect(id in useNav.getState().stacks).toBe(false)
    } finally { useSingle.getState().setPinned(undefined); useSingle.getState().resetLayout(); unregisterView('homev'); unregisterView('otherv') }
  })

  it('真的 Space 表:带过去开的那一下,订阅 activeSpaceId 的人读得到带的是什么视图;切完即清;自己那一页不带', async () => {
    const { redirectOpenFromOnePage, openRedirectType, registerSpace, unregisterSpace } = await import('./spaceRegistry')
    const side = { left: [], right: [] }
    const seen: Array<string | null> = []
    const prev = useSpaceStore.getState().activeSpaceId
    const realSwitch = useSpaceStore.getState().setActiveSpace
    registerSpace({ id: 't-home', name: 'Home', sidebarDefaults: side, onePage: true, pinned: { main: [{ type: 'homev', params: {} }] }, build() {} })
    registerSpace({ id: 't-chat', name: 'Chat', sidebarDefaults: side, pinned: { main: [{ type: 'chatv', params: {} }] }, build() {} })
    // 这里只看判定与标记,不摆真布局(那半由模拟器台架看):切 Space 换成只改活动 id
    useSpaceStore.setState({ activeSpaceId: 't-home', setActiveSpace: (id: string) => useSpaceStore.setState({ activeSpaceId: id }) })
    const off = useSpaceStore.subscribe((st, p) => { if (st.activeSpaceId !== p.activeSpaceId) seen.push(openRedirectType()) })
    try {
      expect(redirectOpenFromOnePage('homev')).toBe(false)
      expect(useSpaceStore.getState().activeSpaceId).toBe('t-home')
      expect(redirectOpenFromOnePage('chatv')).toBe(true)
      expect(useSpaceStore.getState().activeSpaceId).toBe('t-chat')
      expect(seen).toEqual(['chatv'])
      expect(openRedirectType()).toBeNull()
      redirectOpenFromOnePage('homev') // 已经不在一页式 Space 里:不带
      expect(useSpaceStore.getState().activeSpaceId).toBe('t-chat')
    } finally {
      off()
      useSpaceStore.setState({ activeSpaceId: prev, setActiveSpace: realSwitch })
      unregisterSpace('t-home'); unregisterSpace('t-chat')
    }
  })
})

describe('默认主页(mainPage):进 Space 先看到它', () => {
  const page = { type: 'chatv', params: { followActive: true } }
  const tab = (id: string, type: string, front = false) => ({ id, type, front })

  it('判定:开着 → 顶到前台(已在前台不动);没开 → 开出来,只剩空态占位时就地换;没声明什么都不做', () => {
    expect(mainPageLanding({ mainPage: page }, [tab('chatv', 'chatv'), tab('filev#1', 'filev', true)])).toEqual({ activate: 'chatv', open: null })
    expect(mainPageLanding({ mainPage: page }, [tab('chatv', 'chatv', true), tab('filev#1', 'filev')])).toEqual({ activate: null, open: null })
    expect(mainPageLanding({ mainPage: page }, [tab('filev#1', 'filev', true)])).toEqual({ activate: null, open: { ...page, newTab: true } })
    expect(mainPageLanding({ mainPage: page }, [tab('home', 'home', true)])).toEqual({ activate: null, open: { ...page, newTab: false } })
    expect(mainPageLanding({}, [tab('filev#1', 'filev', true)])).toEqual({ activate: null, open: null })
    expect(mainPageLanding(undefined, [])).toEqual({ activate: null, open: null })
  })

  it('真的桌面 store:主页里多开了一个标签在前台 → 落点后前台是默认主页,那个标签还在;关掉了也会开回来', () => {
    const m = mkApi()
    const ws = useWorkspace.getState()
    ws.setApi(m.api)
    useWorkspace.setState({ stash: { left: [], right: [], bottom: [] }, stashActive: { left: null, right: null, bottom: null }, sidebarDefaults: { left: [], right: [], bottom: [] } })
    ws.setPinned({})
    const prev = useSpaceStore.getState()
    useSpaceStore.setState({ spaces: [{ id: 'mp', name: 'MP', build() {}, sidebarDefaults: { left: [], right: [] }, mainPage: page }], activeSpaceId: 'mp' })
    try {
      landOnMainPage() // 还没摆上布局(主区一个标签都没有):不先开 —— 单列壳随后的冷启动还原见主区非空会跳过存档(Codex 评审 High)
      expect(at(m.panels, 'main')).toEqual([])
      ws.openView('chatv', page.params, 'main')
      ws.openView('filev', { path: '/a.md' }, 'main', { newTab: true })
      expect((m.api.activePanel?.params as { __type?: string }).__type).toBe('filev')
      landOnMainPage()
      expect((m.api.activePanel?.params as { __type?: string }).__type).toBe('chatv')
      expect(at(m.panels, 'main')).toEqual(['chatv', 'filev'])
      landOnMainPage() // 幂等:已在前台不再动(手机一次切换会跑两遍)
      expect(at(m.panels, 'main')).toEqual(['chatv', 'filev'])

      ws.closeLeaf(idOf(m.panels, 'main', 'chatv'))
      landOnMainPage()
      expect(at(m.panels, 'main').sort()).toEqual(['chatv', 'filev'])
      expect((m.api.activePanel?.params as { __type?: string }).__type).toBe('chatv')
    } finally { useSpaceStore.setState({ spaces: prev.spaces, activeSpaceId: prev.activeSpaceId }) }
  })
})
