import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMiniAutoPanel } from './miniAutoPanel'
import { normalizeMiniSessionContext, type MiniSessionContext } from '../shared/miniPanel'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const state = { foreground: false, focused: true, manual: false, context: { sessionId: 's1', runId: 'r1' } as MiniSessionContext }
  const open = vi.fn(), close = vi.fn(), restore = vi.fn(async () => {})
  const panel = startMiniAutoPanel({ readForeground: async () => state.foreground ? { targetPid: 55, runId: state.context.runId } : null,
    hasForsionFocus: () => state.focused, manualMiniVisible: () => state.manual,
    session: () => state.context, open, close, restore })
  const tick = () => vi.advanceTimersByTimeAsync(100)
  return { state, panel, open, close, restore, tick }
}

describe('automatic Computer Use conversation panel', () => {
  it('requires external focus, a physical-input lease and a current run; no manual Mini prerequisite', async () => {
    const { state, panel, open, tick } = fixture()
    state.foreground = true; await tick(); expect(open).not.toHaveBeenCalled()
    state.foreground = false; state.focused = false; await tick(); expect(open).not.toHaveBeenCalled()
    state.foreground = true; state.context.runId = null; await tick(); expect(open).not.toHaveBeenCalled()
    state.context.runId = 'r1'; await tick(); expect(open).toHaveBeenCalledExactlyOnceWith('s1')
    expect(panel.following()).toBe(true)
    panel.stop()
  })
  it('keeps the conversation through input gaps and closes when the run ends', async () => {
    const { state, panel, open, close, tick } = fixture()
    state.focused = false; state.foreground = true; await tick()
    state.foreground = false; await tick()
    expect(panel.wants('s1')).toBe(true); expect(panel.following()).toBe(true)
    expect(close).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledTimes(1)
    state.context.runId = null; panel.refresh()
    expect(panel.wants('s1')).toBe(false); expect(close).toHaveBeenCalledTimes(1)
    expect(panel.following()).toBe(false)
    panel.stop()
  })
  it('cancels pending display immediately on Forsion focus, then can reopen on a later foreground call', async () => {
    const { state, panel, open, close, tick } = fixture()
    state.focused = false; state.foreground = true; await tick()
    state.focused = true; panel.refresh()
    expect(panel.wants('s1')).toBe(false); expect(close).toHaveBeenCalledTimes(1)
    expect(panel.following()).toBe(false)
    state.foreground = false; await tick(); state.focused = false; await tick()
    expect(open).toHaveBeenCalledTimes(1)
    state.foreground = true; await tick(); expect(open).toHaveBeenCalledTimes(2)
    panel.stop()
  })
  it('never owns a visible manual panel, and explicit dismissal wins until the next run', async () => {
    const { state, panel, open, tick } = fixture()
    state.focused = false; state.foreground = true; state.manual = true; await tick()
    expect(open).not.toHaveBeenCalled()
    state.manual = false; await tick(); expect(panel.wants('s1')).toBe(true)
    panel.dismiss(); await tick(); expect(panel.wants('s1')).toBe(false)
    state.context.runId = 'r2'; await tick(); expect(panel.wants('s1')).toBe(true)
    panel.stop()
  })
  it('does not carry an old episode to another conversation or run without foreground input', async () => {
    const { state, panel, open, tick } = fixture()
    state.focused = false; state.foreground = true; await tick()
    state.foreground = false; await tick()
    state.context = { sessionId: 's2', runId: 'r2' }; panel.refresh()
    expect(panel.wants('s1')).toBe(false); expect(open).toHaveBeenCalledTimes(1)
    expect(panel.following()).toBe(false)
    panel.stop()
  })
  it('keeps a visible manual Mini following during pauses, without opening an automatic Mini', async () => {
    const { state, panel, open, tick } = fixture()
    state.focused = false; state.manual = true; state.foreground = true; await tick()
    state.foreground = false; await tick()
    expect(panel.following()).toBe(true); expect(open).not.toHaveBeenCalled()
    state.context.runId = null; panel.refresh(); expect(panel.following()).toBe(false)
    panel.stop()
  })
  it('returns to the owning conversation even when a manual Mini suppressed the automatic one', async () => {
    const { state, panel, restore, open, tick } = fixture()
    state.focused = false; state.manual = true; state.foreground = true; await tick()
    state.foreground = false; state.context.runId = null; panel.refresh()
    expect(open).not.toHaveBeenCalled(); expect(restore).toHaveBeenCalledExactlyOnceWith('s1', 55)
    panel.stop()
  })
  it('does not reclaim focus after a user switches conversations, dismisses Mini or replaces the run', async () => {
    const { state, panel, restore, tick } = fixture()
    state.focused = false; state.foreground = true; await tick()
    state.context = { sessionId: 's2', runId: 'r2' }; panel.refresh(); await tick()
    state.context.runId = 'r3'; panel.refresh(); await tick()
    panel.dismiss(); state.context.runId = null; panel.refresh()
    await tick(); expect(restore).not.toHaveBeenCalled()
    panel.stop()
  })
  it('does not reuse a consumed lease after the user returned and left again', async () => {
    vi.useFakeTimers()
    const context: MiniSessionContext = { sessionId: 's', runId: 'r' }
    let focused = false
    const restore = vi.fn(), open = vi.fn()
    const panel = startMiniAutoPanel({ session: () => context, hasForsionFocus: () => focused, manualMiniVisible: () => false,
      readForeground: async () => ({runId: 'r', targetPid: 55, id: '2/19'}), open, close: vi.fn(), restore })
    await vi.advanceTimersByTimeAsync(80)
    focused = true; panel.refresh(); focused = false
    await vi.advanceTimersByTimeAsync(80); context.runId = null; panel.refresh()
    await vi.advanceTimersByTimeAsync(80)
    expect(open).toHaveBeenCalledTimes(1); expect(restore).not.toHaveBeenCalled(); panel.stop()
  })
  it('recovers a completed run between polls only with its own stored lease', async () => {
    const context: MiniSessionContext = {sessionId: 'fast', runId: 'brief'}
    const restore = vi.fn(async () => {}); let leaseRun = 'brief'
    const panel = startMiniAutoPanel({session: () => context, manualMiniVisible: () => true, hasForsionFocus: () => false,
      readForeground: async () => ({runId: leaseRun, targetPid: 42}), open: vi.fn(), close: vi.fn(), restore})
    context.runId = null; panel.refresh(); await Promise.resolve(); await Promise.resolve()
    expect(restore).toHaveBeenCalledExactlyOnceWith('fast', 42)
    context.runId = 'next'; panel.refresh(); leaseRun = 'old'; context.runId = null; panel.refresh()
    await Promise.resolve(); await Promise.resolve(); expect(restore).toHaveBeenCalledTimes(1)
    panel.stop()
  })
  it('does not resurrect a stopped controller after an in-flight read', async () => {
    vi.useFakeTimers()
    let resolve!: (active: {runId: string; targetPid: number}) => void
    const open = vi.fn()
    const panel = startMiniAutoPanel({ readForeground: () => new Promise((r) => { resolve = r }),
      hasForsionFocus: () => false, manualMiniVisible: () => false,
      session: () => ({ sessionId: 's', runId: 'r' }), open, close: vi.fn(), restore: vi.fn() })
    panel.stop(); resolve({runId: 'r', targetPid: 11}); await vi.advanceTimersByTimeAsync(200)
    expect(open).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('accepts only bounded session/run identifiers from the renderer', () => {
    expect(normalizeMiniSessionContext({ sessionId: ' s ', runId: 'r' })).toEqual({ sessionId: 's', runId: 'r' })
    expect(normalizeMiniSessionContext({ sessionId: null, runId: 'r' })).toEqual({ sessionId: null, runId: null })
    expect(normalizeMiniSessionContext({ sessionId: 's'.repeat(257), runId: {} })).toEqual({ sessionId: null, runId: null })
  })
})
