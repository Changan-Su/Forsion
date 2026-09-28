// @vitest-environment happy-dom
//
// D-09(评审 2026-09-27 P1):粘贴把外来内联颜色固化进笔记(Google Docs 黑字 / 暗色网站浅灰字在另一种明暗下看不见,
// 只带背景色的 span 写成 `<span style="color:">`);应用内复制粘贴把色板色变成 `rgb()`、丢掉 data-hlc 语义映射。
// 走真 schema 的 parseDOM(DOMParser.fromSchema = 粘贴 / 拖入 / DOMObserver 读回用的同一套规则)。
// 真浏览器那一半:评审探针 verify-integrity-2/d09d10.cjs(真剪贴板 Meta+V)与 verify-inline-3/v14-colorpaste.cjs。
// 负对照:colorSchema.parseDOM 的 getAttrs 改回 `({ color: dom.style.color })` → 「外来颜色丢弃」「应用内复制」红。
import { afterEach, describe, expect, it } from 'vitest'
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { DOMParser, DOMSerializer, type Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { commonmarkWithIndent } from './paragraphIndent'
import { gfmWithAnchoredRules } from './anchoredMarkRules'
import { bgSchema, colorSchema, cssColorToHex, inlineHtmlMarksRemark, underlineSchema } from './marks'

let ed: Editor | null = null
afterEach(async () => { await ed?.destroy(); ed = null })

/** 生产装配里与颜色 mark 相关的那几件(顺序同 MarkdownBlock)。 */
async function boot(md = ''): Promise<{ view: EditorView; md: (doc: PMNode) => string }> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  ed = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, md) })
    .use(commonmarkWithIndent).use(gfmWithAnchoredRules).use(inlineHtmlMarksRemark)
    .use(underlineSchema).use(colorSchema).use(bgSchema)
    .create()
  const e = ed
  return { view: e.action((c) => c.get(editorViewCtx)), md: (doc) => e.action((c) => c.get(serializerCtx)(doc)) }
}
const html = (s: string): HTMLElement => { const d = document.createElement('div'); d.innerHTML = s; return d }
/** 粘贴一段 HTML 到空文档 → 落盘 md。 */
async function paste(h: string): Promise<string> {
  const b = await boot()
  const slice = DOMParser.fromSchema(b.view.state.schema).parseSlice(html(h))
  b.view.dispatch(b.view.state.tr.replaceWith(0, b.view.state.doc.content.size, slice.content))
  return b.md(b.view.state.doc)
}

describe('cssColorToHex', () => {
  it('hex / rgb / 不透明 rgba 归一;命名色、半透明、越界 → null', () => {
    expect(cssColorToHex('#C62222')).toBe('#c62222')
    expect(cssColorToHex('#abc')).toBe('#aabbcc')
    expect(cssColorToHex('rgb(198, 34, 34)')).toBe('#c62222')
    expect(cssColorToHex('rgba(198,34,34,1)')).toBe('#c62222')
    expect(cssColorToHex('rgb(198 34 34 / 100%)')).toBe('#c62222')
    expect(cssColorToHex('rgba(198, 34, 34, 0.5)')).toBeNull()
    expect(cssColorToHex('red')).toBeNull()
    expect(cssColorToHex('rgb(300, 0, 0)')).toBeNull()
  })
})

describe('粘贴:外来颜色丢弃(D-09)', () => {
  it('Google Docs 黑字 / 暗色网站浅灰字:不建颜色 mark,文字照留', async () => {
    const gd = '<b style="font-weight:normal;"><p><span style="font-size:11pt;color:#000000;background-color:transparent;">Meeting notes</span></p></b>'
    expect(await paste(gd)).toBe('Meeting notes\n')
    expect(await paste('<span style="color: rgb(236, 236, 236); background-color: rgb(33, 33, 33);">dark site</span>')).toBe('dark site\n')
  })
  it('只带背景色的 span 不再写成 `<span style="color:">`', async () => {
    expect(await paste('<span style="background-color: rgb(255, 255, 0);">web highlighted</span>')).toBe('web highlighted\n')
  })
  it('外来 <mark> 保留高亮语义、丢外来底色', async () => {
    // 只看 mark attrs(无色 `<mark>` 的落盘形态见文末 I-16e 那组)
    const b = await boot()
    const slice = DOMParser.fromSchema(b.view.state.schema).parseSlice(html('<mark style="background: rgb(1, 2, 3)">hl</mark>'))
    const marks: Array<{ name: string; bg: unknown }> = []
    slice.content.descendants((n) => { for (const m of n.marks) marks.push({ name: m.type.name, bg: m.attrs.bg }) })
    expect(marks).toEqual([{ name: 'amadeusBg', bg: '' }])
  })
  it('外来 HTML 里恰好是色板色(浏览器归一的 rgb)→ 收成色板 hex', async () => {
    expect(await paste('<span style="color: rgb(198, 34, 34)">r</span>')).toBe('<span style="color:#c62222">r</span>\n')
  })
})

describe('应用内复制粘贴保语义色(D-09 / I-14)', () => {
  it('PM 复制出来的 HTML(浏览器已把 style 归一成 rgb)→ 回到色板 hex,DOM 上 data-hlc / data-hl 在', async () => {
    const md = await paste('<p data-pm-slice="1 1 []"><span data-hlc="red" style="color: rgb(198, 34, 34);">红字</span> 与 <mark data-hl="yellow" style="background: rgb(254, 243, 161);">黄底</mark></p>')
    expect(md).toBe('<span style="color:#c62222">红字</span> 与 <mark style="background:#fef3a1">黄底</mark>\n')
  })
  it('往返:本应用 toDOM 出来的 DOM 再 parseDOM 回来,属性逐字(含手写的自定义色、旧色板别名)', async () => {
    const src = '<span style="color:#c62222">a</span> <span style="color:var(--accent)">b</span> <span style="color:#e03131">c</span> <mark style="background:#fef3a1">e</mark>\n'
    const b = await boot(src)
    const schema = b.view.state.schema
    const dom = DOMSerializer.fromSchema(schema).serializeFragment(b.view.state.doc.content)
    const holder = document.createElement('div')
    holder.appendChild(dom)
    const back = DOMParser.fromSchema(schema).parse(holder)
    expect(b.md(back)).toBe(src)
  })
  it('语义名在、样式被外部改成别的值 → 按语义名回到色板值', async () => {
    expect(await paste('<span data-hlc="green" style="color: rgb(0, 0, 0)">g</span>')).toBe('<span style="color:#117b38">g</span>\n')
  })
  it('data-amx-fg 注入(非安全色值)不被信任', async () => {
    expect(await paste('<span data-amx-fg="red;background:url(x)" style="color: rgb(0, 0, 0)">x</span>')).toBe('x\n')
  })
})

describe('toDOM:存量里被旧版写成 rgb() 的色板色也认回语义名(只影响显示)', () => {
  it('rgb(198, 34, 34) → data-hlc=red;rgb(254, 243, 161) → data-hl=yellow', async () => {
    const b = await boot('<span style="color:rgb(198, 34, 34)">a</span> <mark style="background:rgb(254, 243, 161)">b</mark>\n')
    const dom = b.view.dom
    expect(dom.querySelector('span[style*="color"]')?.getAttribute('data-hlc')).toBe('red')
    expect(dom.querySelector('mark')?.getAttribute('data-hl')).toBe('yellow')
    expect(b.md(b.view.state.doc)).toBe('<span style="color:rgb(198, 34, 34)">a</span> <mark style="background:rgb(254, 243, 161)">b</mark>\n')
  })
})

describe('裸 <mark> 往返(I-16e)', () => {
  // 修前:无色高亮序列化成 `<mark style="background:">`,读侧 openTag 要求颜色值非空 → 重开退成字面,高亮永久丢失。
  it('读进来是无色高亮,写回仍是裸 <mark>;重开还是高亮', async () => {
    const b = await boot('m: <mark>高亮</mark> 完\n')
    const out = b.md(b.view.state.doc)
    expect(out).toBe('m: <mark>高亮</mark> 完\n')
    await ed?.destroy()
    const c = await boot(out)
    const marks: string[] = []
    c.view.state.doc.descendants((n) => { for (const m of n.marks) marks.push(`${m.type.name}:${String(m.attrs.bg)}`) })
    expect(marks).toEqual(['amadeusBg:'])
  })
})
