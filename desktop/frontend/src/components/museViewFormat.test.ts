/**
 * Muse 面板「它给自己排的」那列时间(11-07 右栏改版):今天 / 明天写相对日 + 时刻,更远写月日,不是今年才带年份 ——
 * 跨年的同月同日照样分得开(从前一律带年份是为这个,见 calDateFmt.test.ts 的 R2-e2-1),今年的条目不再被年份占掉第一眼。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setLocaleGlobal, translate } from '../i18n'
import { roundDuration, roundOutcome, roundTrigger, trackWhen } from './museViewFormat'
import './MuseView' // 词条登记在面板文件里

const NOW = new Date(2026, 10, 7, 12, 0).getTime()
afterEach(() => setLocaleGlobal('zh'))

describe('trackWhen', () => {
  it('今天 / 明天写相对日 + 时刻', () => {
    setLocaleGlobal('zh')
    expect(trackWhen('2026-11-07T20:00', NOW)).toBe('今天 20:00')
    expect(trackWhen('2026-11-08T07:30', NOW)).toBe('明天 07:30')
    setLocaleGlobal('en')
    expect(trackWhen('2026-11-07T20:00', NOW)).toBe('Today 20:00') // 单独成列,句首大写
  })
  it('今年更远的不带年份,跨年的带年份(同月同日分得开)', () => {
    setLocaleGlobal('zh')
    const later = trackWhen('2026-11-20T09:00', NOW)
    expect(later).toContain('09:00')
    expect(later).not.toContain('2026')
    expect(trackWhen('2027-11-20T09:00', NOW)).toContain('2027')
    expect(trackWhen('2027-11-20T09:00', NOW)).not.toBe(later)
  })
  it('全天条目只写日期,同样不是今年才带年份', () => {
    setLocaleGlobal('zh')
    expect(trackWhen('2026-11-20', NOW)).not.toMatch(/\d{2}:\d{2}|2026/)
    expect(trackWhen('2027-03-01', NOW)).toContain('2027')
  })
  it('读不懂的原样给回去', () => {
    expect(trackWhen('someday', NOW)).toBe('someday')
  })
  it('区间两侧都写:同一天的时段、跨天、一侧全天一侧带时刻都不丢、不空', () => {
    setLocaleGlobal('zh')
    expect(trackWhen('2026-11-07T20:00/2026-11-07T21:00', NOW)).toBe('今天 20:00–21:00')
    expect(trackWhen('2026-11-07T20:00/2026-11-07T22:00', NOW)).toBe('今天 20:00–22:00')
    expect(trackWhen('2026-11-07T20:00/2026-11-08T09:00', NOW)).toBe('今天 20:00 → 明天 09:00')
    const mixed = trackWhen('2026-11-07/2026-11-08T09:00', NOW)
    expect(mixed).toMatch(/→ 明天 09:00$/)
    expect(mixed.startsWith(' ')).toBe(false)
  })
})

// 「最近几轮」(11-08):时间 · 怎么醒的 · 用了多久,下一行写了几个文件 / 提了几条待办
describe('最近几轮', () => {
  const t = (k: string, v?: Record<string, string | number>): string => translate(k, v as Record<string, string>)
  const names: Record<string, string> = { t1: '打开 Figma 时提醒' }
  it('怎么醒的:叫醒 / 心跳 / 规则按 id 取名(删了的只写「规则」)/ 日程写第一条;没记 → 空', () => {
    setLocaleGlobal('zh')
    expect(roundTrigger('manual', t, (id) => names[id])).toBe('你叫醒的')
    expect(roundTrigger('heartbeat', t, (id) => names[id])).toBe('心跳')
    expect(roundTrigger('rule:t1+t2', t, (id) => names[id])).toBe('规则「打开 Figma 时提醒」')
    expect(roundTrigger('rule:gone', t, (id) => names[id])).toBe('规则')
    expect(roundTrigger('schedule:Weekly loadout review+Read', t, (id) => names[id])).toBe('日程「Weekly loadout review」')
    expect(roundTrigger(null, t, (id) => names[id])).toBe('')
    setLocaleGlobal('en')
    expect(roundTrigger('manual', t, (id) => names[id])).toBe('You woke it')
  })
  it('用时:秒 / 分钟 / 小时', () => {
    setLocaleGlobal('zh')
    expect(roundDuration(400, t)).toBe('1 秒')
    expect(roundDuration(42_000, t)).toBe('42 秒')
    expect(roundDuration(90_000, t)).toBe('2 分钟')
    expect(roundDuration(3_900_000, t)).toBe('1 小时 5 分')
    expect(roundDuration(-1, t)).toBe('')
    setLocaleGlobal('en')
    expect(roundDuration(90_000, t)).toBe('2 min')
  })
  it('做了什么:文件 / 待办单复数;都没有写一句;失败写原因', () => {
    setLocaleGlobal('en')
    expect(roundOutcome({ status: 'done', files: 1, todos: 2, error: null }, t)).toBe('Wrote 1 file · Added 2 to-dos')
    expect(roundOutcome({ status: 'done', files: 0, todos: 0, error: null }, t)).toBe('No files written, no to-dos')
    setLocaleGlobal('zh')
    expect(roundOutcome({ status: 'done', files: 3, todos: 0, error: null }, t)).toBe('写了 3 个文件')
    expect(roundOutcome({ status: 'failed', files: 0, todos: 0, error: 'upstream 529' }, t)).toBe('没跑完：upstream 529')
    expect(roundOutcome({ status: 'aborted', files: 0, todos: 0, error: null }, t)).toBe('被停下了')
  })
})
