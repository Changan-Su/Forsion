// 嵌入层的长笔记快路径(embedsUntouched):只有「每一步都落在单个非嵌入文本块里」才沿用旧装饰,其余一律整篇重建。
import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { embedsUntouched } from './embedLayer'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    code_block: { group: 'block', content: 'text*', attrs: { language: { default: '' } }, code: true, toDOM: () => ['pre', 0] },
    text: { group: 'inline' },
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
})
const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : [])
const doc = schema.node('doc', null, [p('第一段'), p('![[a.pdf]]'), p('![[b.pdf]'), p('第四段'), schema.node('code_block', { language: 'ts' }, [schema.text('const a = 1')])])
const state = EditorState.create({ doc, schema })
/** 第 n 个顶层块的正文起点 */
const at = (n: number): number => { let pos = 0; for (let i = 0; i < n; i++) pos += doc.child(i).nodeSize; return pos + 1 }

describe('embedsUntouched', () => {
  it('普通段落里打字:沿用', () => {
    expect(embedsUntouched(state.tr.insertText('字', at(0) + 1))).toBe(true)
    expect(embedsUntouched(state.tr.insertText('x', at(4) + 2))).toBe(true) // 普通代码块
  })
  it('只挪光标 / 只加标记(跨段):沿用', () => {
    expect(embedsUntouched(state.tr.setSelection(TextSelection.create(doc, at(3))))).toBe(true)
    expect(embedsUntouched(state.tr.addMark(at(0), at(3) + 2, schema.marks.strong.create()))).toBe(true)
  })
  it('改节点属性(代码块换语言,StepMap 为空):重建', () => {
    expect(embedsUntouched(state.tr.setNodeAttribute(at(4) - 1, 'language', 'forsion-button'))).toBe(false)
  })
  it('改到嵌入段自己:重建', () => {
    expect(embedsUntouched(state.tr.insertText('x', at(1) + 4))).toBe(false)
  })
  it('打字把段落补成嵌入:重建', () => {
    expect(embedsUntouched(state.tr.insertText(']', at(2) + doc.child(2).content.size))).toBe(false)
  })
  it('拆段 / 合段 / 插新段:重建', () => {
    expect(embedsUntouched(state.tr.split(at(0) + 1))).toBe(false)
    expect(embedsUntouched(state.tr.delete(at(3) - 2, at(3) + 1))).toBe(false)
    expect(embedsUntouched(state.tr.insert(at(1) - 1, p('新段')))).toBe(false)
  })
  it('一次事务里有一步不在单块内:重建', () => {
    expect(embedsUntouched(state.tr.insertText('字', at(0) + 1).split(at(3) + 2))).toBe(false)
  })
})
