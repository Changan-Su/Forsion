import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DockviewApi } from 'dockview'
import { useSpaceStore, spaceLayoutName } from './spaceRegistry'
import { useWorkspace } from './workspaceStore'
import { tryRestoreLayout } from './dockviewStore'
import type { SpaceDefinition } from './types'

// 单开一个文件:「启动还原落空」记在 dockviewStore 的模块状态里,只进不退,和 spaceRegistry.test.ts 放一起会串到别的用例。
const mkSpace = (id: string): SpaceDefinition => ({ id, name: id, build: vi.fn(), sidebarDefaults: { left: [], right: [] } })

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

/** 纯插件产品(Unit)的启动:Space 全靠插件异步就位,Dockview 就绪时一个视图都没注册 → 还原落空,屏上是空布局;
 *  此前也没人设过 Space 画像。接着宿主切到产品默认 Space。 */
describe('启动还原落空的空布局不归档', () => {
  it('还没有任何 Space 画像:切 Space 不把屏上的空布局存进上次那个 Space 的槽', () => {
    const saved: string[] = []
    useWorkspace.setState({
      sideProfileKey: null,
      saveNamed: (n: string) => { saved.push(n) },
      setSidebarDefaults: () => {}, setSideProfile: () => {}, setPinned: () => {},
      namedLayouts: () => [] as string[], resetLayout: () => {},
    })
    expect(tryRestoreLayout({} as DockviewApi)).toBe(false) // 布局键是空的 → 落空(不碰 api)
    useSpaceStore.setState({ spaces: [mkSpace('server-admin'), mkSpace('server-models')], activeSpaceId: 'server-models', recent: [] })

    useSpaceStore.getState().setActiveSpace('server-admin')

    expect(useSpaceStore.getState().activeSpaceId).toBe('server-admin')
    expect(saved).toEqual([])
  })

  it('对照:已经有 Space 画像(屏上是它的默认布局)→ 照常存进它的槽', () => {
    const saved: string[] = []
    useWorkspace.setState({
      sideProfileKey: 'server-admin',
      saveNamed: (n: string) => { saved.push(n) },
      setSidebarDefaults: () => {}, setSideProfile: () => {}, setPinned: () => {},
      namedLayouts: () => [] as string[], resetLayout: () => {},
    })
    expect(tryRestoreLayout({} as DockviewApi)).toBe(false)
    useSpaceStore.setState({ spaces: [mkSpace('server-admin'), mkSpace('server-models')], activeSpaceId: 'server-admin', recent: [] })

    useSpaceStore.getState().setActiveSpace('server-models')

    expect(saved).toEqual([spaceLayoutName('server-admin')])
  })
})
