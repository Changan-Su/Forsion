import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} })) // desktopFloat 顶层 import;纯逻辑用不到
import {
  clampPipHeight, createComputerUsePip, createPipAgentRelay, normalizePipTarget, pipInitialBounds, pipResizedBounds,
  PIP_DEFAULT_HEIGHT, PIP_MAX_HEIGHT, PIP_MIN_HEIGHT, PIP_WIDTH, type PipAgentHost, type PipWindowLike,
} from './computerUsePip'

const AREA = { x: 0, y: 25, width: 1440, height: 875 }

function fakeWindow(id: number) {
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  const w = {
    destroyed: false, visible: false, shows: 0, moveTops: 0, closes: 0,
    webContents: { id },
    isDestroyed: () => w.destroyed,
    showInactive: () => { w.visible = true; w.shows++ },
    moveTop: () => { w.moveTops++ },
    getBounds: () => bounds,
    setBounds: (b: typeof bounds) => { bounds = { ...b } },
    destroy: () => { w.destroyed = true; w.onClosed?.() },
    close: () => { w.closes++; w.destroyed = true; w.onClosed?.() },
    onClosed: undefined as undefined | (() => void),
  }
  return w
}

function fixture() {
  vi.useFakeTimers()
  const made: ReturnType<typeof fakeWindow>[] = []
  const onGone = vi.fn()
  const pip = createComputerUsePip({
    primaryWorkArea: () => AREA,
    readyTimeoutMs: 1000,
    create: (bounds, onClosed) => {
      const w = fakeWindow(100 + made.length)
      w.setBounds(bounds)
      w.onClosed = onClosed
      made.push(w)
      return w as unknown as PipWindowLike
    },
    onGone,
  })
  return { pip, made, onGone }
}

describe('Computer Use PiP geometry', () => {
  it('parks 264 wide in the primary work area top-right corner, 24 from the edges', () => {
    const b = pipInitialBounds(AREA)
    expect(b).toEqual({ x: 1440 - 264 - 24, y: 25 + 24, width: PIP_WIDTH, height: PIP_DEFAULT_HEIGHT })
    expect(pipInitialBounds({ x: -1920, y: 0, width: 1920, height: 1080 }).x).toBe(-264 - 24)
  })
  it('follows content height within bounds and keeps the dragged top-left', () => {
    expect(clampPipHeight(213.4)).toBe(213)
    expect(clampPipHeight(5)).toBe(PIP_MIN_HEIGHT)
    expect(clampPipHeight(5000)).toBe(PIP_MAX_HEIGHT)
    expect(clampPipHeight('300')).toBe(PIP_DEFAULT_HEIGHT)
    expect(clampPipHeight(Number.NaN)).toBe(PIP_DEFAULT_HEIGHT)
    expect(pipResizedBounds({ x: 40, y: 60, width: 500, height: 100 }, 250)).toEqual({ x: 40, y: 60, width: PIP_WIDTH, height: 250 })
  })
})

describe('Computer Use PiP controller', () => {
  it('creates hidden, shows only after the renderer reports the view mounted, then open() is true', async () => {
    const { pip, made } = fixture()
    const p = pip.open()
    expect(made).toHaveLength(1)
    expect(made[0].visible).toBe(false)
    expect(pip.isOpen()).toBe(false)
    pip.ready(made[0].webContents.id, true, 230)
    await expect(p).resolves.toBe(true)
    expect(made[0].visible).toBe(true)
    expect(made[0].getBounds().height).toBe(230)
    expect(pip.isOpen()).toBe(true)
    vi.useRealTimers()
  })
  it('is idempotent: a second open() while loading shares the result, and while shown brings it forward in place', async () => {
    const { pip, made } = fixture()
    const a = pip.open(), b = pip.open()
    expect(made).toHaveLength(1)
    pip.ready(made[0].webContents.id, true, 200)
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)
    made[0].setBounds({ x: 10, y: 400, width: PIP_WIDTH, height: 200 }) // 用户拖走了
    await expect(pip.open()).resolves.toBe(true)
    expect(made).toHaveLength(1)
    expect(made[0].getBounds()).toEqual({ x: 10, y: 400, width: PIP_WIDTH, height: 200 })
    expect(made[0].moveTops).toBe(1)
    vi.useRealTimers()
  })
  it('missing or disabled plugin: open() is false and the window is destroyed without ever showing', async () => {
    const { pip, made, onGone } = fixture()
    const refused = pip.open()
    pip.ready(made[0].webContents.id, false)
    await expect(refused).resolves.toBe(false)
    expect(made[0].destroyed).toBe(true)
    expect(made[0].shows).toBe(0)
    expect(onGone).toHaveBeenCalled()

    const silent = pip.open() // 视图一直没注册(插件根本没装)
    await vi.advanceTimersByTimeAsync(1001)
    await expect(silent).resolves.toBe(false)
    expect(made[1].destroyed).toBe(true)
    expect(made[1].shows).toBe(0)
    expect(pip.isOpen()).toBe(false)
    vi.useRealTimers()
  })
  it('ignores ready / resize from any other webContents', async () => {
    const { pip, made } = fixture()
    const p = pip.open()
    pip.ready(999, true, 200)
    expect(made[0].visible).toBe(false)
    expect(pip.owns(999)).toBe(false)
    expect(pip.owns(made[0].webContents.id)).toBe(true)
    pip.ready(made[0].webContents.id, true, 200)
    await p
    pip.resize(999, 400)
    expect(made[0].getBounds().height).toBe(200)
    pip.resize(made[0].webContents.id, 300)
    expect(made[0].getBounds().height).toBe(300)
    vi.useRealTimers()
  })
  it('close and dispose end it; a later open() starts a fresh hidden window (nothing restored or remembered)', async () => {
    const { pip, made, onGone } = fixture()
    const p = pip.open(); pip.ready(made[0].webContents.id, true, 200); await p
    pip.close()
    expect(made[0].closes).toBe(1)
    expect(pip.isOpen()).toBe(false)
    expect(onGone).toHaveBeenCalledTimes(1)
    const q = pip.open()
    expect(made).toHaveLength(2)
    expect(made[1].getBounds()).toEqual(pipInitialBounds(AREA))
    pip.dispose()
    await expect(q).resolves.toBe(false)
    expect(made[1].destroyed).toBe(true)
    vi.useRealTimers()
  })
})

describe('PiP stop / status relay', () => {
  function relayFixture() {
    vi.useFakeTimers()
    const sent: Array<{ host: number; payload: Record<string, unknown> }> = []
    const hosts: PipAgentHost[] = [
      { id: 1, main: true, send: (_c, p) => sent.push({ host: 1, payload: p as Record<string, unknown> }) },
      { id: 2, main: false, send: (_c, p) => sent.push({ host: 2, payload: p as Record<string, unknown> }) },
    ]
    const pushed: Array<{ key: string; status: unknown }> = []
    const relay = createPipAgentRelay({ hosts: () => hosts, toPip: (key, status) => pushed.push({ key, status }), replyTimeoutMs: 500 })
    return { relay, sent, pushed, hosts }
  }
  const idle = { phase: 'idle', sessionId: null, runId: null }
  const busy = (runId: string) => ({ phase: 'tool', sessionId: 's9', runId })

  it('stop by runId asks the main window first, then the others, and returns the first true', async () => {
    const { relay, sent } = relayFixture()
    const p = relay.stop({ runId: 'r1', junk: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0].host).toBe(1)
    expect(sent[0].payload).toMatchObject({ op: 'stop', target: { runId: 'r1' } })
    expect(sent[0].payload.target).not.toHaveProperty('junk')
    relay.reply(2, sent[0].payload.id, true) // 别的窗口不能替主窗回答
    relay.reply(1, sent[0].payload.id, false)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(2)
    expect(sent[1].host).toBe(2)
    relay.reply(2, sent[1].payload.id, true)
    await expect(p).resolves.toBe(true)
    vi.useRealTimers()
  })
  it('stop that nobody confirms is false (timeouts included); session / active-session targets only ask the main window', async () => {
    const { relay, sent } = relayFixture()
    const p = relay.stop({ runId: 'gone' })
    await vi.advanceTimersByTimeAsync(1100)
    await expect(p).resolves.toBe(false)
    expect(sent.map((s) => s.host)).toEqual([1, 2])
    sent.length = 0
    const q = relay.stop(undefined)
    expect(sent.map((s) => s.host)).toEqual([1])
    relay.reply(1, sent[0].payload.id, false)
    await expect(q).resolves.toBe(false)
    vi.useRealTimers()
  })
  it('watch fans out to every host; by-run merges to whichever window is running it; pushes only on change', () => {
    const { relay, sent, pushed } = relayFixture()
    relay.watch('o:r:r1', { runId: 'r1' })
    expect(sent.filter((s) => s.payload.op === 'watch').map((s) => s.host)).toEqual([1, 2])
    relay.status(1, 'o:r:r1', idle)
    relay.status(2, 'o:r:r1', busy('r1'))
    expect(pushed.at(-1)).toEqual({ key: 'o:r:r1', status: busy('r1') })
    const n = pushed.length
    relay.status(1, 'o:r:r1', idle) // 合并结果没变
    expect(pushed).toHaveLength(n)
    relay.status(2, 'o:r:r1', idle) // 这一轮结束
    expect(pushed.at(-1)).toEqual({ key: 'o:r:r1', status: idle })
    relay.status(1, 'unwatched', busy('x'))
    expect(pushed.every((p) => p.key === 'o:r:r1')).toBe(true)
    vi.useRealTimers()
  })
  it('non-run targets read the main window only; a reloaded host gets the watches again; clear() unwatches everywhere', () => {
    const { relay, sent, pushed } = relayFixture()
    relay.watch('active', undefined)
    relay.status(2, 'active', busy('mini-run'))
    expect(pushed).toHaveLength(0)
    relay.status(1, 'active', idle)
    expect(pushed.at(-1)).toEqual({ key: 'active', status: idle })
    sent.length = 0
    relay.hostReady(2)
    expect(sent).toEqual([{ host: 2, payload: { op: 'watch', key: 'active', target: undefined } }])
    sent.length = 0
    relay.clear()
    expect(sent.map((s) => [s.host, s.payload.op])).toEqual([[1, 'unwatch'], [2, 'unwatch']])
    expect(relay.watchCount()).toBe(0)
    vi.useRealTimers()
  })
  it('target shapes are re-built from known fields only', () => {
    expect(normalizePipTarget({ runId: 'r', sessionId: 's', extra: { a: 1 } })).toEqual({ runId: 'r', sessionId: 's' })
    expect(normalizePipTarget({ runId: 42 })).toEqual({ runId: null })
    expect(normalizePipTarget('s1')).toBe('s1')
    expect(normalizePipTarget(null)).toBe(null)
    expect(normalizePipTarget(undefined)).toBe(undefined)
    expect(normalizePipTarget(7)).toBe(undefined)
  })
})
