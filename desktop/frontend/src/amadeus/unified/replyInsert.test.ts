// 助手回答插回的落点(评审 G3-08):「问 Tangu」出处 → 被引用块所在顶层块之后;标题限定到那一节;原文找不到退到节尾;都不成 → null。
import { describe, it, expect } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { replyAnchorPos } from './replyInsert'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 }, id: { default: '' } } },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' },
  },
})
const p = (s: string) => schema.node('paragraph', null, s ? [schema.text(s)] : [])
const h = (s: string, level = 2) => schema.node('heading', { level }, [schema.text(s)])
const ul = (...items: string[]) => schema.node('bullet_list', null, items.map((x) => schema.node('list_item', null, [p(x)])))
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)
/** 第 i 个顶层块的结尾位置。 */
const endOf = (d: PMNode, i: number) => {
  let pos = 0
  for (let k = 0; k <= i; k++) pos += d.child(k).nodeSize
  return pos
}

describe('replyAnchorPos', () => {
  const d = doc(h('开头', 1), p('同一句话。'), h('第二节'), p('前面一段。'), p('同一句话。被问的那段。'), p('后面一段。'), h('第三节'), p('尾段。'))

  it('标题限定到那一节:同样的字在上一节也有,落在本节被引用块之后', () => {
    expect(replyAnchorPos(d, { heading: '第二节', text: '同一句话。' })).toBe(endOf(d, 4))
  })

  it('跨块引用按行:落在末行所在块之后', () => {
    expect(replyAnchorPos(d, { heading: '第二节', text: '前面一段。\n同一句话。被问的那段。' })).toBe(endOf(d, 4))
  })

  it('原文找不到(引用后改过)但标题在 → 那一节末尾(下一个同级标题之前)', () => {
    expect(replyAnchorPos(d, { heading: '第二节', text: '早就被改掉的话' })).toBe(endOf(d, 5))
  })

  it('没有标题锚 → 全文找原文', () => {
    expect(replyAnchorPos(d, { text: '尾段。' })).toBe(endOf(d, 7))
  })

  it('列表里的项 → 整只列表之后(与 insertMd 的「顶层块」同口径)', () => {
    const d2 = doc(p('甲'), ul('一项', '被问的项'), p('乙'))
    expect(replyAnchorPos(d2, { text: '被问的项' })).toBe(endOf(d2, 1))
  })

  it('标题与原文都对不上 / 没有锚 → null(调用方退回光标处或文末)', () => {
    expect(replyAnchorPos(d, { heading: '不存在', text: '也不存在' })).toBeNull()
    expect(replyAnchorPos(d, null)).toBeNull()
    expect(replyAnchorPos(d, {})).toBeNull()
  })
})
