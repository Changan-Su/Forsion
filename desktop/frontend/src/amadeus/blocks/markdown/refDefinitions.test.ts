// @vitest-environment happy-dom
//
// D-12:链接定义行 / `[标签]: 值` 中文行打开看不见、编辑后从磁盘删掉;`[a][1]` 被改写成行内链接(评审 2026-09-27)。
// 真 Milkdown(生产装配,见 parseFidelity.testkit.ts)。真浏览器那一半:npm run check:rtcorpus 的 d12.* / entry.*。
import { describe, expect, it } from 'vitest'
import { DOMParser, DOMSerializer } from '@milkdown/kit/prose/model'
import { bootEditor, roundTrip } from './parseFidelity.testkit'

describe('定义行 / 引用式链接逐字往返', () => {
  it.each([
    ['中文标签行', '会议记录\n\n[重要]: 明天开会\n\n[TODO]: 回复邮件\n\n结尾\n'],
    ['没被引用的书签定义(相邻两行合一段)', 'text\n\n[bookmark]: https://example.com\n[other]: https://other.com "t"\n'],
    ['full / collapsed / shortcut 三种引用', 'see [a][1] and [b][] and [c]\n\n[1]: http://example.com "Title"\n[b]: http://x.y\n[c]: /c\n'],
    ['定义里的 `_` `*` 尖括号地址不被转义', '[a_b]: https://x.com/a_b*c "t_1"\n\n[k]: <https://x.com/y z>\n'],
    ['引用里的定义', '> 引文\n>\n> [ref]: https://q.example\n'],
    ['列表项里的多行定义', '* [a]: http://x.example\n  "title"\n'],
    ['图片引用与链接引用同在(不白屏)', '![pic][1] and [t][1]\n\n[1]: http://x.y/p.png\n'],
  ])('%s', async (label, md) => {
    const out = await roundTrip(md)
    // 图片引用照旧转行内图片(取舍,见 refDefinitions.ts 顶注),其余逐字。
    if (label.startsWith('图片引用')) expect(out).toBe('![pic](http://x.y/p.png) and [t][1]\n\n[1]: http://x.y/p.png\n')
    else expect(out).toBe(md)
  })

  it('v3 宿主(softBreakRemark 按行拆段)也逐字:每段只认自己那一行原文', async () => {
    const md = 'text\n\n[bookmark]: https://example.com\n[other]: https://other.com "t"\n'
    expect(await roundTrip(md, { v3: true })).toBe(md)
  })

  it('定义行打开即可见(段落正文就是原文)', async () => {
    const b = await bootEditor('会议记录\n\n[重要]: 明天开会\n')
    try {
      expect(b.view.dom.textContent).toContain('[重要]: 明天开会')
    } finally { await b.destroy() }
  })

  it('引用照常渲染成链接,对象 attr 不漏进 DOM', async () => {
    const b = await bootEditor('see [a][1]\n\n[1]: http://example.com\n')
    try {
      const a = b.view.dom.querySelector('a')!
      expect(a.getAttribute('href')).toBe('http://example.com')
      expect(a.hasAttribute('ref')).toBe(false)
      expect(JSON.parse(a.getAttribute('data-md-ref')!)).toMatchObject({ referenceType: 'full', label: '1' })
    } finally { await b.destroy() }
  })

  it('改了链接地址(链接卡)→ 退成行内链接,不写回指向旧地址的引用', async () => {
    const b = await bootEditor('see [a][1]\n\n[1]: http://example.com\n')
    try {
      const { state } = b.view
      const link = state.schema.marks.link
      let from = -1, to = -1, attrs: Record<string, unknown> = {}
      state.doc.descendants((n, pos) => {
        const m = n.marks.find((x) => x.type === link)
        if (m && from < 0) { from = pos; to = pos + n.nodeSize; attrs = m.attrs }
      })
      b.view.dispatch(state.tr.removeMark(from, to, link).addMark(from, to, link.create({ ...attrs, href: 'http://new.example' })))
      expect(b.md()).toBe('see [a](http://new.example)\n\n[1]: http://example.com\n')
    } finally { await b.destroy() }
  })

  it('动过的定义行按普通段落写(转义成字面,内容不丢)', async () => {
    const b = await bootEditor('[重要]: 明天开会\n')
    try {
      b.view.dispatch(b.view.state.tr.insertText('！', b.view.state.doc.content.size - 1))
      expect(b.md()).toBe('\\[重要]: 明天开会！\n')
    } finally { await b.destroy() }
  })

  it('给定义行加缩进档:不能原样写回吞掉缩进', async () => {
    const b = await bootEditor('[重要]: 明天开会\n')
    try {
      const p = b.view.state.doc.firstChild!
      b.view.dispatch(b.view.state.tr.setNodeMarkup(0, undefined, { ...p.attrs, indent: 1 }))
      expect(b.md()).not.toBe('[重要]: 明天开会\n')
      expect(b.md()).toContain('明天开会')
    } finally { await b.destroy() }
  })

  it('粘贴链路(md → PM → DOM → parseSlice)保留定义原文与引用形', async () => {
    const md = 'see [a][1]\n\n[1]: http://example.com "T"\n'
    const b = await bootEditor('x\n')
    try {
      const { schema } = b.view.state
      const dom = DOMSerializer.fromSchema(schema).serializeFragment(b.parse(md).content)
      const slice = DOMParser.fromSchema(schema).parseSlice(dom)
      b.view.dispatch(b.view.state.tr.replaceWith(0, b.view.state.doc.content.size, slice.content))
      expect(b.md()).toBe(md)
    } finally { await b.destroy() }
  })
})
