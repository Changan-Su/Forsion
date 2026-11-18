// 标注令牌的元数据位(Notion 对齐 A5):`[!tip|🚀 blue]`。读写同一套规则,认得的写法逐字往返,认不得的词不丢。
import { describe, expect, it } from 'vitest'
import { calloutHead, CALLOUT_HEAD_RE, FOLD_HEAD_RE, formatCalloutMeta, isCalloutIcon, parseCalloutMeta, readCalloutToken, withCalloutMeta } from './calloutToken'

describe('readCalloutToken', () => {
  it.each([
    ['[!tip] 标题', { type: 'tip', marker: undefined, head: 6, icon: '', color: '' }],
    ['[!tip|🚀 blue] 标题', { type: 'tip', marker: undefined, head: 14, icon: '🚀', color: 'blue' }],
    ['[!fold|green]- 折叠', { type: 'fold', marker: '-', head: 13, icon: '', color: 'green' }],
    ['[!my-type|wide]+ x', { type: 'my-type', marker: '+', head: 15, icon: '', color: '' }],
    ['[!note|]', { type: 'note', marker: undefined, head: 8, icon: '', color: '' }],
  ])('%s', (text, want) => {
    const t = readCalloutToken(text)!
    expect({ type: t.type, marker: t.marker, head: t.head, icon: t.meta.icon, color: t.meta.color }).toEqual(want)
    expect(t.token.length).toBe(t.head + (t.marker ? 1 : 0))
  })
  it('不是令牌', () => {
    for (const s of ['[tip]', '[!tip', '[!ti p]', 'x[!tip]', '[!tip|a]b]']) expect(readCalloutToken(s)?.token ?? null).not.toBe(s)
    expect(readCalloutToken('[!tip\n|x]')).toBeNull()
  })
  it('FOLD_HEAD_RE / CALLOUT_HEAD_RE 认元数据', () => {
    expect(FOLD_HEAD_RE.test('[!fold|blue]- x')).toBe(true)
    expect(FOLD_HEAD_RE.test('[!folder] x')).toBe(false)
    expect(CALLOUT_HEAD_RE.test('[!tip|🚀 blue] x')).toBe(true)
  })
})

describe('元数据:图标 / 底色 / 其余', () => {
  it('图标只认 emoji,ASCII 词当 Obsidian 的 CSS 片段名原样留着', () => {
    expect(parseCalloutMeta('wide')).toEqual({ icon: '', color: '', rest: ['wide'] })
    expect(parseCalloutMeta('🚀 blue wide')).toEqual({ icon: '🚀', color: 'blue', rest: ['wide'] })
    expect(parseCalloutMeta('blue 🚀')).toEqual({ icon: '🚀', color: 'blue', rest: [] })
    expect(parseCalloutMeta('🚀 💡 red blue')).toEqual({ icon: '🚀', color: 'red', rest: ['💡', 'blue'] })
    expect(parseCalloutMeta('#1a2b3c')).toEqual({ icon: '', color: '', rest: ['#1a2b3c'] }) // hex 不收(会被当成标签)
    for (const w of ['❤️', '👍🏽', '🇨🇳', '⭐']) expect(isCalloutIcon(w)).toBe(true)
    for (const w of ['a🚀', '1', '|', '中', '']) expect(isCalloutIcon(w)).toBe(false)
    // 整个词必须正好一枚 emoji(Codex 评审 A5 #3):混文字、两枚并排都不算,ZWJ 组合和旗帜标签序列算一枚
    for (const w of ['🚀中文', '🚀🔥', '中🚀']) expect(isCalloutIcon(w)).toBe(false)
    for (const w of ['👨‍👩‍👧', '🏳️‍🌈', '🏴󠁧󠁢󠁥󠁮󠁧󠁿']) expect(isCalloutIcon(w)).toBe(true)
    expect(parseCalloutMeta('🚀中文 wide')).toEqual({ icon: '', color: '', rest: ['🚀中文', 'wide'] })
  })
  it('规范形往返逐字不变', () => {
    for (const m of ['🚀 blue', '🚀', 'blue', '🚀 blue wide', 'wide x']) expect(formatCalloutMeta(parseCalloutMeta(m))).toBe(m)
  })
  it('写回:空元数据回到 [!type]', () => {
    expect(calloutHead('tip', { icon: '', color: '', rest: [] })).toBe('[!tip]')
    expect(calloutHead('fold', { icon: '', color: 'green', rest: [] })).toBe('[!fold|green]')
  })
})

describe('withCalloutMeta:只改令牌、不碰标题', () => {
  it.each([
    ['[!tip] 标题', { icon: '🚀' }, '[!tip|🚀]'],
    ['[!tip|🚀] 标题', { color: 'blue' }, '[!tip|🚀 blue]'],
    ['[!tip|🚀 blue] 标题', { icon: '' }, '[!tip|blue]'],
    ['[!tip|🚀 blue] 标题', { icon: '', color: '' }, '[!tip]'],
    ['[!tip|wide] 标题', { color: 'red' }, '[!tip|red wide]'],
    ['[!fold|green]- 折叠', { color: 'blue' }, '[!fold|blue]'],
    ['[!tip|🚀中文 wide] 标题', { icon: '💡' }, '[!tip|💡 🚀中文 wide]'],
  ])('%s + %j', (text, patch, head) => {
    const r = withCalloutMeta(text, patch)!
    expect(r.head).toBe(head)
    expect(head + text.slice(r.to)).toMatch(/标题|折叠/)
    // 折叠符、标题原样留在 to 之后
    expect(text.slice(r.to)).toBe(text.slice(readCalloutToken(text)!.head))
  })
  it('没变化 → null;不是令牌 → null', () => {
    expect(withCalloutMeta('[!tip|blue] x', { color: 'blue' })).toBeNull()
    expect(withCalloutMeta('普通引用', { color: 'blue' })).toBeNull()
  })
})
