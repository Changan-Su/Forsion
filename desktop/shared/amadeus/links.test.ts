/** unescapeWikiOutsideFences:还原 remark 对 [[ 的转义,但代码围栏内逐字保留。 */
import { describe, it, expect } from 'vitest'
import { unescapeWikiOutsideFences } from './links'

describe('unescapeWikiOutsideFences', () => {
  it('围栏外的 \\[\\[ 还原为 [[(含 !\\[\\[ 嵌入)', () => {
    expect(unescapeWikiOutsideFences('去 \\[\\[目标页]] 看')).toBe('去 [[目标页]] 看')
    expect(unescapeWikiOutsideFences('!\\[\\[图.png]]')).toBe('![[图.png]]')
  })
  it('``` 围栏内逐字保留(用户真写的 \\[\\[)', () => {
    const md = '前 \\[\\[a]]\n```\n正则 \\[\\[b]] 示例\n```\n后 \\[\\[c]]'
    expect(unescapeWikiOutsideFences(md)).toBe('前 [[a]]\n```\n正则 \\[\\[b]] 示例\n```\n后 [[c]]')
  })
  it('~~~ 围栏同样跳过,且 ``` 与 ~~~ 不互相闭合', () => {
    const md = '~~~\n\\[\\[x]]\n```\n\\[\\[y]]\n~~~\n\\[\\[z]]'
    expect(unescapeWikiOutsideFences(md)).toBe('~~~\n\\[\\[x]]\n```\n\\[\\[y]]\n~~~\n[[z]]')
  })
  it('无 \\[\\[ 时原样快速返回', () => {
    const md = '普通 [[已成链]] 文本\n```\ncode\n```'
    expect(unescapeWikiOutsideFences(md)).toBe(md)
  })
})
