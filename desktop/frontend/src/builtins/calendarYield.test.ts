import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

// 日历核心插件(方案 B 并行双跑)开着时内置日历让位:撤 Space / 视图,但不动用户的开关;插件停了按开关回来。
let mod: typeof import('./index')
const spy = { install: vi.fn(), installSpace: vi.fn(), removeSpace: vi.fn() }
let restore: () => void = () => {}

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  mod = await import('./index') // 拖着几十个视图,只载一次
  const def = mod.BUILTINS.find((b) => b.id === 'calendar')!
  const saved = { ...def }
  // 只看让位逻辑调没调 Space 的装 / 撤;真视图的注册由 calendar-ui 台架的插件档管
  Object.assign(def, { available: () => true, types: [], ...spy })
  restore = () => { Object.assign(def, saved); vi.unstubAllGlobals() }
}, 60_000)
afterAll(() => restore())
beforeEach(() => {
  vi.clearAllMocks()
  mod.useBuiltins.setState({ calendarYielded: false, enabled: { ...mod.useBuiltins.getState().enabled, calendar: true } })
})

describe('setCalendarYield', () => {
  it('插件开 → 撤内置日历、开关不变;重复调不再撤;插件关 → 装回来', () => {
    mod.setCalendarYield(true)
    expect(spy.removeSpace).toHaveBeenCalledTimes(1)
    expect(mod.useBuiltins.getState().enabled.calendar).toBe(true)
    mod.setCalendarYield(true)
    expect(spy.removeSpace).toHaveBeenCalledTimes(1)
    mod.setCalendarYield(false)
    expect(spy.installSpace).toHaveBeenCalledTimes(1)
  })

  it('让位期间用户切内置日历开关:只记开关,不装不撤;插件停了按最后的开关办', () => {
    mod.setCalendarYield(true)
    vi.clearAllMocks()
    mod.useBuiltins.getState().toggle('calendar', false)
    mod.useBuiltins.getState().toggle('calendar', true)
    expect(spy.installSpace).not.toHaveBeenCalled()
    expect(spy.removeSpace).not.toHaveBeenCalled()
    mod.useBuiltins.getState().toggle('calendar', false)
    mod.setCalendarYield(false)
    expect(spy.installSpace).not.toHaveBeenCalled() // 用户关了 → 插件停了也不回来
    expect(mod.useBuiltins.getState().enabled.calendar).toBe(false)
  })

  it('用户本来就关着内置日历:插件开关都不碰它', () => {
    mod.useBuiltins.setState({ enabled: { ...mod.useBuiltins.getState().enabled, calendar: false } })
    mod.setCalendarYield(true)
    mod.setCalendarYield(false)
    expect(spy.installSpace).not.toHaveBeenCalled()
    expect(spy.removeSpace).not.toHaveBeenCalled()
  })
})
