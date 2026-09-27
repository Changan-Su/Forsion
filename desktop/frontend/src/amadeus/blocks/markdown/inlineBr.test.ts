// @vitest-environment happy-dom
//
// D-06:行内 / 单元格 / 列表项里的 `<br>` 打开即被 preserve-empty-line 删掉(评审 2026-09-27)。
// 真 Milkdown(生产装配顺序,见 parseFidelity.testkit.ts)测「解析 → 落盘」逐字往返 + 渲染成真换行。
// 真浏览器那一半(打开零写、编辑别处后远处逐字):npm run check:rtcorpus 的 d06.*。
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor, roundTrip } from './parseFidelity.testkit'
import { inlineBrToBreak } from './inlineBr'

describe('行内 <br> 逐字往返', () => {
  it.each([
    ['段落', 'hello<br>world\n'],
    ['四种精确写法 + 变体', 'a<br>b<br/>c<br />d<br >e<BR>f<br class="k">g\n'],
    ['中文', '第一行<br>第二行\n'],
    ['列表项', '* 项<br>续行\n'],
    ['标题', '## 上<br>下\n'],
    ['段末 <br>(preset 会掐尾随 hardbreak)', 'line<br>\nnext\n'],
    ['单元格(规范宽度种子,只考 <br>)', '| k | v         |\n| - | --------- |\n| a | Alice<br> |\n'],
    ['单元格中间', '| 名称 | 说明         |\n| -- | ---------- |\n| a  | 第一行<br>第二行 |\n'],
  ])('%s', async (_label, md) => {
    expect(await roundTrip(md)).toBe(md)
  })

  it('渲染成真换行(<br> 元素),不是字面原子、也不是被删', async () => {
    const b = await bootEditor('hello<br>world\n')
    try {
      const html = b.view.dom.innerHTML
      expect(html).toMatch(/hello<br[^>]*>world/)
      expect(html).not.toContain('data-type="html"')
    } finally { await b.destroy() }
  })

  it('块级整行 <br> 不归它管(空行编码,附录 A 既定)', () => {
    const tree = { type: 'root', children: [{ type: 'html', value: '<br>' }, { type: 'paragraph', children: [{ type: 'text', value: 'a' }, { type: 'html', value: '<br />' }] }] }
    inlineBrToBreak(tree)
    expect(tree.children[0]).toEqual({ type: 'html', value: '<br>' })
    expect(tree.children[1].children![1]).toMatchObject({ type: 'break', data: { amadeusBr: '<br />' } })
  })

  it('给跨过 <br> 的选区加粗:<br> 原文不被重置(preset 的 hardbreakClearMark 会把 attrs 拍回缺省)', async () => {
    const b = await bootEditor('ab<br>cd\n')
    try {
      const { state } = b.view
      const strong = state.schema.marks.strong
      b.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)).addMark(1, state.doc.content.size - 1, strong.create()))
      // 粗体在 <br> 两侧各自闭合(mark 不挂在 hardbreak 上,与 preset 同),要紧的是 `<br>` 原文还在、没退成 `\` 换行。
      expect(b.md()).toBe('**ab**<br>**cd**\n')
    } finally { await b.destroy() }
  })

  it('用户自己敲的硬换行(无原文)照旧走 preset 的 `\\` 换行', async () => {
    const b = await bootEditor('ab\n')
    try {
      const { state } = b.view
      b.view.dispatch(state.tr.insert(2, state.schema.nodes.hardbreak.create()))
      expect(b.md()).toBe('a\\\nb\n')
    } finally { await b.destroy() }
  })
})
