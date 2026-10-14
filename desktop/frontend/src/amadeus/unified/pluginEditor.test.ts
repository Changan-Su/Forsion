// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { history, undo, redo } from '@milkdown/kit/prose/history'
import { bootEditor, type Booted } from '../blocks/markdown/parseFidelity.testkit'
import { captureMarkdownEdit } from './pluginEditor'
let b: Booted
const start = async (text: string) => { b = await bootEditor(text); b.view.updateState(b.view.state.reconfigure({ plugins: [...b.view.state.plugins, history()] })); return b }
afterEach(async () => { await b?.destroy() })
const capture = (valid = () => true) => captureMarkdownEdit({ path: 'Note.md', view: b.view, valid, parse: b.parse, serialize: b.savedNode })!
describe('native plugin Markdown transactions', () => {
  it('maps a reversed selection through heading/strong syntax and Unicode', async () => {
    await start('# Title\n\nHello **世界** and hello.\n')
    let at = 0; b.view.state.doc.descendants((n,p) => { if(n.isText && n.text === '世界') at = p })
    b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc,at+2,at)))
    const e=capture(); expect(e.text.slice(e.head,e.anchor)).toBe('世界')
  })
  it('changes only selected lines, preserves other blocks, has separate native undo/redo', async () => {
    await start('# Unchanged\n\nZebra\nApple\n\nTail\n')
    const top=b.view.state.doc.firstChild
    const e=capture(); expect(e.apply({text:e.text.replace('Zebra\nApple','Apple\nZebra')})).toBe(true)
    expect(b.view.state.doc.firstChild).toBe(top)
    const e2=capture(); expect(e2.apply({text:e2.text.replace('Apple\nZebra','Banana\nZebra')})).toBe(true)
    expect(undo(b.view.state,b.view.dispatch)).toBe(true); expect(b.saved()).toContain('Apple\nZebra')
    expect(undo(b.view.state,b.view.dispatch)).toBe(true); expect(b.saved()).toContain('Zebra\nApple')
    expect(redo(b.view.state,b.view.dispatch)).toBe(true); expect(b.saved()).toContain('Apple\nZebra')
    expect(e.apply({text:'overwrite'})).toBe(false)
  })
  it('refuses edits after typing, selection changes or host invalidation', async () => {
    await start('Hello\n')
    const e=capture(); b.view.dispatch(b.view.state.tr.insertText('X',1)); expect(e.apply({text:'lost'})).toBe(false)
    const s=capture(); b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc,3))); expect(s.apply({text:'lost'})).toBe(false)
    let live=true; const t=capture(()=>live); live=false; expect(t.apply({text:'lost'})).toBe(false); expect(b.saved()).toContain('XHello')
  })
  it('preserves unrelated reference links for no-op and actual plugin edits', async () => {
    const source='Hello\n\n[a][ref]\n\n[ref]: https://example.com\n'
    await start(source)
    const original=b.view.state.doc, e=capture()
    expect(e.text).toBe(source);expect(e.apply({text:e.text})).toBe(true)
    expect(b.view.state.doc).toBe(original);expect(b.saved()).toBe(source)
    const changed=capture();expect(changed.apply({text:changed.text.replace('Hello','Hello world')})).toBe(true)
    expect(b.saved()).toBe(source.replace('Hello','Hello world'))
  })
  it('maps an explicit final cursor without losing native history', async () => {
    await start('Alpha\n')
    const e=capture(); expect(e.apply({text:'Alpha Beta\n', selection:{anchor:6,head:10}})).toBe(true)
    expect(b.view.state.doc.textBetween(b.view.state.selection.from,b.view.state.selection.to)).toBe('Beta')
  })
  it('handles the native empty paragraph used for TOC insertion', async () => {
    await start('# Title\n\n## Child\n')
    b.view.dispatch(b.view.state.tr.insert(b.view.state.doc.firstChild!.nodeSize, b.view.state.schema.nodes.paragraph.create()))
    let at=0; b.view.state.doc.descendants((n,p)=>{if(n.type.name==='paragraph' && !n.content.size)at=p+1})
    expect(at).toBeGreaterThan(0)
    b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc,at)))
    const e=capture(); expect(e.anchor).toBeGreaterThan(0); expect(e.text[e.anchor]).toBe('\n')
  })
})
