import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection } from '@milkdown/kit/prose/state'
import { unfoldCalloutsAfterDrop } from './callout'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'text*' },
  blockquote: { group: 'block', content: 'block+' },
  code_block: { group: 'block', content: 'text*', code: true },
  horizontal_rule: { group: 'block', atom: true },
  text: {},
} })
const p = (text = '') => schema.node('paragraph', null, text ? schema.text(text) : undefined)
const fold = (title: string, ...body: ReturnType<typeof p>[]) => schema.node('blockquote', null, [p(`[!fold]- ${title}`), ...body])
const code = () => schema.node('code_block', null, schema.text('const answer = 42;'))
const stateOf = (...blocks: ReturnType<typeof p>[]) => EditorState.create({ schema, doc: schema.node('doc', null, blocks) })
const markers = (state: EditorState) => {
  const out: string[] = []
  state.doc.descendants((node) => { if (node.type.name === 'blockquote') out.push(node.firstChild!.textContent) })
  return out
}

describe('dropping content into collapsed callouts', () => {
  it('opens a collapsed destination with a nonempty code block selection', () => {
    const state = stateOf(fold('Target', p('Body')))
    const at = 1 + state.doc.firstChild!.firstChild!.nodeSize
    const drop = state.tr.insert(at, code()).setMeta('uiEvent', 'drop')
    drop.setSelection(NodeSelection.create(drop.doc, at))
    const next = state.apply(drop)
    const opened = unfoldCalloutsAfterDrop([drop], next)
    expect(opened).not.toBeNull()
    expect(markers(next.apply(opened!))).toEqual(['[!fold]+ Target'])
    expect(next.apply(opened!).doc.nodeAt(at)!.textContent).toBe('const answer = 42;')
  })

  it('opens all covering ancestors for an atomic drop, leaves other folds closed', () => {
    const state = stateOf(fold('Outer', fold('Inner', p('Body'))), fold('Other', p('Keep hidden')))
    const inner = 1 + state.doc.firstChild!.firstChild!.nodeSize
    const at = inner + 1 + state.doc.nodeAt(inner)!.firstChild!.nodeSize
    const drop = state.tr.insert(at, schema.node('horizontal_rule')).setMeta('uiEvent', 'drop')
    const next = state.apply(drop)
    expect(markers(next.apply(unfoldCalloutsAfterDrop([drop], next)!))).toEqual(['[!fold]+ Outer', '[!fold]+ Inner', '[!fold]- Other'])
  })

  it('preserves a whole folded block being moved into an outer fold', () => {
    const state = stateOf(fold('Target', p('Body')), fold('Moved', p('Still hidden')))
    const from = state.doc.firstChild!.nodeSize
    const moved = state.doc.child(1)
    const at = 1 + state.doc.firstChild!.firstChild!.nodeSize
    const drop = state.tr.delete(from, from + moved.nodeSize).insert(at, moved).setMeta('uiEvent', 'drop')
    const next = state.apply(drop)
    expect(markers(next.apply(unfoldCalloutsAfterDrop([drop], next)!))).toEqual(['[!fold]+ Target', '[!fold]- Moved'])
  })

  it('preserves a whole folded block dropped at the document level', () => {
    const state = stateOf(p('Before'))
    const drop = state.tr.insert(state.doc.content.size, fold('Moved', p('Body'))).setMeta('uiEvent', 'drop')
    expect(unfoldCalloutsAfterDrop([drop], state.apply(drop))).toBeNull()
  })

  it('uses the actual inserted range when selection remains in the title', () => {
    const state = stateOf(fold('Target', p('Body')))
    const at = 1 + state.doc.firstChild!.firstChild!.nodeSize
    const drop = state.tr.insert(at, [schema.node('horizontal_rule'), schema.node('horizontal_rule')]).setMeta('uiEvent', 'drop')
    const next = state.apply(drop)
    expect(markers(next.apply(unfoldCalloutsAfterDrop([drop], next)!))).toEqual(['[!fold]+ Target'])
  })

  it('maps inserted ranges through later plugin transactions', () => {
    const state = stateOf(fold('Target', p('Body')), fold('Other', p('Hidden')))
    const at = 1 + state.doc.firstChild!.firstChild!.nodeSize
    const drop = state.tr.insert(at, code()).setMeta('uiEvent', 'drop')
    const dropped = state.apply(drop)
    const follow = dropped.tr.insert(0, p('Inserted before destination'))
    const next = dropped.apply(follow)
    expect(markers(next.apply(unfoldCalloutsAfterDrop([drop, follow], next)!))).toEqual(['[!fold]+ Target', '[!fold]- Other'])
  })

  it('keeps title-only drops and ordinary edits folded', () => {
    const state = stateOf(fold('Target', p('Body')))
    const titleDrop = state.tr.insertText('Title ', 10).setMeta('uiEvent', 'drop')
    expect(unfoldCalloutsAfterDrop([titleDrop], state.apply(titleDrop))).toBeNull()
    const bodyEdit = state.tr.insertText('Edit ', 1 + state.doc.firstChild!.firstChild!.nodeSize + 1)
    expect(unfoldCalloutsAfterDrop([bodyEdit], state.apply(bodyEdit))).toBeNull()
  })
})
