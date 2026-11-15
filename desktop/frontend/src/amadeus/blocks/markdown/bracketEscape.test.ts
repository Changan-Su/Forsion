// @vitest-environment happy-dom
// 成对字面方括号 `[词]` 落盘不带反斜杠(bracketEscape.ts):只还原「重新解析仍是同一段字面」的那种。
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { unescapeLiteralBrackets } from './bracketEscape'
import { bootEditor, roundTrip } from './parseFidelity.testkit'

describe('unescapeLiteralBrackets', () => {
  it.each([
    ['hello \\[there]\n', 'hello [there]\n'],
    ['ab \\[{x}]\n', 'ab [{x}]\n'],
    ['a \\[b] c \\[d]\n', 'a [b] c [d]\n'],
    ['\\\\\\[a]\n', '\\\\[a]\n'], // 字面反斜杠 + 字面 [a]
    ['| \\[a] | b |\n', '| [a] | b |\n'],
  ])('还原 %j', (src, want) => expect(unescapeLiteralBrackets(src)).toBe(want))

  it.each([
    '\\[a](u)\n', // 行内链接
    '\\[a]\\[b]\n', // 完整引用
    '\\[a]:\n', // 定义
    '!\\[a]\n', // 图片
    '\\[^1]\n', // 脚注
    '> \\[!note] t\n', // callout 令牌(归 unescapeCalloutToken)
    '\\[ ] a\n', '\\[x] a\n', '\\[] a\n', // 任务框
    '`\\[a]`\n', // 行内代码
    '```\n\\[a]\n```\n', // 围栏
    '$\\[a]$\n', // 公式
    '[x]: http://a\n\nhello \\[x]\n', // 整篇有链接定义
    '\\[a\n', // 不成对
    '![\\[a] b](x.png)\n', '\\[a]]\n', // 还原会拼出 `![[` / `]]`
    '\\\\[a]\n', // 本来就没转义
  ])('保留 %j', (src) => expect(unescapeLiteralBrackets(src)).toBe(src))
})

describe('编辑器里打的字面方括号:落盘后重开仍是同一段字面', () => {
  it.each([
    'hello [there]',
    'ab [{x}] cd',
    'a [b] c [d]',
    'x [a]: y',
    'see [a] [b]',
    'list [1] and [2].',
    '[a] at start',
  ])('%j', async (text) => {
    const b = await bootEditor('seed')
    try {
      const v = b.view
      v.dispatch(v.state.tr.insertText(text, 1, 5))
      const md = b.md()
      const again = b.parse(md)
      expect(again.textContent).toBe(text)
      // 没还原的转义重开后带 amadeusEscaped(D-11 的用户转义记号),不算;别的 mark(链接等)一个都不许有
      let marks = 0
      again.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name !== 'amadeusEscaped')) marks++ })
      expect(marks).toBe(0)
      // 再存一次不变
      const b2 = await bootEditor(md)
      try { expect(b2.md()).toBe(md) } finally { await b2.destroy() }
    } finally {
      await b.destroy()
    }
  })

  it('用户自己写的 `\\[a]` 原样往返', async () => {
    expect(await roundTrip('keep \\[a] here\n')).toBe('keep \\[a] here\n')
  })

  it('文档里有链接定义(在没动过的块里)时,v4 落盘整篇保留转义', async () => {
    const b = await bootEditor('[y]: http://a.example\n\nhello\n')
    try {
      const v = b.view
      let at = -1
      v.state.doc.descendants((n, p) => { if (at < 0 && n.isTextblock && n.textContent === 'hello') at = p + 1 + 5; return at < 0 })
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at)))
      v.dispatch(v.state.tr.insertText(' [y]'))
      expect(b.saved()).toBe('[y]: http://a.example\n\nhello \\[y]\n')
    } finally {
      await b.destroy()
    }
  })

  it('没有链接定义时 v4 落盘写 `[y]`(`[x]` 形似任务框,照旧转义)', async () => {
    const b = await bootEditor('top\n\nhello\n')
    try {
      const v = b.view
      let at = -1
      v.state.doc.descendants((n, p) => { if (at < 0 && n.isTextblock && n.textContent === 'hello') at = p + 1 + 5; return at < 0 })
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at)))
      v.dispatch(v.state.tr.insertText(' [y] [x]'))
      expect(b.saved()).toBe('top\n\nhello [y] \\[x]\n')
    } finally {
      await b.destroy()
    }
  })
})

describe('行首 `=词=` 不带反斜杠', () => {
  it.each([
    ['=hello= there', '=hello= there\n'],
    ['==mark== there', '==mark== there\n'],
    ['= spaced', '\\= spaced\n'],
  ])('%j', async (text, want) => {
    const b = await bootEditor('seed')
    try {
      const v = b.view
      v.dispatch(v.state.tr.insertText(text, 1, 5))
      expect(b.md()).toBe(want)
      expect(b.parse(b.md()).textContent).toBe(text)
    } finally {
      await b.destroy()
    }
  })
})
