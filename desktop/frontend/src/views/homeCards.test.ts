import { describe, expect, it } from 'vitest'
import { HOME_CARDS_MAX, shownHomeCards, toggleHomeCard } from './homeCards'

describe('toggleHomeCard', () => {
  it('adds at the end, removes in place, keeps the last card and stops at the cap', () => {
    expect(toggleHomeCard(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleHomeCard(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(toggleHomeCard(['a'], 'a')).toEqual(['a'])
    const full = Array.from({ length: HOME_CARDS_MAX }, (_, i) => `s${i}`)
    expect(toggleHomeCard(full, 'x')).toEqual(full)
    expect(toggleHomeCard(full, 's0')).toEqual(full.slice(1))
  })
})

describe('shownHomeCards', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('keeps the saved order, skips what is gone, and falls back to the defaults rather than showing nothing', () => {
    expect(shownHomeCards(['c', 'gone', 'a'], all, [all[1]])).toEqual([{ id: 'c' }, { id: 'a' }])
    expect(shownHomeCards(null, all, [all[1]])).toEqual([{ id: 'b' }])
    expect(shownHomeCards(['gone'], all, [all[1]])).toEqual([{ id: 'b' }]) // no card = nothing to long-press = no way back
  })
})
