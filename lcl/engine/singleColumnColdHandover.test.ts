/**
 * 手机 App 的冷启动布局交接(单列存档)。病史(2026-10-12 查清):单列壳只存一份「在用」的布局、不记它是哪个 Space 的,
 * 启动时的交接(adoptSpaceLayoutCold)只搬桌面存档 →
 *  ① 上次退出的 Space(Tangu)的现场从没归档进它自己的槽,启动落在主页后被覆盖:Tangu 每次启动都丢一次上次开着的标签;
 *  ② 「启动时进入」固定成主页以外的 Space,它穿着上次退出那个 Space 的布局(主区标签 + 两侧面板)。
 * 跑的是手机构建里的接线:spaceRegistry 经 workspaceStore 拿到的是单列 store(mobile vite 的 engineSwap)。
 * 只经改动前就有的入口驱动(adoptSpaceLayoutCold / restoreSingleColumnLayout / setActiveSpace…),同一份测试在旧代码上是红的。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SpaceDefinition } from './types'

import { useSpaceStore, setActiveSpaceCold, adoptSpaceLayoutCold, setActiveSpace, getActiveSpace } from './spaceRegistry'
import { useWorkspace, restoreSingleColumnLayout, namedLayoutRestorable } from './singleColumnStore'
import { registerView } from './viewRegistry'

vi.mock('./workspaceStore', async () => await import('./singleColumnStore')) // 手机构建的 engineSwap

const LAYOUT = 'lcl_sc_layout_v1'
const NAMED = 'lcl_sc_named_layouts_v1'
let disk: Map<string, string>

const mkSpace = (id: string, main: string, left: string[] = []): SpaceDefinition => ({
  id, name: id,
  build: () => { useWorkspace.getState().openView(main, {}, 'main') },
  sidebarDefaults: { left: left.map((type) => ({ type, params: {} })), right: [] },
})
const SPACES = [mkSpace('home', 'homev'), mkSpace('tangu', 'chat', ['sessions']), mkSpace('agents', 'agentsv')]

beforeEach(() => {
  disk = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => { disk.set(k, v) },
    removeItem: (k: string) => { disk.delete(k) },
    clear: () => disk.clear(),
  })
  for (const type of ['homev', 'chat', 'agentsv', 'sessions', 'note']) registerView({ type, displayName: type, factory: () => null })
  boot('home', 'home') // 首启:什么都没存
})

/** 一次进程启动:内存清空,盘上的留着。顺序照 installEngine(定位 → 交接 → 画像)+ SingleColumnHost(还原,落空才建默认)。 */
function boot(lastExit: string, target: string, spaces: SpaceDefinition[] = SPACES): void {
  useSpaceStore.setState({ spaces, activeSpaceId: spaces.some((s) => s.id === lastExit) ? lastExit : spaces[0].id, recent: [] })
  useWorkspace.setState({ mainLeaves: [], leftLeaves: [], rightLeaves: [], activeMainId: null, leftActiveId: null, rightActiveId: null, leftVisible: false, rightVisible: false })
  setActiveSpaceCold(target)
  adoptSpaceLayoutCold(lastExit, target)
  const sp = getActiveSpace()!
  useWorkspace.getState().setSidebarDefaults(sp.sidebarDefaults)
  useWorkspace.getState().setSideProfile(sp.id, {}, {})
  useWorkspace.getState().setDefaultBuilder(() => getActiveSpace()?.build())
  if (!restoreSingleColumnLayout()) getActiveSpace()!.build()
}
/** 退出前那一下自动存盘(200ms 节流 / pagehide)。 */
const quit = (): void => useWorkspace.getState().saveCurrent()
const main = (): string[] => useWorkspace.getState().mainLeaves.map((r) => `${r.type}${r.params.sessionId ? `:${r.params.sessionId}` : ''}`)
const left = (): string[] => useWorkspace.getState().leftLeaves.map((r) => r.type)
const slot = (id: string): { space?: string; main: Array<{ type: string; params: Record<string, unknown> }> } | undefined => JSON.parse(disk.get(NAMED) ?? '{}')[`space:${id}`]
const inUse = (): { space?: string; main: Array<{ type: string }> } | null => JSON.parse(disk.get(LAYOUT) ?? 'null')

/** 人在 Tangu 里开着一条钉住的会话、左边会话列表开着,就这么退出了。 */
function leaveInTangu(): void {
  setActiveSpace('tangu')
  useWorkspace.getState().openView('chat', { sessionId: 'left-here', followActive: false }, 'main', { newTab: true })
  useWorkspace.getState().toggleSidebar('left')
  quit()
}

describe('手机 App 冷启动:单列存档的交接', () => {
  it('① 停在 Tangu 退出、启动落在主页:主页是主页自己的;再进 Tangu,上次开着的那条会话还在', () => {
    leaveInTangu()
    boot('tangu', 'home')
    const onHome = { main: main(), left: left() }
    quit() // 主页的自动存盘盖掉在用的那份 —— 旧代码里 Tangu 的现场就丢在这一下
    setActiveSpace('tangu')
    expect({ onHome, tangu: main() }).toEqual({ onHome: { main: ['homev'], left: [] }, tangu: ['chat', 'chat:left-here'] })
  })

  it('② 启动时进入固定成 Agents:它没存过 → 按它的默认建;存过 → 还原它自己的,不穿 Tangu 的布局', () => {
    leaveInTangu()
    boot('tangu', 'agents')
    expect({ main: main(), left: left() }).toEqual({ main: ['agentsv'], left: [] })
    expect(slot('tangu')?.main.map((r) => r.type)).toEqual(['chat', 'chat']) // 归档了,没丢
    // Agents 里开过一篇笔记,切回 Tangu 后退出 → 下次启动 Agents 是它自己那份
    useWorkspace.getState().openView('note', { path: 'a.md' }, 'main', { newTab: true })
    setActiveSpace('tangu')
    quit()
    boot('tangu', 'agents')
    expect(main()).toEqual(['agentsv', 'note'])
    setActiveSpace('tangu')
    expect(main()).toEqual(['chat', 'chat:left-here'])
  })

  it('上次退出的就是启动 Space:只归档,在用的那份原样还原', () => {
    leaveInTangu()
    boot('tangu', 'tangu')
    expect(main()).toEqual(['chat', 'chat:left-here'])
    expect(slot('tangu')?.main.map((r) => r.type)).toEqual(['chat', 'chat'])
  })

  it('存盘记归属:在用的记屏上那个 Space,切走时存进槽的记它自己', () => {
    leaveInTangu()
    expect(inUse()?.space).toBe('tangu')
    setActiveSpace('agents')
    expect(slot('tangu')?.space).toBe('tangu')
  })

  it('老存档(没记归属)照旧信「上次退出在哪」', () => {
    leaveInTangu()
    const old = inUse()!
    delete old.space
    disk.set(LAYOUT, JSON.stringify(old))
    disk.delete(NAMED)
    boot('tangu', 'home')
    expect(slot('tangu')?.main.map((r) => r.type)).toEqual(['chat', 'chat'])
    expect(main()).toEqual(['homev'])
  })

  it('归属对不上、主人的槽里已有存档:不拿在用的这份盖它(插件 Space 没就位那一程,屏上是回落 Space)', () => {
    leaveInTangu()
    setActiveSpace('agents')                 // Tangu 的槽 = 那条会话
    useWorkspace.getState().setSideProfile('tangu', {}, {}) // 让在用的那份记成 Tangu 的、内容却是 Agents 默认(回落那一程的样子)
    quit()
    boot('plugin-space', 'home')             // 盘上的活动 id 是没装上的插件 Space
    expect(slot('tangu')?.main.map((r) => `${r.type}${r.params.sessionId ? `:${r.params.sessionId}` : ''}`)).toEqual(['chat', 'chat:left-here'])
    expect(main()).toEqual(['homev'])
  })

  it('归属对不上、在用的正是此刻活动 Space 自己的:原样留着还原(点名的 Space 还没注册,人先停在回落 Space)', () => {
    leaveInTangu()
    // 上次退出在插件 Space,它没注册 → 活动 id 归一成 Tangu;「上次退出」档下目标就是那个插件 Space,setActiveSpaceCold 认不出不动
    boot('plugin-space', 'plugin-space', [SPACES[1], SPACES[0], SPACES[2]])
    expect(main()).toEqual(['chat', 'chat:left-here'])
  })

  it('异步就位的 Space 的现场在回落 Space 下还原:存盘仍记在它名下,切走时存进它的槽而不是回落 Space 的', () => {
    const plugin = mkSpace('plugin-space', 'note')
    boot('plugin-space', 'plugin-space', [...SPACES, plugin])
    useWorkspace.getState().openView('chat', { sessionId: 'in-plugin', followActive: false }, 'main', { newTab: true })
    quit()
    boot('plugin-space', 'plugin-space') // 这一程它还没注册:活动 id 回落到首个 Space
    expect(useSpaceStore.getState().activeSpaceId).toBe('home')
    expect(main()).toEqual(['note', 'chat:in-plugin'])
    quit()
    expect(inUse()?.space).toBe('plugin-space')
    setActiveSpace('agents')
    expect(slot('plugin-space')?.main.map((r) => r.type)).toEqual(['note', 'chat'])
    expect(slot('home')).toBeUndefined()
  })

  it('归档没写进去(配额满):在用的那份一个字节都不动 —— 槽里那份旧的读回来也不算数', () => {
    leaveInTangu()
    setActiveSpace('agents'); setActiveSpace('tangu') // Tangu 的槽里有一份
    useWorkspace.getState().openView('note', { path: 'b.md' }, 'main', { newTab: true }) // 之后又开了一个
    quit()
    const before = disk.get(LAYOUT)
    const set = localStorage.setItem
    vi.stubGlobal('localStorage', { ...localStorage, setItem: (k: string, v: string) => { if (k === NAMED) throw new Error('QuotaExceededError'); set(k, v) } })
    adoptSpaceLayoutCold('tangu', 'home')
    expect(disk.get(LAYOUT)).toBe(before)
    expect(JSON.parse(before!).main.map((r: { type: string }) => r.type)).toEqual(['chat', 'chat', 'note'])
  })

  it('补定位用的 namedLayoutRestorable:槽不存在 / 引用了没注册的视图 → false;都在 → true', () => {
    leaveInTangu()
    setActiveSpace('agents')
    expect(namedLayoutRestorable('space:none')).toBe(false)
    expect(namedLayoutRestorable('space:tangu')).toBe(true)
    const all = JSON.parse(disk.get(NAMED)!)
    all['space:late'] = { ...all['space:tangu'], main: [...all['space:tangu'].main, { id: 'x#1', type: 'not-yet', loc: 'main', params: {}, title: '' }] }
    disk.set(NAMED, JSON.stringify(all))
    expect(namedLayoutRestorable('space:late')).toBe(false)
  })
})
