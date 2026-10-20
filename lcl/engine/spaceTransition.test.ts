import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spaceSwitchDirection, switchSpace } from './spaceTransition'
import { useSpaceStore } from './spaceRegistry'

const bar = ['home', 'tangu', 'amadeus', 'calendar']
const registry = ['tangu', 'amadeus', 'calendar', 'home', 'plugin']

describe('which way a Space switch pushes', () => {
  it('follows the order on the bar: further down is next, further up is prev', () => {
    expect(spaceSwitchDirection(bar, registry, 'tangu', 'calendar')).toBe('next')
    expect(spaceSwitchDirection(bar, registry, 'calendar', 'home')).toBe('prev')
  })
  it('falls back to registration order when either end is not on the bar', () => {
    expect(spaceSwitchDirection(bar, registry, 'home', 'plugin')).toBe('next') // registry: home 3 → plugin 4
    expect(spaceSwitchDirection([], registry, 'home', 'tangu')).toBe('prev') // phone: no bar reported
  })
  it('defaults to next when neither list knows them', () => {
    expect(spaceSwitchDirection(bar, registry, 'gone', 'tangu')).toBe('next')
  })
})

describe('what a switch costs', () => {
  // 挂在 <html> 上的自定义属性会继承:每切一次挂一次、摘一次 = 整页样式重算两遍(10-16 安卓模拟器实测 4870 个元素)。
  // 过渡用到的变量只许写在快照(::view-transition-*)自己身上。
  it('keeps the push\'s custom properties off <html>', () => {
    const css = readFileSync(new URL('./engine.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel, body]) => sel.includes('data-space-switch') && /(^|;)\s*--[\w-]+\s*:/.test(body))
    expect(rules.length).toBeGreaterThan(0)
    for (const [, sel] of rules) for (const one of sel.split(',')) expect(one).toContain('::view-transition')
  })

  afterEach(() => { vi.unstubAllGlobals() })
  const setup = () => {
    const vt = { skipTransition: vi.fn(), ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() }
    const start = vi.fn(() => vt)
    vi.stubGlobal('document', { startViewTransition: start, visibilityState: 'visible', documentElement: { dataset: {} } })
    vi.stubGlobal('window', { addEventListener: () => {} })
    const space = (id: string) => ({ id, name: id, sidebarDefaults: { left: [], right: [] }, build: () => {} })
    useSpaceStore.setState({ spaces: [space('a'), space('b')], activeSpaceId: 'a' })
    return start
  }
  // 10-16 用户定:手机('x')先不播,等真机量过再开 —— 直接、同步地换
  it('switches at once on the phone, without a View Transition', () => {
    const start = setup()
    const run = vi.fn()
    switchSpace('b', run, { axis: 'x' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
  })
  it('still pushes on the desktop', () => {
    const start = setup()
    const run = vi.fn()
    switchSpace('b', run)
    expect(start).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled() // runs in the transition's callback, a frame later
  })
})
