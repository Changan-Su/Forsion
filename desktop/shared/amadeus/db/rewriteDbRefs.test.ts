import { describe, expect, it } from 'vitest'
import { rewriteDbRefs } from './rewriteDbRefs'

const opts = { oldRel: 'notes/sub/a.db', newBase: 'b.db', pageDir: 'notes' }

describe('rewriteDbRefs', () => {
  it('裸 basename 命中并保留 ! 前缀', () => {
    expect(rewriteDbRefs('前 ![[a.db]] 后', { oldRel: 'a.db', newBase: 'b.db', pageDir: '.' })).toBe('前 ![[b.db]] 后')
    expect(rewriteDbRefs('[[a.db]]', { oldRel: 'a.db', newBase: 'b.db', pageDir: '.' })).toBe('[[b.db]]')
  })

  it('保留 |alias', () => {
    expect(rewriteDbRefs('![[a.db|我的表]]', { oldRel: 'a.db', newBase: 'b.db', pageDir: '.' })).toBe('![[b.db|我的表]]')
  })

  it('路径型 ref 按页目录相对解析命中,只换最后一段', () => {
    expect(rewriteDbRefs('![[sub/a.db]]', opts)).toBe('![[sub/b.db]]')
  })

  it('路径型 ref 按 vault 根解析也命中(根兜底语义)', () => {
    expect(rewriteDbRefs('![[notes/sub/a.db]]', opts)).toBe('![[notes/sub/b.db]]')
  })

  it('不命中不动:别的 basename / 非 .db / 不同路径', () => {
    const src = '![[c.db]] [[a.md]] ![[other/a.db]] 普通文字 [[a]]'
    expect(rewriteDbRefs(src, opts)).toBe(src)
  })

  it('同页多处引用全部重写', () => {
    expect(rewriteDbRefs('![[a.db]]\n[[a.db|x]]', { oldRel: 'a.db', newBase: 'b.db', pageDir: '.' })).toBe('![[b.db]]\n[[b.db|x]]')
  })
})
