// @vitest-environment happy-dom
// 成对字面方括号 `[词]` 落盘不带反斜杠(bracketEscape.ts):只还原「重新解析仍是同一段字面」的那种。
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { unescapeTextBrackets } from './bracketEscape'
import { bootEditor, roundTrip } from './parseFidelity.testkit'
import { normalizeFragmentMd } from './MarkdownBlock'

describe('unescapeTextBrackets(一个 text 节点的序列化结果)', () => {
  const nl = (out: string): string => unescapeTextBrackets(out, '\n', '\n')
  it.each([
    ['hello \\[there]', 'hello [there]'],
    ['ab \\[{x}]', 'ab [{x}]'],
    ['a \\[b] c \\[d]', 'a [b] c [d]'],
    ['\\\\\\[a]', '\\\\[a]'], // 字面反斜杠 + 字面 [a]
    ['\\[a\\*b]', '[a\\*b]'], // 里面别的转义照算一个字
    ['\\[a\\\\]', '[a\\\\]'], // 闭括号前是字面反斜杠
    ['\\[a]\\*', '[a]\\*'], // 后面接的是别的转义
  ])('还原 %j', (out, want) => expect(nl(out)).toBe(want))

  it.each([
    '\\[a](u)', // 行内链接
    '\\[a]\\[b]', // 完整引用
    '\\[a]:', // 定义
    '!\\[a]', '\\!\\[a]', // 图片
    '\\[^1]', // 脚注
    '\\[!note] t', // callout 令牌(归 unescapeCalloutToken)
    '\\[ ] a', '\\[x] a', '\\[X] a', '\\[] a', '\\[\t] a', // 任务框形状(GFM:空格 / Tab / x)
    '$\\[a]$', // 公式(unescapeMathSource 管)
    '\\[a', // 不成对
    '\\[a]]', '[\\[a]', // 还原会拼出 `]]` / `[[`
    '\\\\[a]', // 本来就没转义
    '\\[b\\] c', 'x \\[a \\[b\\] c]', // 闭括号被转义 = 不是这一对(二审 P1 的形状)
  ])('保留 %j', (out) => expect(nl(out)).toBe(out))

  it('节点边上:前一个兄弟的末字只认空白与 * _ ~ ` >,不知道(空串)就不动', () => {
    for (const before of [' ', '\n', '*', '_', '~', '`', '>']) expect(unescapeTextBrackets('\\[a] x', before, '\n')).toBe('[a] x')
    for (const before of ['', 'h', '/', ')', '!', ']', '[', '\\']) expect(unescapeTextBrackets('\\[a] x', before, '\n')).toBe('\\[a] x')
  })
  it('节点边上:后一个兄弟的首字是 ( [ : ] \\ 或不知道就不动', () => {
    for (const after of [' ', '\n', '*', '<', '`']) expect(unescapeTextBrackets('x \\[a]', '\n', after)).toBe('x [a]')
    for (const after of ['', '(', '[', ':', ']', '\\']) expect(unescapeTextBrackets('x \\[a]', '\n', after)).toBe('x \\[a]')
  })
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
      const md = b.saved()
      const again = b.parse(md)
      expect(again.textContent).toBe(text)
      // 没还原的转义重开后带 amadeusEscaped(D-11 的用户转义记号),不算;别的 mark(链接等)一个都不许有
      let marks = 0
      again.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name !== 'amadeusEscaped')) marks++ })
      expect(marks).toBe(0)
      // 再存一次不变
      const b2 = await bootEditor(md)
      try { expect(b2.saved()).toBe(md) } finally { await b2.destroy() }
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

describe('编辑器里打的、该保留转义的方括号:v4 落盘逐字 + 重开仍是字面', () => {
  it.each([
    ['[a](u)', '[a]\\(u)\n'], // 行内链接:序列化器转义的是 `(`,`[a]` 已不可能成链接
    ['[a][b]', '\\[a]\\[b]\n'], // 完整引用
    ['[a]:', '\\[a]:\n'], // 定义
    ['![a]', '!\\[a]\n'], // 图片
    ['[^1]', '\\[^1]\n'], // 脚注
    ['[ ] a', '\\[ ] a\n'], ['[x] a', '\\[x] a\n'], ['[] a', '\\[] a\n'], ['[\t] a', '\\[\t] a\n'], // 任务框形状
    ['[a', '\\[a\n'], // 不成对
    ['[a]]', '\\[a]]\n'], // 还原会拼出 `]]`
    ['\\[a]', '\\\\[a]\n'], // 字面反斜杠 + 字面 [a]
  ])('%j', async (text, want) => {
    const b = await bootEditor('seed')
    try {
      b.view.dispatch(b.view.state.tr.insertText(text, 1, 5))
      expect(b.saved()).toBe(want)
      const again = b.parse(want)
      expect(again.textContent).toBe(text)
      let marked = 0
      again.descendants((n) => { if (n.type.name === 'image' || (n.isText && n.marks.some((m) => m.type.name !== 'amadeusEscaped'))) marked++ })
      expect(marked).toBe(0)
    } finally {
      await b.destroy()
    }
  })

  it('被 mark 拆开的一对(`[**a** b]`)看不全,保留转义', async () => {
    const b = await bootEditor('seed\n')
    try {
      const v = b.view
      const { schema } = v.state
      const para = v.state.doc.firstChild!
      v.dispatch(v.state.tr.replaceWith(1, 1 + para.content.size, [schema.text('['), schema.text('a', [schema.marks.strong.create()]), schema.text(' b]')]))
      expect(b.saved()).toBe('\\[**a** b]\n')
    } finally {
      await b.destroy()
    }
  })

  it.each([
    ['$a[i]$ x', '$a[i]$ x\n'],
    ['$f[a](x)$ x', '$f[a](x)$ x\n'],
    ['y $[a]$', 'y $[a]$\n'],
  ])('公式里的方括号:开关开 / 关落盘一致 %j', async (text, want) => {
    const b = await bootEditor('seed')
    try {
      b.view.dispatch(b.view.state.tr.insertText(text, 1, 5))
      expect(b.saved()).toBe(want)
      expect(b.md()).toBe(want)
    } finally {
      await b.destroy()
    }
  })
})

describe('行首 `=` 只去正文文字自己的转义(text handler)', () => {
  const editFirst = async (md: string): Promise<{ saved: string; again: PMNode }> => {
    const b = await bootEditor(md)
    try {
      const v = b.view
      v.dispatch(v.state.tr.insertText('K', 1, 2)) // 首字换成 K,整段重新序列化
      const saved = b.saved()
      return { saved, again: b.parse(saved) }
    } finally {
      await b.destroy()
    }
  }
  it.each([
    ['a\n\\==\n', 'K\n\\==\n'], // 整行只有 `=`:去掉就成 setext 下划线
    ['a\n\\===\n', 'K\n\\===\n'],
    ['a\n\\=\n', 'K\n\\=\n'],
    ['a\n\\= x\n', 'K\n\\= x\n'], // `=` 后空白
    ['a\n==x== y\n', 'K\n==x== y\n'],
    ['a\n=x= y\n', 'K\n=x= y\n'],
  ])('段内换行后的行首 %j', async (md, want) => {
    const { saved, again } = await editFirst(md)
    expect(saved).toBe(want)
    expect(again.firstChild?.type.name).toBe('paragraph')
    expect(again.childCount).toBe(1)
  })

  it('公式块里行首的 `=`:与公式反转义的结果一致', async () => {
    const b = await bootEditor('$$\nk\n=y+1\n= y\n$$\n')
    try {
      const v = b.view
      v.dispatch(v.state.tr.insertText('K', 4, 5)) // k → K(`$$` 换行之后那个字)
      expect(v.state.doc.textContent.startsWith('$$\nK')).toBe(true)
      expect(b.saved()).toBe('$$\nK\n=y+1\n= y\n$$\n')
    } finally {
      await b.destroy()
    }
  })

  it('片段(切块 / 结构化复制)那条路径同样不带 `\\=`', async () => {
    const b = await bootEditor('seed\n')
    try {
      expect(normalizeFragmentMd(b.serialize(b.parse('=x= y\n')))).toBe('=x= y\n')
    } finally {
      await b.destroy()
    }
  })
})

describe('只在 v4 整篇落盘还原:单块 / 剪贴板那条规范化照旧保留 `\\[`', () => {
  it('md()(normalizeSerializedMd 缺省)保留,saved()(serializeUnified)还原', async () => {
    const b = await bootEditor('seed')
    try {
      b.view.dispatch(b.view.state.tr.insertText('hello [there]', 1, 5))
      expect(b.md()).toBe('hello \\[there]\n')
      expect(b.saved()).toBe('hello [there]\n')
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

// ── 二审(落盘格式):只有正文文字里序列化器自己加的转义能去掉;图片说明 / 链接文字 / HTML / 任务框形状一律原样 ──
// 每条:打开 → 只做一处无关编辑(或文末追加一段,让文末的 HTML 块退出逐字回填)→ v4 落盘逐字断言 → 重开断言结构。
describe('落盘只还原正文里的成对方括号与行首转义(Codex 二审四条 + 同类)', () => {
  const textAt = (doc: PMNode, s: string): number => {
    let at = -1
    doc.descendants((n, p) => {
      if (at >= 0) return false
      if (n.isText && n.text!.includes(s)) at = p + n.text!.indexOf(s)
      return at < 0
    })
    if (at < 0) throw new Error(`no text ${s}`)
    return at
  }
  const capitalize = (word: string) => (v: EditorView): void => {
    const at = textAt(v.state.doc, word)
    v.dispatch(v.state.tr.insertText(word[0].toUpperCase(), at, at + 1))
  }
  const appendParagraph = (text: string) => (v: EditorView): void => {
    const { schema } = v.state
    v.dispatch(v.state.tr.insert(v.state.doc.content.size, schema.nodes.paragraph.create(null, schema.text(text))))
  }
  const insertAfter = (anchor: string, s: string) => (v: EditorView): void => {
    v.dispatch(v.state.tr.insertText(s, textAt(v.state.doc, anchor) + anchor.length))
  }
  async function save(md: string, edit: (v: EditorView) => void): Promise<{ saved: string; again: PMNode }> {
    const b = await bootEditor(md)
    try {
      edit(b.view)
      const saved = b.saved()
      return { saved, again: b.parse(saved) }
    } finally {
      await b.destroy()
    }
  }
  const all = (doc: PMNode, name: string): PMNode[] => {
    const out: PMNode[] = []
    doc.descendants((n) => { if (n.type.name === name) out.push(n) })
    return out
  }
  const htmlValues = (doc: PMNode): string => all(doc, 'html').map((n) => String(n.attrs.value)).join('|')
  /** 带链接 mark 的文字按地址拼起来(重开后 `\\[` `\\]` 是用户转义,会把链接文字拆成几段同址的 text)。 */
  const linked = (doc: PMNode): string[] => {
    const by = new Map<string, string>()
    doc.descendants((n) => {
      const link = n.isText ? n.marks.find((m) => m.type.name === 'link') : undefined
      if (link) by.set(String(link.attrs.href), (by.get(String(link.attrs.href)) ?? '') + n.text)
    })
    return [...by].map(([href, text]) => `${text}->${href}`)
  }

  it.each([
    ['图片说明里的方括号(P1)', 'hello ![a [b] c](/img.png)\n', 'Hello ![a \\[b\\] c](/img.png)\n', 'a [b] c'],
    ['同一行还有字面 [w]', 'hello [w] ![a [b] c](/i.png)\n', 'Hello [w] ![a \\[b\\] c](/i.png)\n', 'a [b] c'],
  ])('%s', async (_n, md, want, alt) => {
    const { saved, again } = await save(md, capitalize('hello'))
    expect(saved).toBe(want)
    const imgs = all(again, 'image')
    expect(imgs.map((n) => n.attrs.alt)).toEqual([alt])
  })

  it.each([
    ['链接文字里的方括号(P1)', 'hello [a [b] c](/u)\n', 'Hello [a \\[b\\] c](/u)\n', ['a [b] c->/u']],
    ['链接文字里的编号', 'hello [see [1] here](/u)\n', 'Hello [see \\[1\\] here](/u)\n', ['see [1] here->/u']],
  ])('%s', async (_n, md, want, links) => {
    const { saved, again } = await save(md, capitalize('hello'))
    expect(saved).toBe(want)
    expect(linked(again)).toEqual(links)
  })

  it.each([
    ['行内 HTML 的 src(P2)', 'hello <img src="\\[a].png"> tail\n', '<img src="\\[a].png">'],
    ['行内 HTML 的 title', 'hello <span title="\\[a] x">t</span> tail\n', '<span title="\\[a] x">'],
    ['行内 HTML 的 href', 'hello <a href="/p/\\[a]">l</a> tail\n', '<a href="/p/\\[a]">'],
  ])('%s', async (_n, md, tag) => {
    const { saved, again } = await save(md, capitalize('hello'))
    expect(saved).toBe(`H${md.slice(1)}`)
    expect(htmlValues(again)).toContain(tag)
  })

  it.each([
    ['<pre> 里的 \\=(P3)', '<pre>\n\\=keep\n</pre>\n'],
    ['<div> 里的 \\=', '<div>\n\\=keep\n</div>\n'],
    ['<pre> 里的 \\==', '<pre>\n\\==keep==\n</pre>\n'],
    ['<div> 里的 \\[a]', '<div>\n\\[a] b\n</div>\n'],
  ])('HTML 块:%s', async (_n, md) => {
    const { saved, again } = await save(md, appendParagraph('after'))
    expect(saved).toBe(`${md}\nafter\n`)
    expect(htmlValues(again)).toContain(md.split('\n')[1])
  })

  it.each([
    ['无序列表(P4)', '- [\t]task\n', '- \\[\t] task\n'],
    ['有序列表', '1. [\t]task\n', '1. \\[\t] task\n'],
    ['段首', '[\t]task\n', '\\[\t] task\n'],
  ])('Tab 形式的任务框形状:%s', async (_n, md, want) => {
    const { saved, again } = await save(md, insertAfter(']', ' '))
    expect(saved).toBe(want)
    expect(again.textContent).toBe('[\t] task')
    expect(all(again, 'list_item').map((n) => n.attrs.checked ?? null)).toEqual(md.startsWith('[') ? [] : [null])
  })
})
