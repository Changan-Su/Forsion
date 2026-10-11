import { describe, expect, it } from 'vitest'
import { NO_QUOTE_DRAFT, addQuote, composeQuotes, quoteAdded, quotesFor, splitLeadingQuotes } from './quotes'
import { composeOutgoing } from './Composer2'
import { parseAskOrigin } from './insertToNote'

describe('引用卡', () => {
  it('多段引用发出去再读回来,段数与原文不变', () => {
    const quotes = ['第一段\n\n带空行', '第二段']
    const sent = composeOutgoing('', composeQuotes(quotes), '我的问题\n> 正文里的大于号不算')
    expect(sent).toBe('> 第一段\n> \n> 带空行\n\n> 第二段\n\n我的问题\n> 正文里的大于号不算')
    expect(splitLeadingQuotes(sent)).toEqual({ quotes, body: '我的问题\n> 正文里的大于号不算' })
  })

  it('只有引用没有正文、以及只挂过一段的老消息', () => {
    expect(splitLeadingQuotes(composeQuotes(['只有引用']))).toEqual({ quotes: ['只有引用'], body: '' })
    expect(splitLeadingQuotes('> 老消息\n> 第二行\n\n问题')).toEqual({ quotes: ['老消息\n第二行'], body: '问题' })
  })

  it('开头不是引用就不拆', () => {
    expect(splitLeadingQuotes('普通消息\n> 后面才引用')).toBeNull()
    expect(splitLeadingQuotes('')).toBeNull()
  })

  it('以大于号开头的正文不是引用', () => {
    expect(splitLeadingQuotes('>= 10\n用这个比较')).toBeNull()
    expect(splitLeadingQuotes('>> output.log')).toBeNull()
    expect(splitLeadingQuotes('> 真引用\n\n>= 10 才算')).toEqual({ quotes: ['真引用'], body: '>= 10 才算' })
  })

  it('引用只属于挂它的那个会话:换了会话不显示、不跟着发,在新会话里再挂就只有新的', () => {
    const inA = quoteAdded(quoteAdded(NO_QUOTE_DRAFT, 'A', '甲一'), 'A', '甲二')
    expect(quotesFor(inA, 'A')).toEqual(['甲一', '甲二'])
    expect(quotesFor(inA, 'B')).toEqual([])
    expect(quotesFor(inA, null)).toEqual([])
    const inB = quoteAdded(inA, 'B', '乙一')
    expect(quotesFor(inB, 'B')).toEqual(['乙一'])
    expect(quotesFor(inB, 'A')).toEqual([])
  })

  it('追加:空的不加,同一段不重复挂', () => {
    expect(addQuote(['a'], '  b  ')).toEqual(['a', 'b'])
    expect(addQuote(['a'], 'a')).toEqual(['a'])
    expect(addQuote(['a'], '   ')).toEqual(['a'])
  })

  it('多段里各自的「问 Tangu」出处仍然认得出(取最后一段)', () => {
    const sent = composeQuotes(['甲\n— [[a.md#一]]', '乙\n— [[b.md#二]]']) + '问'
    expect(parseAskOrigin(sent)).toEqual({ path: 'b.md', anchor: { heading: '二', text: '乙' } })
  })
})
