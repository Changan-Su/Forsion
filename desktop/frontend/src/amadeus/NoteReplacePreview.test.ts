import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { noteReplaceMatches } from './lib/noteReplaceMatches'
import { matchContext, NoteReplaceBody, reviewSelection } from './NoteReplacePreview'

function preview(source: string, query = 'alpha') {
  const path = 'Notebook/Sample.md', matches = noteReplaceMatches(path, source, query)
  const file = { path, source, matches }
  const html = renderToStaticMarkup(createElement(NoteReplaceBody, { view: {
    root: '/vault', file, selected: new Set(matches.map(hit => hit.id)), replacement: '<literal>', activeId: matches[0].id,
  } }))
  return { html, matches, file }
}

describe('replace review source positions', () => {
  it('keeps Markdown blockquote continuation syntax out of the rendered text', () => {
    const { html } = preview('> First alpha\r\n> second alpha\r\n> third alpha.\r\n')
    expect(html).toContain('<blockquote>')
    expect(html.match(/<del>alpha<\/del>/g)).toHaveLength(3)
    expect(html).not.toContain('&gt; second')
    expect(html).not.toContain('&gt; third')
    expect(html).toContain('<ins>&lt;literal&gt;</ins>')
  })

  it('maps list continuation indentation, entities and escapes before later occurrences', () => {
    const { html } = preview('- Hold &amp; \\* alpha\n  next alpha and alpha.\n')
    expect(html).toContain('<li>')
    expect(html).toContain('Hold &amp; * ')
    expect(html).not.toContain('&amp;amp;')
    expect(html).not.toContain('  next')
    expect(html.match(/<del>alpha<\/del>/g)).toHaveLength(3)
  })

  it('preserves note formatting while the sidebar shows readable text', () => {
    const { html, file, matches } = preview('\uFEFF---\r\ntitle: alpha\r\n---\r\n\r\nRead **alpha** beside [a link](https://example.org).\r\n')
    expect(html).toContain('<strong><span')
    expect(html).not.toContain('title: alpha')
    expect(matchContext(file, matches[0]).join('')).toBe('Read alpha beside a link.')
  })
})

describe('replace review selection', () => {
  function file(path: string, source: string, fileId?: string) {
    return { path, source, fileId, matches: noteReplaceMatches(path, source, 'old') }
  }
  it('requires review after deletion gives a different occurrence the same offset', () => {
    const a = file('A.md', 'oldold'), b = file('B.md', 'old old'), quoted = file('C.md', '> old')
    const plan = { scope: 'vault', query: 'old', files: [a, b, quoted] }
    const previous = { plan, selected: new Set([a.matches[0].id, b.matches[1].id]) }
    const afterDeletion = file('A.md', 'old')
    expect(afterDeletion.matches[0].id).toBe(a.matches[0].id)
    const refreshed = reviewSelection({ ...plan, files: [afterDeletion, b, quoted] }, previous)
    expect(refreshed.selected).toEqual(new Set([b.matches[1].id]))
    expect(refreshed.needsReview).toEqual(new Set(['A.md']))
  })
  it('requires review when a same-path cloud file was replaced with identical text', () => {
    const before = file('Cloud.md', 'old', 'one'), after = file('Cloud.md', 'old', 'two')
    const plan = { scope: 'account/vault', query: 'old', files: [before] }
    const initial = reviewSelection(plan, null)
    expect(initial.selected).toEqual(new Set([before.matches[0].id]))
    expect(reviewSelection({ ...plan, files: [after] }, { plan, selected: initial.selected }).selected.size).toBe(0)
  })
})
