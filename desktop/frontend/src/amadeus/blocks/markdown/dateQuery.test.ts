import { describe, expect, it } from 'vitest'
import { dateCandidates, parseDateQuery } from './dateQuery'

const NOW = new Date(2026, 8, 1, 10, 0) // 2026-09-01 周二
const p = (q: string) => parseDateQuery(q, NOW)

describe('parseDateQuery', () => {
  it('纯数字时刻 → 今天那个点(Notion 的 @2200 同款)', () => {
    expect(p('2200')).toBe('2026-09-01T22:00')
    expect(p('930')).toBe('2026-09-01T09:30')
    expect(p('9:30')).toBe('2026-09-01T09:30')
  })

  it('月-日 → 今年;可带时刻', () => {
    expect(p('9-1')).toBe('2026-09-01')
    expect(p('12-25T20:00')).toBe('2026-12-25T20:00')
  })

  it('完整日期原样规范化', () => {
    expect(p('2027-1-3')).toBe('2027-01-03')
    expect(p('2026-09-01T14:30')).toBe('2026-09-01T14:30')
  })

  it('关键词', () => {
    expect(p('今天')).toBe('2026-09-01')
    expect(p('明天')).toBe('2026-09-02')
    expect(p('tomorrow')).toBe('2026-09-02')
    expect(p('后天')).toBe('2026-09-03')
  })

  it('负对照:认不出的一律 null(不许瞎猜)', () => {
    for (const q of ['', 'foo', '25:00', '13-40', '9', '99999', '下周三']) expect(p(q)).toBeNull()
  })

  // ⚠️ 只查 1–12 / 1–31 是不够的:造出来的日期会被 Date 归一化到下个月,
  //    提示文案(按字符串排版)与日历落点(按 Date)当场对不上(Codex 对抗评审)。
  it('负对照:不存在的日期不许造出来(平年 2-29 / 4-31 / 6-31)', () => {
    for (const q of ['2-29', '4-31', '6-31', '2026-02-30']) expect(p(q)).toBeNull()
    expect(dateCandidates('2-29', NOW)).toEqual([])
  })

  it('闰年 2-29 正常给', () => {
    expect(parseDateQuery('2-29', new Date(2028, 0, 1))).toBe('2028-02-29')
  })
})

describe('dateCandidates', () => {
  it('两条:日程 + 提醒;全天的提醒落在 09:00', () => {
    const c = dateCandidates('9-1', NOW)
    expect(c.map((x) => x.insert)).toEqual(['@2026-09-01', '@remind:2026-09-01T09:00'])
    expect(c[0].hint).toBe('9月1日')
  })

  it('带时刻时提醒就用那个时刻', () => {
    expect(dateCandidates('2200', NOW)[1].insert).toBe('@remind:2026-09-01T22:00')
  })

  it('查询已写 remind: → 只给提醒一条', () => {
    expect(dateCandidates('remind:2200', NOW).map((x) => x.insert)).toEqual(['@remind:2026-09-01T22:00'])
  })

  it('认不出 → 空(面板照旧只显示页面候选)', () => {
    expect(dateCandidates('会议纪要', NOW)).toEqual([])
  })

  it('插入串必须能被正文解析器认出(与 mdMarks 互锁)', async () => {
    const { parseMdMarks } = await import('@amadeus-shared/mdMarks')
    const [sched, remind] = dateCandidates('2200', NOW)
    expect(parseMdMarks(`周会 ${sched.insert}`, 'n.md', 'n')[0]).toMatchObject({ due: '2026-09-01T22:00', isTask: false })
    expect(parseMdMarks(`- [ ] 吃药 ${remind.insert}`, 'n.md', 'n')[0]).toMatchObject({ remind: '2026-09-01T22:00', isTask: true })
  })
})
