import { describe, expect, it } from 'vitest'
import { fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('查询里的分隔符互通(实报:moc forsion → moc-forsion)', () => {
    expect(fuzzyScore('moc forsion', 'MOC-Forsion')).not.toBeNull()
    expect(fuzzyScore('moc-forsion', 'MOC Forsion')).not.toBeNull()
    expect(fuzzyScore('moc.forsion', 'moc_forsion')).not.toBeNull()
  })

  it('缺字符仍然不命中', () => {
    expect(fuzzyScore('mocz', 'moc-forsion')).toBeNull()
  })

  it('完全相同仍拿满加分,且排在子串命中前面', () => {
    const exact = fuzzyScore('moc-forsion', 'moc-forsion') ?? -1
    const other = fuzzyScore('moc-forsion', 'moc-forsion-archive') ?? -1
    expect(exact).toBeGreaterThan(0)
    expect(other).toBeGreaterThan(0)
    expect(exact).toBeGreaterThan(other)
  })
})
