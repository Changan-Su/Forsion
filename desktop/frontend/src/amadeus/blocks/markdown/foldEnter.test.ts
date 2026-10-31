import { describe, expect, it } from 'vitest'
import { Schema, type Node } from '@milkdown/kit/prose/model'
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { calloutKey, handleFoldKeyDown } from './callout'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'text*' },
  blockquote: { group: 'block', content: 'block+' },
  bullet_list: { group: 'block', content: 'list_item+' },
  list_item: { content: 'paragraph block*' },
  code_block: { group: 'block', content: 'text*', code: true },
  text: {},
} })
const p = (text = '') => schema.node('paragraph', null, text ? schema.text(text) : undefined)
const quote = (...body: Node[]) => schema.node('blockquote', null, body)
const fold = (...body: Node[]) => quote(p('[!fold]+ Title'), ...body)

function press(block: Node, event: Partial<KeyboardEvent> = {}, source = false) {
  const doc = schema.node('doc', null, [block, p('After')])
  let cursor = -1
  doc.descendants((node, pos) => { if (cursor < 0 && node.type.name === 'paragraph' && !node.content.size) cursor = pos + 1 })
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, cursor), plugins: source ? [
    new Plugin({ key: calloutKey, state: { init: () => ({ srcAt: 0, animations: [] }), apply: (_tr, value) => value } }),
  ] : [] })
  const view = { editable: true, get state() { return state }, dispatch: (tr) => { state = state.apply(tr) } } as EditorView
  const handled = handleFoldKeyDown(view, { key: 'Enter', ...event } as KeyboardEvent)
  return { handled, state, before: doc }
}

describe('Enter in empty fold body paragraphs', () => {
  it('keeps later paragraphs, code and nested folds inside their original fold', () => {
    const body = [p('First'), schema.node('code_block', null, schema.text('const answer = 42')), fold(p('Nested'))]
    const { handled, state } = press(fold(p(), ...body))
    expect(handled).toBe(true)
    expect(state.doc.childCount).toBe(2)
    const outer = state.doc.firstChild!
    expect(outer.childCount).toBe(6)
    body.forEach((node, i) => expect(outer.child(i + 3).eq(node)).toBe(true))
    expect(state.selection.$from.parent.content.size).toBe(0)
    expect(state.selection.$from.node(1)).toBe(outer)
  })

  it('handles an inner fold without splitting its outer fold', () => {
    const { handled, state } = press(fold(fold(p(), p('Inner body')), p('Outer body')))
    expect(handled).toBe(true)
    expect(state.doc.firstChild!.childCount).toBe(3)
    expect(state.doc.firstChild!.child(1).child(3).textContent).toBe('Inner body')
    expect(state.doc.firstChild!.lastChild!.textContent).toBe('Outer body')
  })

  for (const [name, block] of [
    ['last empty paragraph', fold(p('Body'), p())],
    ['ordinary quote', quote(p('Quote'), p(), p('More'))],
    ['colored callout', quote(p('[!note] Note'), p(), p('Body'))],
    ['ordinary quote nested in a fold', fold(quote(p('Quote'), p(), p('More')))],
    ['list item nested in a fold', fold(schema.node('bullet_list', null, schema.node('list_item', null, [p(), p('More')])))],
  ] as const) {
    it(`leaves ${name} to the existing keyboard command`, () => {
      const { handled, state, before } = press(block)
      expect(handled).toBe(false)
      expect(state.doc.eq(before)).toBe(true)
    })
  }

  it('leaves explicit source editing to the normal quote commands', () => {
    expect(press(fold(p(), p('Body')), {}, true).handled).toBe(false)
  })

  for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey', 'isComposing']) {
    it(`does not intercept Enter with ${modifier}`, () => {
      const { handled, state, before } = press(fold(p(), p('Body')), { [modifier]: true })
      expect(handled).toBe(false)
      expect(state.doc.eq(before)).toBe(true)
    })
  }
})
