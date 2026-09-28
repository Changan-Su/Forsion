// 回灌最小差异事务(评审 D-08 / K-05)。用一个与 Milkdown 同形的小 schema(标题带 id 属性、列表 / 引用可嵌套)
// 直接驱动纯函数:光标、折叠锚这类「位置」要随 mapping 活下来,前提是被替换的区间足够小。
import { describe, it, expect } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { history, undo } from '@milkdown/kit/prose/history'
import { reconcileSteps, reconcileTr, sameNodeLoose } from './reconcileDiff'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 }, id: { default: '' } } },
    blockquote: { group: 'block', content: 'block+' },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' },
  },
})
const t = (s: string) => schema.text(s)
const p = (s: string) => schema.node('paragraph', null, s ? [t(s)] : [])
const h = (s: string, id = '') => schema.node('heading', { level: 2, id }, [t(s)])
const li = (s: string) => schema.node('list_item', null, [p(s)])
const ul = (...items: string[]) => schema.node('bullet_list', null, items.map(li))
const bq = (...ps: string[]) => schema.node('blockquote', null, ps.map(p))
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)

/** 光标放到 doc 里第一处 text 之后。 */
function at(d: PMNode, text: string): number {
  let found = -1
  d.descendants((n, pos) => {
    if (found >= 0) return false
    if (n.isText && n.text!.includes(text)) found = pos + n.text!.indexOf(text) + text.length
    return true
  })
  if (found < 0) throw new Error(`no ${text}`)
  return found
}
function stateAt(d: PMNode, text: string): EditorState {
  const st = EditorState.create({ doc: d, plugins: [history()] })
  return st.apply(st.tr.setSelection(TextSelection.create(st.doc, at(d, text))))
}
function apply(st: EditorState, next: PMNode): EditorState {
  const tr = reconcileTr(st, next)
  return tr ? st.apply(tr) : st
}
const caret = (st: EditorState) => ({ text: st.selection.$from.parent.textContent, off: st.selection.$from.parentOffset })

describe('reconcileTr:结果恒等于 next', () => {
  const cases: Array<[string, PMNode, PMNode]> = [
    ['单段改字', doc(p('alpha beta')), doc(p('ALPHA beta'))],
    ['插入一段', doc(p('a'), p('c')), doc(p('a'), p('b'), p('c'))],
    ['删掉一段', doc(p('a'), p('b'), p('c')), doc(p('a'), p('c'))],
    ['重复字符的重叠收缩', doc(p('aa')), doc(p('aaa'))],
    ['重复字符的重叠收缩(删)', doc(p('aaa')), doc(p('aa'))],
    ['两处不相邻', doc(p('one'), p('two'), p('three'), p('four')), doc(p('ONE'), p('two'), p('three'), p('FOUR'))],
    ['块类型变了', doc(p('x'), p('y')), doc(h('x'), p('y'))],
    ['清空', doc(p('a'), p('b')), doc(p(''))],
    ['列表项增删', doc(ul('a', 'b', 'c')), doc(ul('a', 'c', 'd'))],
    ['引用里改段', doc(bq('q1', 'q2', 'q3')), doc(bq('q1 x', 'q2', 'q3'))],
    ['整体重排', doc(p('a'), p('b'), p('c')), doc(p('c'), p('b'), p('a'))],
  ]
  for (const [name, a, b] of cases) {
    it(name, () => {
      const st = EditorState.create({ doc: a })
      const out = apply(st, b)
      expect(sameNodeLoose(out.doc, b)).toBe(true)
    })
  }
})

describe('D-08:光标 / 折叠锚不被甩走', () => {
  it('大列表:光标在第 10 项,外部改第 1 项 → 光标原地', () => {
    const items = Array.from({ length: 12 }, (_, i) => `item${i + 1} text`)
    const st = stateAt(doc(h('Outline', 'outline'), ul(...items)), 'item10 te')
    const next = doc(h('Outline'), ul(...items.map((x, i) => (i === 0 ? `${x} CHANGED` : x))))
    const out = apply(st, next)
    expect(caret(out)).toEqual({ text: 'item10 text', off: 9 })
  })

  it('标题 id 只差回填值(解析出来是空串)→ 视为相同,零步', () => {
    const cur = doc(h('A', 'a'), p('x'), h('B', 'b'))
    expect(reconcileSteps(cur, doc(h('A'), p('x'), h('B')))).toEqual([])
  })

  it('带标题的文档只改一处:替换区间只覆盖那几个字,标题前的位置不动', () => {
    const cur = doc(h('文档', 'wd'), p('段落5 原文'), h('小节10', 'x10'), p('段落20 原文内容'), h('小节25', 'x25'), p('段落40'))
    const next = doc(h('文档'), p('段落5 AGENT'), h('小节10'), p('段落20 原文内容'), h('小节25'), p('段落40'))
    const steps = reconcileSteps(cur, next)
    expect(steps).toHaveLength(1)
    expect(steps[0].to - steps[0].from).toBe(2) // 「原文」两个字
    const st = stateAt(cur, '段落20 原文')
    expect(caret(apply(st, next))).toEqual({ text: '段落20 原文内容', off: 7 })
  })

  it('同一段里光标前的字被改 → 光标跟着字走,不甩到段尾', () => {
    const st = stateAt(doc(p('alpha beta gamma delta')), 'gamma')
    const out = apply(st, doc(p('ALPHA-EXT beta gamma delta')))
    expect(caret(out)).toEqual({ text: 'ALPHA-EXT beta gamma delta', off: 20 })
  })

  it('两处不相邻的改动 → 两处都替换,中间那段光标不动', () => {
    const st = stateAt(doc(p('one'), p('two here'), p('three')), 'two')
    const next = doc(p('ONE'), p('two here'), p('THREE'))
    expect(reconcileSteps(st.doc, next)).toHaveLength(2)
    const out = apply(st, next)
    expect(caret(out)).toEqual({ text: 'two here', off: 3 })
  })

  it('光标落在被替换区间里 → 按原偏移夹回(不被甩到区间一端)', () => {
    const st = stateAt(doc(p('head'), p('abcdefgh'), p('tail')), 'abcd')
    const out = apply(st, doc(p('head'), h('abcdefgh'), p('tail'))) // 段 → 标题:整块替换
    expect(caret(out)).toEqual({ text: 'abcdefgh', off: 4 })
  })

  it('位于未改区间的位置(折叠锚)随 mapping 活下来', () => {
    const cur = doc(h('A', 'a'), p('a1'), h('B', 'b'), p('b1'), p('tail'))
    const st = EditorState.create({ doc: cur })
    let posB = -1
    cur.forEach((n, off) => { if (n.textContent === 'B') posB = off })
    const tr = reconcileTr(st, doc(h('A'), p('a1'), h('B'), p('b1'), p('tail CHANGED')))!
    const mapped = tr.mapping.mapResult(posB)
    expect(mapped.deleted).toBe(false)
    expect(tr.doc.nodeAt(mapped.pos)?.textContent).toBe('B')
  })
})

describe('K-05:回灌不进撤销栈', () => {
  it('本地打字 → 外部改另一段 → undo 只撤本地,外部那段留着', () => {
    let st = stateAt(doc(p('甲段。'), p('乙段。')), '甲段。')
    st = st.apply(st.tr.insertText('本地'))
    st = apply(st, doc(p('甲段。本地'), p('乙段。外部改动')))
    let undone: EditorState | null = null
    undo(st, (tr) => { undone = st.apply(tr) })
    expect(undone).not.toBeNull()
    expect(undone!.doc.textContent).toBe('甲段。乙段。外部改动')
  })

  it('没有本地编辑 → 回灌后 undo 无事可做', () => {
    const st = apply(stateAt(doc(p('甲段。'), p('乙段。')), '甲段。'), doc(p('甲段。'), p('乙段。外部改动')))
    expect(undo(st)).toBe(false)
  })
})
