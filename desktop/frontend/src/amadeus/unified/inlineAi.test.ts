// 正文 AI 编辑器侧(评审 G3-07)的纯契约:目标区间随编辑映射;写入的三种方式;目标被改过时不盖掉;空行空格的闸。
import { describe, it, expect } from 'vitest'
import { Schema, Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { history, undoDepth } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import { aiTargetOf, applyAiResult, inlineAiPlugin, setAiTarget, translateTargetOf, aiContextOf } from './inlineAi'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' },
  },
  marks: { link: { attrs: { href: {} } }, strong: {} },
})
const p = (s: string) => schema.node('paragraph', null, s ? [schema.text(s)] : [])
const doc = (...b: PMNode[]) => schema.node('doc', null, b)
const texts = (d: PMNode) => { const o: string[] = []; d.forEach((n) => o.push(n.textContent)); return o }
function view(d: PMNode, space = { on: false, hits: 0 }) {
  const plugin = inlineAiPlugin({ spaceTrigger: () => space.on, onSpace: () => { space.hits++ } })
  const v = {
    state: EditorState.create({ doc: d, plugins: [history(), plugin] }),
    composing: false,
    dispatch(tr: Parameters<EditorView['dispatch']>[0]) { v.state = v.state.apply(tr) },
    someKey: (e: Partial<KeyboardEvent>) => plugin.props.handleKeyDown!.call(plugin, v as unknown as EditorView, { key: ' ', ...e } as KeyboardEvent),
  }
  return v as unknown as EditorView & { state: EditorState; composing: boolean; someKey: (e: Partial<KeyboardEvent>) => boolean | void }
}
function rangeOf(d: PMNode, s: string): [number, number] {
  let r: [number, number] | null = null
  d.descendants((n, pos) => { if (!r && n.isText && n.text!.includes(s)) r = [pos + n.text!.indexOf(s), pos + n.text!.indexOf(s) + s.length]; return !r })
  return r!
}

describe('inlineAi', () => {
  it('替换:单段结果并进原段落(不劈段),是一次可撤销的编辑', () => {
    const v = view(doc(p('完成了改版，写得不太好。'), p('第二段')))
    const [a, b] = rangeOf(v.state.doc, '写得不太好')
    const t = setAiTarget(v, a, b)
    expect(applyAiResult(v, t, Fragment.from(p('Better')), 'replace')).toBe('replace')
    expect(texts(v.state.doc)).toEqual(['完成了改版，Better。', '第二段'])
    expect(aiTargetOf(v)).toBeNull()
    expect(undoDepth(v.state)).toBe(1)
  })

  it('目标在生成期间被用户改过 → 不盖掉,改为插入下方', () => {
    const v = view(doc(p('甲乙丙丁'), p('尾')))
    const [a, b] = rangeOf(v.state.doc, '乙丙')
    const t = setAiTarget(v, a, b)
    v.dispatch(v.state.tr.insertText('X', a + 1)) // 用户在目标中间打了字(贴边打字不算,见区间映射的结合方向)
    expect(applyAiResult(v, aiTargetOf(v)!, Fragment.from(p('新')), 'replace')).toBe('below')
    expect(texts(v.state.doc)).toEqual(['甲乙X丙丁', '新', '尾'])
    expect(t.text).toBe('乙丙')
  })

  it('目标文字没变但链接地址 / marks 被改了(Codex 复核 P1)→ 同样不盖掉,改为插入下方', () => {
    const d = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('看'), schema.text('这个链接', [schema.mark('link', { href: 'https://a.example' })]), schema.text('吧')])])
    const v = view(d)
    const [a, b] = rangeOf(v.state.doc, '这个链接')
    setAiTarget(v, a, b)
    const t = aiTargetOf(v)!
    v.dispatch(v.state.tr.removeMark(t.from, t.to, schema.marks.link).addMark(t.from, t.to, schema.marks.link.create({ href: 'https://b.example' })))
    expect(applyAiResult(v, aiTargetOf(v)!, Fragment.from(p('新')), 'replace')).toBe('below')
    expect(v.state.doc.rangeHasMark(a, b, schema.marks.link)).toBe(true)
  })

  it('插入下方 / 光标模式插入(空行被替换、非空行插在后面)', () => {
    const v = view(doc(p('一'), p(''), p('三')))
    const [a, b] = rangeOf(v.state.doc, '一')
    applyAiResult(v, setAiTarget(v, a, b), Fragment.from([p('A1'), p('A2')]), 'below')
    expect(texts(v.state.doc)).toEqual(['一', 'A1', 'A2', '', '三'])
    let empty = -1
    v.state.doc.forEach((n, off) => { if (empty < 0 && !n.textContent) empty = off + 1 })
    applyAiResult(v, setAiTarget(v, empty, empty), Fragment.from(p('填上')), 'insert')
    expect(texts(v.state.doc)).toEqual(['一', 'A1', 'A2', '填上', '三'])
  })

  it('空行空格:缺省关放行;开了只在空的普通段落里、非组字时接管', () => {
    const space = { on: false, hits: 0 }
    const v = view(doc(p('有字'), p('')), space)
    const endEmpty = v.state.doc.content.size - 1
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, endEmpty)))
    expect(v.someKey({})).toBe(false)
    space.on = true
    expect(v.someKey({ isComposing: true } as Partial<KeyboardEvent>)).toBe(false)
    expect(v.someKey({ keyCode: 229 } as Partial<KeyboardEvent>)).toBe(false)
    expect(v.someKey({ shiftKey: true })).toBe(false)
    expect(v.someKey({})).toBe(true)
    expect(space.hits).toBe(1)
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2)))
    expect(v.someKey({})).toBe(false) // 有字的段落照常打空格
  })

  it('翻译方向与上下文截取', () => {
    expect(translateTargetOf('这是一段中文')).toBe('English')
    expect(translateTargetOf('Plain English text')).toBe('Chinese (Simplified)')
    const d = doc(p('a'.repeat(3000)), p('mid'), p('b'.repeat(3000)))
    const [a, b] = rangeOf(d, 'mid')
    const c = aiContextOf(d, a, b)
    expect(c.before.length).toBe(2000)
    expect(c.after.length).toBe(1000)
  })
})
