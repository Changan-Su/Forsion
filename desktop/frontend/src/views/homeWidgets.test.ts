import { describe, expect, it } from 'vitest'
import { CALENDAR_TODAY, CALENDAR_TODO, DEFAULT_HOME_LAYOUT, MUSE_CARD, STATUS_CARD, moveOnHome, parsePluginWidgetId, placeOnHome, removeCenterPart, removeFromHome, sanitizeHomeLayout } from './homeWidgets'

// 右栏空着的那份:摆放规则的测试从这里起步(缺省右栏已摆满三张)
const BARE = { ...DEFAULT_HOME_LAYOUT, right: [] }

describe('home widget layout', () => {
  it('defaults to the status row plus plan A on the right', () => {
    expect(sanitizeHomeLayout(null)).toEqual(DEFAULT_HOME_LAYOUT)
    expect(DEFAULT_HOME_LAYOUT.row).toEqual([{ id: STATUS_CARD, w: 4 }])
    expect(DEFAULT_HOME_LAYOUT.right).toEqual([CALENDAR_TODAY, CALENDAR_TODO, MUSE_CARD])
  })

  it('keeps what the user stored, even an empty rail', () => {
    expect(sanitizeHomeLayout({ row: [{ id: STATUS_CARD, w: 4 }], right: [] }).right).toEqual([])
    expect(sanitizeHomeLayout({ row: [] }).right).toEqual([])
  })

  it('accepts built-in and plugin ids and drops look-alikes', () => {
    const l = sanitizeHomeLayout({ right: ['builtin:inbox', 'plugin:forsion-calendar/today', 'builtin:nope'], left: ['plugin:Bad/x', 'plugin:a/b/c', 'plugin:../x', 'builtin:notes'] })
    expect(l.right).toEqual(['builtin:inbox', 'plugin:forsion-calendar/today'])
    expect(l.left).toEqual(['builtin:notes'])
    expect(parsePluginWidgetId('plugin:market-0f7e/today')).toEqual({ pluginId: 'market-0f7e', widgetId: 'today' })
    expect(parsePluginWidgetId('builtin:inbox')).toBeNull()
  })

  it('keeps the chat box and caps rails and the row', () => {
    const l = sanitizeHomeLayout({ center: ['dock', 'clock'], row: [{ id: 'w_a', w: 2 }, { id: 'w_b', w: 2 }, { id: 'w_c', w: 1 }], right: ['w_a', 'w_d', 'w_e', 'w_f', 'w_g'], left: ['../x'] })
    expect(l.center).toContain('composer')
    expect(l.center).toContain('row')
    expect(l.row.map((c) => c.id)).toEqual(['w_a', 'w_b'])
    expect(l.right).toEqual(['w_d', 'w_e', 'w_f'])
    expect(l.left).toEqual([])
  })

  it('places into the row first, then the right rail, then the left, then refuses', () => {
    let l = sanitizeHomeLayout({ row: [{ id: 'w_x', w: 2 }] })
    l = placeOnHome(l, 'w_a')!
    expect(l.row).toEqual([{ id: 'w_x', w: 2 }, { id: 'w_a', w: 2 }])
    l = placeOnHome(BARE, 'w_a')!
    expect(l.right).toEqual(['w_a'])
    l = placeOnHome(placeOnHome(l, 'w_b')!, 'w_c')!
    expect(removeFromHome(l, 'w_b').right).toEqual(['w_a', 'w_c'])
    // 缺省摆放右栏已满:落到左栏
    expect(placeOnHome(DEFAULT_HOME_LAYOUT, 'builtin:inbox')?.left).toEqual(['builtin:inbox'])
    l = placeOnHome(placeOnHome(placeOnHome(l, 'w_d')!, 'w_e')!, 'w_f')!
    expect(l.left).toEqual(['w_d', 'w_e', 'w_f'])
    expect(placeOnHome(l, 'w_g')).toBeNull()
  })

  it('moves between areas and refuses what does not fit', () => {
    const l = { ...BARE, right: ['w_a'] }
    expect(moveOnHome(l, 'w_a', { area: 'row', index: 0 })).toBeNull() // 近况卡占满下排
    expect(moveOnHome(l, 'w_a', { area: 'left', index: 0 })?.left).toEqual(['w_a'])
    expect(moveOnHome(l, STATUS_CARD, { area: 'right', index: 0 })).toBeNull()
    expect(removeCenterPart(l, 'composer').center).toContain('composer')
    expect(removeCenterPart(l, 'clock').center).not.toContain('clock')
  })

  it('restores the status card at full width only', () => {
    const l = removeFromHome(BARE, STATUS_CARD)
    expect(moveOnHome(l, STATUS_CARD, { area: 'row', index: 0 })?.row).toEqual([{ id: STATUS_CARD, w: 4 }])
    expect(moveOnHome({ ...l, row: [{ id: 'w_a', w: 1 }] }, STATUS_CARD, { area: 'row', index: 0 })).toBeNull()
  })
})
