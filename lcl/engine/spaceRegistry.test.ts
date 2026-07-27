import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSpaceStore, getActiveSpace, spaceLayoutName, setActiveSpaceCold } from './spaceRegistry'
import { useWorkspace } from './workspaceStore'
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
