import { describe, expect, it } from 'vitest'
import { blockIdsOf, headingsOf, parseSubQuery } from './wikiSubpath'

describe('L-13 `[[笔记#…` 补全的纯逻辑', () => {
  it('parseSubQuery:# 标题 / #^ 块 / 空目标 = 本篇 / 带 | 不管', () => {
    expect(parseSubQuery('Alpha#Se')).toEqual({ name: 'Alpha', kind: 'heading', q: 'Se' })
    expect(parseSubQuery('Alpha#^ab')).toEqual({ name: 'Alpha', kind: 'block', q: 'ab' })
    expect(parseSubQuery('#')).toEqual({ name: '', kind: 'heading', q: '' })
    expect(parseSubQuery('Alpha')).toBeNull()
    expect(parseSubQuery('Alpha|al#x')).toBeNull()
  })
  it('headingsOf:剥 fm、跳过围栏里的 #,去语法与锚点语法字符', () => {
    const md = '---\ntitle: x\n---\n# 一 **粗**\n\n```sh\n# 注释\n```\n## 二 [[a|b]] ##\n### C#语言\n'
    expect(headingsOf(md)).toEqual([
      { level: 1, text: '一 粗' },
      { level: 2, text: '二 b' },
      { level: 3, text: 'C 语言' },
    ])
  })
  it('blockIdsOf:只列已有的行尾 ^id', () => {
    expect(blockIdsOf('para one ^abc\n\n```\nx ^no\n```\nplain\n- item ^i-2\n')).toEqual([
      { id: 'abc', preview: 'para one' },
      { id: 'i-2', preview: 'item' },
    ])
  })
})
