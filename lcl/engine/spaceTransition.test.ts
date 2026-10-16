import { describe, expect, it } from 'vitest'
import { spaceSwitchDirection } from './spaceTransition'

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
