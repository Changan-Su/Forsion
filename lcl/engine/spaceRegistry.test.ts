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
  useWorkspace.setState({ sideProfileKey: null }) // 真 setSideProfile 会留下上一条用例切到的 Space
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

  // 屏上的布局不一定是内存里活动 Space 的:「上次退出」档下,异步就位的用户 Space 的现场在启动时就还原出来了,
  // 那一两秒里活动 id 还是回落 Space。此时切走,存的是那个 Space 的现场 —— 按活动 id 存就写进了回落 Space 的槽。
  it('switch saves the outgoing layout into the slot of the Space that owns it, not the in-memory active id', () => {
    const calls: string[] = []
    useWorkspace.setState({
      sideProfileKey: 'user-space', // liveLayoutOwner() 的来源(启动还原出来的归属同样经它返回,见 bottomPanel.test)
      saveNamed: (n: string) => { calls.push(n) }, setSidebarDefaults: () => {},
      namedLayouts: () => [] as string[], resetLayout: () => {},
    })
    useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'tangu' })
    useSpaceStore.getState().setActiveSpace('amadeus')
    expect(calls).toEqual([spaceLayoutName('user-space')])
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

  // 启动点名的 Space 还没注册(异步就位的插件 Space)→ 落在回落 Space 上,但盘上的「上次退出在哪」不许被它盖掉:
  // 补定位那一趟没赶上时,盘上就成了「上次退出 = 回落 Space」(10-04 实报,窗口停在 Tangu)。
  it('setActiveSpaceCold(id, false): a startup fallback only changes memory', () => {
    localStorage.setItem('forsion_tangu_active_space', 'plugin-space')
    useSpaceStore.setState({ spaces: [mkSpace('tangu'), mkSpace('amadeus')], activeSpaceId: 'amadeus' })
    setActiveSpaceCold('tangu', false)
    expect(useSpaceStore.getState().activeSpaceId).toBe('tangu')
    expect(localStorage.getItem('forsion_tangu_active_space')).toBe('plugin-space')
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
  /** 新格式:信封自己记着是给哪个 Space 摆的。 */
  const stamped = (tag: string, space: string): LayoutBlob => ({ ...blob(tag), space })

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

  // ── 信封自带归属(2026-10-04)。布局键与「上次退出在哪」是两把键、两次写盘,对不上时认信封。
  // 病史:「上次退出」档下某一程插件 Space 始终没注册上,那一程把回落 Space 的默认布局存进了布局键,活动 id 却仍是
  // 插件 Space → 下一程按活动 id 归档,插件 Space 自己的槽被回落 Space 的布局盖掉,屏上也是它(check:spacefallback A / B)。
  it('归属 = 上次退出的 Space(平常的一程):照旧归档', () => {
    saveLayout(stamped('now', 'tangu'))
    adoptSpaceLayoutCold('tangu', 'tangu')
    expect(tagOf(loadNamedLayout(spaceLayoutName('tangu')))).toBe('now')
    expect(tagOf(loadLayout())).toBe('now')
  })

  it('老存档没记归属:照旧信上次退出的活动 id;布局键原样不动(不在启动时替它补写归属)', () => {
    saveLayout(blob('now'))
    adoptSpaceLayoutCold('probe', 'probe')
    expect(tagOf(loadNamedLayout(spaceLayoutName('probe')))).toBe('now')
    expect(loadLayout()).toEqual(blob('now'))
  })

  it('归属 ≠ 上次退出、目标这一程也还没注册:哪个槽都不写,布局键留给回落 Space 原样还原', () => {
    // 内存里的活动 Space = tangu(回落,见 beforeEach);probe 是异步注册的插件 Space,也可能永远不来
    saveNamedLayout(spaceLayoutName('probe'), blob('probe-own'))
    saveNamedLayout(spaceLayoutName('tangu'), blob('tangu-own'))
    saveLayout(stamped('tangu-fallback', 'tangu'))
    adoptSpaceLayoutCold('probe', 'probe')
    expect(tagOf(loadNamedLayout(spaceLayoutName('probe')))).toBe('probe-own') // 修前:被回落 Space 的布局盖掉
    expect(tagOf(loadNamedLayout(spaceLayoutName('tangu')))).toBe('tangu-own') // 也不拿「默认起步」的那份去盖回落 Space 的存档
    expect(loadLayout()).toMatchObject({ space: 'tangu', dockview: { tag: 'tangu-fallback' } })
  })

  it('归属 ≠ 上次退出、目标这一程同步注册上了:布局键换成目标自己的归档(记成目标的),不归档', () => {
    useSpaceStore.setState({ activeSpaceId: 'probe' }) // setActiveSpaceCold(target) 已先一步定位
    saveNamedLayout(spaceLayoutName('probe'), blob('probe-own')) // 老归档:没记归属
    saveLayout(stamped('tangu-fallback', 'tangu'))
    adoptSpaceLayoutCold('probe', 'probe')
    expect(loadLayout()).toMatchObject({ space: 'probe', dockview: { tag: 'probe-own' } })
    expect(tagOf(loadNamedLayout(spaceLayoutName('probe')))).toBe('probe-own')
    // 回落 Space 的槽还空着:被换下来的那份是仅存的一份,归到它自己名下(没东西可盖)
    expect(tagOf(loadNamedLayout(spaceLayoutName('tangu')))).toBe('tangu-fallback')
  })

  it('归属 ≠ 上次退出 × 固定启动别的 Space:主人已有存档 → 不盖它,照常换成目标的(「没归档」不算「归档失败」)', () => {
    useSpaceStore.setState({ activeSpaceId: 'amadeus' })
    saveNamedLayout(spaceLayoutName('amadeus'), blob('amadeus-old'))
    saveNamedLayout(spaceLayoutName('tangu'), blob('tangu-own'))
    saveLayout(stamped('tangu-fallback', 'tangu'))
    adoptSpaceLayoutCold('probe', 'amadeus')
    expect(loadNamedLayout(spaceLayoutName('probe'))).toBeNull()
    expect(tagOf(loadNamedLayout(spaceLayoutName('tangu')))).toBe('tangu-own')
    expect(tagOf(loadLayout())).toBe('amadeus-old')
  })

  // Codex 评审 2026-10-04:归属对不上的那份也可能是真现场、且是仅存的一份 —— 上一程换 Space 时归档没落盘(配额满),
  // 布局键被保住了,活动 id 却已经写成了目标。这一程不能因为「对不上」就把它清掉。
  it('归属 ≠ 上次退出、主人的槽还空着:先归档;归档写不进去 → 保住布局键不动', () => {
    useSpaceStore.setState({ activeSpaceId: 'tangu' })
    saveLayout(stamped('probe-only-copy', 'probe'))
    const real = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === 'tangu2_named_layouts') throw new Error('QuotaExceededError')
      real(k, v)
    })
    adoptSpaceLayoutCold('tangu', 'tangu')
    vi.restoreAllMocks()
    expect(tagOf(loadLayout())).toBe('probe-only-copy')
    // 配额缓过来的下一程:归到主人名下,再换成目标的(这里目标没有存档 → 清空,onReady 建默认)
    adoptSpaceLayoutCold('tangu', 'tangu')
    expect(tagOf(loadNamedLayout(spaceLayoutName('probe')))).toBe('probe-only-copy')
    expect(loadNamedLayout(spaceLayoutName('tangu'))).toBeNull()
    expect(loadLayout()).toBeNull()
  })

  it('归属 ≠ 上次退出、但就是固定启动的那个 Space:布局键原样留着', () => {
    saveLayout(stamped('tangu-fallback', 'tangu'))
    adoptSpaceLayoutCold('probe', 'tangu')
    expect(tagOf(loadLayout())).toBe('tangu-fallback')
    expect(loadNamedLayout(spaceLayoutName('probe'))).toBeNull()
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
