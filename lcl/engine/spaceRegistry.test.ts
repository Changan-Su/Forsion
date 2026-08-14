import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSpaceStore, getActiveSpace, spaceLayoutName, setActiveSpaceCold, adoptSpaceLayoutCold } from './spaceRegistry'
import { useWorkspace } from './workspaceStore'
import { loadLayout, saveLayout, loadNamedLayout, saveNamedLayout, type LayoutBlob } from './layoutPersist'
import type { SpaceDefinition } from './types'

const mkSpace = (id: string): SpaceDefinition => ({
  id,
  name: id,
  build: vi.fn(),
  sidebarDefaults: { left: [{ type: `${id}-l`, params: {} }], right: [] },
})

/** node 测试环境无 localStorage(registry 用 try/catch 包住);用 Map 桩好让持久化可断言。 */
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  useSpaceStore.setState({ spaces: [], activeSpaceId: 'tangu' })
})

describe('spaceRegistry', () => {
  it('registerSpace upserts by id; re-register replaces (filter+append)', () => {
    const r = useSpaceStore.getState().registerSpace
    r(mkSpace('tangu')); r(mkSpace('amadeus'))
    expect(useSpaceStore.getState().spaces.map((s) => s.id)).toEqual(['tangu', 'amadeus'])
    const again = mkSpace('tangu')
    r(again)
    const spaces = useSpaceStore.getState().spaces
    expect(spaces.map((s) => s.id)).toEqual(['amadeus', 'tangu'])
    expect(spaces.find((s) => s.id === 'tangu')).toBe(again)
  })

  it('getActiveSpace returns active, falls back to first when id missing', () => {
    const a = mkSpace('tangu'), b = mkSpace('amadeus')
    useSpaceStore.setState({ spaces: [a, b], activeSpaceId: 'amadeus' })
    expect(getActiveSpace()).toBe(b)
    useSpaceStore.setState({ activeSpaceId: 'nope' })
    expect(getActiveSpace()).toBe(a)
  })

  it('switch with no saved layout: saveNamed(out) → setSidebarDefaults → resetLayout; persists active id', () => {
    const calls: string[] = []
    useWorkspace.setState({
      saveNamed: (n: string) => { calls.push(`saveNamed:${n}`) },
      setSidebarDefaults: () => { calls.push('setSidebarDefaults') },
      namedLayouts: () => [] as string[],
      applyNamed: () => { calls.push('applyNamed'); return true },
      resetLayout: () => { calls.push('resetLayout') },
      saveCurrent: () => { calls.push('saveCurrent') },
    })
    useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'tangu' })

    useSpaceStore.getState().setActiveSpace('amadeus')

    expect(useSpaceStore.getState().activeSpaceId).toBe('amadeus')
    expect(localStorage.getItem('forsion_tangu_active_space')).toBe('amadeus')
    expect(calls).toEqual([`saveNamed:${spaceLayoutName('tangu')}`, 'setSidebarDefaults', 'resetLayout'])
  })

  it('switch with saved layout: applyNamed(in) → saveCurrent, no resetLayout', () => {
    const calls: string[] = []
    useWorkspace.setState({
      saveNamed: () => { calls.push('saveNamed') },
      setSidebarDefaults: () => { calls.push('setSidebarDefaults') },
      namedLayouts: () => [spaceLayoutName('tangu')],
      applyNamed: () => { calls.push('applyNamed'); return true },
      resetLayout: () => { calls.push('resetLayout') },
      saveCurrent: () => { calls.push('saveCurrent') },
    })
    useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'amadeus' })

    useSpaceStore.getState().setActiveSpace('tangu')
    expect(calls).toContain('applyNamed')
    expect(calls).toContain('saveCurrent')
    expect(calls).not.toContain('resetLayout')
  })

  it('corrupt saved layout (applyNamed→false) falls back to resetLayout, no saveCurrent', () => {
    const calls: string[] = []
    useWorkspace.setState({
      saveNamed: () => {}, setSidebarDefaults: () => {},
      namedLayouts: () => [spaceLayoutName('tangu')],
      applyNamed: () => { calls.push('applyNamed'); return false },
      resetLayout: () => { calls.push('resetLayout') },
      saveCurrent: () => { calls.push('saveCurrent') },
    })
    useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'amadeus' })

    useSpaceStore.getState().setActiveSpace('tangu')
    expect(calls).toEqual(['applyNamed', 'resetLayout'])
  })

  it('switch to same id is a no-op', () => {
    const calls: string[] = []
    useWorkspace.setState({ saveNamed: () => { calls.push('x') } })
    useSpaceStore.setState({ spaces: [mkSpace('tangu')], activeSpaceId: 'tangu' })
    useSpaceStore.getState().setActiveSpace('tangu')
    expect(calls).toEqual([])
  })

  // 冷启动定位(默认 Space 启动设置的地基):只钉 id + 写 ACTIVE_KEY,绝不碰布局
  // —— 布局交给 onReady 的 buildDefault 重建干净默认。若回归成也存/套布局,「干净默认」契约就破了。
  it('setActiveSpaceCold pins active id + persists, without any layout op', () => {
    const calls: string[] = []
    useWorkspace.setState({
      saveNamed: () => { calls.push('saveNamed') },
      applyNamed: () => { calls.push('applyNamed'); return true },
      resetLayout: () => { calls.push('resetLayout') },
      saveCurrent: () => { calls.push('saveCurrent') },
    })
    useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'tangu' })

    setActiveSpaceCold('amadeus')
    expect(useSpaceStore.getState().activeSpaceId).toBe('amadeus')
    expect(localStorage.getItem('forsion_tangu_active_space')).toBe('amadeus')
    expect(calls).toEqual([]) // 无任何布局操作
  })

  it('setActiveSpaceCold ignores an unregistered id (caller falls back)', () => {
    useSpaceStore.setState({ spaces: [mkSpace('tangu')], activeSpaceId: 'tangu' })
    setActiveSpaceCold('ghost')
    expect(useSpaceStore.getState().activeSpaceId).toBe('tangu')
  })
})

// 冷启动的每-Space 布局交接:纯 Storage 搬运,不碰 workspace store(此刻 Dockview api 还没就绪)。
// 病史:原来这里是无条件 clearLayout(),于是「固定启动 Space」= 每次重启都推倒重建,
// 用户实报「进 space 不显示上次打开的文件」。
describe('adoptSpaceLayoutCold', () => {
  const blob = (tag: string): LayoutBlob => ({
    version: 4,
    dockview: { tag },
    sidebars: { left: { visible: true, stash: [] }, right: { visible: false, stash: [] } },
  })
  const tagOf = (b: LayoutBlob | null): string | undefined => (b?.dockview as { tag?: string } | undefined)?.tag

  it('同一个 Space:归档进它自己的命名槽,布局键原样留着(重启后照旧还原)', () => {
    saveLayout(blob('now'))
    adoptSpaceLayoutCold('tangu', 'tangu')
    expect(tagOf(loadLayout())).toBe('now')
    expect(tagOf(loadNamedLayout(spaceLayoutName('tangu')))).toBe('now')
  })

  it('换 Space:先归档上次退出那个,再把目标的命名布局搬进布局键', () => {
    saveNamedLayout(spaceLayoutName('amadeus'), blob('amadeus-old'))
    saveLayout(blob('tangu-now'))
    adoptSpaceLayoutCold('tangu', 'amadeus')
    expect(tagOf(loadNamedLayout(spaceLayoutName('tangu')))).toBe('tangu-now') // 没丢
    expect(tagOf(loadLayout())).toBe('amadeus-old')
  })

  it('目标 Space 没有命名布局:清空布局键 → onReady 落空 → buildDefault 干净默认', () => {
    saveLayout(blob('tangu-now'))
    adoptSpaceLayoutCold('tangu', 'inbox')
    expect(loadLayout()).toBeNull()
    expect(tagOf(loadNamedLayout(spaceLayoutName('tangu')))).toBe('tangu-now')
  })

  it('首启(布局键为空)不写出空归档,也不崩', () => {
    adoptSpaceLayoutCold('tangu', 'tangu')
    expect(loadNamedLayout(spaceLayoutName('tangu'))).toBeNull()
    expect(loadLayout()).toBeNull()
  })

  // Codex 评审 2026-08-13:saveNamedLayout 吞异常且不返回成败。归档没落盘就往下搬/清,等于把
  // 这份布局仅存的一份直接丢掉。
  it('归档写不进去(配额满)→ 保住布局键不动,宁可不换也不丢', () => {
    saveLayout(blob('tangu-now'))
    const real = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === 'tangu2_named_layouts') throw new Error('QuotaExceededError')
      real(k, v)
    })
    adoptSpaceLayoutCold('tangu', 'amadeus')
    vi.restoreAllMocks()
    expect(loadNamedLayout(spaceLayoutName('tangu'))).toBeNull() // 确实没归档成
    expect(tagOf(loadLayout())).toBe('tangu-now')                // 但布局键还在
  })
})
