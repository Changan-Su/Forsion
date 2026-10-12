import { describe, expect, it } from 'vitest'
import { rankRefs } from './refRank'

const note = (p: string) => ({ p, note: true as const })
const file = (p: string) => ({ p })
const names = (xs: Array<{ p: string }>): string[] => xs.map((x) => x.p)

describe('rankRefs(聊天 [[ 引用候选)', () => {
  const cands = [note('moc/MOC-Forsion.md'), note('日记/2026-10-12 周会纪要.md'), file('src/wikiRank.ts'), file('docs/forsion/readme.md'), file('src/other.ts')]

  it('原样包含的档位不变:名字前缀 > 名字包含 > 仅路径包含', () => {
    expect(names(rankRefs(cands, 'forsion'))).toEqual(['moc/MOC-Forsion.md', 'docs/forsion/readme.md'])
    expect(names(rankRefs([file('a/xread.md'), file('read/zz.md'), file('b/readme.md')], 'read'))).toEqual(['b/readme.md', 'a/xread.md', 'read/zz.md'])
  })

  it('实报:只认连续子串 —— 多一个空格 / 少几个字也要找得到', () => {
    expect(names(rankRefs(cands, 'moc forsion'))).toEqual(['moc/MOC-Forsion.md'])
    expect(names(rankRefs(cands, 'wkrank'))).toEqual(['src/wikiRank.ts'])
    expect(names(rankRefs(cands, '周会纪'))).toEqual(['日记/2026-10-12 周会纪要.md'])
    expect(names(rankRefs(cands, '10 周会'))).toEqual(['日记/2026-10-12 周会纪要.md'])
  })

  it('模糊命中只补位,排在原样命中后面;只比名字,不比整条路径', () => {
    // 'frs':没有谁原样包含;MOC-Forsion 名字里按序有 f-r-s;readme 只有路径(forsion/)里有 → 不出
    // (菜单开着 Enter 是选中不是发送,路径子序列太容易命中,会把发送键扣住)
    expect(names(rankRefs(cands, 'frs'))).toEqual(['moc/MOC-Forsion.md'])
    expect(rankRefs(cands, '这句只是正文里随手打的两个方括号')).toEqual([])
    // 'other' 原样命中 other.ts;模糊的不许挤到它前面
    expect(names(rankRefs([file('o-t-h-e-r.md'), file('src/other.ts')], 'other'))).toEqual(['src/other.ts', 'o-t-h-e-r.md'])
  })

  it('字符凑不齐的仍然不出;空查询保持原行为(路径短者先)', () => {
    expect(rankRefs(cands, 'zzq')).toEqual([])
    // 只有分隔符的查询:模糊那边会把它归一成空串(= 全命中),不许拿来补位
    for (const sep of ['---', '..', '__', '//']) expect(rankRefs([note('Alpha.md')], sep)).toEqual([])
    expect(names(rankRefs([note('Alpha.md'), note('a-b.md')], '-'))).toEqual(['a-b.md'])
    expect(names(rankRefs([file('long/path/a.ts'), file('b.ts')], ''))).toEqual(['b.ts', 'long/path/a.ts'])
  })

  it('封顶 limit 条:原样命中够数就不再跑模糊', () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`ab${i}.ts`))
    expect(rankRefs([...many, file('a-b.ts')], 'ab')).toHaveLength(10)
    expect(names(rankRefs([...many, file('a-b.ts')], 'ab'))).not.toContain('a-b.ts')
  })
})
