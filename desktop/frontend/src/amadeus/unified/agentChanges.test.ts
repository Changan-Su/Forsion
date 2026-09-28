// Agent 改动呈现(评审 G3-03)的纯状态契约:回灌打标 → 记「新区间 + 旧片段」;连改同一处合并、旧片段取第一次之前;
// 「全部撤回」跳过用户改过的那处、是一次进撤销栈的普通编辑;「保留」零改动;贴边打字不算改过。
import { describe, it, expect } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { history, undo, undoDepth } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import { reconcileTr, type ReconcileChange } from './reconcileDiff'
import { agentChangesKey, agentChangesPlugin, keepAgentChanges, markAgentChanges, nextAgentChange, revertAgentChanges } from './agentChanges'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 }, id: { default: '' } } },
    horizontal_rule: { group: 'block' },
    text: { group: 'inline' },
  },
})
const p = (s: string) => schema.node('paragraph', null, s ? [schema.text(s)] : [])
const h = (s: string, id = '') => schema.node('heading', { level: 2, id }, [schema.text(s)])
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)
const text = (d: PMNode) => { const out: string[] = []; d.forEach((n) => out.push(n.textContent)); return out.join(' / ') }

/** 最小视图替身:revert / keep / next 只用 state 与 dispatch。 */
function fakeView(d: PMNode): EditorView & { state: EditorState } {
  const v = {
    state: EditorState.create({ doc: d, plugins: [history(), agentChangesPlugin({ current: () => {} })] }),
    dispatch(tr: Parameters<EditorView['dispatch']>[0]) { v.state = v.state.apply(tr) },
  }
  return v as unknown as EditorView & { state: EditorState }
}
/** 一次 Agent 回灌(与 UnifiedPage.applyMinimalDiff 的 agent 分支同一条路)。 */
function agentWrite(v: EditorView & { state: EditorState }, next: PMNode): void {
  const changes: ReconcileChange[] = []
  const tr = reconcileTr(v.state, next, changes)
  if (tr) v.dispatch(markAgentChanges(tr, v.state.doc, changes))
}
const st = (v: { state: EditorState }) => agentChangesKey.getState(v.state)!
function typeAt(v: EditorView & { state: EditorState }, after: string, s: string): void {
  let at = -1
  v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text!.includes(after)) at = pos + n.text!.indexOf(after) + after.length; return at < 0 })
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at)).insertText(s))
}

describe('agentChanges', () => {
  it('回灌打标:每处改动记新区间,区间里正好是 Agent 写的字;回灌本身不进撤销栈', () => {
    const v = fakeView(doc(h('文档'), p('第一段原文。'), p('第二段原文。'), p('第三段原文。')))
    agentWrite(v, doc(h('文档'), p('第一段 AGENT 改过。'), p('第二段原文。'), p('第三段 AGENT 也改了。')))
    const cs = st(v).changes
    expect(cs.map((c) => v.state.doc.textBetween(c.from, c.to))).toEqual([' AGENT 改过', ' AGENT 也改了'])
    expect(undoDepth(v.state)).toBe(0)
  })

  it('全部撤回:回到 Agent 改之前,且是一次可撤销的普通编辑', () => {
    // 中间隔一段没改的:回灌的 LCS 才会把两处拆开(没有它,首尾收缩后就是一整段区间 —— reconcileDiff 的口径)。
    const base = doc(h('文档'), p('第一段原文。'), p('中间不动。'), p('第三段原文。'))
    const v = fakeView(base)
    agentWrite(v, doc(h('文档'), p('第一段 AGENT。'), p('中间不动。'), p('第三段原文 AGENT。')))
    expect(revertAgentChanges(v)).toEqual({ reverted: 2, skipped: 0 })
    expect(v.state.doc.eq(base)).toBe(true)
    expect(st(v).changes).toEqual([])
    expect(undoDepth(v.state)).toBe(1)
    undo(v.state, v.dispatch)
    expect(text(v.state.doc)).toBe('文档 / 第一段 AGENT。 / 中间不动。 / 第三段原文 AGENT。')
  })

  it('Agent 连改同一处 → 合并成一处,撤回回到第一次改之前', () => {
    const v = fakeView(doc(p('开头'), p('甲乙丙'), p('结尾')))
    agentWrite(v, doc(p('开头'), p('甲 AAA 乙丙'), p('结尾')))
    agentWrite(v, doc(p('开头'), p('甲 AXXXA 乙丙'), p('结尾'))) // 改在第一处里面
    expect(st(v).changes.length).toBe(1)
    const [c] = st(v).changes
    expect(v.state.doc.textBetween(c.from, c.to)).toBe(' AXXXA ')
    revertAgentChanges(v)
    expect(text(v.state.doc)).toBe('开头 / 甲乙丙 / 结尾')
  })

  it('第二次改动贴着第一处 → 也并成一处', () => {
    const v = fakeView(doc(p('甲乙丙')))
    agentWrite(v, doc(p('甲AAA乙丙')))
    agentWrite(v, doc(p('甲AAABBB乙丙')))
    expect(st(v).changes.length).toBe(1)
    revertAgentChanges(v)
    expect(text(v.state.doc)).toBe('甲乙丙')
  })

  it('第二次回灌与第一次不相交 → 各记各的,互不干扰', () => {
    const v = fakeView(doc(p('一'), p('二'), p('三')))
    agentWrite(v, doc(p('一 A'), p('二'), p('三')))
    agentWrite(v, doc(p('一 A'), p('二'), p('三 B')))
    expect(st(v).changes.length).toBe(2)
    revertAgentChanges(v)
    expect(text(v.state.doc)).toBe('一 / 二 / 三')
  })

  it('用户在某处中间改过 → 撤回跳过那处;贴边打字不算改过', () => {
    const v = fakeView(doc(p('第一段原文。'), p('中间。'), p('第二段原文。')))
    agentWrite(v, doc(p('第一段 AGENT。'), p('中间。'), p('第二段 AGENT。')))
    typeAt(v, '第一段 AG', 'x') // 改在第一处中间
    typeAt(v, '第二段 AGENT', '!') // 贴着第二处的末尾
    expect(revertAgentChanges(v)).toEqual({ reverted: 1, skipped: 1 })
    expect(text(v.state.doc)).toBe('第一段 AGxENT。 / 中间。 / 第二段原文!。')
  })

  it('纯删除:区间收成一点,撤回把删掉的放回去', () => {
    const v = fakeView(doc(p('保留'), p('被删掉的一段'), p('结尾')))
    agentWrite(v, doc(p('保留'), p('结尾')))
    const [c] = st(v).changes
    expect(c.from).toBe(c.to)
    revertAgentChanges(v)
    expect(text(v.state.doc)).toBe('保留 / 被删掉的一段 / 结尾')
  })

  it('标题 id 这类回填属性变了不算用户改过(syncHeadingId 会在回灌后补一笔)', () => {
    const v = fakeView(doc(h('旧标题'), p('正文')))
    agentWrite(v, doc(h('新标题'), p('正文')))
    const pos = 0
    v.dispatch(v.state.tr.setNodeMarkup(pos, undefined, { level: 2, id: '新标题' }))
    expect(revertAgentChanges(v).reverted).toBe(1)
    expect(text(v.state.doc)).toBe('旧标题 / 正文')
  })

  it('保留:只清标记,文档不动;逐处查看循环', () => {
    const v = fakeView(doc(p('一'), p('中'), p('二')))
    agentWrite(v, doc(p('一 A'), p('中'), p('二 B')))
    const d = v.state.doc
    expect(nextAgentChange(v)?.id).toBe(st(v).changes[0].id)
    expect(nextAgentChange(v)?.id).toBe(st(v).changes[1].id)
    expect(nextAgentChange(v)?.id).toBe(st(v).changes[0].id)
    keepAgentChanges(v)
    expect(st(v)).toEqual({ changes: [], current: null })
    expect(v.state.doc.eq(d)).toBe(true)
  })

  it('不打标的回灌(非 Tangu / 恢复草稿)不产生任何标记', () => {
    const v = fakeView(doc(p('一')))
    const tr = reconcileTr(v.state, doc(p('一 改')))!
    v.dispatch(tr)
    expect(st(v).changes).toEqual([])
  })
})
