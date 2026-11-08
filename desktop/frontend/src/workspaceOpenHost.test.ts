// @vitest-environment happy-dom
// workspace.open 的壳层接缝(LCL 表面规范第三期):插件 ctx.openView 的打开器转到 workspace.open(还没注册的类型照旧直开);
// 桌面档接到 Mini(window.tangu.openMini)与 Floating Panel(openFloatingPanel,窗口 id = 视图类型 + key,带 pin);
// 手机两样都不接(引擎自己降级)。引擎侧规则在 workspaceOpen.test.ts。
// 负对照(11-08 已实跑红):openDockedView 不判注册、一律走 workspace.open →「还没注册的类型照旧直接 openView」红;
// panel 不带 key 拼 id →「Floating Panel 的窗口 id = 类型 + key」红;mini 不转 pin:false → 桌面那条红。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  getView: vi.fn(),
  openView: vi.fn(),
  workspaceOpen: vi.fn(async () => ({ ok: true })),
  setDesktopOpener: vi.fn(),
}))
vi.mock('@lcl/engine', () => ({
  getView: engine.getView,
  useWorkspace: { getState: () => ({ openView: engine.openView }) },
  workspaceOpen: engine.workspaceOpen,
  setDesktopOpener: engine.setDesktopOpener,
}))

const { openDockedView, installWorkspaceOpenHost, resetWorkspaceOpenHostForTest } = await import('./workspaceOpenHost')
type Opener = import('@lcl/engine').DesktopOpener
const opener = (): Opener => engine.setDesktopOpener.mock.calls.at(-1)![0] as Opener

beforeEach(() => {
  for (const f of Object.values(engine)) f.mockClear()
  resetWorkspaceOpenHostForTest()
  engine.setDesktopOpener.mockClear()
})

describe('openDockedView (ctx.openView 的打开器)', () => {
  it('注册了的视图经 workspace.open 停靠', () => {
    engine.getView.mockReturnValue({ type: 'plugin:p:v' })
    openDockedView('plugin:p:v', 'right', { a: 1 })
    expect(engine.workspaceOpen).toHaveBeenCalledWith({ type: 'plugin:p:v', params: { a: 1 } }, { layer: { dock: 'right' } })
    expect(engine.openView).not.toHaveBeenCalled()
  })
  it('还没注册的类型照旧直接 openView(2.13.7 的行为)', () => {
    engine.getView.mockReturnValue(undefined)
    openDockedView('plugin:p:later', 'main')
    expect(engine.openView).toHaveBeenCalledWith('plugin:p:later', {}, 'main')
    expect(engine.workspaceOpen).not.toHaveBeenCalled()
  })
})

describe('installWorkspaceOpenHost', () => {
  it('桌面:Mini 接 openMini(直开带视图 / 主视图,Space 只带 id 和参数),Floating Panel 的窗口 id = 类型 + key、带 pin', async () => {
    const tangu = { openMini: vi.fn(async () => ({ ok: true, reused: false })), openFloatingPanel: vi.fn() }
    ;(window as unknown as { tangu?: unknown }).tangu = tangu
    installWorkspaceOpenHost()
    const o = opener()
    expect(await o.mini!({ view: { type: 'c' }, mainView: { type: 'm' }, params: { x: 1 }, key: 'k', title: 'T' })).toEqual({ ok: true })
    expect(tangu.openMini).toHaveBeenLastCalledWith({ view: { type: 'c' }, mainView: { type: 'm' }, params: { x: 1 }, key: 'k', title: 'T' })
    await o.mini!({ view: { type: 'mini-todo' }, mainView: { type: 'todo-list' }, spaceId: 'calendar', params: { d: 1 } })
    expect(tangu.openMini).toHaveBeenLastCalledWith({ spaceId: 'calendar', params: { d: 1 }, key: undefined, title: undefined })
    await o.mini!({ view: { type: 'c' }, mainView: { type: 'c' }, pin: false })
    expect(tangu.openMini).toHaveBeenLastCalledWith(expect.objectContaining({ view: { type: 'c' }, pin: false }))
    await o.mini!({ spaceId: 'calendar', view: { type: 'mini-todo' }, mainView: { type: 'todo-list' }, pin: false })
    expect(tangu.openMini).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 'calendar', pin: false }))
    tangu.openMini.mockResolvedValueOnce({ ok: false, reason: 'limit', limit: 6 } as never)
    expect(await o.mini!({ view: { type: 'c' }, mainView: { type: 'c' } })).toEqual({ ok: false, reason: 'limit', limit: 6 })
    o.panel!({ view: { type: 'plugin:p:v' }, title: 'V', pin: true, key: 'a', size: { width: 500 } })
    expect(tangu.openFloatingPanel).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'plugin:p:v#a', title: 'V', view: { type: 'plugin:p:v' }, width: 500, pin: true }))
    o.panel!({ view: { type: 'plugin:p:v' }, title: 'V', pin: false })
    const last = (tangu.openFloatingPanel.mock.calls.at(-1) as unknown[])[0] as Record<string, unknown>
    expect(last.id).toBe('plugin:p:v')
    expect('pin' in last).toBe(false)
  })
  it('手机:两样都不接(引擎降级成抽屉 / 主区);装一次就够', () => {
    ;(window as unknown as { tangu?: unknown }).tangu = { mobile: true }
    installWorkspaceOpenHost()
    installWorkspaceOpenHost()
    expect(engine.setDesktopOpener).toHaveBeenCalledTimes(1)
    expect(opener()).toEqual({})
  })
})
