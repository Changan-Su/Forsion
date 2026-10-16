import { describe, expect, it } from 'vitest'
import type { LayoutBlob } from '@lcl/engine'
import { calendarSidesAreOld } from './calendar'

const blob = (panels: Array<[string, string]>, stash: { left?: string[]; right?: string[] } = {}): LayoutBlob => ({
  version: 4,
  dockview: { panels: Object.fromEntries(panels.map(([loc, type], i) => [`${type}-${i}`, { params: { __loc: loc, __type: type } }])) },
  sidebars: {
    left: { visible: true, stash: (stash.left ?? []).map((type) => ({ type, params: {} })) },
    right: { visible: true, stash: (stash.right ?? []).map((type) => ({ type, params: {} })) },
  },
})

describe('calendarSidesAreOld', () => {
  it('认出旧的默认摆法(含收起的一侧看暂存)', () => {
    expect(calendarSidesAreOld(blob([['main', 'calendar'], ['left', 'todo-list'], ['right', 'calendar-config']]))).toBe(true)
    expect(calendarSidesAreOld(blob([['main', 'calendar'], ['left', 'todo-list']], { right: ['calendar-config'] }))).toBe(true)
  })
  it('用户动过的、新摆法、没有存档都不动', () => {
    expect(calendarSidesAreOld(blob([['main', 'calendar'], ['left', 'todo-list'], ['left', 'outline'], ['right', 'calendar-config']]))).toBe(false)
    expect(calendarSidesAreOld(blob([['main', 'calendar'], ['left', 'calendar-config'], ['right', 'calendar-side']]))).toBe(false)
    expect(calendarSidesAreOld(blob([['main', 'calendar']]))).toBe(false)
    expect(calendarSidesAreOld(null)).toBe(false)
    // 主区多开了标签 / 底栏开过终端:两侧没动也整份不动(重建会清掉主区)
    expect(calendarSidesAreOld(blob([['main', 'calendar'], ['main', 'note'], ['left', 'todo-list'], ['right', 'calendar-config']]))).toBe(false)
    expect(calendarSidesAreOld(blob([['main', 'calendar'], ['bottom', 'termv'], ['left', 'todo-list'], ['right', 'calendar-config']]))).toBe(false)
    const stashed = blob([['main', 'calendar'], ['left', 'todo-list'], ['right', 'calendar-config']])
    stashed.sidebars.bottom = { visible: false, stash: [{ type: 'termv', params: {} }] }
    expect(calendarSidesAreOld(stashed)).toBe(false)
  })
})
