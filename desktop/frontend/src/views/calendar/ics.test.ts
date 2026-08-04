import { describe, expect, it } from 'vitest'
import { icsCalendarName, looksLikeIcs, parseIcs } from './ics'

const wrap = (body: string): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`
const ev = (lines: string): string => `BEGIN:VEVENT\r\n${lines}\r\nEND:VEVENT`

describe('parseIcs 基本事件', () => {
  it('定时事件(浮动时间按本地读)', () => {
    const r = parseIcs(wrap(ev('UID:a\r\nSUMMARY:站会\r\nDTSTART:20260803T090000\r\nDTEND:20260803T093000')))
    expect(r).toEqual([{ uid: 'a', summary: '站会', location: undefined, allDay: false, start: '2026-08-03T09:00', end: '2026-08-03T09:30' }])
  })

  it('全天事件:DTEND 是排他的,要减回一天', () => {
    const r = parseIcs(wrap(ev('UID:b\r\nSUMMARY:年假\r\nDTSTART;VALUE=DATE:20260803\r\nDTEND;VALUE=DATE:20260806')))
    expect(r[0]).toMatchObject({ allDay: true, start: '2026-08-03', end: '2026-08-05' })
  })

  it('单日全天事件没有 end(减完为 0 长度)', () => {
    const r = parseIcs(wrap(ev('UID:c\r\nSUMMARY:生日\r\nDTSTART;VALUE=DATE:20260803\r\nDTEND;VALUE=DATE:20260804')))
    expect(r[0]).toMatchObject({ allDay: true, start: '2026-08-03', end: undefined })
  })

  it('DURATION 替代 DTEND', () => {
    const r = parseIcs(wrap(ev('UID:d\r\nSUMMARY:会\r\nDTSTART:20260803T140000\r\nDURATION:PT1H30M')))
    expect(r[0]).toMatchObject({ start: '2026-08-03T14:00', end: '2026-08-03T15:30' })
  })

  it('UTC(带 Z)换算到本地', () => {
    const r = parseIcs(wrap(ev('UID:e\r\nSUMMARY:x\r\nDTSTART:20260803T000000Z')))
    const local = new Date(Date.UTC(2026, 7, 3, 0, 0, 0))
    const p = (n: number): string => String(n).padStart(2, '0')
    expect(r[0].start).toBe(`${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())}T${p(local.getHours())}:${p(local.getMinutes())}`)
  })

  it('折行还原 + TEXT 转义还原', () => {
    const r = parseIcs(wrap(ev('UID:f\r\nSUMMARY:很长的标\r\n 题\\, 带逗号\r\nDTSTART:20260803T090000')))
    expect(r[0].summary).toBe('很长的标题, 带逗号')
  })

  it('参数值里的冒号不误当分隔符', () => {
    const r = parseIcs(wrap(ev('UID:g\r\nSUMMARY;ALTREP="cid:x@y":标题\r\nDTSTART:20260803T090000')))
    expect(r[0].summary).toBe('标题')
  })

  it('没有 DTSTART 的条目直接丢掉', () => {
    expect(parseIcs(wrap(ev('UID:h\r\nSUMMARY:坏数据')))).toEqual([])
  })
})

describe('parseIcs RRULE 展开', () => {
  const win = { from: new Date(2026, 7, 1), to: new Date(2026, 8, 30) }

  it('每日 + COUNT', () => {
    const r = parseIcs(wrap(ev('UID:r1\r\nSUMMARY:每日\r\nDTSTART:20260803T090000\r\nRRULE:FREQ=DAILY;COUNT=3')), win)
    expect(r.map((x) => x.start)).toEqual(['2026-08-03T09:00', '2026-08-04T09:00', '2026-08-05T09:00'])
  })

  it('每周 BYDAY 两天 + UNTIL', () => {
    const r = parseIcs(wrap(ev('UID:r2\r\nSUMMARY:周会\r\nDTSTART:20260803T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260812T235959')), win)
    // 2026-08-03 是周一
    expect(r.map((x) => x.start)).toEqual([
      '2026-08-03T10:00', '2026-08-05T10:00',
      '2026-08-10T10:00', '2026-08-12T10:00',
    ])
  })

  it('INTERVAL=2 隔周', () => {
    const r = parseIcs(wrap(ev('UID:r3\r\nSUMMARY:双周\r\nDTSTART:20260803T100000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3')), win)
    expect(r.map((x) => x.start)).toEqual(['2026-08-03T10:00', '2026-08-17T10:00', '2026-08-31T10:00'])
  })

  it('每月遇到不存在的日子按 RFC 跳过(不顺延到下月 1 号)', () => {
    const r = parseIcs(
      wrap(ev('UID:r4\r\nSUMMARY:月末\r\nDTSTART:20260131T090000\r\nRRULE:FREQ=MONTHLY;COUNT=3')),
      { from: new Date(2026, 0, 1), to: new Date(2026, 5, 30) },
    )
    // RFC 5545:不存在的日子跳过且**不计入 COUNT** → 1/31、3/31、5/31
    expect(r.map((x) => x.start)).toEqual(['2026-01-31T09:00', '2026-03-31T09:00', '2026-05-31T09:00'])
  })

  it('EXDATE 剔除指定的那一次', () => {
    const r = parseIcs(wrap(ev('UID:r5\r\nSUMMARY:每日\r\nDTSTART:20260803T090000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:20260804T090000')), win)
    expect(r.map((x) => x.start)).toEqual(['2026-08-03T09:00', '2026-08-05T09:00'])
  })

  it('RECURRENCE-ID 改期:母序列剔掉那次,改后的作为独立事件', () => {
    const body = [
      ev('UID:r6\r\nSUMMARY:每日\r\nDTSTART:20260803T090000\r\nRRULE:FREQ=DAILY;COUNT=3'),
      ev('UID:r6\r\nSUMMARY:每日(改到下午)\r\nRECURRENCE-ID:20260804T090000\r\nDTSTART:20260804T150000'),
    ].join('\r\n')
    const r = parseIcs(wrap(body), win)
    expect(r.map((x) => `${x.start} ${x.summary}`).sort()).toEqual([
      '2026-08-03T09:00 每日',
      '2026-08-04T15:00 每日(改到下午)',
      '2026-08-05T09:00 每日',
    ])
  })

  it('窗口外的循环不展开(无限规则不会跑飞)', () => {
    const r = parseIcs(wrap(ev('UID:r7\r\nSUMMARY:无限每日\r\nDTSTART:20260803T090000\r\nRRULE:FREQ=DAILY')), {
      from: new Date(2026, 7, 3),
      to: new Date(2026, 7, 5),
    })
    expect(r).toHaveLength(3)
  })

  it('不认识的 FREQ 退化成单次事件', () => {
    const r = parseIcs(wrap(ev('UID:r8\r\nSUMMARY:x\r\nDTSTART:20260803T090000\r\nRRULE:FREQ=SECONDLY')), win)
    expect(r).toHaveLength(1)
  })
})

describe('icsCalendarName', () => {
  it('读 X-WR-CALNAME', () => {
    expect(icsCalendarName('BEGIN:VCALENDAR\r\nX-WR-CALNAME:我的日历\r\nEND:VCALENDAR')).toBe('我的日历')
  })
  it('没有就 undefined', () => {
    expect(icsCalendarName('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBeUndefined()
  })
})

// ── Codex 评审查出的一批。日期 bug 只在特定时区复现,**必须跨时区跑**:`npm run test:ics-tz` ──
describe('parseIcs 夏令时与秒(Codex 评审)', () => {
  it('全天事件跨春季夏令时:必须按日历日减,不是减 86400000ms', () => {
    // 2026-03-29 是 Europe/London 的春季切换日,3/28→3/30 只有 47 小时。
    const r = parseIcs(wrap(ev('UID:d1\r\nSUMMARY:春假\r\nDTSTART;VALUE=DATE:20260328\r\nDTEND;VALUE=DATE:20260330')), {
      from: new Date(2026, 2, 1),
      to: new Date(2026, 3, 30),
    })
    expect(r[0]).toMatchObject({ start: '2026-03-28', end: '2026-03-29' })
  })

  it('UTC(Z)锚定的循环在 UTC 上推:本地墙钟该变就得变', () => {
    const r = parseIcs(wrap(ev('UID:d2\r\nSUMMARY:周会\r\nDTSTART:20260322T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3')), {
      from: new Date(2026, 2, 1),
      to: new Date(2026, 3, 30),
    })
    // 每次都是 UTC 09:00;换算到本地后,跨夏令时的那几次墙钟会整体挪一小时
    const utcHours = r.map((x) => {
      const [d, hm] = x.start.split('T')
      const [Y, M, D] = d.split('-').map(Number)
      const [h, m] = hm.split(':').map(Number)
      return new Date(Y, M - 1, D, h, m).toISOString().slice(11, 16)
    })
    expect(utcHours).toEqual(['09:00', '09:00', '09:00'])
    expect(r.map((x) => x.start.slice(0, 10))).toEqual(['2026-03-22', '2026-03-29', '2026-04-05'])
  })

  it('DTSTART 带非零秒:首次出现不能被自己滤掉', () => {
    const r = parseIcs(wrap(ev('UID:d3\r\nSUMMARY:秒\r\nDTSTART:20260803T090030\r\nRRULE:FREQ=DAILY;COUNT=2')), {
      from: new Date(2026, 7, 1),
      to: new Date(2026, 7, 30),
    })
    expect(r.map((x) => x.start)).toEqual(['2026-08-03T09:00', '2026-08-04T09:00'])
  })

  it('久远起点的无限规则要快进到窗口(不能空转到迭代上限)', () => {
    const r = parseIcs(wrap(ev('UID:d4\r\nSUMMARY:十年每日\r\nDTSTART:20100101T080000\r\nRRULE:FREQ=DAILY')), {
      from: new Date(2026, 7, 1),
      to: new Date(2026, 7, 5),
    })
    expect(r.map((x) => x.start)).toEqual([
      '2026-08-01T08:00', '2026-08-02T08:00', '2026-08-03T08:00', '2026-08-04T08:00', '2026-08-05T08:00',
    ])
  })
})

describe('parseIcs 健壮性(Codex 评审)', () => {
  it('VALARM 里的 SUMMARY / DURATION 不许顶掉事件自己的', () => {
    const body = ev(
      'UID:v1\r\nSUMMARY:董事会\r\nDTSTART:20260803T090000\r\nDTEND:20260803T110000\r\n' +
      'BEGIN:VALARM\r\nACTION:EMAIL\r\nTRIGGER:-PT15M\r\nDURATION:PT5M\r\nSUMMARY:会议提醒\r\nEND:VALARM',
    )
    const r = parseIcs(wrap(body))
    expect(r[0]).toMatchObject({ summary: '董事会', start: '2026-08-03T09:00', end: '2026-08-03T11:00' })
  })

  it('非法日期一律丢弃,绝不静默顺延到另一天', () => {
    expect(parseIcs(wrap(ev('UID:x1\r\nSUMMARY:非闰年2月29\r\nDTSTART;VALUE=DATE:20260229')))).toEqual([])
    expect(parseIcs(wrap(ev('UID:x2\r\nSUMMARY:25点\r\nDTSTART:20260803T250000')))).toEqual([])
    expect(parseIcs(wrap(ev('UID:x3\r\nSUMMARY:13月\r\nDTSTART;VALUE=DATE:20261301')))).toEqual([])
  })

  it('looksLikeIcs 挡得住 200 返回的登录页', () => {
    expect(looksLikeIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBe(true)
    expect(looksLikeIcs('<!doctype html><html>Sign in</html>')).toBe(false)
  })
})
