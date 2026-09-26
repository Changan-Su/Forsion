/**
 * 日历日期的渲染层格式化(Codex 第三轮 R2-e2-1):Muse 追踪日程改走月日格式后丢了年份 —— 跨年日程、不同年份
 * 同月同日的条目显示成同一天,用户可能删错追踪项。带年份版 fmtCalDateYL 两种语言都要有年份,区间两侧都带。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setLocaleGlobal } from '../../i18n'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { fmtCalDateL, fmtCalDateYL } from './calDateFmt'

afterEach(() => setLocaleGlobal('zh'))

describe('fmtCalDateYL', () => {
  it('zh / en 都带年份,时刻与区间照旧', () => {
    setLocaleGlobal('zh')
    expect(fmtCalDateYL(parseCalDate('2027-01-05T09:00'))).toBe('2027年1月5日 09:00')
    expect(fmtCalDateYL(parseCalDate('2026-12-30/2027-01-02'))).toBe('2026年12月30日 → 2027年1月2日')
    setLocaleGlobal('en')
    expect(fmtCalDateYL(parseCalDate('2027-01-05T09:00'))).toBe('1/5/2027 09:00')
    expect(fmtCalDateYL(parseCalDate('2026-12-30/2027-01-02'))).toBe('12/30/2026 → 1/2/2027')
  })
  it('不同年份的同月同日分得开;不带年份的 fmtCalDateL 行为不变', () => {
    const a = parseCalDate('2026-03-01')
    const b = parseCalDate('2027-03-01')
    expect(fmtCalDateYL(a)).not.toBe(fmtCalDateYL(b))
    expect(fmtCalDateL(a)).toBe('3月1日')
  })
  it('Muse 的追踪日程用带年份的格式化', () => {
    const src = readFileSync(join(__dirname, '../../components/MuseView.tsx'), 'utf8')
    expect(src).toContain('fmtCalDateYL(parseCalDate(e.date))')
    expect(src).not.toMatch(/\bfmtCalDateL\(/)
  })
})
