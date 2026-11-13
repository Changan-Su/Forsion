// @vitest-environment happy-dom
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
/** 仪表盘待办摘要卡:带勾选列的表里每一行都是待办,只看表有没有勾选列,不按行细分(2026-11-13 撤掉日程记号)。
 *  行上旧的 `cells._kind = 'event'`(11-09 那套记号)没人读,带着它的行照样进待办数和列表 —— 和日历插件的清单一致。
 *  装了日历插件时这张卡仍是宿主自己画的(不走 CoreViewSlot)。 */
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
  it('带旧记号的行照样是待办(有没有日期都算);勾过的不列', async () => {
    const el = document.createElement('div'); document.body.append(el)
    root = createRoot(el)
    await act(async () => root!.render(createElement(TodoDashboardCard, { size: 'full' })))
    const names = [...el.querySelectorAll('.dash-compact-row span')].map((e) => e.textContent)
    expect(names.sort()).toEqual(['交周报', '周会', '没排期的'].sort())
    expect(el.querySelector('.dash-compact-kpi strong')?.textContent).toBe('3')
  })
})
