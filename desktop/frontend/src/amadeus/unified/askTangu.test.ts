// 「问 Tangu」引用文本(评审 G3-04):选区文字 + 最近标题锚点;锚点只到标题、不碰笔记;坏标题退回只带路径。
import { describe, it, expect } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { askTanguQuote, headingAbove } from './askTangu'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 }, id: { default: '' } } },
    text: { group: 'inline' },
  },
})
const p = (s: string) => schema.node('paragraph', null, s ? [schema.text(s)] : [])
const h = (s: string, level = 2) => schema.node('heading', { level }, [schema.text(s)])
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)
/** 第一处 text 的 [起, 止)。 */
function range(d: PMNode, text: string): [number, number] {
  let r: [number, number] | null = null
  d.descendants((n, pos) => {
    if (r || !n.isText || !n.text!.includes(text)) return !r
    const at = pos + n.text!.indexOf(text)
    r = [at, at + text.length]
    return false
  })
  if (!r) throw new Error(`no ${text}`)
  return r
}

describe('askTanguQuote', () => {
  it('选区文字 + 最近的上级标题锚点(库相对路径)', () => {
    const d = doc(h('开头', 1), p('第一段。'), h('第二节'), p('这是一段需要润色的文字。'))
    const [a, b] = range(d, '需要润色的文字')
    expect(askTanguQuote(d, a, b, 'dir/笔记.md')).toBe('需要润色的文字\n— [[dir/笔记.md#第二节]]')
  })

  it('选中的就是标题本身(块菜单 NodeSelection 的 from = 标题 pos)→ 锚到它自己', () => {
    const d = doc(h('开头', 1), h('第二节'), p('正文'))
    let pos = -1
    d.forEach((n, off) => { if (n.textContent === '第二节') pos = off })
    expect(headingAbove(d, pos)).toBe('第二节')
    expect(askTanguQuote(d, pos, pos + d.nodeAt(pos)!.nodeSize, 'a.md')).toBe('第二节\n— [[a.md#第二节]]')
  })

  it('跨块选区按行拼;上面没有标题 → 只带路径', () => {
    const d = doc(p('甲段'), p('乙段'), h('后面的标题'))
    const [a] = range(d, '甲段')
    const [, b] = range(d, '乙段')
    expect(askTanguQuote(d, a, b, 'a.md')).toBe('甲段\n乙段\n— [[a.md]]')
  })

  it('标题里有会让链接解析失败的字符 → 退回只带路径,不造坏锚', () => {
    for (const bad of ['C# 入门', 'a|b', '[x]', '块 ^ab']) {
      const d = doc(h(bad), p('正文内容'))
      const [a, b] = range(d, '正文内容')
      expect(askTanguQuote(d, a, b, 'a.md')).toBe('正文内容\n— [[a.md]]')
    }
  })

  it('空选区 / 纯空白 → 空串(调用方据此不交接)', () => {
    const d = doc(p('  '), p('x'))
    expect(askTanguQuote(d, 1, 3, 'a.md')).toBe('')
  })
})
