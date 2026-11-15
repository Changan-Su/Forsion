// 插件 insertMarkdownAt 的事务算术(insertAt.ts):'caret' 档的行内插入能放 / 放不下,cursorMarker 的占位字换、认、删。
// 真编辑器上的接线(解析、派发、撤销、阅读模式拒绝)在 scripts/plugin-blocksurface.check.cjs 的 T9–T14。
import { describe, it, expect } from 'vitest'
import { Fragment, Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { CARET_MARK, caretMarkUsable, inlineAtCaret, landOnCaretMark, markCaret } from './insertAt'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    code_block: { group: 'block', content: 'text*', marks: '' },
    image: { group: 'block', atom: true, attrs: { src: { default: '' } } },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    link: { attrs: { href: {} } },
  },
})
const p = (...kids: Array<string | PMNode>) => schema.node('paragraph', null, kids.map((k) => (typeof k === 'string' ? schema.text(k) : k)))
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)
const bold = (s: string) => schema.text(s, [schema.marks.strong.create()])
/** 文档里第一处 `needle` 的位置(在它之前)。 */
const posOf = (d: PMNode, needle: string): number => {
  let at = -1
  d.descendants((n, pos) => {
    if (at >= 0 || !n.isText) return at < 0
    const i = n.text!.indexOf(needle)
    if (i >= 0) at = pos + i
    return false
  })
  if (at < 0) throw new Error(`no ${needle}`)
  return at
}
const stateAt = (d: PMNode, from: number, to = from) => EditorState.create({ doc: d, selection: TextSelection.create(d, from, to) })

describe('markCaret', () => {
  it('第一处换成占位字,其余删掉;plain = 全删', () => {
    expect(markCaret('a<C>b<C>c', '<C>')).toEqual({ md: `a${CARET_MARK}bc`, plain: 'abc', marked: true })
  })
  it('没给标记 / 文中没有 → 原样,marked:false', () => {
    expect(markCaret('abc')).toEqual({ md: 'abc', plain: 'abc', marked: false })
    expect(markCaret('abc', '<C>')).toEqual({ md: 'abc', plain: 'abc', marked: false })
  })
  it('原文已含占位字 → 只删标记,不落光标(分不清哪个是标记)', () => {
    expect(markCaret(`x${CARET_MARK}y<C>`, '<C>')).toEqual({ md: `x${CARET_MARK}y`, plain: `x${CARET_MARK}y`, marked: false })
  })
})

describe('caretMarkUsable', () => {
  it('恰好一个、在正文文字里(加粗里也算)', () => {
    expect(caretMarkUsable(doc(p('a', bold(`b${CARET_MARK}`))))).toBe(true)
  })
  it('进了链接地址 / 块属性 → 不可用(删了文字里那个,属性里那个照样写盘)', () => {
    const link = schema.text(`x${CARET_MARK}`, [schema.marks.link.create({ href: `https://e.com/${CARET_MARK}` })])
    expect(caretMarkUsable(doc(p(link)))).toBe(false)
    expect(caretMarkUsable(doc(schema.node('image', { src: `a${CARET_MARK}.png` })))).toBe(false)
  })
  it('一个都没有 / 不止一个 → 不可用', () => {
    expect(caretMarkUsable(doc(p('abc')))).toBe(false)
    expect(caretMarkUsable(doc(p(`a${CARET_MARK}`), p(`b${CARET_MARK}`)))).toBe(false)
  })
})

describe('landOnCaretMark', () => {
  it('删掉占位字、光标落在那里(同一事务)', () => {
    const d = doc(p('前面'), p(`ab${CARET_MARK}cd`))
    const tr = EditorState.create({ doc: d }).tr
    expect(landOnCaretMark(tr)).toBe(true)
    expect(tr.doc.textContent).toBe('前面abcd')
    expect(tr.selection.from).toBe(posOf(tr.doc, 'cd'))
    expect(tr.doc.textContent.includes(CARET_MARK)).toBe(false)
  })
  it('找不到 / 不止一个 → false,事务不动', () => {
    for (const d of [doc(p('abc')), doc(p(`a${CARET_MARK}`), p(`b${CARET_MARK}`))]) {
      const tr = EditorState.create({ doc: d }).tr
      expect(landOnCaretMark(tr)).toBe(false)
      expect(tr.steps.length).toBe(0)
    }
  })
})

describe('inlineAtCaret', () => {
  const one = (s: string | PMNode) => Fragment.from(p(s))

  it('段落中间插一行字:进同一行,光标在插入内容末尾', () => {
    const d = doc(p('Hello world'))
    const r = inlineAtCaret(stateAt(d, posOf(d, ' world')), one(', dear'))!
    expect(r.tr.doc.childCount).toBe(1)
    expect(r.tr.doc.textContent).toBe('Hello, dear world')
    expect(r.tr.selection.from).toBe(posOf(r.tr.doc, ' world'))
    expect(r.to).toBe(r.tr.selection.from)
  })
  it('非空选区先删(同打字)', () => {
    const d = doc(p('Hello {{name}}!'))
    const from = posOf(d, '{{name}}')
    const r = inlineAtCaret(stateAt(d, from, from + '{{name}}'.length), one('Ada'))!
    expect(r.tr.doc.textContent).toBe('Hello Ada!')
  })
  it('带标记的行内内容也照插(加粗)', () => {
    const d = doc(p('ab'))
    const r = inlineAtCaret(stateAt(d, posOf(d, 'b')), Fragment.from(p(bold('X'))))!
    expect(r.tr.doc.firstChild!.child(1).marks.map((m) => m.type.name)).toEqual(['strong'])
  })
  it('标题里也能插(行内内容)', () => {
    const d = doc(schema.node('heading', null, [schema.text('Title')]))
    const r = inlineAtCaret(stateAt(d, posOf(d, 'Title') + 5), one(' two'))!
    expect(r.tr.doc.firstChild!.type.name).toBe('heading')
    expect(r.tr.doc.textContent).toBe('Title two')
  })
  it('放不下 → null:不止一段、不是段落、整块选中、代码块里放加粗', () => {
    const d = doc(p('ab'), schema.node('code_block', null, [schema.text('code')]))
    const at = stateAt(d, posOf(d, 'b'))
    expect(inlineAtCaret(at, Fragment.from([p('x'), p('y')]))).toBeNull()
    expect(inlineAtCaret(at, Fragment.from(schema.node('heading', null, [schema.text('h')])))).toBeNull()
    expect(inlineAtCaret(EditorState.create({ doc: d, selection: NodeSelection.create(d, 0) }), one('x'))).toBeNull()
    expect(inlineAtCaret(stateAt(d, posOf(d, 'code')), Fragment.from(p(bold('X'))))).toBeNull()
  })
  it('代码块里放纯文字可以(同打字)', () => {
    const d = doc(schema.node('code_block', null, [schema.text('code')]))
    const r = inlineAtCaret(stateAt(d, posOf(d, 'code') + 4), one('X'))!
    expect(r.tr.doc.textContent).toBe('codeX')
  })
  it('与标记连用:占位字随行内内容进来,删掉后光标落在标记处', () => {
    const d = doc(p('ab'))
    const r = inlineAtCaret(stateAt(d, posOf(d, 'b')), one(`[${CARET_MARK}]`))!
    expect(landOnCaretMark(r.tr)).toBe(true)
    expect(r.tr.doc.textContent).toBe('a[]b')
    expect(r.tr.selection.from).toBe(posOf(r.tr.doc, ']b'))
  })
})
