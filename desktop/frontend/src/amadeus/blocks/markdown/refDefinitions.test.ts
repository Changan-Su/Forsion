// @vitest-environment happy-dom
//
// D-12:链接定义行 / `[标签]: 值` 中文行打开看不见、编辑后从磁盘删掉;`[a][1]` 被改写成行内链接(评审 2026-09-27)。
// 真 Milkdown(生产装配,见 parseFidelity.testkit.ts)。真浏览器那一半:npm run check:rtcorpus 的 d12.* / entry.*。
import { describe, expect, it } from 'vitest'
import { DOMParser, DOMSerializer } from '@milkdown/kit/prose/model'
import { bootEditor, roundTrip, type Booted } from './parseFidelity.testkit'
import { normalizeFragmentMd } from './MarkdownBlock'

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

  it('相邻几条定义一行一条(硬换行),不挤成一行', async () => {
    const b = await bootEditor('[1]: http://a.example\n[c]: /c\n')
    try {
      const p = b.view.dom.querySelector('p')!
      expect(p.innerHTML).toMatch(/http:\/\/a\.example<br[^]*?\[c\]: \/c/)
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

// 评审返修 D-12-orphan-ref:引用形 `[a][1]` 只有在「正在写的这份文档」里还有那条定义时才写回;
// 否则退成行内链接 —— 不然文件里只剩一串字面 `[a][1]`,URL 没了。四条真实路径各一例,外加同名定义的「首个生效」。
describe('引用离开定义 → 退行内链接,URL 不丢', () => {
  const A = 'see [a][1] here\n\n[1]: http://example.com "T"\n'
  /** 找第一个正文以 prefix 开头的段落。 */
  const para = (b: Booted, prefix: string): { pos: number; size: number } => {
    let hit: { pos: number; size: number } | null = null
    b.view.state.doc.descendants((n, pos) => {
      if (!hit && n.type.name === 'paragraph' && n.textContent.startsWith(prefix)) hit = { pos, size: n.nodeSize }
      return !hit
    })
    if (!hit) throw new Error(`no paragraph starting with ${prefix}`)
    return hit
  }

  it('① 跨笔记粘贴(复制带 data-md-ref,贴进没有这条定义的笔记)', async () => {
    const a = await bootEditor(A)
    const b = await bootEditor('B 正文\n')
    try {
      const p = para(a, 'see ')
      // 同 PM 自己的复制:选区切片 → DOM(text/html)→ 目标编辑器 parseSlice
      const dom = DOMSerializer.fromSchema(a.view.state.schema).serializeFragment(a.view.state.doc.slice(p.pos, p.pos + p.size).content)
      const slice = DOMParser.fromSchema(b.view.state.schema).parseSlice(dom)
      b.view.dispatch(b.view.state.tr.insert(b.view.state.doc.content.size, slice.content))
      const out = b.md()
      expect(out).toBe('B 正文\n\nsee [a](http://example.com "T") here\n')
      expect(await roundTrip(out)).toBe(out) // 重开不再是字面 `[a][1]`
    } finally { await a.destroy(); await b.destroy() }
  })

  it('② 删掉定义那一段', async () => {
    const b = await bootEditor(A)
    try {
      const p = para(b, '[1]:')
      b.view.dispatch(b.view.state.tr.delete(p.pos, p.pos + p.size))
      expect(b.md()).toBe('see [a](http://example.com "T") here\n')
    } finally { await b.destroy() }
  })

  it('③ 结构化复制给外部应用(剪贴板序列化的是切片文档,不是编辑器里那份)', async () => {
    const b = await bootEditor('* 看 [a][1] 吧\n\n[1]: http://example.com\n')
    try {
      const { state } = b.view
      let list = -1, size = 0
      state.doc.forEach((n, pos) => { if (list < 0 && n.type.name === 'bullet_list') { list = pos; size = n.nodeSize } })
      // 同 clipboardTextSerializer:切片内容 → topNodeType.createAndFill → 宿主序列化器 → normalizeFragmentMd
      const doc = state.schema.topNodeType.createAndFill(undefined, state.doc.slice(list, list + size).content)!
      expect(normalizeFragmentMd(b.serialize(doc)).trim()).toBe('* 看 [a](http://example.com) 吧')
      // 整份文档照旧写引用形(定义还在)
      expect(b.md()).toBe('* 看 [a][1] 吧\n\n[1]: http://example.com\n')
    } finally { await b.destroy() }
  })

  it('④ 改了定义行(改错字):定义落盘成转义字面,引用退成带原地址的行内链接', async () => {
    const b = await bootEditor('see [a][1] here\n\n[1]: http://exmaple.com\n')
    try {
      const p = para(b, '[1]:')
      const at = p.pos + 1 + b.view.state.doc.nodeAt(p.pos)!.textContent.indexOf('exmaple')
      b.view.dispatch(b.view.state.tr.insertText('example', at, at + 7))
      const out = b.md()
      expect(out).toBe('see [a](http://exmaple.com) here\n\n\\[1]: http://example.com\n')
      expect(out).not.toContain('[a][1]')
    } finally { await b.destroy() }
  })

  it('同名定义首个生效:删掉第一条后剩下的那条地址不同 → 不能写回引用形(否则重开指向别处)', async () => {
    const b = await bootEditor('see [a][1]\n\n[1]: http://first.example\n\n[1]: http://second.example\n')
    try {
      const p = para(b, '[1]: http://first')
      b.view.dispatch(b.view.state.tr.delete(p.pos, p.pos + p.size))
      expect(b.md()).toBe('see [a](http://first.example)\n\n[1]: http://second.example\n')
    } finally { await b.destroy() }
  })

  it('定义还在(大小写 / 空白不同的 label 也认):照旧写引用形', async () => {
    for (const md of ['see [a][Foo  Bar] ok\n\n[foo bar]: http://x.example\n', '* [a][1]\n\n> [1]: http://q.example\n']) {
      expect(await roundTrip(md)).toBe(md)
    }
  })
})

describe('外来剪贴板 HTML 的 data-md-raw', () => {
  it('首行不是定义的一律作废(这份原文会不经转义落盘);合法定义照旧逐字', async () => {
    const b = await bootEditor('x\n')
    try {
      const { schema } = b.view.state
      const paste = (html: string): string => {
        const div = document.createElement('div')
        div.innerHTML = html
        const slice = DOMParser.fromSchema(schema).parseSlice(div)
        b.view.dispatch(b.view.state.tr.replaceWith(0, b.view.state.doc.content.size, slice.content))
        return b.md()
      }
      expect(paste('<p>前</p><p data-md-raw="&lt;b&gt;x&lt;/b&gt;">&lt;b&gt;x&lt;/b&gt;</p>')).toBe('前\n\n\\<b>x\\</b>\n')
      expect(paste('<p>前</p><p data-md-raw="[1]: http://x.example">[1]: http://x.example</p>')).toBe('前\n\n[1]: http://x.example\n')
    } finally { await b.destroy() }
  })
})
