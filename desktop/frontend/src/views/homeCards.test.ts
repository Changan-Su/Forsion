import { describe, expect, it } from 'vitest'
import { shownHomeCards } from './homeCards'

describe('shownHomeCards', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('keeps the saved order, skips what is gone, and falls back to the defaults rather than showing nothing', () => {
    expect(shownHomeCards(['c', 'gone', 'a'], all, [all[1]])).toEqual([{ id: 'c' }, { id: 'a' }])
    expect(shownHomeCards(null, all, [all[1]])).toEqual([{ id: 'b' }])
    expect(shownHomeCards(['gone'], all, [all[1]])).toEqual([{ id: 'b' }]) // no card = nothing to long-press = no way back
  })
})
