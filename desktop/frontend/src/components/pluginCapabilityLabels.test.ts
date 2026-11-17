// 能力说法与「没在这一版上验过」的标注(2026-11-16)。
import { describe, expect, it } from 'vitest'
import { capabilityLabels, internalsUnverified } from './pluginCapabilityLabels'

const t = (k: string) => k.replace('settings.amadeusPlugins.', '')

describe('capabilityLabels', () => {
  it('按固定顺序列;白名单外的不列;只声明第二级不列(不生效)', () => {
    expect(capabilityLabels(['internals-raw', 'databases', 'weird', 'internals'], t)).toEqual(['capDatabases', 'capInternals', 'capInternalsRaw'])
    expect(capabilityLabels(['internals-raw'], t)).toEqual([])
    expect(capabilityLabels(null, t)).toEqual([])
  })
})

describe('internalsUnverified', () => {
  it('没声明内部接口:不标', () => {
    expect(internalsUnverified({ capabilities: ['databases'] }, '2.14.2')).toBe(false)
  })
  it('只比到次版本;没写 = 没验过', () => {
    expect(internalsUnverified({ capabilities: ['internals'], internalsVerified: ['2.14'] }, '2.14.2')).toBe(false)
    expect(internalsUnverified({ capabilities: ['internals'], internalsVerified: ['2.13'] }, '2.14.0')).toBe(true)
    expect(internalsUnverified({ capabilities: ['internals'] }, '2.14.0')).toBe(true)
  })
})
