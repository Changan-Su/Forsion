// @vitest-environment happy-dom
/**
 * 停靠的临时 View(Extend View)被收走时报的原因,以及侧栏占位的退位。跑的是**真的 dockviewStore**,
 * Dockview 换成最小桩(同 pinnedViews / bottomPanel 先例),补上本文件要的 onDidRemovePanel 与 clear。
 *   · 用户关的就是这块面板(关它的标签)→ dismiss;宿主连同位置一起收走(收起那一侧 / 恢复默认布局 /
 *     别的视图的扩展占了这一侧)→ layout。插件靠这个区分「用户不想看它」和「位置没了」。
 *   · 代码往只剩「空侧栏」占位的一侧开真视图 → 占位退位,不留一个多余的标签。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorkspace, presentDockedExtension } from '@lcl/engine/dockviewStore'
import { registerView, unregisterView } from '@lcl/engine/viewRegistry'
import type { DockviewApi } from 'dockview-react'

type G = { id: string; panels: P[]; activePanel?: P; api: Record<string, unknown> }
type P = { id: string; title: string; params: Record<string, unknown>; group: G; api: Record<string, (...a: never[]) => unknown> }

function mkApi() {
  const panels: P[] = []
  const removed = new Set<(p: P) => void>()
  let gid = 0
  const remove = (p: P): void => {
    const i = panels.indexOf(p)
    if (i < 0) return
    panels.splice(i, 1)
    p.group.panels.splice(p.group.panels.indexOf(p), 1)
    if (p.group.activePanel === p) p.group.activePanel = p.group.panels[0]
    for (const fn of [...removed]) fn(p)
  }
  const api = {
    width: 1600, height: 900, panels,
    get activePanel() { return panels[0] ?? null },
    getPanel: (id: string) => panels.find((p) => p.id === id),
    toJSON: () => ({}),
    clear: () => { for (const p of [...panels]) remove(p) },
    onDidRemovePanel: (fn: (p: P) => void) => { removed.add(fn); return { dispose: () => { removed.delete(fn) } } },
    addPanel: (o: { id: string; params: Record<string, unknown>; position?: { referencePanel?: string | P } }) => {
      const ref = typeof o.position?.referencePanel === 'string' ? panels.find((p) => p.id === o.position!.referencePanel) : o.position?.referencePanel
      const group: G = ref ? ref.group : { id: `g${++gid}`, panels: [], api: { width: 300, height: 300, setActive() { }, setSize() { }, setConstraints() { } } }
      const p: P = { id: o.id, title: o.id, params: o.params, group, api: {
        close: () => remove(p),
        setActive: () => { group.activePanel = p },
        setTitle: () => { },
        updateParameters: (np: Record<string, unknown>) => { p.params = { ...p.params, ...np } },
      } as never }
      group.panels.push(p); panels.push(p); group.activePanel = p
      return p
    },
  }
  return { api: api as unknown as DockviewApi, panels }
}

const right = (panels: P[]): string[] => panels.filter((p) => p.params.__loc === 'right').map((p) => p.params.__type as string)
const VIEWS = ['mainv', 'detailv', 'assetv', 'home', 'sidebar-empty']

function build() {
  const m = mkApi()
  const ws = useWorkspace.getState()
  ws.setApi(m.api)
  useWorkspace.setState({ stash: { left: [], right: [], bottom: [] }, stashActive: { left: null, right: null, bottom: null }, sidebarDefaults: { left: [], right: [], bottom: [] } })
  ws.setPinned({})
  ws.openView('mainv', {}, 'main')
  ws.openView('detailv', {}, 'right')
  return m
}
/** 开一份右栏扩展;返回宿主回调(记下每次被叫时带的原因)与它的 panel id。 */
function extend(panels: P[], id = 'props') {
  const dismiss = vi.fn()
  presentDockedExtension({ id, title: id, side: 'right', mount() { } }, dismiss)
  return { dismiss, leaf: panels.filter((p) => p.params.__type === '__extend').at(-1)!.id }
}

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear() })
  vi.stubGlobal('requestAnimationFrame', undefined) // 无 rAF → 补间走同步兜底(同 node 下的先例)
  vi.useFakeTimers()
  for (const type of VIEWS) registerView({ type, displayName: type, factory: () => null, ...(type === 'home' || type === 'sidebar-empty' ? { closable: false } : {}) })
})
afterEach(() => {
  for (const type of VIEWS) unregisterView(type)
  vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('停靠的临时 View:谁收走的', () => {
  it('用户关它的标签 = dismiss(不带原因)', () => {
    const { panels } = build()
    const ext = extend(panels)
    useWorkspace.getState().closeLeaf(ext.leaf)
    vi.runAllTimers()
    expect(ext.dismiss.mock.calls).toEqual([[]])
    expect(right(panels)).toEqual(['detailv'])
  })

  it('收起那一侧 = layout', () => {
    const { panels } = build()
    const ext = extend(panels)
    useWorkspace.getState().toggleSidebar('right')
    vi.runAllTimers()
    expect(ext.dismiss.mock.calls).toEqual([['layout']])
    expect(right(panels)).toEqual([])
  })

  it('恢复默认布局 = layout', () => {
    const { panels } = build()
    const ext = extend(panels)
    useWorkspace.getState().resetLayout()
    vi.runAllTimers()
    expect(ext.dismiss.mock.calls).toEqual([['layout']])
  })

  it('别的视图的扩展占了这一侧 = layout;后来者不受影响', () => {
    const { panels } = build()
    const first = extend(panels, 'a'), second = extend(panels, 'b')
    expect(first.dismiss.mock.calls).toEqual([['layout']])
    expect(second.dismiss).not.toHaveBeenCalled()
    expect(right(panels)).toEqual(['detailv', '__extend'])
  })
})

describe('侧栏占位', () => {
  it('往只剩占位的一侧开真视图 → 占位退位', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    ws.closeLeaf(panels.find((p) => p.params.__type === 'detailv')!.id)
    expect(right(panels)).toEqual(['sidebar-empty']) // 侧栏关空 → 占位
    ws.openView('assetv', {}, 'right')
    expect(right(panels)).toEqual(['assetv'])
  })

  it('旧存档里留在真视图旁边的占位(它关不掉):再要一次那个视图就清掉', () => {
    const { api, panels } = build()
    const ref = panels.find((p) => p.params.__type === 'detailv')!
    api.addPanel({ id: 'sidebar-empty#9', component: 'sidebar-empty', params: { __loc: 'right', __type: 'sidebar-empty' }, position: { referencePanel: ref.id } } as never)
    expect(right(panels)).toEqual(['detailv', 'sidebar-empty'])
    useWorkspace.getState().openView('detailv', {}, 'right')
    expect(right(panels)).toEqual(['detailv'])
  })

  it('空的一侧展开时照旧开出占位(否则开合键空转)', () => {
    const { panels } = build()
    const ws = useWorkspace.getState()
    ws.closeLeaf(panels.find((p) => p.params.__type === 'detailv')!.id)
    ws.toggleSidebar('right'); vi.runAllTimers()
    expect(right(panels)).toEqual([])
    ws.toggleSidebar('right'); vi.runAllTimers()
    expect(right(panels)).toEqual(['sidebar-empty'])
  })
})
