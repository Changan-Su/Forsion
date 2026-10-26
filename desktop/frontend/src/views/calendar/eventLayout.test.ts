import { describe, expect, it } from 'vitest'
import { agendaOrder, layoutMonthWeek, layoutTimedEvents } from './eventLayout'

const at = (h: number, m = 0) => new Date(2026, 7, 22, h, m)

describe('layoutTimedEvents', () => {
  it('重叠事件按开始时间阶梯错开 14px,首尾相接不算重叠', () => {
    const got = layoutTimedEvents([
      { key: 'c', start: at(10), end: at(10, 30) },
      { key: 'a', start: at(9), end: at(10, 30) },
      { key: 'b', start: at(9, 30), end: at(11) },
      { key: 'd', start: at(11), end: at(12) },
    ])
    expect(got.get('a')).toEqual({ depth: 0, indentPx: 0, col: 0, cols: 1 })
    expect(got.get('b')).toEqual({ depth: 1, indentPx: 14, col: 0, cols: 1 })
    expect(got.get('c')).toEqual({ depth: 2, indentPx: 28, col: 0, cols: 1 })
    expect(got.get('d')).toEqual({ depth: 0, indentPx: 0, col: 0, cols: 1 })
  })

  it('只压在仍在进行的那条上:前面的结束了就退回它的上一层', () => {
    const got = layoutTimedEvents([
      { key: 'long', start: at(9), end: at(12) },
      { key: 'x', start: at(9, 30), end: at(10) },
      { key: 'y', start: at(10, 30), end: at(11) },
    ])
    expect(got.get('x')?.depth).toBe(1)
    expect(got.get('y')?.depth).toBe(1)
  })

  it('第 5 层起不再错开', () => {
    const got = layoutTimedEvents([0, 1, 2, 3, 4, 5].map((i) => ({ key: `e${i}`, start: at(9, i * 10), end: at(12) })))
    expect([0, 1, 2, 3, 4, 5].map((i) => got.get(`e${i}`)?.indentPx)).toEqual([0, 14, 28, 42, 42, 42])
  })

  it('同一时刻开始的在本层等宽分栏,后来的照样错开', () => {
    const got = layoutTimedEvents([
      { key: 'a', start: at(9), end: at(10) },
      { key: 'b', start: at(9), end: at(11) },
      { key: 'c', start: at(9, 30), end: at(10) },
    ])
    expect(got.get('b')).toEqual({ depth: 0, indentPx: 0, col: 0, cols: 2 }) // 长的在前
    expect(got.get('a')).toEqual({ depth: 0, indentPx: 0, col: 1, cols: 2 })
    expect(got.get('c')).toEqual({ depth: 1, indentPx: 14, col: 0, cols: 1 })
  })

  it('无结束时间按一小时参与碰撞', () => {
    const got = layoutTimedEvents([
      { key: 'a', start: at(9), end: null },
      { key: 'b', start: at(9, 45), end: at(10, 15) },
    ])
    expect(got.get('b')?.depth).toBe(1)
  })
})

describe('layoutMonthWeek', () => {
  const day = (d: number, h = 0) => new Date(2026, 9, d, h)
  const days = [25, 26, 27, 28, 29, 30, 31].map((d) => day(d))
  const ev = (key: string, s: Date, e: Date | null, allDay: boolean) => ({ key, start: s, end: e, allDay })

  it('跨天条先占行、同一行对齐;再单日全天;最后定时', () => {
    const timed = ev('t', day(26, 9), day(26, 10), false)
    const release = ev('rel', day(26), null, true)
    const workshop = ev('ws', day(25), day(27), true)
    const rows = layoutMonthWeek([timed, release, workshop], days)
    expect(rows[0].map((e) => e?.key)).toEqual(['ws'])
    expect(rows[1].map((e) => e?.key)).toEqual(['ws', 'rel', 't'])
    expect(rows[2].map((e) => e?.key)).toEqual(['ws'])
    expect(rows[3]).toEqual([])
  })

  it('某天这一行没有条时留空位,跨天条行号不变', () => {
    const a = ev('a', day(25), day(26), true)
    const b = ev('b', day(25), day(28), true)
    const rows = layoutMonthWeek([a, b], days)
    expect(rows[0].map((e) => e?.key)).toEqual(['b', 'a'])
    expect(rows[2].map((e) => e?.key)).toEqual(['b'])
  })

  it('单日全天不补跨天条的空位(不排到跨天条上面)', () => {
    const a = ev('a', day(25), day(26), true)
    const b = ev('b', day(26), day(27), true)
    const c = ev('c', day(27), null, true)
    const rows = layoutMonthWeek([c, b, a], days)
    expect(rows[1].map((e) => e?.key)).toEqual(['a', 'b'])
    expect(rows[2].map((e) => e?.key ?? null)).toEqual([null, 'b', 'c'])
  })

  it('从上一周延续过来的条也进这一行;跨天的定时事件按条画', () => {
    const fromPrev = ev('p', day(23), day(25), true)
    const overnight = ev('o', day(27, 22), day(28, 2), false)
    const rows = layoutMonthWeek([overnight, fromPrev], days)
    expect(rows[0].map((e) => e?.key)).toEqual(['p'])
    expect(rows[2].map((e) => e?.key)).toEqual(['o'])
    expect(rows[3].map((e) => e?.key)).toEqual(['o'])
  })

  it('浮层顺序:全天在前再按开始时间', () => {
    const list = agendaOrder([ev('t2', day(26, 10), null, false), ev('t1', day(26, 9), null, false), ev('all', day(26), null, true)])
    expect(list.map((e) => e.key)).toEqual(['all', 't1', 't2'])
  })
})
