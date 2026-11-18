import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultHomeCards, loadHomeCards, shownHomeCards } from './homeCards'

describe('shownHomeCards', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('keeps the saved order, skips what is gone, and falls back to the defaults rather than showing nothing', () => {
    expect(shownHomeCards(['c', 'gone', 'a'], all, [all[1]])).toEqual([{ id: 'c' }, { id: 'a' }])
    expect(shownHomeCards(null, all, [all[1]])).toEqual([{ id: 'b' }])
    expect(shownHomeCards(['gone'], all, [all[1]])).toEqual([{ id: 'b' }]) // no card = nothing to long-press = no way back
  })
})

describe('defaultHomeCards', () => {
  const card = (id: string) => ({ id })
  const ids = (cards: Array<{ id: string }>) => cards.map((c) => c.id)
  const fallback = [card('space:agents'), card('rb-market')]
  it('the Spaces with something to report, in their own order whatever the shelf order is', () => {
    const all = ['space:inbox', 'rb-market', 'space:calendar', 'space:agents', 'space:amadeus', 'rb-achievements', 'space:tangu'].map(card)
    expect(ids(defaultHomeCards(all, fallback))).toEqual(['space:tangu', 'space:amadeus', 'space:calendar', 'space:inbox'])
  })
  it('only the ones that exist; the store, achievements and plugin entries are not among the defaults', () => {
    const all = ['space:tangu', 'space:agents', 'rb-market', 'rb-achievements', 'plugin:x', 'space:inbox'].map(card)
    expect(ids(defaultHomeCards(all, fallback))).toEqual(['space:tangu', 'space:inbox'])
  })
  it('none of them on the shelf: the fallback, so there is still a card to long-press', () => {
    expect(ids(defaultHomeCards(['space:agents', 'rb-market'].map(card), fallback))).toEqual(['space:agents', 'rb-market'])
  })
  it('a choice the user made is shown as made, not replaced by the defaults', () => {
    const all = ['space:tangu', 'space:amadeus', 'rb-market', 'rb-achievements'].map(card)
    expect(ids(shownHomeCards(['rb-market', 'space:tangu'], all, defaultHomeCards(all, fallback)))).toEqual(['rb-market', 'space:tangu'])
  })
})

describe('loadHomeCards', () => {
  const KEY = 'forsion_home_cards_v1'
  function storage(raw: string | null): { writes: string[]; get(): string | null } {
    const store = new Map<string, string>(raw === null ? [] : [[KEY, raw]])
    const writes: string[] = []
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { writes.push(k); store.set(k, v) },
      removeItem: (k: string) => { writes.push(k); store.delete(k) },
    })
    return { writes, get: () => store.get(KEY) ?? null }
  }
  afterEach(() => vi.unstubAllGlobals())

  it('reads what was chosen and writes nothing', () => {
    const st = storage('["space:tangu","rb-market"]')
    expect(loadHomeCards()).toEqual(['space:tangu', 'rb-market'])
    expect(st.writes).toEqual([])
  })
  it('never chosen: null', () => {
    const st = storage(null)
    expect(loadHomeCards()).toBeNull()
    expect(st.writes).toEqual([])
  })
  it('a stored value that does not parse, or is not a list, reads as never chosen and stays on disk as it is', () => {
    for (const raw of ['{not json', '{"cards":["space:tangu"]}', '"space:tangu"']) {
      const st = storage(raw)
      expect(loadHomeCards()).toBeNull()
      expect(st.writes).toEqual([])
      expect(st.get()).toBe(raw)
    }
  })
})
