/** Space 窗口(`?window=detached&space=<id>`:整个 Space 开在自己的 OS 窗口里)在引擎这一层的三条规矩:
 *  锁在自己的 Space;不写主窗那几把共用键;第一次打开照这个 Space 存着的布局摆。
 *  窗口归属是模块装载时从 location 读一次定格的 → 每条用例先摆好 location 再重新装载模块。 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SpaceDefinition } from './types'
import type { LayoutBlob } from './layoutPersist'

const mkSpace = (id: string): SpaceDefinition => ({ id, name: id, build: vi.fn(), sidebarDefaults: { left: [], right: [] } })
const blob = (tag: string): LayoutBlob => ({
  version: 4, dockview: { tag },
  sidebars: { left: { visible: true, stash: [] }, right: { visible: false, stash: [] } },
})

let store: Map<string, string>
async function load(search: string) {
  vi.resetModules()
  vi.stubGlobal('location', { search })
  const reg = await import('./spaceRegistry')
  const persist = await import('./layoutPersist')
  const { useWorkspace } = await import('./workspaceStore')
  const calls: string[] = []
  useWorkspace.setState({
    api: null,
    saveNamed: (n: string) => { calls.push(`saveNamed:${n}`) },
    setSidebarDefaults: () => {}, namedLayouts: () => [] as string[],
    applyNamed: () => true, resetLayout: () => { calls.push('resetLayout') }, saveCurrent: () => {},
  })
  return { ...reg, ...persist, calls }
}

beforeEach(() => {
  store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

describe('Space 窗口', () => {
  it('活动 Space 从头就是它自己,不看主窗上次退出在哪', async () => {
    store.set('forsion_tangu_active_space', 'tangu')
    const m = await load('?window=detached&id=sp_amadeus&ui=desktop&space=amadeus')
    expect(m.useSpaceStore.getState().activeSpaceId).toBe('amadeus')
  })

  it('锁在自己的 Space:setActiveSpace 不切、不存布局、不碰共用的活动键与最近使用', async () => {
    store.set('forsion_tangu_active_space', 'tangu')
    const m = await load('?window=detached&id=sp_amadeus&ui=desktop&space=amadeus')
    m.useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')] })
    const before = new Map(store)
    m.useSpaceStore.getState().setActiveSpace('tangu')
    expect(m.useSpaceStore.getState().activeSpaceId).toBe('amadeus')
    expect(m.calls).toEqual([])
    expect([...store]).toEqual([...before])
  })

  it('setActiveSpaceCold 钉内存里的活动 id,但不落盘(活动键是主窗的)', async () => {
    store.set('forsion_tangu_active_space', 'tangu')
    const m = await load('?window=detached&id=sp_probe&ui=desktop&space=probe')
    m.useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('probe')], activeSpaceId: 'tangu' }) // registerSpaces 的归一
    m.setActiveSpaceCold('probe')
    expect(m.useSpaceStore.getState().activeSpaceId).toBe('probe')
    expect(store.get('forsion_tangu_active_space')).toBe('tangu')
  })

  it('第一次打开:本窗的布局键是空的 → 照这个 Space 的命名槽摆,归属记成它', async () => {
    const m = await load('?window=detached&id=sp_amadeus&ui=desktop&space=amadeus')
    m.saveNamedLayout(m.spaceLayoutName('amadeus'), blob('amadeus-saved'))
    const named = store.get(m.NAMED_LAYOUTS_KEY)
    m.seedSpaceWindowLayout()
    expect(m.LAYOUT_KEY).toContain('tangu2_layout_detached_sp_amadeus') // 本窗自己的键,不是主窗那把
    expect((m.loadLayout()?.dockview as { tag: string }).tag).toBe('amadeus-saved')
    expect(m.loadLayout()?.space).toBe('amadeus')
    expect(store.get(m.NAMED_LAYOUTS_KEY)).toBe(named) // 只读共用的槽
  })

  it('再开:本窗已有自己的布局 → 不拿命名槽盖它;槽是空的 → 不动(落空走默认布局)', async () => {
    let m = await load('?window=detached&id=sp_amadeus&ui=desktop&space=amadeus')
    m.seedSpaceWindowLayout()
    expect(m.loadLayout()).toBeNull()
    m.saveLayout(blob('window-own'))
    m.saveNamedLayout(m.spaceLayoutName('amadeus'), blob('main-newer'))
    m = await load('?window=detached&id=sp_amadeus&ui=desktop&space=amadeus')
    m.seedSpaceWindowLayout()
    expect((m.loadLayout()?.dockview as { tag: string }).tag).toBe('window-own')
  })

  it('主窗 / 普通独立窗不受影响:没有 space 参数就不锁、不播种', async () => {
    store.set('forsion_tangu_active_space', 'tangu')
    for (const search of ['', '?window=detached&id=d1&ui=desktop']) {
      const m = await load(search)
      m.useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'tangu' })
      m.saveNamedLayout(m.spaceLayoutName('tangu'), blob('x'))
      m.seedSpaceWindowLayout()
      expect(m.loadLayout()).toBeNull()
      m.useSpaceStore.getState().setActiveSpace('amadeus')
      expect(m.useSpaceStore.getState().activeSpaceId).toBe('amadeus')
    }
  })

  it('只有主窗记「最近使用」:普通独立窗里切 Space 不写那把键', async () => {
    let m = await load('?window=detached&id=d1&ui=desktop')
    m.useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'tangu' })
    m.useSpaceStore.getState().setActiveSpace('amadeus')
    expect(store.has('forsion_tangu_recent_spaces')).toBe(false)
    m = await load('')
    m.useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'tangu' })
    m.useSpaceStore.getState().setActiveSpace('amadeus')
    expect(JSON.parse(store.get('forsion_tangu_recent_spaces')!)).toEqual(['amadeus', 'tangu'])
  })
})
