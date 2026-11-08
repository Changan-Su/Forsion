/**
 * Muse 面板「它给自己排的」那列时间(11-07 右栏改版):今天 / 明天写相对日 + 时刻,更远写月日,不是今年才带年份 ——
 * 跨年的同月同日照样分得开(从前一律带年份是为这个,见 calDateFmt.test.ts 的 R2-e2-1),今年的条目不再被年份占掉第一眼。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setLocaleGlobal } from '../i18n'
import { trackWhen } from './museViewFormat'

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
