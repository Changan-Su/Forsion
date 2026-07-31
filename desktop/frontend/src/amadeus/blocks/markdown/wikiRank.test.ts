import { describe, expect, it } from 'vitest'
import { pickWikiResults, type Cand } from './wikiRank'

const page = (base: string): Cand => ({ path: `${base}.md`, base, file: false })
const file = (base: string): Cand => ({ path: base, base, file: true })

// 用户实报的现场:笔记远多于 8 条,附件/数据库排在候选池尾部。
const MANY_PAGES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'].map(page)
const FILES = [file('打卡.db'), file('风景.png'), file('手册.pdf')]

describe('pickWikiResults', () => {
  it('空查询也给文件留名额(否则附件/数据库永远被页面挤掉)', () => {
    const out = pickWikiResults([...MANY_PAGES, ...FILES], '')
    expect(out).toHaveLength(8)
    expect(out.filter((c) => c.file)).toHaveLength(2)
    expect(out.filter((c) => !c.file)).toHaveLength(6) // 名额从队尾挤,页面仍占多数
  })

  it('名额是保底不是配额:文件本来就排得进去时不额外占位', () => {
    const out = pickWikiResults([...MANY_PAGES, ...FILES], '打卡')
    expect(out[0].base).toBe('打卡.db')
    expect(out.filter((c) => c.file)).toHaveLength(1) // 只有一个文件匹配,不硬凑两条
  })

  it('没有文件候选时行为与从前一致', () => {
    const out = pickWikiResults(MANY_PAGES, '')
    expect(out.map((c) => c.base)).toEqual(['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'])
  })

  it('文件少于名额时有多少给多少', () => {
    const out = pickWikiResults([...MANY_PAGES, file('唯一.png')], '')
    expect(out.filter((c) => c.file).map((c) => c.base)).toEqual(['唯一.png'])
    expect(out).toHaveLength(8)
  })

  it('不匹配的候选照旧被过滤掉', () => {
    expect(pickWikiResults([...MANY_PAGES, ...FILES], 'zzz')).toEqual([])
  })
})
