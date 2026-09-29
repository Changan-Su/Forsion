import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { countText } from './textCount'
import { visibleText } from '../unified/noteStats'

// 评审 C-22:状态栏按原始 md 计数(156 vs 实际可见约 25),没有词数与选区计数。
describe('countText', () => {
  it('counts non-whitespace characters by code point, CJK characters as words, latin by word', () => {
    expect(countText('Hello world')).toEqual({ chars: 10, words: 2 })
    expect(countText('看这篇文章吧。')).toEqual({ chars: 7, words: 6 })
    expect(countText("don't use e-mail 😀")).toEqual({ chars: 15, words: 3 })
    expect(countText('中文 mixed 英文 text')).toEqual({ chars: 13, words: 6 })
    expect(countText('  \n\t ')).toEqual({ chars: 0, words: 0 })
  })
})

describe('visibleText', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      image: { group: 'inline', inline: true, atom: true },
      text: { group: 'inline' },
    },
    marks: { link: { attrs: { href: {} } } },
  })
  const p = (...c: Parameters<typeof schema.node>[2][]) => schema.node('paragraph', null, c.flat() as never)
  it('drops link targets, atoms and embed syntax; keeps the shown name of a wikilink', () => {
    const doc = schema.node('doc', null, [
      p(schema.text('看 '), schema.text('这篇文章', [schema.mark('link', { href: 'https://example.com/very/long?utm=x' })]), schema.text(' 吧。')),
      p(schema.text('![[Embedded]]')),
      p(schema.text('见 [[Alpha|别名]] 和 [[Beta]]'), schema.node('image')),
    ])
    expect(visibleText(doc)).toBe('看 这篇文章 吧。\n\n见 别名 和 Beta')
    expect(countText(visibleText(doc))).toEqual({ chars: 15, words: 11 })
  })
})
