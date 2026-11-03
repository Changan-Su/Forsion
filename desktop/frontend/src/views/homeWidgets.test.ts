import { describe, expect, it } from 'vitest'
import { DEFAULT_HOME_LAYOUT, STATUS_CARD, moveOnHome, placeOnHome, removeCenterPart, removeFromHome, sanitizeHomeLayout } from './homeWidgets'

describe('home widget layout', () => {
  it('defaults to today\'s home page', () => {
    expect(sanitizeHomeLayout(null)).toEqual(DEFAULT_HOME_LAYOUT)
    expect(DEFAULT_HOME_LAYOUT.row).toEqual([{ id: STATUS_CARD, w: 4 }])
  })

  it('keeps the chat box and caps rails and the row', () => {
    const l = sanitizeHomeLayout({ center: ['dock', 'clock'], row: [{ id: 'w_a', w: 2 }, { id: 'w_b', w: 2 }, { id: 'w_c', w: 1 }], right: ['w_a', 'w_d', 'w_e', 'w_f', 'w_g'], left: ['../x'] })
    expect(l.center).toContain('composer')
    expect(l.center).toContain('row')
    expect(l.row.map((c) => c.id)).toEqual(['w_a', 'w_b'])
    expect(l.right).toEqual(['w_d', 'w_e', 'w_f'])
    expect(l.left).toEqual([])
  })

  it('places into the row first, then the right rail, then refuses', () => {
    let l = sanitizeHomeLayout({ row: [{ id: 'w_x', w: 2 }] })
    l = placeOnHome(l, 'w_a')!
    expect(l.row).toEqual([{ id: 'w_x', w: 2 }, { id: 'w_a', w: 2 }])
    l = placeOnHome(DEFAULT_HOME_LAYOUT, 'w_a')!
    expect(l.right).toEqual(['w_a'])
    l = placeOnHome(placeOnHome(l, 'w_b')!, 'w_c')!
    expect(placeOnHome(l, 'w_d')).toBeNull()
    expect(removeFromHome(l, 'w_b').right).toEqual(['w_a', 'w_c'])
  })

  it('moves between areas and refuses what does not fit', () => {
    const l = { ...DEFAULT_HOME_LAYOUT, right: ['w_a'] }
    expect(moveOnHome(l, 'w_a', { area: 'row', index: 0 })).toBeNull() // 近况卡占满下排
    expect(moveOnHome(l, 'w_a', { area: 'left', index: 0 })?.left).toEqual(['w_a'])
    expect(moveOnHome(l, STATUS_CARD, { area: 'right', index: 0 })).toBeNull()
    expect(removeCenterPart(l, 'composer').center).toContain('composer')
    expect(removeCenterPart(l, 'clock').center).not.toContain('clock')
  })
})
