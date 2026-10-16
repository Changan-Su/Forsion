import { describe, expect, it } from 'vitest'
import { parseQuickAdd } from './nlDate'

// 2026-10-16 是周五
const NOW = new Date(2026, 9, 16, 11, 20)
const p = (s: string) => parseQuickAdd(s, NOW)

describe('parseQuickAdd', () => {
  it('中文相对日期与时刻', () => {
    expect(p('明天下午3点开会')).toEqual({ title: '开会', value: '2026-10-17T15:00' })
    expect(p('后天 交周报')).toEqual({ title: '交周报', value: '2026-10-18' })
    expect(p('大后天上午十点半 体检')).toEqual({ title: '体检', value: '2026-10-19T10:30' })
    expect(p('今晚8点 打电话')).toEqual({ title: '打电话', value: '2026-10-16T20:00' })
  })
  it('周X 与下周X(周一起算的下一个自然周)', () => {
    expect(p('周五 复盘').value).toBe('2026-10-16') // 今天就是周五
    expect(p('周一 交报告').value).toBe('2026-10-19')
    expect(p('下周一 交周报')).toEqual({ title: '交周报', value: '2026-10-19' })
    expect(p('下周五').value).toBe('2026-10-23')
  })
  it('绝对日期;没写年份且已过去 = 明年', () => {
    expect(p('10/20 体检')).toEqual({ title: '体检', value: '2026-10-20' })
    expect(p('10月20日体检')).toEqual({ title: '体检', value: '2026-10-20' })
    expect(p('1月5日 续签').value).toBe('2027-01-05')
    expect(p('2026-11-02 出差').value).toBe('2026-11-02')
    expect(p('2/30 不存在').value).toBeNull()
  })
  it('只有时刻 = 今天;24 小时制与 am/pm', () => {
    expect(p('15:30 站会')).toEqual({ title: '站会', value: '2026-10-16T15:30' })
    expect(p('3pm call')).toEqual({ title: 'call', value: '2026-10-16T15:00' })
  })
  it('英文', () => {
    expect(p('Call mom tomorrow at 3pm')).toEqual({ title: 'Call mom', value: '2026-10-17T15:00' })
    expect(p('Review next friday').value).toBe('2026-10-23')
    expect(p('Plan monday').value).toBe('2026-10-19')
    expect(p('Fix monitor').value).toBeNull() // mon 只认整词
  })
  it('认不出就原样当标题', () => {
    expect(p('买牛奶')).toEqual({ title: '买牛奶', value: null })
  })
})
