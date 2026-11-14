// @vitest-environment happy-dom
// PROBE inline-literal-bold: round-trip and scanner checks with the switch on (real Milkdown, production plugin order).
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor } from './parseFidelity.testkit'
import { editorFocusPlugin } from './editorFocus'
import { literalBoldPlugin, scanLiteralBold, toggleLiteralBold } from './literalBold'
import { setLiteralBold } from './literalBoldFlag'

const CORPUS: Record<string, string> = {
  star: 'x **a** y',
  under: 'x __a__ y',
  triple: 'x ***a*** y',
  nestedEm: 'x **a *b* c** y',
  cjk: '中文紧挨着**加粗**中文',
  softBreak: 'x **bold\nacross** y',
  list: '- item **b** one\n- two',
  table: '| h | i |\n| --- | --- |\n| **c** | d |',
  heading: '# Title **b**',
  callout: '> [!note] Title\n> body **b** end',
  code: 'x `**x**` y',
  math: 'x $a*b*c$ y $$**$$ z',
  escaped: 'x \\*\\*x\\*\\* y',
  unpaired: 'x ** y',
  plainStar: '5 * 3 = 15',
  lineStartBold: '**lead** text',
  lineStartUnder: '__lead__ text',
  mixed: 'a **b** and *c* and _d_ and __e__',
}
const FULL_DIFF: Record<string, string> = {}
const doc = (body: string): string => `First para.\n\n${body}\n\nLast para.\n`

afterEach(() => setLiteralBold(null))

describe('literal bold (switch on)', () => {
  for (const [name, body] of Object.entries(CORPUS)) {
    it(`open unchanged + full reserialize + edit elsewhere + switch off: ${name}`, async () => {
      setLiteralBold(true)
      const md = doc(body)
      const b = await bootEditor(md, { extra: [editorFocusPlugin(), literalBoldPlugin()] })
      try {
        expect(b.saved()).toBe(md)
        // every block re-serialized (no verbatim slices): equals the source, except main's own canonicalization of
        // edited blocks (table padding, callout spacing, `_it_` -> `*it*`), which is the same with the switch off
        const full = b.md()
        if (full !== md) FULL_DIFF[name] = full
        else expect(full).toBe(md)
        // edit one char in another block
        const v = b.view
        v.dispatch(v.state.tr.insertText('!', 1 + 'First para'.length))
        expect(b.saved()).toBe(md.replace('First para.', 'First para!.'))
      } finally {
        await b.destroy()
      }
      // switch off and reopen the same file: main's path must read the same bytes back
      setLiteralBold(false)
      const off = await bootEditor(md)
      try {
        expect(off.saved()).toBe(md)
        if (FULL_DIFF[name] != null) {
          // the full-reserialize difference must be main's: same output with the switch off, bold aside
          const offFull = off.md()
          const strip = (x: string): string => x.replace(/\*\*|__/g, '')
          expect(strip(FULL_DIFF[name])).toBe(strip(offFull))
          console.log(`[full-reserialize differs from source like main does] ${name}\n on : ${JSON.stringify(FULL_DIFF[name])}\n off: ${JSON.stringify(offFull)}`)
        }
      } finally {
        await off.destroy()
      }
    })
  }

  it('edit inside the same block keeps the bold delimiters raw', async () => {
    setLiteralBold(true)
    const md = 'a **bold** b and 5 * 3\n'
    const b = await bootEditor(md, { extra: [editorFocusPlugin(), literalBoldPlugin()] })
    try {
      const v = b.view
      v.dispatch(v.state.tr.insertText('Z', v.state.doc.content.size - 1))
      expect(b.saved()).toBe('a **bold** b and 5 * 3Z\n')
    } finally {
      await b.destroy()
    }
  })

  it('document text holds the delimiters; no strong mark', async () => {
    setLiteralBold(true)
    const b = await bootEditor('a **bold** __u__\n', { extra: [editorFocusPlugin(), literalBoldPlugin()] })
    try {
      const p = b.view.state.doc.firstChild!
      expect(p.textContent).toBe('a **bold** __u__')
      let marks = 0
      b.view.state.doc.descendants((n) => { marks += n.marks.filter((m) => m.type.name === 'strong').length })
      expect(marks).toBe(0)
    } finally {
      await b.destroy()
    }
  })

  it('Mod-b toggle: wrap selection, unwrap, empty inserts ****', async () => {
    setLiteralBold(true)
    const b = await bootEditor('hello world\n', { extra: [editorFocusPlugin(), literalBoldPlugin()] })
    try {
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
    } finally {
      await b.destroy()
    }
  })

  it('switch off: strong is a mark as on main', async () => {
    setLiteralBold(false)
    const b = await bootEditor('a **bold** b\n')
    try {
      expect(b.view.state.doc.firstChild!.textContent).toBe('a bold b')
    } finally {
      await b.destroy()
    }
  })
})

describe('scanLiteralBold', () => {
  it('pairs and literals', () => {
    expect(scanLiteralBold('a **b** c')).toEqual([{ from: 2, to: 7, delim: '**' }])
    expect(scanLiteralBold('****')).toEqual([])
    expect(scanLiteralBold('a ** b')).toEqual([])
    expect(scanLiteralBold('snake__case__x')).toEqual([])
    expect(scanLiteralBold('x __u__ y')).toEqual([{ from: 2, to: 7, delim: '__' }])
    expect(scanLiteralBold('**a *b* c**')).toEqual([{ from: 0, to: 11, delim: '**' }])
  })
})
