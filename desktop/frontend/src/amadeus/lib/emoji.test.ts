import { describe, expect, it } from 'vitest'
import { EMOJI_ALL, EMOJI_GROUPS, searchEmoji } from './emoji'

describe('emoji 库', () => {
  it('比原来那 66 个硬编码的多得多', () => expect(EMOJI_ALL.length).toBeGreaterThan(300))

  it('每条都有关键词(没关键词=搜不到=等于不存在)', () => {
    for (const g of EMOJI_GROUPS) for (const [e, kw] of g.items) expect(kw.trim(), `${g.name} ${e}`).not.toBe('')
  })

  it('中英文都能搜', () => {
    expect(searchEmoji('猫')).toContain('🐱')
    expect(searchEmoji('cat')).toContain('🐱')
    expect(searchEmoji('火箭')).toContain('🚀')
    expect(searchEmoji('rocket')).toContain('🚀')
  })

  it('前缀命中排在包含命中之前', () => {
    const r = searchEmoji('book') ?? []
    expect(r[0]).toBe('📚') // 关键词以 book 开头
  })

  it('空查询返回 null(调用方走分组网格)', () => {
    expect(searchEmoji('')).toBeNull()
    expect(searchEmoji('   ')).toBeNull()
  })

  it('搜不到返回空数组(不是 null —— 调用方据此提示「回车直接用输入的字符」)', () => {
    expect(searchEmoji('zzzzqqq')).toEqual([])
  })

  it('结果不重复(同一 emoji 出现在多个组里也只出一次)', () => {
    const r = searchEmoji('星') ?? []
    expect(new Set(r).size).toBe(r.length)
  })
})
