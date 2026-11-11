// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { bootEditor } from '../blocks/markdown/parseFidelity.testkit'
import { embedMatches, embedsUntouched } from './embedLayer'

it('finds embed-only soft lines without changing paragraphs or source bytes', async () => {
  const md = '[[Normal]]\n![[drawing.excalidraw]]\n![[lecture.pdf]]\n[[Other]]\n'
  const b = await bootEditor(md)
  try {
    const node = b.view.state.doc.firstChild!
    const matches = embedMatches(node, 0)
    expect(matches.map(m => [m.node.textContent, m.pos, m.inline])).toEqual([
      ['![[drawing.excalidraw]]', 11, true], ['![[lecture.pdf]]', 35, true],
    ])
    expect(b.saved()).toBe(md)
    expect(b.view.state.doc.childCount).toBe(1)
    const tr = b.view.state.tr.insertText('X', matches[1].pos + 4)
    expect(embedsUntouched(tr)).toBe(false)
  } finally { await b.destroy() }
})

it('does not promote inline prose, code, escaped bangs, or image lines', async () => {
  const b = await bootEditor('text ![[x.pdf]]\n`![[code.pdf]]`\n![[`name.pdf`]]\n\\![[literal.pdf]]\n![[pic.png]]\n')
  try { expect(embedMatches(b.view.state.doc.firstChild!, 0)).toEqual([]) }
  finally { await b.destroy() }
})

it('rebuilds when a line is marked as inline code', async () => {
  const b = await bootEditor('before\n![[lecture.pdf]]\nafter\n')
  try {
    const v = b.view
    const match = embedMatches(v.state.doc.firstChild!, 0)[0]
    const tr = v.state.tr.addMark(match.pos + 1, match.pos + match.node.nodeSize - 1, v.state.schema.marks.inlineCode.create())
    expect(embedsUntouched(tr)).toBe(false)
    expect(embedMatches(tr.doc.firstChild!, 0)).toEqual([])
  } finally { await b.destroy() }
})
