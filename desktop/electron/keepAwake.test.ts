import { describe, expect, it } from 'vitest'
import { createKeepAwake } from './keepAwake'

function setup(enabled = true) {
  const state = { enabled, next: 1, held: new Set<number>(), starts: 0 }
  const ka = createKeepAwake({
    isEnabled: () => state.enabled,
    start: () => { state.starts++; const id = state.next++; state.held.add(id); return id },
    stop: (id) => { if (!state.held.delete(id)) throw new Error(`stop 了没持有的 ${id}`) },
  })
  return { state, ka }
}

describe('keepAwake', () => {
  it('默认关:有 run 也不拦', () => {
    const { state, ka } = setup(false)
    expect(ka.report(1, true)).toBe(false)
    expect(state.held.size).toBe(0)
  })

  it('开着:有 run 拦一枚(重复上报不叠加),归零即放', () => {
    const { state, ka } = setup()
    ka.report(1, true)
    ka.report(1, true)
    expect(state.starts).toBe(1)
    expect(state.held.size).toBe(1)
    expect(ka.report(1, false)).toBe(false)
    expect(state.held.size).toBe(0)
  })

  it('运行中关开关立刻放,再打开立刻拦', () => {
    const { state, ka } = setup()
    ka.report(1, true)
    state.enabled = false
    expect(ka.refresh()).toBe(false)
    expect(state.held.size).toBe(0)
    state.enabled = true
    expect(ka.refresh()).toBe(true)
    expect(state.held.size).toBe(1)
  })

  it('多窗口判「任一」:一个归零另一个还在跑就不放;窗口销毁替它清掉', () => {
    const { state, ka } = setup()
    ka.report(1, true)
    ka.report(2, true)
    expect(ka.report(1, false)).toBe(true)
    expect(state.held.size).toBe(1)
    expect(ka.forget(2)).toBe(false)
    expect(state.held.size).toBe(0)
  })

  it('唤醒后重新申请:持有时换一枚新的,没持有时不凭空拦', () => {
    const { state, ka } = setup()
    expect(ka.rearm()).toBe(false)
    expect(state.starts).toBe(0)
    ka.report(1, true)
    expect(ka.rearm()).toBe(true)
    expect(state.starts).toBe(2)
    expect([...state.held]).toEqual([2])
  })
})
