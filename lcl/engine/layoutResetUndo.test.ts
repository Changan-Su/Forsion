/**
 * 「恢复本 Space 默认布局」的撤销(U-06):跑真 dockviewStore,Dockview 换成最小桩(同 activeMainPanel.test 先例)。
 * 真 Electron 那半(开标签 → 恢复 → 点通知里的撤销 → 标签与分屏复原)在 desktop/scripts/layout-reset.check.cjs。
 * 锁的是:
 *   ① reset 前拍快照 + 经 ribbonActions.notify 给出「撤销」动作;撤销 = 把快照原样 fromJSON 回去,侧栏开合一并还原
 *   ② 快照一次性:撤销过一次再点无效
 *   ③ 换 Space(画像键变了)/ 应用命名布局后快照作废 —— 不把别的 Space 的布局灌进来
 *   ④ 自动重置(进一个没存档的 Space 时 spaceRegistry 调的那种)不给撤销,且作废之前的快照(codex 评审 P1)
 *   ⑤ 撤销连收起侧栏的「当前项」stashActive 一起还原(codex 评审 P2)
 *   ⑥ 重置后用户第一次改了布局结构(新开标签 / 分屏)→ 快照作废、「撤销」提示收回(Codex 第一轮 C-1)
 *   ⑦ 重置后拖了主区分屏的分隔线 → 同样作废;只拖侧栏宽 / 重置自己的沉降不算(Codex 第三轮 H1-3)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DockviewApi } from 'dockview-react'
import { useWorkspace } from './dockviewStore'
import { setRibbonActions, ribbonActions } from './ribbonRegistry'

function mkApi() {
  const loaded: unknown[] = []
  let layout: { tag: string } = { tag: 'user-layout' }
  const api = {
    panels: [] as unknown[],
    groups: [] as Array<{ panels: Array<{ id: string }> }>,
    activePanel: null,
    width: 1200,
    height: 800,
    getPanel: () => undefined,
    /** 序列化网格(layoutMetrics 读它):缺省空 branch;⑦ 里换成「左栏 | 主 1 | 主 2 | 右栏」。 */
    grid: { root: { type: 'branch', data: [] as unknown[] } } as { root: unknown },
    panelsJson: {} as Record<string, unknown>,
    clear() { layout = { tag: 'cleared' } },
    toJSON: () => ({ ...layout, grid: api.grid, panels: api.panelsJson }),
    fromJSON(j: { tag: string }) { loaded.push(j); layout = { tag: j.tag } },
  }
  useWorkspace.getState().setApi(api as unknown as DockviewApi)
  return { api, loaded }
}

afterEach(() => { setRibbonActions({ notify: undefined }) })

describe('resetLayout 的撤销', () => {
  it('① 拍快照 + 通知带「撤销」;撤销后布局与侧栏开合复原', () => {
    const notify = vi.fn()
    setRibbonActions({ notify })
    const { loaded } = mkApi()
    useWorkspace.setState({ leftVisible: false, rightVisible: true, bottomVisible: false, sideProfileKey: 'home' })
    useWorkspace.getState().resetLayout({ undoable: true })
    expect(useWorkspace.getState().leftVisible).toBe(true) // 重置把左栏打开了
    expect(notify).toHaveBeenCalledTimes(1)
    const [text, action] = notify.mock.calls[0] as [string, { label: string; run(): void }]
    expect(text).toBeTruthy()
    expect(action.label).toBeTruthy()
    action.run()
    expect(loaded).toHaveLength(1)
    expect((loaded[0] as { tag: string }).tag).toBe('user-layout')
    expect(useWorkspace.getState().leftVisible).toBe(false) // 快照里左栏是关的(桩没有左栏 panel)
    // ② 一次性
    expect(useWorkspace.getState().undoResetLayout()).toBe(false)
    expect(loaded).toHaveLength(1)
  })

  it('③ 换了 Space(画像键变了)→ 撤销静默作废', () => {
    setRibbonActions({ notify: vi.fn() })
    const { loaded } = mkApi()
    useWorkspace.setState({ sideProfileKey: 'home' })
    useWorkspace.getState().resetLayout({ undoable: true })
    useWorkspace.setState({ sideProfileKey: 'calendar' })
    expect(useWorkspace.getState().undoResetLayout()).toBe(false)
    expect(loaded).toHaveLength(0)
  })

  it('③ 换了 api(窗口重建)→ 撤销作废', () => {
    mkApi()
    useWorkspace.setState({ sideProfileKey: 'home' })
    useWorkspace.getState().resetLayout({ undoable: true })
    const second = mkApi()
    expect(useWorkspace.getState().undoResetLayout()).toBe(false)
    expect(second.loaded).toHaveLength(0)
  })

  it('④ 自动重置(不带 undoable)不弹撤销,还作废手动重置留下的快照', () => {
    const notify = vi.fn()
    setRibbonActions({ notify })
    const { loaded } = mkApi()
    useWorkspace.setState({ sideProfileKey: 'home' })
    useWorkspace.getState().resetLayout({ undoable: true })
    expect(notify).toHaveBeenCalledTimes(1)
    useWorkspace.getState().resetLayout() // 如切进一个没存档的 Space:此刻 Dockview 里还是上一个 Space 的布局
    expect(notify).toHaveBeenCalledTimes(1)
    expect(useWorkspace.getState().undoResetLayout()).toBe(false)
    expect(loaded).toHaveLength(0)
  })

  it('⑤ 撤销还原收起侧栏的当前项(stashActive)', () => {
    setRibbonActions({ notify: vi.fn() })
    mkApi()
    useWorkspace.setState({ sideProfileKey: 'home', stashActive: { left: null, right: 'outline#2', bottom: null } })
    useWorkspace.getState().resetLayout({ undoable: true })
    expect(useWorkspace.getState().stashActive.right).toBeNull()
    expect(useWorkspace.getState().undoResetLayout()).toBe(true)
    expect(useWorkspace.getState().stashActive.right).toBe('outline#2')
  })

  it('⑥ 重置后新开了标签:布局回调到来即作废快照并收回提示;撤销不再把旧布局灌回', () => {
    const dismiss = vi.fn()
    setRibbonActions({ notify: vi.fn(() => dismiss) })
    const { api, loaded } = mkApi()
    useWorkspace.setState({ sideProfileKey: 'home' })
    useWorkspace.getState().resetLayout({ undoable: true })
    // 重置本身引起的那批(异步到达的)布局回调:结构没变 → 撤销仍有效
    useWorkspace.getState().noteLayoutChange()
    expect(dismiss).not.toHaveBeenCalled()
    // 用户新开一个标签
    api.groups.push({ panels: [{ id: 'note#new' }] })
    useWorkspace.getState().noteLayoutChange()
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(useWorkspace.getState().undoResetLayout()).toBe(false)
    expect(loaded).toHaveLength(0)
  })

  it('⑥ 布局回调还没到就点了撤销:按结构指纹同样拒绝', () => {
    setRibbonActions({ notify: vi.fn() })
    const { api, loaded } = mkApi()
    useWorkspace.setState({ sideProfileKey: 'home' })
    useWorkspace.getState().resetLayout({ undoable: true })
    api.groups.push({ panels: [{ id: 'chat#2' }] })
    expect(useWorkspace.getState().undoResetLayout()).toBe(false)
    expect(loaded).toHaveLength(0)
  })

  describe('⑦ 尺寸 / 排列指纹', () => {
    /** 左栏 | 主 1 | 主 2 | 右栏(侧栏按绝对方向加在根 branch 上,主区分屏是它们的兄弟)。 */
    const split = (api: ReturnType<typeof mkApi>['api'], sizes: [number, number, number, number]) => {
      const leaf = (id: string, size: number) => ({ type: 'leaf', data: { views: [id], id: `g-${id}` }, size })
      api.grid = { root: { type: 'branch', data: [leaf('outline#1', sizes[0]), leaf('note#1', sizes[1]), leaf('note#2', sizes[2]), leaf('chat#1', sizes[3])] } }
      api.panelsJson = {
        'outline#1': { params: { __loc: 'left' } }, 'note#1': { params: { __loc: 'main' } },
        'note#2': { params: { __loc: 'main' } }, 'chat#1': { params: { __loc: 'right' } },
      }
    }
    const settle = () => vi.advanceTimersByTime(1000) // 过了重置自己的沉降窗口
    afterEach(() => { vi.useRealTimers() })

    it('拖主区分屏的分隔线 → 布局回调到来即作废快照、收回提示', () => {
      vi.useFakeTimers()
      const dismiss = vi.fn()
      setRibbonActions({ notify: vi.fn(() => dismiss) })
      const { api, loaded } = mkApi()
      split(api, [240, 480, 480, 240])
      useWorkspace.setState({ sideProfileKey: 'home' })
      useWorkspace.getState().resetLayout({ undoable: true })
      settle()
      split(api, [240, 600, 360, 240]) // 用户把主 1 | 主 2 的分隔线往右拖了 120px
      useWorkspace.getState().noteLayoutChange()
      expect(dismiss).toHaveBeenCalledTimes(1)
      expect(useWorkspace.getState().undoResetLayout()).toBe(false)
      expect(loaded).toHaveLength(0)
    })

    it('回调还没到就点撤销:按尺寸指纹同样拒绝', () => {
      vi.useFakeTimers()
      setRibbonActions({ notify: vi.fn() })
      const { api, loaded } = mkApi()
      split(api, [240, 480, 480, 240])
      useWorkspace.setState({ sideProfileKey: 'home' })
      useWorkspace.getState().resetLayout({ undoable: true })
      settle()
      split(api, [240, 360, 600, 240])
      expect(useWorkspace.getState().undoResetLayout()).toBe(false)
      expect(loaded).toHaveLength(0)
    })

    it('只拖左 / 右侧栏宽:撤销仍有效', () => {
      vi.useFakeTimers()
      const dismiss = vi.fn()
      setRibbonActions({ notify: vi.fn(() => dismiss) })
      const { api, loaded } = mkApi()
      split(api, [240, 480, 480, 240])
      useWorkspace.setState({ sideProfileKey: 'home' })
      useWorkspace.getState().resetLayout({ undoable: true })
      settle()
      split(api, [320, 400, 480, 240]) // 左栏拖宽 80:主 1 相应变窄,主 1 | 主 2 那条线不动
      useWorkspace.getState().noteLayoutChange()
      split(api, [320, 400, 380, 340]) // 右栏拖宽 100
      useWorkspace.getState().noteLayoutChange()
      expect(dismiss).not.toHaveBeenCalled()
      expect(useWorkspace.getState().undoResetLayout()).toBe(true)
      expect(loaded).toHaveLength(1)
    })

    it('重置自己的沉降(默认布局建完后尺寸还在变)不误伤撤销', () => {
      vi.useFakeTimers()
      const dismiss = vi.fn()
      setRibbonActions({ notify: vi.fn(() => dismiss) })
      const { api } = mkApi()
      split(api, [0, 0, 0, 0]) // 同步建完那一刻还没 layout
      useWorkspace.setState({ sideProfileKey: 'home' })
      useWorkspace.getState().resetLayout({ undoable: true })
      split(api, [240, 480, 480, 240]) // Dockview 异步 layout 落定
      useWorkspace.getState().noteLayoutChange()
      settle()
      useWorkspace.getState().noteLayoutChange()
      expect(dismiss).not.toHaveBeenCalled()
      expect(useWorkspace.getState().undoResetLayout()).toBe(true)
    })
  })

  it('没注入 notify 时照常重置、不抛', () => {
    expect(ribbonActions.notify).toBeUndefined()
    mkApi()
    expect(() => useWorkspace.getState().resetLayout({ undoable: true })).not.toThrow()
  })
})
