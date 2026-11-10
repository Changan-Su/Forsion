// @vitest-environment happy-dom
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
/** 仪表盘待办摘要卡认日程标记(2026-11-10):日历格子上建的日程(cells._kind = 'event' 且有日期)不进待办数、不出现在列表里;
 *  带标记但没日期的照旧是待办。装了日历插件时这张卡仍是宿主自己画的(不走 CoreViewSlot)。 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const db = {
  path: 'human://CALENDAR.db', name: '我的日历', isNoteView: false,
  columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }],
  rows: [
    { rowId: 'ev', name: '周会', cells: { name: '周会', date: '2026-11-10T09:00/2026-11-10T10:00', _kind: 'event' } },
    { rowId: 'td', name: '交周报', cells: { name: '交周报', date: '2026-11-10' } },
    { rowId: 'nd', name: '没排期的', cells: { name: '没排期的', _kind: 'event' } },
    { rowId: 'ok', name: '已完成', cells: { name: '已完成', done: true } },
  ],
}
vi.mock('../amadeus/store/calendarMembers', async (orig) => ({
  ...(await orig<typeof import('../amadeus/store/calendarMembers')>()),
  useCalendarMembers: () => [{ db, dateCol: 'date', checkboxCol: 'done' }],
}))
vi.mock('../amadeus/store/mdMarkStore', () => ({ useMdMarks: () => [], useMdCalDbs: () => [], patchMark: () => false }))

const { TodoDashboardCard } = await import('./DashboardCompactViews')

let root: Root | null = null
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = '' })

describe('TodoDashboardCard', () => {
  it('不数日程、不列日程;没日期的带标记行照旧是待办', async () => {
    const el = document.createElement('div'); document.body.append(el)
    root = createRoot(el)
    await act(async () => root!.render(createElement(TodoDashboardCard, { size: 'full' })))
    const names = [...el.querySelectorAll('.dash-compact-row span')].map((e) => e.textContent)
    expect(names.sort()).toEqual(['交周报', '没排期的'])
    expect(el.querySelector('.dash-compact-kpi strong')?.textContent).toBe('2')
  })
})
