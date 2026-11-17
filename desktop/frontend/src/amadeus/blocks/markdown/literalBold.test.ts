// @vitest-environment happy-dom
// Literal bold (hidden switch): every exit of the shared editor core reads and writes the same way.
// 加粗字面化(隐藏开关):同一个编辑器内核的每个出口读写一致 —— 只要一处「读成文字、写时还转义 `*`」,文件里就落成 `\*\*x\*\*`。
// Exits: v4 save (verbatim + re-serialized block), full re-serialization (v3 listener / serializeNow), v3 boot,
// in-block fragment (split-off half / structured copy), plain-text clipboard, PlainMarkdownEditor (record page /
// plugin cards), source mode round trip. 出口:v4 落盘、整篇重序列化、v3、块内片段、纯文本剪贴板、小编辑器、源码模式往返。
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Slice, type Node as PMNode } from '@milkdown/kit/prose/model'
import { bootEditor, type Booted } from './parseFidelity.testkit'
import { editorFocusKey, editorFocusPlugin } from './editorFocus'
import {
  boldSpans, buildLiteralBoldDecorations, literalBoldKey, literalBoldPlugin, literalPaste, literalToMarks, literalScanCount,
  scanInput, scanLiteralBold, toggleLiteralBold,
} from './literalBold'
import { setLiteralBold } from './literalBoldFlag'
import { normalizeFragmentMd, normalizeSerializedMd, PlainMarkdownEditor } from './MarkdownBlock'
import { withoutBoundaryRefs } from './attentionFlanking'
import { addEditorExtension, clearEditorExtensions } from '../../plugins/editorExtensions'

afterEach(() => setLiteralBold(null))

const BODIES = ['**x**', '__x__', '5 * 3', 'snake_case', 'a **x** b __y__ c 5 * 3 d snake_case e']
const doc = (body: string): string => `First para.\n\n${body}\n\nLast para.\n`
// Production order: the literal-bold plugin comes before editorFocusPlugin (MarkdownBlock), so its apply must not read
// the focus field of the new state. 生产顺序:加粗插件排在 editorFocusPlugin 之前。
const on = (extra = true) => ({ extra: extra ? [literalBoldPlugin(), editorFocusPlugin()] : [] })

async function withEditor<T>(md: string, run: (b: Booted) => T | Promise<T>, opts: { v3?: boolean } = {}): Promise<T> {
  const b = await bootEditor(md, { ...on(), ...opts })
  try {
    return await run(b)
  } finally {
    await b.destroy()
  }
}
const paraOf = (d: PMNode, i: number): PMNode => d.child(i)

describe('every exit round-trips unedited input byte for byte (switch on)', () => {
  for (const body of BODIES) {
    it(`v4 save: verbatim, edit elsewhere, edit in the same block — ${body}`, async () => {
      setLiteralBold(true)
      const md = doc(body)
      await withEditor(md, (b) => {
        expect(b.saved()).toBe(md)
        const v = b.view
        v.dispatch(v.state.tr.insertText('!', 1 + 'First para'.length))
        expect(b.saved()).toBe(md.replace('First para.', 'First para!.'))
        // same block: re-serialized by the serializer, not copied verbatim 同一块:走序列化,不是逐字回填
        const p = v.state.doc.child(1)
        let pos = 0
        v.state.doc.forEach((n, off, i) => { if (i === 1) pos = off + 1 + n.content.size })
        expect(p.textContent).toBe(body)
        v.dispatch(v.state.tr.insertText('Z', pos))
        expect(b.saved()).toBe(md.replace('First para.', 'First para!.').replace(`${body}\n`, `${body}Z\n`))
      })
    })

    it(`full re-serialization (v3 listener / serializeNow), v3 boot, fragment, clipboard text, source mode — ${body}`, async () => {
      setLiteralBold(true)
      const md = doc(body)
      await withEditor(md, (b) => {
        const d = b.view.state.doc
        expect(b.md()).toBe(md)
        // in-block fragment: the split-off back half / structured copy 块内片段(切块后半段 / 结构化复制)
        const frag = d.type.create(null, [paraOf(d, 1)])
        expect(normalizeFragmentMd(b.serialize(frag))).toBe(`${body}\n`)
        // plain-text clipboard (boundary refs off) 纯文本剪贴板
        expect(withoutBoundaryRefs(() => normalizeSerializedMd(b.serialize(d)))).toBe(md)
        // source mode: save -> text -> parse -> save 源码模式往返
        const again = b.parse(b.saved())
        expect(normalizeSerializedMd(b.serialize(again))).toBe(md)
        expect(again.child(1).textContent).toBe(body)
      })
      await withEditor(md, (b) => expect(b.md()).toBe(md), { v3: true })
    })
  }

  it('splitting a block: both halves serialize as their own text (a back half that starts with `* ` gets the line-start escape)', async () => {
    setLiteralBold(true)
    const body = BODIES[BODIES.length - 1]
    const md = doc(body)
    await withEditor(md, (b) => {
      const d = b.view.state.doc
      const para = paraOf(d, 1)
      // cut inside `**x**`, before `b __y__`, right before the `*` of `5 * 3` 切在 `**x**` 里、`b __y__` 前、`5 * 3` 的星号前
      for (const k of [4, body.indexOf('b __y__'), body.indexOf('* 3')]) {
        const front = body.slice(0, k)
        const back = body.slice(k)
        const backMd = normalizeFragmentMd(b.serialize(d.type.create(null, [para.cut(k)])))
        const want = back.startsWith('* ') ? `\\${back}\n` : `${back}\n`
        expect(backMd).toBe(want)
        expect(b.parse(backMd).child(0).textContent).toBe(back)
        expect(normalizeFragmentMd(b.serialize(d.type.create(null, [para.cut(0, k)])))).toBe(`${front}\n`) // the trailing space stays 尾空格照留
      }
    })
  })

  it('the document holds the delimiters as text; no strong mark', async () => {
    setLiteralBold(true)
    await withEditor('a **bold** __u__ ***bi***\n', (b) => {
      const p = b.view.state.doc.firstChild!
      expect(p.textContent).toBe('a **bold** __u__ **bi**')
      let strong = 0
      b.view.state.doc.descendants((n) => { strong += n.marks.filter((m) => m.type.name === 'strong').length })
      expect(strong).toBe(0)
      expect(b.saved()).toBe('a **bold** __u__ ***bi***\n')
      expect(b.md()).toBe('a **bold** __u__ ***bi***\n')
    })
  })
})

describe('`*` / `_` save rule (switch on)', () => {
  const typed = async (text: string, before = ''): Promise<string> => withEditor(`${before}seed\n`, (b) => {
    const v = b.view
    const end = v.state.doc.content.size - 1
    v.dispatch(v.state.tr.insertText(text, end - 'seed'.length, end))
    return b.saved()
  })
  it('in text: raw, including a typed `*x*` and unpaired `**`', async () => {
    setLiteralBold(true)
    expect(await typed('a *x* b ** c _y_ d snake_case 5 * 3')).toBe('a *x* b ** c _y_ d snake_case 5 * 3\n')
  })
  it('at a line start: escaped only where a list bullet / thematic break would appear', async () => {
    setLiteralBold(true)
    expect(await typed('* x')).toBe('\\* x\n')
    expect(await typed('*')).toBe('\\*\n')
    expect(await typed('***')).toBe('\\***\n')
    expect(await typed('* * *')).toBe('\\* * *\n')
    expect(await typed('___')).toBe('\\___\n')
    expect(await typed('**lead** text')).toBe('**lead** text\n')
    expect(await typed('__lead__ text')).toBe('__lead__ text\n')
    expect(await typed('*x* y')).toBe('*x* y\n')
    expect(await typed('_x_ y')).toBe('_x_ y\n')
    expect(await typed('** x')).toBe('** x\n')
    expect(await typed('- * x')).toBe('\\- * x\n') // after `\\-` the line is a paragraph
  })
  it('in a list item and after a soft break', async () => {
    setLiteralBold(true)
    await withEditor('- item\n', (b) => {
      const v = b.view
      v.dispatch(v.state.tr.insertText('* x', 3, 7))
      expect(b.saved()).toBe('- \\* x\n')
    })
    await withEditor('a\nb\n', (b) => {
      const v = b.view
      // paragraph `a<br>b`: replace b (after the soft break) with `* y`
      v.dispatch(v.state.tr.insertText('* y', 3, 4))
      expect(b.saved()).toBe('a\n\\* y\n')
    })
  })
  it('trailing whitespace stays raw after a bold (no &#x20;)', async () => {
    setLiteralBold(true)
    expect(await typed('a **b** ')).toBe('a **b** \n')
  })
  it('user-written escapes keep their backslash; math keeps its stars', async () => {
    setLiteralBold(true)
    const md = 'x \\*\\*x\\*\\* y $a*b*c$ $x_i$ z\n'
    await withEditor(md, (b) => {
      expect(b.md()).toBe(md)
      expect(boldSpans(b.view.state.doc.firstChild!)).toEqual([])
    })
  })
  it('switch off: unchanged (escaped as before)', async () => {
    setLiteralBold(false)
    await withEditor('seed\n', (b) => {
      const v = b.view
      v.dispatch(v.state.tr.insertText('a *x* 5 * 3 snake_case', 1, 5))
      expect(b.saved()).toBe('a \\*x\\* 5 \\* 3 snake\\_case\n')
    })
    const b = await bootEditor('a **x** __y__\n')
    try {
      expect(b.md()).toBe('a **x** **y**\n') // main's canonical form
      expect(b.view.state.doc.firstChild!.textContent).toBe('a x y')
    } finally {
      await b.destroy()
    }
  })
})

describe('PlainMarkdownEditor (record page / plugin cards), switch on', () => {
  const EXT = 'test-literal-bold-plain'
  let host: HTMLDivElement
  let root: Root | null = null
  let view: EditorView | null = null
  afterEach(async () => {
    if (root) await act(async () => { root?.unmount() })
    root = null
    clearEditorExtensions(EXT)
    host?.remove()
    vi.unstubAllGlobals()
  })
  it('reads `**` as text and writes it back raw', async () => {
    setLiteralBold(true)
    vi.stubGlobal('React', React)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    addEditorExtension(EXT, ({ Plugin }) => [new Plugin({ view: (v) => { view = v; return {} } })])
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const changed = vi.fn()
    const initial = 'a **x** b __y__ 5 * 3 snake_case'
    await act(async () => { root!.render(React.createElement(PlainMarkdownEditor, { initial, immediate: true, onChange: changed })) })
    await act(async () => { await vi.waitFor(() => expect(view).not.toBeNull()) })
    expect(view!.state.doc.firstChild!.textContent).toBe(initial)
    changed.mockClear()
    act(() => { view!.dispatch(view!.state.tr.insertText('Z', view!.state.doc.content.size - 1)) })
    expect(changed).toHaveBeenLastCalledWith(`${initial}Z\n`)
  })
})

describe('display', () => {
  const decoClasses = (v: EditorView): string[] =>
    (literalBoldKey.getState(v.state)!.deco.find() as unknown as Array<{ from: number; to: number; type: { attrs: { class: string } } }>)
      .map((d) => `${d.from}-${d.to}:${d.type.attrs.class}`).sort()
  it('selection away: delimiters hidden, inner bold; caret touching either outer edge: shown', async () => {
    setLiteralBold(true)
    await withEditor('plain **bold** tail\n', (b) => {
      const v = b.view
      v.dispatch(v.state.tr.setMeta(editorFocusKey, true).setSelection(TextSelection.create(v.state.doc, 2)))
      expect(decoClasses(v)).toEqual(['13-15:amx-obs-hidden', '9-13:amx-lit-bold', '7-9:amx-obs-hidden'].sort())
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7)))
      expect(decoClasses(v).filter((c) => c.includes('delim'))).toHaveLength(2)
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 15)))
      expect(decoClasses(v).filter((c) => c.includes('delim'))).toHaveLength(2)
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 16)))
      expect(decoClasses(v).filter((c) => c.includes('delim'))).toHaveLength(0)
      // blur: everything rendered 失焦:全部渲染
      v.dispatch(v.state.tr.setMeta(editorFocusKey, false).setSelection(TextSelection.create(v.state.doc, 9)))
      expect(decoClasses(v).filter((c) => c.includes('delim'))).toHaveLength(0)
    })
  })

  it('incremental: typing rescans only the touched block, and the result equals a full rebuild', async () => {
    setLiteralBold(true)
    const md = Array.from({ length: 200 }, (_, i) => `para ${i} **bold ${i}** tail`).join('\n\n') + '\n'
    await withEditor(md, (b) => {
      const v = b.view
      v.dispatch(v.state.tr.setMeta(editorFocusKey, true).setSelection(TextSelection.create(v.state.doc, 3)))
      const before = literalScanCount()
      v.dispatch(v.state.tr.insertText('x', 3))
      expect(literalScanCount() - before).toBeLessThanOrEqual(3)
      // random edits: still equal to a full rebuild 随机编辑后仍等于整篇重建
      const r = (n: number): number => Math.floor(Math.random() * n)
      for (let i = 0; i < 60; i++) {
        const size = v.state.doc.content.size
        const at = 1 + r(size - 2)
        const $at = v.state.doc.resolve(at)
        if (!$at.parent.isTextblock) continue
        const tr = r(3) === 0 && at + 2 < $at.end() ? v.state.tr.delete(at, at + 2) : v.state.tr.insertText(['*', '**', 'a', ' ', '_'][r(5)], at)
        v.dispatch(tr.setSelection(TextSelection.create(tr.doc, Math.min(at, tr.doc.content.size - 1))))
        const inc = decoClasses(v)
        const full = (buildLiteralBoldDecorations(v.state).find() as unknown as Array<{ from: number; to: number; type: { attrs: { class: string } } }>)
          .map((d) => `${d.from}-${d.to}:${d.type.attrs.class}`).sort()
        expect(inc).toEqual(full)
      }
    })
  })

  it('IME composition: decorations are only mapped while composing, recomputed after', async () => {
    setLiteralBold(true)
    await withEditor('plain **bold** tail\n', (b) => {
      const v = b.view
      v.dispatch(v.state.tr.setMeta(editorFocusKey, true).setSelection(TextSelection.create(v.state.doc, 15)))
      expect(decoClasses(v).filter((c) => c.includes('delim'))).toHaveLength(2) // caret right after `**`: shown
      const input = (v as unknown as { input: { composing: boolean } }).input
      input.composing = true
      try {
        v.dispatch(v.state.tr.insertText('wen', 15))
        // still shown on both sides while composing (no half-hidden delimiters) 组字中两边都还露着
        expect(decoClasses(v).filter((c) => c.includes('delim'))).toHaveLength(2)
      } finally {
        input.composing = false
      }
      v.dispatch(v.state.tr.insertText('文', 15, 18))
      expect(decoClasses(v).filter((c) => c.includes('delim'))).toHaveLength(0) // caret after 文: hidden
    })
  })
})

describe('input and clipboard', () => {
  it('Mod-b: wrap a selection, unwrap it, empty selection inserts `****`', async () => {
    setLiteralBold(true)
    await withEditor('hello world\n', (b) => {
      const v = b.view
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7, 12)))
      toggleLiteralBold(v.state, v.dispatch)
      expect(b.saved()).toBe('hello **world**\n')
      expect(v.state.doc.textBetween(v.state.selection.from, v.state.selection.to)).toBe('world')
      toggleLiteralBold(v.state, v.dispatch)
      expect(b.saved()).toBe('hello world\n')
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 12)))
      toggleLiteralBold(v.state, v.dispatch)
      expect(v.state.doc.firstChild!.textContent).toBe('hello world****')
      expect(v.state.selection.from).toBe(14)
      // whitespace at the edges stays outside 首尾空白让到外面
      const tr = v.state.tr.delete(12, 16)
      v.dispatch(tr.setSelection(TextSelection.create(tr.doc, 6, 12)))
      toggleLiteralBold(v.state, v.dispatch)
      expect(b.saved()).toBe('hello **world**\n')
    })
  })

  it('copy: <strong> only in the HTML flavour; paste: <b> becomes `**` text', async () => {
    setLiteralBold(true)
    await withEditor('plain **bold** tail\n', (b) => {
      const v = b.view
      const schema = v.state.schema
      const marked = literalToMarks(v.state.doc.content, schema)
      const p = marked.firstChild!
      expect(p.textContent).toBe('plain bold tail')
      let strong = ''
      p.forEach((c) => { if (c.marks.some((m) => m.type.name === 'strong')) strong += c.text })
      expect(strong).toBe('bold')
      // our own HTML pasted back, or <b> from a web page 自己复制的 HTML 贴回 / 网页 <b>
      const back = literalPaste(new Slice(marked, 0, 0), schema)
      expect(back.content.firstChild!.textContent).toBe('plain **bold** tail')
      let marks = 0
      back.content.descendants((n) => { marks += n.marks.filter((m) => m.type.name === 'strong').length })
      expect(marks).toBe(0)
    })
  })
})

describe('scanner unit cases (fixed from the random comparison)', () => {
  const spans = (s: string): string => scanLiteralBold({
    text: s, lit: Uint8Array.from([...s].map((c) => (c === '*' || c === '_' ? 1 : 0))), scope: new Int32Array(s.length),
    edge: new Array(s.length + 1).fill(''),
  }).map((x) => s.slice(x.from, x.to)).join('|')
  it.each([
    ['a **b** c', '**b**'],
    ['**a**b', '**a**'],
    ['a__b__c', ''], // `__` inside a word is literal
    ['__a__', '__a__'],
    ['****a****', '****a****|**a**'],
    ['***a***', '**a**'],
    ['**a *b* c**', '**a *b* c**'],
    ['**注意：**后面', '**注意：**'], // CJK-friendly flanking (the parser's rule)
    ['** a **', ''],
    ['5 * 3 ** x', ''],
  ])('%s', (src, want) => {
    expect(spans(src)).toBe(want)
  })
  it('scanInput: code, escapes and math are not delimiters', async () => {
    setLiteralBold(true)
    await withEditor('`**c**` \\*\\*e\\*\\* $**m**$ **b**\n', (b) => {
      const p = b.view.state.doc.firstChild!
      const inp = scanInput(p)
      expect(boldSpans(p).map((s) => inp.text.slice(s.from, s.to))).toEqual(['**b**'])
    })
  })
})
