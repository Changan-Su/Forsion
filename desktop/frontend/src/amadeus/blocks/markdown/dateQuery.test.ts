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

  it('Notion 式常用日期写法:斜杠 / 点号 / 中文年月日 / 8 位数字', () => {
    expect(p('9/10')).toBe('2026-09-10')
    expect(p('9.10')).toBe('2026-09-10')
    expect(p('9月10日')).toBe('2026-09-10')
    expect(p('2027/1/3')).toBe('2027-01-03')
    expect(p('2027.1.3')).toBe('2027-01-03')
    expect(p('2027年1月3日')).toBe('2027-01-03')
    expect(p('20270103')).toBe('2027-01-03')
    expect(p('９／１０')).toBe('2026-09-10')
  })

  it('只输日号 → 最近一次该日（已经过去则顺延到下月）', () => {
    expect(p('9')).toBe('2026-09-09')
    expect(p('9日')).toBe('2026-09-09')
    expect(p('9号')).toBe('2026-09-09')
    expect(p('1')).toBe('2026-09-01')
    expect(parseDateQuery('9', new Date(2026, 8, 10))).toBe('2026-10-09')
    expect(p('31')).toBe('2026-10-31')
  })

  it('常用时刻写法和日期 + 时刻组合', () => {
    expect(p('9点')).toBe('2026-09-01T09:00')
    expect(p('9点30')).toBe('2026-09-01T09:30')
    expect(p('9pm')).toBe('2026-09-01T21:00')
    expect(p('9/10T14:30')).toBe('2026-09-10T14:30')
    expect(p('9月10日14点30分')).toBe('2026-09-10T14:30')
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
    for (const q of ['', 'foo', '25:00', '24点', '13pm', '13-40', '0', '32', '99999', '下周三']) expect(p(q)).toBeNull()
  })

  // ⚠️ 只查 1–12 / 1–31 是不够的:造出来的日期会被 Date 归一化到下个月,
  //    提示文案(按字符串排版)与日历落点(按 Date)当场对不上(Codex 对抗评审)。
  it('负对照:不存在的日期不许造出来(平年 2-29 / 4-31 / 6-31)', () => {
    for (const q of ['2-29', '4/31', '6.31', '2026-02-30', '20260230', '2026年2月29日']) expect(p(q)).toBeNull()
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

  it('斜杠日期与裸日号也能直接给日期选项', () => {
    expect(dateCandidates('9/10', NOW).map((x) => x.insert)).toEqual([
      '@2026-09-10',
      '@remind:2026-09-10T09:00',
    ])
    expect(dateCandidates('9', NOW)[0].insert).toBe('@2026-09-09')
  })

  it('带时刻时提醒就用那个时刻', () => {
    expect(dateCandidates('2200', NOW)[1].insert).toBe('@remind:2026-09-01T22:00')
  })

  it('查询已写 remind: → 只给提醒一条', () => {
    expect(dateCandidates('remind:2200', NOW).map((x) => x.insert)).toEqual(['@remind:2026-09-01T22:00'])
  })

  it('认不出 → 空(面板照旧只显示页面候选)', () => {
    for (const q of ['会议纪要', 'z', 'foo', 'x']) expect(dateCandidates(q, NOW)).toEqual([])
  })

  // 2026-09-05 用户实报「@ 后面没有轻易触发日期」:对标 Notion 的 `@r` → Remind me / `@tod` → Today。
  it('关键词前缀直达:@r → 提醒(明天 09:00);@t → 今天 + 明天;中文同款', () => {
    expect(dateCandidates('r', NOW).map((x) => [x.label, x.insert])).toEqual([['提醒', '@remind:2026-09-02T09:00']])
    expect(dateCandidates('REM', NOW).map((x) => x.insert)).toEqual(['@remind:2026-09-02T09:00'])
    expect(dateCandidates('t', NOW).map((x) => [x.label, x.insert])).toEqual([
      ['今天', '@2026-09-01'],
      ['明天', '@2026-09-02'],
    ])
    expect(dateCandidates('tom', NOW).map((x) => x.insert)).toEqual(['@2026-09-02'])
    expect(dateCandidates('明', NOW).map((x) => x.label)).toEqual(['明天'])
    expect(dateCandidates('提', NOW).map((x) => x.label)).toEqual(['提醒'])
  })

  it('裸 @(空查询)= 今天 / 明天 / 提醒 三条全给;整词 today 与前缀 toda 同一条(标签不在最后一字翻脸)', () => {
    expect(dateCandidates('', NOW).map((x) => x.label)).toEqual(['今天', '明天', '提醒'])
    expect(dateCandidates('today', NOW)).toEqual(dateCandidates('toda', NOW))
  })

  it('@remind: 后面什么都没写 → 明天 09:00;写了认不出的 → 空', () => {
    expect(dateCandidates('remind:', NOW).map((x) => x.insert)).toEqual(['@remind:2026-09-02T09:00'])
    expect(dateCandidates('remind:foo', NOW)).toEqual([])
  })

  it('关键词行插入串也必须能被正文解析器认出(与 mdMarks 互锁)', async () => {
    const { parseMdMarks } = await import('@amadeus-shared/mdMarks')
    const [today, , remind] = dateCandidates('', NOW)
    expect(parseMdMarks(`周会 ${today.insert}`, 'n.md', 'n')[0]).toMatchObject({ due: '2026-09-01', isTask: false })
    expect(parseMdMarks(`- [ ] 吃药 ${remind.insert}`, 'n.md', 'n')[0]).toMatchObject({ remind: '2026-09-02T09:00', isTask: true })
  })

  it('插入串必须能被正文解析器认出(与 mdMarks 互锁)', async () => {
    const { parseMdMarks } = await import('@amadeus-shared/mdMarks')
    const [sched, remind] = dateCandidates('2200', NOW)
    expect(parseMdMarks(`周会 ${sched.insert}`, 'n.md', 'n')[0]).toMatchObject({ due: '2026-09-01T22:00', isTask: false })
    expect(parseMdMarks(`- [ ] 吃药 ${remind.insert}`, 'n.md', 'n')[0]).toMatchObject({ remind: '2026-09-01T22:00', isTask: true })
  })
})
