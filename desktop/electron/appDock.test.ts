import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { BrowserWindow, Rectangle } from 'electron'
import { chooseSide, makeRoom, panelRectFor, targetRectFor, startDockFollow, isSizeJump } from './appDock'

const wa: Rectangle = { x: 0, y: 25, width: 1500, height: 900 }

describe('贴边几何', () => {
  it('右边放得下贴右边,放不下但左边放得下贴左边,都不行仍贴右边(makeRoom 腾位)', () => {
    expect(chooseSide({ x: 100, y: 50, width: 800, height: 600 }, 400, wa)).toBe('right')
    expect(chooseSide({ x: 600, y: 50, width: 800, height: 600 }, 400, wa)).toBe('left')
    expect(chooseSide({ x: 0, y: 25, width: 1500, height: 900 }, 400, wa)).toBe('right')
  })

  it('makeRoom:先往左挪,挪到头再缩窄;放得下就不动', () => {
    expect(makeRoom({ x: 100, y: 50, width: 800, height: 600 }, 400, wa)).toBeNull()
    expect(makeRoom({ x: 400, y: 50, width: 900, height: 600 }, 400, wa)).toEqual({ x: 200, y: 50, width: 900, height: 600 })
    expect(makeRoom({ x: 0, y: 25, width: 1500, height: 900 }, 400, wa)).toEqual({ x: 0, y: 25, width: 1100, height: 900 })
  })

  it('面板紧贴目标那一侧,上沿与高度跟目标一样', () => {
    const t = { x: 100, y: 50, width: 800, height: 600 }
    expect(panelRectFor(t, 'right', 400)).toEqual({ x: 900, y: 50, width: 400, height: 600 })
    expect(panelRectFor(t, 'left', 400)).toEqual({ x: -300, y: 50, width: 400, height: 600 })
  })

  it('拖面板(尺寸不变)= 目标整体平移,不写尺寸', () => {
    const t = { x: 100, y: 50, width: 800, height: 600 }
    const prev = panelRectFor(t, 'right', 400)
    const r = targetRectFor(prev, { ...prev, x: prev.x + 30, y: prev.y + 10 }, t, 'right')
    expect(r).toEqual({ rect: { x: 130, y: 60, width: 800, height: 600 }, resized: false })
    const prevL = panelRectFor(t, 'left', 400)
    expect(targetRectFor(prevL, { ...prevL, x: prevL.x - 20 }, t, 'left').rect).toEqual({ x: 80, y: 50, width: 800, height: 600 })
  })

  it('拉面板贴着目标的那条缝 → 目标跟着变宽;拉外沿只改面板;拉上下沿两边同步', () => {
    const t = { x: 100, y: 50, width: 800, height: 600 }
    const prev = panelRectFor(t, 'right', 400) // x=900
    // 缝往右拉 50:面板左沿 950、宽 350
    expect(targetRectFor(prev, { x: 950, y: 50, width: 350, height: 600 }, t, 'right').rect).toEqual({ x: 100, y: 50, width: 850, height: 600 })
    // 外沿拉宽:面板左沿不动 → 目标宽度不变
    expect(targetRectFor(prev, { x: 900, y: 50, width: 450, height: 600 }, t, 'right').rect.width).toBe(800)
    // 下沿拉长 100
    const tall = targetRectFor(prev, { x: 900, y: 50, width: 400, height: 700 }, t, 'right')
    expect(tall).toEqual({ rect: { x: 100, y: 50, width: 800, height: 700 }, resized: true })
    // 左侧:缝 = 面板右沿,目标右沿不动
    const prevL = panelRectFor(t, 'left', 400) // x=-300..100
    expect(targetRectFor(prevL, { x: -300, y: 50, width: 450, height: 600 }, t, 'left').rect).toEqual({ x: 150, y: 50, width: 750, height: 600 })
  })
})

class FakeWin extends EventEmitter {
  bounds: Rectangle = { x: 0, y: 0, width: 400, height: 500 }
  visible = true
  shows = 0
  getBounds(): Rectangle { return { ...this.bounds } }
  setBounds(r: Rectangle): void { this.bounds = { ...r }; this.emit('move'); this.emit('resize') }
  isDestroyed(): boolean { return false }
  hide(): void { this.visible = false }
  showInactive(): void { this.visible = true; this.shows++ }
  /** 模拟用户拖 / 拉:直接改 bounds 并发事件(不经 setBounds)。 */
  userMove(r: Rectangle): void { this.bounds = { ...r }; this.emit('move') }
}

function harness(probe: () => Record<string, unknown>) {
  const win = new FakeWin()
  const calls: Array<Record<string, unknown>> = []
  const onGone = vi.fn()
  const request = vi.fn(async (p: Record<string, unknown>) => {
    calls.push(p)
    return p.cmd === 'dockProbe' ? probe() : { ok: true }
  })
  const stop = startDockFollow({
    win: win as unknown as BrowserWindow,
    target: { pid: 42, windowId: 7, app: 'Notes', title: 'n' },
    side: 'right',
    request,
    displayBoundsOf: () => ({ x: 0, y: 0, width: 1500, height: 950 }),
    onGone,
    intervalMs: 5,
  })
  return { win, calls, onGone, stop }
}
const tickN = async (n = 3): Promise<void> => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(6) }

describe('startDockFollow', () => {
  afterEach(() => vi.useRealTimers())

  it('目标在哪面板就贴到哪;目标动了跟着动', async () => {
    vi.useFakeTimers()
    let rect = { x: 100, y: 50, w: 800, h: 600 }
    const h = harness(() => ({ exists: true, onScreen: true, ...rect, frontPid: 1 }))
    await tickN()
    expect(h.win.bounds).toEqual({ x: 900, y: 50, width: 400, height: 600 })
    rect = { x: 200, y: 80, w: 800, h: 500 }
    await tickN()
    expect(h.win.bounds).toEqual({ x: 1000, y: 80, width: 400, height: 500 })
    // 程序化摆位触发的 move/resize 不能被当成用户拖面板 → 不能反推目标
    expect(h.calls.some((c) => c.cmd === 'setWindowFrame')).toBe(false)
    h.stop()
  })

  it('目标最小化 / 去了别的桌面 → 面板藏起;回来再露面;全屏也藏', async () => {
    vi.useFakeTimers()
    let p: Record<string, unknown> = { exists: true, onScreen: true, x: 100, y: 50, w: 800, h: 600, frontPid: 1 }
    const h = harness(() => p)
    await tickN()
    p = { ...p, onScreen: false }
    await tickN()
    expect(h.win.visible).toBe(false)
    p = { ...p, onScreen: true }
    await vi.advanceTimersByTimeAsync(300) // 不在屏上时降到 4Hz 问
    expect(h.win.visible).toBe(true)
    p = { ...p, x: 0, y: 0, w: 1500, h: 950 }
    await tickN()
    expect(h.win.visible).toBe(false)
    h.stop()
  })

  it('目标 App 刚到前台那一下把面板提上来(只在变化那一下,不是每帧)', async () => {
    vi.useFakeTimers()
    let front = 1
    const h = harness(() => ({ exists: true, onScreen: true, x: 100, y: 50, w: 800, h: 600, frontPid: front }))
    await tickN()
    const before = h.win.shows
    front = 42
    await tickN(5)
    expect(h.win.shows).toBe(before + 1)
    h.stop()
  })

  it('用户拖面板 → 目标跟着挪(只挪不写尺寸);拖动期间不把面板拽回去', async () => {
    vi.useFakeTimers()
    const h = harness(() => ({ exists: true, onScreen: true, x: 100, y: 50, w: 800, h: 600, frontPid: 1 }))
    await tickN()
    await vi.advanceTimersByTimeAsync(100) // 越过「刚摆完」的保护窗
    h.win.userMove({ x: 950, y: 70, width: 400, height: 600 })
    await tickN()
    const moves = h.calls.filter((c) => c.cmd === 'setWindowFrame')
    expect(moves.at(-1)).toMatchObject({ pid: 42, windowId: 7, x: 150, y: 70 })
    expect(moves.at(-1)).not.toHaveProperty('width')
    expect(h.win.bounds.x).toBe(950) // 目标(假的)没动,但拖动期间面板不被拽回
    await vi.advanceTimersByTimeAsync(400)
    expect(h.win.bounds.x).toBe(900) // 松手后按目标真实位置收尾
    h.stop()
  })

  it('尺寸跳变(最小化的神灯 / 还原 / 一键贴边)→ 先藏起,目标稳住再贴回;用户拖边的小步变化照常跟', async () => {
    vi.useFakeTimers()
    let rect = { x: 150, y: 150, w: 600, h: 500 }
    const h = harness(() => ({ exists: true, onScreen: true, ...rect, frontPid: 1 }))
    await tickN()
    rect = { x: 152, y: 150, w: 610, h: 504 } // 拖边:小步
    await tickN()
    expect(h.win.visible).toBe(true)
    expect(h.win.bounds.x).toBe(762)
    rect = { x: 320, y: 376, w: 896, h: 501 } // 神灯第一帧
    await tickN(1)
    expect(h.win.visible).toBe(false)
    rect = { x: 900, y: 200, w: 700, h: 600 } // 贴到新位置后稳住
    await tickN(6)
    expect(h.win.visible).toBe(true)
    expect(h.win.bounds).toEqual({ x: 1600, y: 200, width: 400, height: 600 })
    h.stop()
  })

  it('isSizeJump:20% / 120px 门槛', () => {
    const a = { x: 0, y: 0, width: 600, height: 500 }
    expect(isSizeJump(a, { ...a, width: 610 })).toBe(false)
    expect(isSizeJump(a, { ...a, width: 896 })).toBe(true)
    expect(isSizeJump(a, { ...a, height: 53 })).toBe(true)
  })

  it('窗口关了 → onGone(closed) 并停表', async () => {
    vi.useFakeTimers()
    const h = harness(() => ({ exists: false, frontPid: 1 }))
    await tickN()
    expect(h.onGone).toHaveBeenCalledWith('closed')
    const n = h.calls.length
    await tickN()
    expect(h.calls.length).toBe(n)
  })
})
