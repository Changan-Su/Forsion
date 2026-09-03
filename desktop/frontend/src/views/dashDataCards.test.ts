// @vitest-environment happy-dom
/** useDayKey:数据卡的「今天是哪天」缓存键,跨过本地午夜必须换值 —— 绑定视图里的相对日期筛选
 *  (`today` / `-7d`)是按当前时刻折算的,卡片的 useMemo 不把它纳入依赖就会一直显示昨天的数。
 *  用假定时器把时钟停在 23:59:59 再推 2s,直接量 hook 的返回值(纯函数 localDayKey 的单测在
 *  shared/amadeus/db/viewQuery.test.ts —— 那个绿不能证明依赖接对了,所以这里量 hook 本身)。
 *  ponytail: 用 createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx(照 propertyTypes.builtins.test 先例)。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@amadeus/api', () => ({ amadeus: {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const { useDayKey } = await import('./dashDataCards')

afterEach(() => {
  vi.useRealTimers()
})

/** 把 hook 的当前值写进 out,并数一下渲染次数。 */
function mount(out: { key: string; renders: number }): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const Probe = (): null => {
    out.key = useDayKey()
    out.renders++
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  return { host, root }
}

describe('useDayKey', () => {
  it('跨本地午夜换值:23:59:59 → 推 2s 后是新的一天', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 2, 23, 59, 59))
    const out = { key: '', renders: 0 }
    const { root } = mount(out)
    expect(out.key).toBe('2026-09-02')

    act(() => { vi.advanceTimersByTime(2_000) }) // 定时器排的是「午夜 +1s」= 此刻起 2s
    expect(out.key).toBe('2026-09-03')

    act(() => root.unmount())
  })

  it('同一天内不换值、不空转重渲', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 2, 9, 0, 0))
    const out = { key: '', renders: 0 }
    const { root } = mount(out)
    const before = out.renders
    act(() => { vi.advanceTimersByTime(6 * 3600_000) }) // 到 15:00,还没到午夜
    expect(out.key).toBe('2026-09-02')
    expect(out.renders).toBe(before)
    act(() => root.unmount())
  })

  it('卸载清定时器:卸载后推过午夜不再有待跑的定时器', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 2, 23, 59, 59))
    const out = { key: '', renders: 0 }
    const { root } = mount(out)
    expect(vi.getTimerCount()).toBe(1)
    act(() => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('时钟被拨回(定时器到点但日子没换):仍会排下一班,不卡死', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 2, 23, 59, 59))
    const out = { key: '', renders: 0 }
    const { root } = mount(out)
    act(() => {
      vi.setSystemTime(new Date(2026, 8, 2, 12, 0, 0)) // 定时器到点前把时钟拨回当天中午
      vi.advanceTimersByTime(2_000)
    })
    expect(out.key).toBe('2026-09-02') // 值没换
    expect(vi.getTimerCount()).toBe(1) // 但下一班已排出去(tick 兜底);否则这里是 0 = 永远不再更新
    act(() => root.unmount())
  })
})

// ── 依赖接线本身:hook 绿不代表卡片用上了它。绑定一个 `on today` 视图,把时钟推过午夜,量卡面上的数字。
describe('StatCard 跨午夜重算', () => {
  it('绑定视图含相对日期(on today)时,过了本地午夜卡片值跟着变', async () => {
    const { useDbStore } = await import('@amadeus/store/dbStore')
    const { StatCard } = await import('./dashDataCards')
    const data = {
      version: 1,
      name: '任务',
      columns: [{ id: 'd', name: '日期', type: 'date' }],
      rows: [
        { id: 'r1', cells: { d: '2026-09-02' } },
        { id: 'r2', cells: { d: '2026-09-02' } },
        { id: 'r3', cells: { d: '2026-09-03' } },
      ],
      views: [{ id: 'v1', name: '今天', type: 'table', filters: [{ colId: 'd', op: 'on', value: 'today' }] }],
    }
    useDbStore.setState({ entries: { 'a.db': { status: 'ok', path: 'a.db', data: data as never } } })

    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 2, 23, 59, 59))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(createElement(StatCard, { opts: { source: 'a.db', view: '今天' }, filters: [] })))
    const shown = (): string => host.querySelector('.dash-stat-value')?.textContent ?? ''
    expect(shown()).toBe('2') // 09-02 那两行

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(shown()).toBe('1') // 换到 09-03 → 只剩 r3

    act(() => root.unmount())
    useDbStore.setState({ entries: {} })
  })
})
