// @vitest-environment happy-dom
//
// D-05(评审 2026-09-27):任何编辑都把 `-` 无序列表 / 待办写成松散的 `*` 列表。真 Milkdown(生产装配,见 parseFidelity.testkit.ts)。
// 真浏览器那一半:npm run check:rtcorpus 的 d18.list_* / d05.*。
import { describe, expect, it } from 'vitest'
import { bootEditor, roundTrip } from './parseFidelity.testkit'

describe('列表往返:紧凑度与原列表符(D-05 / 拍板 #17)', () => {
  it.each([
    ['`-` 紧凑 + 嵌套', '- a\n- b\n  - c\n'],
    ['`*` 紧凑', '* a\n* b\n'],
    ['`+` 紧凑', '+ a\n+ b\n'],
    ['待办 `-`', '- [ ] todo\n- [x] done\n'],
    ['松散列表仍松散', '- a\n\n- b\n'],
    ['有序嵌套紧凑', '1. x\n   1. y\n2. z\n'],
    ['嵌套层各用各的符', '- a\n  * b\n    + c\n'],
    ['引用里的列表', '> - q\n> - r\n'],
  ])('%s', async (_label, md) => {
    expect(await roundTrip(md)).toBe(md)
  })

  it('编辑器里新建的嵌套列表(list 缺省 spread=false、项缺省 true)落盘紧凑,重开再存不散开', async () => {
    const b = await bootEditor('seed\n')
    try {
      const s = b.view.state.schema
      const li = (text: string, ...kids: ReturnType<typeof s.node>[]) => s.nodes.list_item.create(null, [s.nodes.paragraph.create(null, s.text(text)), ...kids])
      const list = s.nodes.bullet_list.create(null, [li('a', s.nodes.bullet_list.create(null, [li('b'), li('c')]))])
      b.view.dispatch(b.view.state.tr.insert(b.view.state.doc.content.size, list))
      const first = b.md()
      expect(first).toBe('seed\n\n* a\n  * b\n  * c\n')
      expect(await roundTrip(first)).toBe(first)
    } finally {
      await b.destroy()
    }
  })

  it('Tab 缩进出来的子列表(无 bullet attr)跟随外层的原列表符', async () => {
    const b = await bootEditor('- a\n')
    try {
      const s = b.view.state.schema
      const outer = b.view.state.doc.firstChild!
      const item = outer.firstChild!
      const nested = s.nodes.bullet_list.create(null, [s.nodes.list_item.create(null, [s.nodes.paragraph.create(null, s.text('b'))])])
      // 项内段落之后追加一只新子列表(= sinkListItem 的产物形状:子列表 attrs 全缺省)
      const at = 1 + item.nodeSize - 1
      b.view.dispatch(b.view.state.tr.insert(at, nested))
      expect(b.md()).toBe('- a\n  - b\n')
      expect(outer.attrs.bullet).toBe('-')
    } finally {
      await b.destroy()
    }
  })

  it('相邻两只同符列表落盘仍是两只(换另一个符隔开,不并成一只)', async () => {
    const b = await bootEditor('- a\n\ntext\n\n- b\n')
    try {
      // 删掉中间的段落 → 两只 `-` 列表相邻
      const doc = b.view.state.doc
      const mid = doc.child(1)
      const from = doc.child(0).nodeSize
      b.view.dispatch(b.view.state.tr.delete(from, from + mid.nodeSize))
      const out = b.md()
      const kids: string[] = []
      b.parse(out).forEach((n) => { kids.push(n.type.name) })
      expect(kids).toEqual(['bullet_list', 'bullet_list'])
    } finally {
      await b.destroy()
    }
  })
})
