// 拼写检查「不查」装饰的增量更新(updateCodeRanges):每种编辑之后都必须与整篇重建(codeRanges)一模一样。
import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { DecorationSet } from '@milkdown/kit/prose/view'
import { codeRanges, updateCodeRanges } from './spellcheck'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    blockquote: { group: 'block', content: 'block+', toDOM: () => ['blockquote', 0] },
    code_block: { group: 'block', content: 'text*', code: true, marks: '', toDOM: () => ['pre', 0] },
    text: { group: 'inline' },
  },
  marks: { inlineCode: { code: true, toDOM: () => ['code', 0] }, strong: { toDOM: () => ['strong', 0] } },
})
const p = (...parts: Array<string | [string]>) => schema.node('paragraph', null, parts.map((x) => typeof x === 'string' ? schema.text(x) : schema.text(x[0], [schema.marks.inlineCode.create()])))
const doc = schema.node('doc', null, [
  p('第一段 ', ['code'], ' 后面'), p('公式 $a+b$ 在这'), schema.node('code_block', null, [schema.text('const $x$ = 1')]),
  schema.node('blockquote', null, [p('引用里 ', ['q'])]), p('最后一段'),
])
const spans = (set: DecorationSet) => set.find().map((d) => `${d.from}-${d.to}`).sort()
/** 第 n 个顶层块的正文起点 */
const at = (n: number): number => { let pos = 0; for (let i = 0; i < n; i++) pos += doc.child(i).nodeSize; return pos + 1 }

function same(make: (s: EditorState) => Transaction): void {
  const state = EditorState.create({ doc, schema })
  const tr = make(state)
  expect(spans(updateCodeRanges(tr, codeRanges(doc)))).toEqual(spans(codeRanges(tr.doc)))
}

describe('updateCodeRanges', () => {
  it('普通段落里打字', () => same((s) => s.tr.insertText('字', at(0) + 2)))
  it('行内代码前后打字、在代码里打字', () => { same((s) => s.tr.insertText('x', at(0) + 4)); same((s) => s.tr.insertText('y', at(0) + 6)) })
  it('补出一对 $ 成了公式 / 删掉一个 $ 公式没了', () => {
    same((s) => s.tr.insertText('$c$', at(4) + 1))
    same((s) => s.tr.delete(at(1) + 3, at(1) + 4))
  })
  it('给一段文字加 / 去行内代码', () => {
    same((s) => s.tr.addMark(at(4), at(4) + 3, schema.marks.inlineCode.create()))
    same((s) => s.tr.removeMark(at(0), at(0) + 20, schema.marks.inlineCode))
  })
  it('拆段 / 合段 / 跨块删除 / 插入新块', () => {
    same((s) => s.tr.split(at(1) + 2))
    same((s) => s.tr.join(at(1) - 1))
    same((s) => s.tr.delete(at(0) + 2, at(1) + 5))
    same((s) => s.tr.insert(at(2) - 1, p('新段 ', ['n'], ' $m$')))
  })
  it('嵌套块里改 / 代码块里打 $', () => {
    same((s) => s.tr.insertText('z', at(3) + 3))
    same((s) => s.tr.insertText('$k$', at(2) + 1))
  })
  it('几段包进引用再去掉行内代码(ReplaceAroundStep;Codex 10-16 复现过残留)', () => {
    const d = schema.node('doc', null, [p('$a$'), p(['code']), p('$b$')])
    const s0 = EditorState.create({ doc: d, schema })
    const wrap = s0.tr.wrap(s0.doc.resolve(1).blockRange(s0.doc.resolve(d.content.size - 1))!, [{ type: schema.nodes.blockquote }])
    const s1 = updateCodeRanges(wrap, codeRanges(d))
    expect(spans(s1)).toEqual(spans(codeRanges(wrap.doc)))
    const unmark = EditorState.create({ doc: wrap.doc, schema }).tr.removeMark(0, wrap.doc.content.size, schema.marks.inlineCode)
    expect(spans(updateCodeRanges(unmark, s1))).toEqual(spans(codeRanges(unmark.doc)))
  })
  it('一次事务多步,再撤回去', () => {
    const state = EditorState.create({ doc, schema })
    const tr = state.tr.insertText('$a$', at(4) + 1).split(at(0) + 3).addMark(at(4) + 2, at(4) + 6, schema.marks.inlineCode.create())
    const forward = updateCodeRanges(tr, codeRanges(doc))
    expect(spans(forward)).toEqual(spans(codeRanges(tr.doc)))
    const undo = EditorState.create({ doc: tr.doc, schema }).tr
    for (let i = tr.steps.length - 1; i >= 0; i--) undo.step(tr.steps[i].invert(tr.docs[i]))
    expect(undo.doc.eq(doc)).toBe(true)
    expect(spans(updateCodeRanges(undo, forward))).toEqual(spans(codeRanges(doc)))
  })
})
