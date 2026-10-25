import { describe, expect, it } from 'vitest'
import { moveCard, orderCards } from './summaryPrefs'

const D = ['progress', 'bg', 'outputs', 'sources', 'scope', 'desk']

describe('orderCards', () => {
  it('no saved order → defaults, absent cards dropped', () => {
    expect(orderCards(['desk', 'bg', 'progress'], D)).toEqual(['progress', 'bg', 'desk'])
  })
  it('stale saved ids are dropped, saved positions win', () => {
    expect(orderCards(['progress', 'bg', 'desk'], D, ['plugin:gone:x', 'desk', 'progress', 'bg'])).toEqual(['desk', 'progress', 'bg'])
  })
  it('a new plugin card lands at its default slot before the Desk, not after it', () => {
    const defaults = ['progress', 'bg', 'outputs', 'sources', 'scope', 'plugin:cal:today', 'desk']
    const saved = ['outputs', 'progress', 'bg', 'sources', 'scope', 'desk']
    expect(orderCards(defaults, defaults, saved)).toEqual(['outputs', 'progress', 'bg', 'sources', 'scope', 'plugin:cal:today', 'desk'])
  })
  it('a card missing from saved follows its nearest earlier default neighbour', () => {
    // 用户把 Desk 拖到最上面时还没有「后台」卡;后台卡后来出现,跟在 progress 后面
    expect(orderCards(D, D, ['desk', 'progress', 'outputs'])).toEqual(['desk', 'progress', 'bg', 'outputs', 'sources', 'scope'])
  })
})

describe('moveCard', () => {
  it('moves before a target, or to the end', () => {
    expect(moveCard(D, 'outputs', 'bg')).toEqual(['progress', 'outputs', 'bg', 'sources', 'scope', 'desk'])
    expect(moveCard(D, 'progress', null)).toEqual(['bg', 'outputs', 'sources', 'scope', 'desk', 'progress'])
  })
})
