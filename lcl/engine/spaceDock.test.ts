import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCK_CELLS, DOCK_PICKS, dockPicks, dockSpaceIds, subscribeDockPicks, toggleDockPick } from './spaceDock'

const nine = ['home', 'tangu', 'notes', 'calendar', 'inbox', 'agents', 'images', 'publish', 'plugin']

describe('which Spaces stand in the dock', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear(),
    })
  })

  it('holds every Space while they fit', () => {
    const five = nine.slice(0, DOCK_CELLS)
    expect([...dockSpaceIds(five)]).toEqual(five)
    expect([...dockSpaceIds(five, ['inbox'])]).toEqual(five) // a stored choice changes nothing while everything fits
  })

  it('never chosen: Home and the next ones in list order', () => {
    expect(dockPicks()).toBeNull()
    expect([...dockSpaceIds(nine)]).toEqual(['home', 'tangu', 'notes', 'calendar'])
  })

  it('chosen: Home plus the picks, in list order, not in the order they were picked', () => {
    expect([...dockSpaceIds(nine, ['publish', 'tangu', 'inbox'])]).toEqual(['home', 'tangu', 'inbox', 'publish'])
    expect([...dockSpaceIds(nine, ['inbox', 'agents', 'images', 'publish'])]).toEqual(['home', 'inbox', 'agents', 'images']) // more than fit: the first ones
  })

  it('a pick whose Space is gone leaves its cell empty', () => {
    expect([...dockSpaceIds(nine, ['tangu', 'removed-plugin', 'inbox'])]).toEqual(['home', 'tangu', 'inbox'])
    expect([...dockSpaceIds(nine, [])]).toEqual(['home'])
  })

  it('toggling swaps one Space and keeps the others; a full dock refuses a fourth', () => {
    let told = 0
    const off = subscribeDockPicks(() => { told += 1 })
    expect(DOCK_PICKS).toBe(3)
    expect(toggleDockPick(nine, 'inbox')).toBe(false) // tangu, notes, calendar are in: no room
    expect(dockPicks()).toBeNull()
    expect(toggleDockPick(nine, 'calendar')).toBe(true) // out
    expect(dockPicks()).toEqual(['tangu', 'notes'])
    expect(toggleDockPick(nine, 'inbox')).toBe(true) // in
    expect([...dockSpaceIds(nine)]).toEqual(['home', 'tangu', 'notes', 'inbox'])
    expect(told).toBe(2)
    off()
  })

  it('Home cannot be taken out, an unknown Space cannot be put in', () => {
    expect(toggleDockPick(nine, 'home')).toBe(false)
    expect(toggleDockPick(nine, 'nope')).toBe(false)
    expect([...dockSpaceIds(nine)]).toEqual(['home', 'tangu', 'notes', 'calendar'])
  })

  it('garbage in storage counts as never chosen', () => {
    localStorage.setItem('lcl_dock_pins_v1', '{"not":"a list"}')
    expect(dockPicks()).toBeNull()
    localStorage.setItem('lcl_dock_pins_v1', 'not json')
    expect(dockPicks()).toBeNull()
  })
})
