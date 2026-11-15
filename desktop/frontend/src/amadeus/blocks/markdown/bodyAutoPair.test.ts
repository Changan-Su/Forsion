// @vitest-environment happy-dom
// 正文括号 / 引号自动成对(bodyAutoPair.ts)+ 选中后敲 Markdown 符号包裹(unified/keyboard.ts 的 wrapSelectionPlugin)。
// 真 Milkdown(生产装配,parseFidelity.testkit),按 MarkdownBlock 的顺序挂:跨过 / 成对退格在前,公式,补闭合 / 包裹在后。
// 页面级(callout 令牌、链接输入规则、双链面板、表格、真输入法事件)在 scripts/body-auto-pair.check.cjs。
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { bootEditor, type Booted } from './parseFidelity.testkit'
import { bodyPairEarlyPlugin, bodyPairOpenPlugin, composingNow } from './bodyAutoPair'
import { mathLivePreviewPlugin } from './mathLivePreview'
import { wrapSelectionPlugin } from '../../unified/keyboard'

const PLUGINS = [bodyPairEarlyPlugin, mathLivePreviewPlugin(), bodyPairOpenPlugin, wrapSelectionPlugin]

/** 与 PM 的 readDOMChange 同一条路:先问 handleTextInput,都不接就按缺省插字(用当时的 state,与 PM 一样)。 */
function type(v: EditorView, s: string): void {
  for (const ch of s) {
    const { from, to } = v.state.selection
    if (!v.someProp('handleTextInput', (f) => f(v, from, to, ch, () => v.state.tr.insertText(ch, from, to)))) {
      v.dispatch(v.state.tr.insertText(ch, from, to))
    }
  }
}
function backspace(v: EditorView): boolean {
  const handled = !!v.someProp('handleKeyDown', (f) => f(v, new KeyboardEvent('keydown', { key: 'Backspace' })))
  if (!handled) {
    const { from } = v.state.selection
    v.dispatch(v.state.tr.delete(from - 1, from))
  }
  return handled
}
/** 第一个文本块的文字(叶子占 \ufffc)+ 光标的块内偏移。 */
function snap(v: EditorView): [string, number] {
  const $h = v.state.selection.$head
  return [$h.parent.textBetween(0, $h.parent.content.size, undefined, '\ufffc'), $h.parentOffset]
}
function caretAt(v: EditorView, text: string, after = true): void {
  let hit = -1
  v.state.doc.descendants((n, p) => {
    if (hit >= 0) return false
    if (n.isTextblock) {
      const i = n.textBetween(0, n.content.size, undefined, '\ufffc').indexOf(text)
      if (i >= 0) hit = p + 1 + i + (after ? text.length : 0)
      return false
    }
    return true
  })
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hit)))
}
function select(v: EditorView, text: string): void {
  let hit = -1
  v.state.doc.descendants((n, p) => {
    if (hit >= 0) return false
    if (n.isTextblock) {
      const i = n.textBetween(0, n.content.size, undefined, '\ufffc').indexOf(text)
      if (i >= 0) hit = p + 1 + i
      return false
    }
    return true
  })
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, hit, hit + text.length)))
}

let b: Booted | null = null
const boot = async (md: string): Promise<EditorView> => { b = await bootEditor(md, { extra: PLUGINS }); return b.view }
afterEach(async () => {
  localStorage.removeItem('amadeus.notes.codeAutoPair')
  localStorage.removeItem('amadeus.notes.markdownAutoPair')
  if (b) await b.destroy()
  b = null
})

describe('正文括号成对(K11 / K12d / K12e / K12h)', () => {
  it('圆括号:补闭合 → 跨过 → 成对退格', async () => {
    const v = await boot('ab')
    caretAt(v, 'ab')
    type(v, ' (')
    expect(snap(v)).toEqual(['ab ()', 4])
    type(v, 'a)')
    expect(snap(v)).toEqual(['ab (a)', 6])
    type(v, ' (')
    expect(backspace(v)).toBe(true)
    expect(snap(v)).toEqual(['ab (a) ', 7])
    expect(b!.md()).toBe('ab (a) \n')
  })
  it.each([
    ['"', 'ab ""', 'ab "x"', 'ab "x"\n'],
    ['[{', 'ab [{}]', 'ab [{x}]', 'ab [{x}]\n'],
    ['[[', 'ab [[]]', 'ab [[x]]', 'ab [[x]]\n'],
  ])('%s', async (seq, opened, typed, md) => {
    const v = await boot('ab')
    caretAt(v, 'ab')
    type(v, ' ' + seq)
    expect(snap(v)[0]).toBe(opened)
    type(v, 'x')
    expect(snap(v)[0]).toBe(typed)
    expect(b!.saved()).toBe(md)
  })
  it('双链打完 `]]` 跨过两个闭合,光标在链接后', async () => {
    const v = await boot('see x')
    caretAt(v, 'see ')
    type(v, '[[Note]]')
    expect(snap(v)).toEqual(['see [[Note]]x', 12])
  })
  it("引号挨着字母数字不配:don't、a\"b", async () => {
    const v = await boot('ab')
    caretAt(v, 'ab')
    type(v, " don't a\"b")
    expect(snap(v)[0]).toBe("ab don't a\"b")
  })
  it('括号紧贴在字 / 标点前面不配,后面是空白 / 闭合符才配', async () => {
    const v = await boot('foo. bar')
    caretAt(v, 'foo', false)
    type(v, '(')
    expect(snap(v)[0]).toBe('(foo. bar')
    caretAt(v, 'foo')
    type(v, '(')
    expect(snap(v)[0]).toBe('(foo(. bar') // 后面是 `.` → 不配
    caretAt(v, 'bar')
    type(v, '[')
    expect(snap(v)[0]).toBe('(foo(. bar[]')
  })
  it('全角括号不配', async () => {
    const v = await boot('ab')
    caretAt(v, 'ab')
    type(v, '（【「')
    expect(snap(v)[0]).toBe('ab（【「')
  })
  it('前面有行内叶子(图片)时偏移不错位:成对退格只删那一对', async () => {
    const v = await boot('a ![](x.png) b')
    caretAt(v, 'b')
    type(v, ' (')
    expect(snap(v)[0]).toBe('a \ufffc b ()')
    expect(backspace(v)).toBe(true)
    expect(snap(v)[0]).toBe('a \ufffc b ')
    let images = 0
    v.state.doc.descendants((n) => { if (n.type.name === 'image') images++ })
    expect(images).toBe(1)
  })
  it('跨过时落下的闭合符沿用原来那个的样式(⌘B 后打的字后面仍是普通的 `)`)', async () => {
    const v = await boot('ab')
    caretAt(v, 'ab')
    type(v, ' (')
    const strong = v.state.schema.marks.strong
    v.dispatch(v.state.tr.addStoredMark(strong.create()))
    type(v, 'x')
    type(v, ')')
    expect(snap(v)).toEqual(['ab (x)', 6])
    expect(b!.md()).toBe('ab (**x**)\n')
  })
  it.each(['"', "'"])('空的一对引号里再敲 %s = 跨过,不再补出一对', async (q) => {
    const v = await boot('ab')
    caretAt(v, 'ab')
    type(v, ' ' + q)
    type(v, q)
    expect(snap(v)).toEqual([`ab ${q}${q}`, 5])
  })
  it('用户转义过的闭合符(`\\)`)跨过时原样保留', async () => {
    const v = await boot('a \\)')
    caretAt(v, 'a ')
    type(v, ')')
    expect(snap(v)).toEqual(['a )', 3])
    expect(b!.md()).toBe('a \\)\n')
  })
})

describe('不该配的地方', () => {
  it('行内代码里不配', async () => {
    const v = await boot('`code`')
    caretAt(v, 'co')
    type(v, '(')
    expect(snap(v)[0]).toBe('co(de')
  })
  it('公式里引号不配,括号交给公式自己的配对', async () => {
    const v = await boot('$f$')
    caretAt(v, 'f')
    type(v, "'")
    expect(snap(v)[0]).toBe("$f'$")
    type(v, '(')
    expect(snap(v)[0]).toBe("$f'()$")
  })
  it('开关关掉时公式里的括号也不配(`$` 的配对不受影响)', async () => {
    const v = await boot('$f$')
    localStorage.setItem('amadeus.notes.codeAutoPair', '0')
    caretAt(v, 'f')
    type(v, '(')
    expect(snap(v)[0]).toBe('$f($')
  })
  it('代码块里正文配对不接手', async () => {
    const v = await boot('```\nx\n```')
    caretAt(v, 'x')
    const { from } = v.state.selection
    expect(v.someProp('handleTextInput', (f) => f(v, from, from, '(', () => v.state.tr))).toBeFalsy()
  })
  it('组字中:不配、不跨、不成对删', async () => {
    const v = await boot('ab ()')
    caretAt(v, 'ab (')
    const input = (v as unknown as { input: { composing: boolean } }).input
    input.composing = true
    try {
      expect(composingNow(v)).toBe(true)
      const { from } = v.state.selection
      expect(v.someProp('handleTextInput', (f) => f(v, from, from, '(', () => v.state.tr))).toBeFalsy()
      expect(v.someProp('handleTextInput', (f) => f(v, from, from, ')', () => v.state.tr))).toBeFalsy()
      expect(snap(v)[0]).toBe('ab ()')
      expect(v.someProp('handleKeyDown', (f) => f(v, new KeyboardEvent('keydown', { key: 'Backspace' })))).toBeFalsy()
      expect(snap(v)[0]).toBe('ab ()')
    } finally {
      input.composing = false
    }
  })
  it('组字刚提交上来的那一下不配', async () => {
    const v = await boot('ab')
    caretAt(v, 'ab')
    v.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '(' }))
    expect(composingNow(v)).toBe(true)
    type(v, '(')
    expect(snap(v)[0]).toBe('ab(')
  })
  it('开关关掉:不配、不跨、不成对删', async () => {
    const v = await boot('ab ()')
    localStorage.setItem('amadeus.notes.codeAutoPair', '0')
    caretAt(v, 'ab (')
    type(v, ')')
    expect(snap(v)[0]).toBe('ab ())')
    caretAt(v, 'ab (')
    expect(backspace(v)).toBe(false)
    expect(snap(v)[0]).toBe('ab ))')
    type(v, '"')
    expect(snap(v)[0]).toBe('ab "))')
  })
})

describe('选中后敲 Markdown 符号(K13 / K13b / K13c)', () => {
  it('`*` 斜体 → 再敲粗体,`_` 同口径,选区保持', async () => {
    const v = await boot('hello world')
    select(v, 'world')
    type(v, '*')
    expect(b!.md()).toBe('hello *world*\n')
    expect(v.state.doc.textBetween(v.state.selection.from, v.state.selection.to)).toBe('world')
    type(v, '*')
    expect(b!.md()).toBe('hello **world**\n')
    select(v, 'hello')
    type(v, '_')
    expect(b!.md()).toBe('*hello* **world**\n')
  })
  it('`~` 先字面包一层,再敲变删除线', async () => {
    const v = await boot('hello world')
    select(v, 'world')
    type(v, '~')
    expect(b!.md()).toBe('hello ~world~\n')
    type(v, '~')
    expect(b!.md()).toBe('hello ~~world~~\n')
    expect(v.state.doc.textBetween(v.state.selection.from, v.state.selection.to)).toBe('world')
  })
  it('`= $ % [` 字面包裹,行首的 `=` 与成对的 `[` 落盘不带反斜杠', async () => {
    const v = await boot('hello world there more')
    select(v, 'hello')
    type(v, '=')
    select(v, 'world')
    type(v, '$')
    select(v, 'there')
    type(v, '[')
    select(v, 'more')
    type(v, '%')
    expect(b!.saved()).toBe('=hello= $world$ [there] %more%\n') // `[词]` 不带反斜杠只在 v4 整篇落盘(bracketEscape)
    expect(b!.md()).toBe('=hello= $world$ \\[there] %more%\n')
  })
  it('开关关掉:照旧替换选区;括号包裹不受这个开关管', async () => {
    const v = await boot('hello world')
    localStorage.setItem('amadeus.notes.markdownAutoPair', '0')
    select(v, 'world')
    type(v, '*')
    expect(snap(v)[0]).toBe('hello *')
    select(v, 'hello')
    type(v, '(')
    expect(snap(v)[0]).toBe('(hello) *')
  })
  it('组字刚提交上来的字替换选区时不包', async () => {
    const v = await boot('hello world')
    select(v, 'world')
    v.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '*' }))
    const { from, to } = v.state.selection
    expect(v.someProp('handleTextInput', (f) => f(v, from, to, '*', () => v.state.tr))).toBeFalsy()
    expect(v.someProp('handleTextInput', (f) => f(v, from, to, '(', () => v.state.tr))).toBeFalsy()
  })
  it('组字中不包', async () => {
    const v = await boot('hello world')
    select(v, 'world')
    const input = (v as unknown as { input: { composing: boolean } }).input
    input.composing = true
    try {
      const { from, to } = v.state.selection
      expect(v.someProp('handleTextInput', (f) => f(v, from, to, '*', () => v.state.tr))).toBeFalsy()
      expect(v.someProp('handleTextInput', (f) => f(v, from, to, '(', () => v.state.tr))).toBeFalsy()
    } finally {
      input.composing = false
    }
  })
})
