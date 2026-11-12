// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { NodeSelection } from '@milkdown/kit/prose/state'
import { bootEditor } from '../blocks/markdown/parseFidelity.testkit'
import { numberedListAt, setListStart } from './listNumbering'

describe('explicit list continuation', () => {
  it('saves a concrete start after intervening prose and does not rewrite the previous list', async () => {
    const b = await bootEditor('4. Alpha\n5. Beta\n\nInterlude\n\n1. Gamma\n2. Delta\n')
    try {
      let at = 0
      b.view.state.doc.forEach((n, pos) => { if (n.type.name === 'ordered_list') at = pos })
      b.view.dispatch(b.view.state.tr.setSelection(NodeSelection.create(b.view.state.doc, at)))
      const list = numberedListAt(b.view.state)!
      expect(list.previousStart).toBe(6)
      expect(setListStart(b.view, list, 6)).toBe(true)
      const saved = b.md()
      expect(saved).toMatch(/4\.\s+Alpha/)
      expect(saved).toMatch(/6\.\s+Gamma/)
      expect(b.parse(saved).lastChild?.attrs.order).toBe(6)
      expect(setListStart(b.view, list, 8)).toBe(false) // stale menu cannot change a later document
    } finally { await b.destroy() }
  })
  it.each(['## Break', '---'])('does not continue across %s', async (barrier) => {
    const b = await bootEditor(`1. First\n\n${barrier}\n\n1. Last\n`)
    try {
      const at = b.view.state.doc.content.size - b.view.state.doc.lastChild!.nodeSize
      b.view.dispatch(b.view.state.tr.setSelection(NodeSelection.create(b.view.state.doc, at)))
      expect(numberedListAt(b.view.state)?.previousStart).toBeNull()
    } finally { await b.destroy() }
  })
})
