/**
 * 「恢复本 Space 默认布局」的撤销(U-06):跑真 dockviewStore,Dockview 换成最小桩(同 activeMainPanel.test 先例)。
 * 真 Electron 那半(开标签 → 恢复 → 点通知里的撤销 → 标签与分屏复原)在 desktop/scripts/layout-reset.check.cjs。
 * 锁的是:
 *   ① reset 前拍快照 + 经 ribbonActions.notify 给出「撤销」动作;撤销 = 把快照原样 fromJSON 回去,侧栏开合一并还原
 *   ② 快照一次性:撤销过一次再点无效
 *   ③ 换 Space(画像键变了)/ 应用命名布局后快照作废 —— 不把别的 Space 的布局灌进来
 *   ④ 自动重置(进一个没存档的 Space 时 spaceRegistry 调的那种)不给撤销,且作废之前的快照(codex 评审 P1)
 *   ⑤ 撤销连收起侧栏的「当前项」stashActive 一起还原(codex 评审 P2)
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
    groups: [] as unknown[],
    activePanel: null,
    width: 1200,
    height: 800,
    getPanel: () => undefined,
    clear() { layout = { tag: 'cleared' } },
    toJSON: () => ({ ...layout, grid: { root: { type: 'branch', data: [] } }, panels: {} }),
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

  it('没注入 notify 时照常重置、不抛', () => {
    expect(ribbonActions.notify).toBeUndefined()
    mkApi()
    expect(() => useWorkspace.getState().resetLayout({ undoable: true })).not.toThrow()
  })
})
