import { describe, expect, it } from 'vitest'
import { NO_QUOTE_DRAFT, addQuote, composeQuotes, noteOf, notesFor, quoteAdded, quoteNoted, quotesFor, splitLeadingQuotes } from './quotes'
import { composeOutgoing } from './Composer2'
import { parseAskOrigin } from './insertToNote'

describe('引用卡', () => {
  it('多段引用发出去再读回来,段数与原文不变', () => {
    const quotes = ['第一段\n\n带空行', '第二段']
    const sent = composeOutgoing('', composeQuotes(quotes), '我的问题\n> 正文里的大于号不算')
    expect(sent).toBe('> 第一段\n> \n> 带空行\n\n> 第二段\n\n我的问题\n> 正文里的大于号不算')
    expect(splitLeadingQuotes(sent)).toEqual({ quotes, notes: ['', ''], body: '我的问题\n> 正文里的大于号不算' })
  })

  it('只有引用没有正文、以及只挂过一段的老消息', () => {
    expect(splitLeadingQuotes(composeQuotes(['只有引用']))).toEqual({ quotes: ['只有引用'], notes: [''], body: '' })
    expect(splitLeadingQuotes('> 老消息\n> 第二行\n\n问题')).toEqual({ quotes: ['老消息\n第二行'], notes: [''], body: '问题' })
  })

  it('每段引用带回应(就地回复框):`↳ 回应` 紧跟引用块,读回来回应和正文分得清', () => {
    const quotes = ['甲', '乙']
    const sent = composeOutgoing('', composeQuotes(quotes, { 甲: '这句说得对', 乙: '第一行\n\n第二段' }), '总结一下')
    expect(sent).toBe('> 甲\n\n↳ 这句说得对\n\n> 乙\n\n↳ 第一行\n第二段\n\n总结一下')
    expect(splitLeadingQuotes(sent)).toEqual({ quotes, notes: ['这句说得对', '第一行\n第二段'], body: '总结一下' })
    expect(splitLeadingQuotes(composeQuotes(['丙'], { 丙: '只有回应' }))).toEqual({ quotes: ['丙'], notes: ['只有回应'], body: '' })
  })

  it('正文里自己写的引用块不会被当成卡,正文一字不少', () => {
    const sent = composeOutgoing('', composeQuotes(['挂的引用']), 'Explain this:\n\n> example\n\nWhy?')
    expect(splitLeadingQuotes(sent)).toEqual({ quotes: ['挂的引用'], notes: [''], body: 'Explain this:\n\n> example\n\nWhy?' })
  })

  it('引用原文是 constructor / toString 也不会取到原型上的东西', () => {
    expect(noteOf({}, 'constructor')).toBeUndefined()
    expect(composeQuotes(['toString'], {})).toBe('> toString\n\n')
  })

  it('回应跟着引用走:换会话作废,能改能清;编辑中原样保存(空格换行不修)', () => {
    const a = quoteAdded(NO_QUOTE_DRAFT, 'A', '甲', '  回应  ')
    expect(notesFor(a, 'A')).toEqual({ 甲: '回应' })
    expect(notesFor(a, 'B')).toEqual({})
    expect(notesFor(quoteNoted(a, 'A', '甲', 'hello world\n'), 'A')).toEqual({ 甲: 'hello world\n' })
    expect(notesFor(quoteNoted(a, 'A', '甲', ' '), 'A')).toEqual({})
    expect(notesFor(quoteAdded(a, 'B', '乙'), 'B')).toEqual({})
  })

  it('开头不是引用就不拆', () => {
    expect(splitLeadingQuotes('普通消息\n> 后面才引用')).toBeNull()
    expect(splitLeadingQuotes('')).toBeNull()
  })

  it('以大于号开头的正文不是引用', () => {
    expect(splitLeadingQuotes('>= 10\n用这个比较')).toBeNull()
    expect(splitLeadingQuotes('>> output.log')).toBeNull()
    expect(splitLeadingQuotes('> 真引用\n\n>= 10 才算')).toEqual({ quotes: ['真引用'], notes: [''], body: '>= 10 才算' })
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
