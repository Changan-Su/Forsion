import { describe, expect, it } from 'vitest'
import { searchTerms } from './vaultIndex'

// 模糊到词一级:全部词都出现即命中(顺序不论、分隔符不论)。search() 里的命中判据就是这一条。
const hit = (query: string, text: string): boolean =>
  searchTerms(query.trim().toLowerCase()).every((t) => text.toLowerCase().includes(t))

describe('searchTerms', () => {
  it('单词查询原样返回(老行为逐字节不变)', () => {
    expect(searchTerms('forsion')).toEqual(['forsion'])
    expect(searchTerms('设计文档')).toEqual(['设计文档'])
  })

  it('空格/连字符/下划线/点/斜杠互通', () => {
    expect(hit('moc forsion', 'MOC-Forsion 索引')).toBe(true)
    expect(hit('moc-forsion', 'moc forsion 索引')).toBe(true)
    expect(hit('moc_forsion', 'moc/forsion')).toBe(true)
    expect(hit('forsion moc', 'MOC-Forsion')).toBe(true) // 顺序不论
  })

  it('缺一个词就不算命中(AND 不是 OR)', () => {
    expect(hit('moc forsion', 'moc 索引')).toBe(false)
  })
})
