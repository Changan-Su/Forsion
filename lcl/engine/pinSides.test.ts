import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorkspace, captureSideWidths } from './dockviewStore'
import { computeSideWidth } from './sideWidth'
import type { DockviewApi } from 'dockview-react'

/** 最小 dockview api 桩:两侧各一 panel(带 __loc),group.api 有可读写的 width + setSize。 */
function mkApi(width: number) {
  const mk = (loc: 'left' | 'right') => ({
    params: { __loc: loc },
    group: { api: { width: 0, setSize(s: { width: number }) { this.width = s.width } } },
  })
  const panels = [mk('left'), mk('right')]
  return { api: { width, panels } as unknown as DockviewApi, panels }
}
const groupW = (p: { group: { api: { width: number } } }): number => p.group.api.width
const setGroupW = (p: { group: { api: { width: number } } }, w: number): void => { p.group.api.width = w }

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  vi.useFakeTimers() // pinSides 的 setTimeout(60) 手动推进;node 无 requestAnimationFrame → rAF 兜底为同步
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('pinSides / repinSides / captureSideWidths(抽风集成:R1 + R3)', () => {
  it('侧栏宽度记忆缺省两侧全开(resizableSides 变 opt-out)', () => {
    // 2026-08-14 用户实报「手动调宽后一折一开就打回原形」:此前只有声明过 resizableSides 的那侧
    // 记宽,其余被 pinSides 钉回黄金分割。缺省翻成 free 之后,显式 false 才是钉宽档。
    useWorkspace.getState().setSideProfile('sp', {}, {})
    expect(useWorkspace.getState().sideFree).toEqual({ left: true, right: true })
    useWorkspace.getState().setSideProfile('sp', { right: false }, {})
    expect(useWorkspace.getState().sideFree).toEqual({ left: true, right: false })
  })

  it('R3:repinSides 按当前容器宽把 pinned 两侧钉回黄金分割', () => {
    const { api, panels } = mkApi(1600)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {}) // 两侧 free 但**无记忆** → 目标宽 = 黄金分割
    useWorkspace.getState().repinSides()
    // rAF 兜底同步 → apply 已执行
    expect(groupW(panels[0])).toBe(computeSideWidth(1600, 'left', { free: false, saved: null })) // 280(钳 max)
    expect(groupW(panels[1])).toBe(computeSideWidth(1600, 'right', { free: false, saved: null })) // 300(钳 max)
    vi.runAllTimers()
  })

  // 关掉分屏的一半时,Dockview 默认把腾出的宽按比例摊给**所有**组 → 侧栏被拉宽、剩下的主区不变
  // (用户实报)。修法是 close 前把两侧 min=max 钉死,空白只能被主区吃掉,沉降后再放开。
  it('关主区分屏的一半:两侧先被钉死宽度,沉降后释放', () => {
    type Con = { minimumWidth?: number; maximumWidth?: number } | null
    const mkP = (id: string, loc: string) => ({
      id, title: id, params: { __loc: loc },
      api: { close: () => { const i = panels.findIndex((x) => x.id === id); if (i >= 0) panels.splice(i, 1) } },
      group: { api: { width: 0, setSize(s: { width: number }) { this.width = s.width }, constraints: null as Con, setConstraints(c: Con) { this.constraints = c } } },
    })
    const panels: ReturnType<typeof mkP>[] = []
    for (const [id, loc] of [['l', 'left'], ['m1', 'main'], ['m2', 'main'], ['r', 'right']] as const) panels.push(mkP(id, loc))
    const api = { width: 1600, panels, getPanel: (id: string) => panels.find((p) => p.id === id), activePanel: null } as unknown as DockviewApi
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})

    useWorkspace.getState().closeLeaf('m2')
    expect(panels.map((p) => p.id)).toEqual(['l', 'm1', 'r']) // 确实关掉了那一半
    const con = (p: (typeof panels)[number]): NonNullable<Con> => p.group.api.constraints!
    for (const p of [panels[0], panels[2]]) {
      expect(con(p).minimumWidth).toBe(con(p).maximumWidth) // 钉死 = 吃不到空白
      expect(con(p).minimumWidth).toBeGreaterThan(0)
    }
    vi.runAllTimers()
    for (const p of [panels[0], panels[2]]) expect(con(p).minimumWidth).toBe(0) // 沉降后放开,仍可手动拖宽
  })

  // 用户实报:展开右栏时左栏「抽闪一下」——先鼓宽再弹回。Dockview 里新组按默认宽(~50%)诞生、
  // 紧接着被 setSize(1) 压回去,这一进一出的宽都是按比例摊给**所有**组的,对侧先被顶宽,
  // 补间收尾 pinSides 再把它弹回去。修法 = 展开全程把对侧 min=max 钉死,空白只由主区吞吐。
  it('展开一侧:对侧从 openView 前就被钉死,沉降后才释放', () => {
    type Con = { minimumWidth?: number; maximumWidth?: number } | null
    const mkGroup = () => ({ api: { width: 0, setSize(s: { width: number }) { this.width = s.width }, constraints: null as Con, setConstraints(c: Con) { this.constraints = c } } })
    const panels: Array<{ id: string; params: { __loc: string; __type: string }; group: ReturnType<typeof mkGroup>; api: unknown }> = []
    const mkP = (id: string, loc: string, type: string) => ({
      id, params: { __loc: loc, __type: type }, group: mkGroup(),
      api: { close: () => { }, setActive: () => { }, setTitle: () => { }, updateParameters: () => { } },
    })
    panels.push(mkP('l', 'left', 'files'), mkP('m', 'main', 'home')) // 右栏已收起
    const api = {
      width: 1600, panels, getPanel: (id: string) => panels.find((p) => p.id === id), activePanel: null,
      toJSON: () => ({}),
      addPanel: (o: { id: string; params: { __loc: string; __type: string } }) => {
        const p = mkP(o.id, o.params.__loc, o.params.__type)
        panels.push(p)
        return p
      },
    } as unknown as DockviewApi
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', {}, {})

    useWorkspace.getState().toggleSidebar('right')
    expect(panels.some((p) => p.params.__loc === 'right')).toBe(true) // 确实展开了
    const left = panels[0].group.api
    expect(left.constraints!.minimumWidth).toBe(left.constraints!.maximumWidth) // 钉死 = 吃不到空白
    expect(left.constraints!.minimumWidth).toBeGreaterThan(0)

    vi.runAllTimers()
    expect(panels[0].group.api.constraints!.minimumWidth).toBe(0) // 沉降后放开,仍可手动拖宽
  })

  it('R1:pin 窗口内 captureSideWidths 不记宽(过渡态不污染);窗口关闭后真拖宽才记', () => {
    const { api, panels } = mkApi(1600)
    useWorkspace.getState().setApi(api)
    useWorkspace.getState().setSideProfile('sp', { left: true }, {}) // 左 free(2026-08-14 起缺省即 free)
    useWorkspace.getState().repinSides() // pinPending=true(setTimeout 未触发)
    // 模拟 dockview 把左组瞬时铺到 ~50%(800),钉宽尚未最终落地
    setGroupW(panels[0], 800)
    captureSideWidths(api)
    expect(localStorage.getItem('lcl.sideWidth2.sp')).toBeNull() // pin 期:绝不污染(旧代码会记 800)

    vi.runAllTimers() // pin 窗口关闭(pinPending=false)
    setGroupW(panels[0], 460) // 用户真拖到 460
    captureSideWidths(api)
    expect(JSON.parse(localStorage.getItem('lcl.sideWidth2.sp')!).left).toBe(460) // 真拖宽才记
  })
})
