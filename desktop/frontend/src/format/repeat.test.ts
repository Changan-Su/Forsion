import { describe, expect, it } from 'vitest'
import { translateFor } from '../i18n'
import { formatRepeat } from './repeat'

const zh = (k: string, v?: Record<string, string>) => translateFor('zh', k, v)
const en = (k: string, v?: Record<string, string>) => translateFor('en', k, v)

describe('formatRepeat', () => {
  it('says the interval in words', () => {
    expect(['1d', '3d', '1h', '2h', '1w', '2w', '1m', '30m', '120m', '60m'].map((s) => formatRepeat(zh, s)))
      .toEqual(['每天', '每 3 天', '每小时', '每 2 小时', '每周', '每 2 周', '每分钟', '每 30 分钟', '每 2 小时', '每小时'])
    expect(['1d', '2h', '1w', '90m'].map((s) => formatRepeat(en, s))).toEqual(['Daily', 'Every 2 hours', 'Weekly', 'Every 90 minutes'])
  })
  it('keeps unknown shapes instead of dropping them', () => {
    expect(formatRepeat(zh, 'P1D')).toBe('每 P1D')
    expect(formatRepeat(en, '0h')).toBe('every 0h')
  })
})
