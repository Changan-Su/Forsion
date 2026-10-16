/**
 * 手机 App 冷启动里「壳挂上之前」的那一段(Codex 评审 2026-10-16 抓的 High)。异步 Space 的补定位(settleAsyncStartupSpace)
 * 和桌面快捷方式(spaceShortcuts 的 setActiveSpace)都可能抢在 SingleColumnHost 的挂载 effect 之前跑:
 *  · 它们若先把布局摆上了,壳不再还原 —— 以前也就不打开自动存盘,那一程的改动一个都不落盘;
 *  · 还没摆的时候拿画像键判归属,会把「在用的正是它的现场」误判成对不上;切走时存进槽的是一份空快照。
 * 自动存盘的发令枪是模块状态,每条用例重新装载模块(从「刚启动、壳还没挂」开始)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SpaceDefinition } from './types'

const LAYOUT = 'lcl_sc_layout_v1'
const NAMED = 'lcl_sc_named_layouts_v1'
let disk: Map<string, string>
const leaf = (type: string, extra: Record<string, unknown> = {}) => ({ id: `${type}#${Object.keys(extra).length + 1}`, type, loc: 'main', params: extra, title: type })
const blob = (space: string | undefined, main: Array<ReturnType<typeof leaf>>) => ({ v: 1, ...(space ? { space } : {}), main, left: [], right: [], activeMainId: main[main.length - 1].id, leftActiveId: null, rightActiveId: null })

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  disk = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => { disk.set(k, v) },
    removeItem: (k: string) => { disk.delete(k) },
    clear: () => disk.clear(),
  })
})
afterEach(() => { vi.useRealTimers() })

/** 进程刚起来:模块新装,Space 注册好(`spaces`),启动策略跑完(定位 → 交接 → 画像),壳还没挂。 */
async function launch(lastExit: string, target: string, spaces: string[]) {
  // 手机构建的 engineSwap。doMock 每次重登记:顶层 vi.mock 的工厂结果跨 resetModules 留着,spaceRegistry 会拿到上一条用例的 store
  vi.doMock('./workspaceStore', async () => await import('./singleColumnStore'))
  const reg = await import('./spaceRegistry')
  const sc = await import('./singleColumnStore')
  const { registerView } = await import('./viewRegistry')
  for (const type of ['homev', 'chat', 'agentsv', 'note']) registerView({ type, displayName: type, factory: () => null })
  const mains: Record<string, string> = { home: 'homev', tangu: 'chat', agents: 'agentsv', u: 'note' }
  const def = (id: string): SpaceDefinition => ({ id, name: id, build: () => { sc.useWorkspace.getState().openView(mains[id], {}, 'main') }, sidebarDefaults: { left: [], right: [] } })
  reg.useSpaceStore.setState({ spaces: spaces.map(def), activeSpaceId: spaces.includes(lastExit) ? lastExit : spaces[0], recent: [] })
  reg.setActiveSpaceCold(target)
  reg.adoptSpaceLayoutCold(lastExit, target)
  sc.useWorkspace.getState().setSideProfile(reg.getActiveSpace()!.id, {}, {})
  /** SingleColumnHost 的挂载 effect。 */
  const mount = (): void => {
    sc.useWorkspace.getState().setDefaultBuilder(() => reg.getActiveSpace()?.build())
    if (!sc.restoreSingleColumnLayout()) reg.getActiveSpace()!.build()
  }
  const main = (): string[] => sc.useWorkspace.getState().mainLeaves.map((r) => `${r.type}${r.params.sessionId ? `:${r.params.sessionId}` : ''}`)
  return { reg, sc, def, mount, main }
}
const inUse = (): { space?: string; main: Array<{ type: string }> } | null => JSON.parse(disk.get(LAYOUT) ?? 'null')
const slot = (id: string): { main: Array<{ type: string }> } | undefined => JSON.parse(disk.get(NAMED) ?? '{}')[`space:${id}`]

describe('手机冷启动:壳挂上之前', () => {
  it('上次退出在插件 Space U、它在壳挂上之前注册:不误判成对不上,壳照常还原它的现场', async () => {
    disk.set(LAYOUT, JSON.stringify(blob('u', [leaf('note'), leaf('chat', { sessionId: 'x' })])))
    const { reg, sc, def, mount, main } = await launch('u', 'u', ['home', 'tangu']) // 「上次退出」档:U 这一刻还没注册
    reg.registerSpace(def('u'))
    expect(sc.liveLayoutOwner()).toBe('u') // 补定位此刻读到的归属(以前:画像键 = 回落 Space → 对不上 → 另摆一份)
    mount()
    expect(main()).toEqual(['note', 'chat:x'])
  })

  it('补定位在壳挂上之前已经把布局摆上了:壳不拿在用的那份盖它,而且之后的改动照样落盘', async () => {
    disk.set(LAYOUT, JSON.stringify(blob('home', [leaf('homev')])))
    disk.set(NAMED, JSON.stringify({ 'space:u': blob('u', [leaf('note'), leaf('chat', { sessionId: 'x' })]) }))
    const { reg, sc, def, mount, main } = await launch('u', 'u', ['home', 'tangu'])
    reg.registerSpace(def('u'))
    // 补定位走「归属对不上 → 从归档还原」那条路(userSpaces.settleAsyncStartupSpace),壳还没挂
    reg.setActiveSpaceCold('u'); sc.useWorkspace.getState().setSideProfile('u', {}, {})
    expect(sc.useWorkspace.getState().applyNamed('space:u')).toBe(true)
    mount()
    expect(main()).toEqual(['note', 'chat:x'])
    sc.useWorkspace.getState().openView('note', { path: 'later.md' }, 'main', { newTab: true })
    vi.advanceTimersByTime(300)
    expect(inUse()).toMatchObject({ space: 'u', main: [{ type: 'note' }, { type: 'chat' }, { type: 'note' }] })
  })

  it('桌面快捷方式抢在壳挂上之前换了 Space:上一个的现场原样进它的槽(不是一份空快照),新 Space 是它自己的布局', async () => {
    disk.set(LAYOUT, JSON.stringify(blob('tangu', [leaf('chat'), leaf('chat', { sessionId: 'x' })])))
    const { reg, mount, main } = await launch('tangu', 'tangu', ['home', 'tangu', 'agents'])
    disk.delete(NAMED) // 交接时的归档不算:只看这一下切换自己存了什么
    reg.setActiveSpace('agents') // 壳还没挂,没有默认构建器:店里是空的
    expect(slot('tangu')?.main.map((r) => r.type)).toEqual(['chat', 'chat'])
    mount()
    expect(main()).toEqual(['agentsv'])
    vi.advanceTimersByTime(300)
    expect(inUse()).toMatchObject({ space: 'agents', main: [{ type: 'agentsv' }] })
  })
})
