/** 手机五格 Dock(phoneDock.ts,2026-11-19 方向 E 第 1 步):五格的数据、选中哪格、「常用」从哪来。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FREQUENT_MAX, PHONE_APPS, PHONE_ME, frequentSpaceIds, phoneAppsSpaceIds, phoneDockCells, saveFrequent, storedFrequent } from './phoneDock'

const SPACES = ['home', 'tangu', 'amadeus', 'calendar', 'inbox', 'agents', 'image', 'todo'].map((id) => ({ id, label: id.toUpperCase() }))
const LABELS = { chats: 'Chats', apps: 'Apps', me: 'Me' }
const on = (cells: ReturnType<typeof phoneDockCells>): string | undefined => cells.find((c) => c.active)?.id

describe('phone dock cells', () => {
  it('Home · Chats · Notes · Apps · Me, all pinned (≤ five: an older native build draws every cell and no "all" cell)', () => {
    const cells = phoneDockCells(SPACES, 'home', null, LABELS)
    expect(cells.map((c) => [c.id, c.label, c.glyph ?? ''])).toEqual([
      ['home', 'HOME', ''], ['tangu', 'Chats', 'chats'], ['amadeus', 'AMADEUS', ''], [PHONE_APPS, 'Apps', 'apps'], [PHONE_ME, 'Me', 'me'],
    ])
    expect(cells.every((c) => c.pinned)).toBe(true)
  })

  it('the selected cell: the open page; else Home / Chats / Notes for their Space; any other Space counts as Apps; an unknown id falls to Home', () => {
    expect(on(phoneDockCells(SPACES, 'tangu', null, LABELS))).toBe('tangu')
    expect(on(phoneDockCells(SPACES, 'amadeus', null, LABELS))).toBe('amadeus')
    expect(on(phoneDockCells(SPACES, 'calendar', null, LABELS))).toBe(PHONE_APPS)
    expect(on(phoneDockCells(SPACES, 'gone', null, LABELS))).toBe('home')
    expect(on(phoneDockCells(SPACES, 'tangu', 'me', LABELS))).toBe(PHONE_ME)
    expect(on(phoneDockCells(SPACES, 'home', 'apps', LABELS))).toBe(PHONE_APPS)
  })

  it('a Space that is not there drops its cell; Apps and Me are always there; notices ride on their cells', () => {
    const cells = phoneDockCells(SPACES.filter((s) => s.id !== 'amadeus'), 'home', null, LABELS, { me: '1 to claim', apps: null })
    expect(cells.map((c) => c.id)).toEqual(['home', 'tangu', PHONE_APPS, PHONE_ME])
    expect(cells.find((c) => c.id === PHONE_ME)?.notice).toEqual({ label: '1 to claim' })
    expect(cells.find((c) => c.id === PHONE_APPS)?.notice).toBeUndefined()
  })

  it('the Apps page lists every Space but the three in the dock, in list order', () => {
    expect(phoneAppsSpaceIds(SPACES.map((s) => s.id))).toEqual(['calendar', 'inbox', 'agents', 'image', 'todo'])
  })
})

describe('frequent apps (the Apps page\'s first row)', () => {
  const C = ['calendar', 'inbox', 'agents', 'image', 'todo', 'guide']
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('never chosen, nothing to carry over: calendar and inbox, then list order up to a row', () => {
    expect(frequentSpaceIds(C, { stored: null, dockPicks: null, homeCards: null })).toEqual(['calendar', 'inbox', 'agents', 'image'])
    expect(frequentSpaceIds(['todo', 'guide'], { stored: null, dockPicks: null, homeCards: null })).toEqual(['todo', 'guide'])
  })

  it('carries the old dock picks first, then the Spaces among the home cards — the dock\'s own three and non-Spaces dropped, a row at most', () => {
    expect(frequentSpaceIds(C, { stored: null, dockPicks: ['tangu', 'amadeus', 'todo'], homeCards: ['space:tangu', 'rb-market', 'space:inbox', 'space:todo'] }))
      .toEqual(['inbox', 'todo'])
    expect(frequentSpaceIds(C, { stored: null, dockPicks: ['guide', 'image'], homeCards: ['space:agents', 'space:calendar', 'space:inbox'] }))
      .toEqual(['calendar', 'agents', 'image', 'guide']) // first four carried (guide, image, agents, calendar), shown in list order
  })

  it('old choices with nothing usable left fall back to the default instead of an empty row', () => {
    expect(frequentSpaceIds(C, { stored: null, dockPicks: ['tangu', 'amadeus'], homeCards: ['rb-market'] })).toEqual(['calendar', 'inbox', 'agents', 'image'])
  })

  it('a stored choice wins (even an empty one) and keeps list order; saving what is already shown stores nothing', () => {
    expect(frequentSpaceIds(C, { stored: ['todo', 'calendar', 'gone'], dockPicks: ['image'], homeCards: null })).toEqual(['calendar', 'todo'])
    expect(frequentSpaceIds(C, { stored: [], dockPicks: ['image'], homeCards: null })).toEqual([])
    saveFrequent(['inbox', 'calendar'], ['calendar', 'inbox'])
    expect(storedFrequent()).toBeNull()
    saveFrequent(['todo', 'guide', 'image', 'agents', 'inbox'], ['calendar', 'inbox'])
    expect(storedFrequent()?.length).toBe(FREQUENT_MAX)
  })
})
