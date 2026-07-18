import { describe, expect, it } from 'vitest'
import { publishCovers, publishStateFor, type PublishRow } from './shareState'

const P = (mode: string, path: string, token = `t_${path}`): PublishRow => ({ token, mode, path })

describe('publishCovers', () => {
  it('subtree publish covers descendants but not siblings', () => {
    const folder = P('subtree', 'Projects')
    expect(publishCovers(folder, 'Projects')).toBe(true) // root itself
    expect(publishCovers(folder, 'Projects/a.md')).toBe(true)
    expect(publishCovers(folder, 'Projects/sub/b.md')).toBe(true)
    expect(publishCovers(folder, 'ProjectsX/a.md')).toBe(false) // prefix trap
    expect(publishCovers(folder, 'Other/a.md')).toBe(false)
  })
  it('page publish covers its .fd subpages only', () => {
    const page = P('page', 'Notes/Root.md')
    expect(publishCovers(page, 'Notes/Root.md')).toBe(true)
    expect(publishCovers(page, 'Notes/Root.fd/child.md')).toBe(true)
    expect(publishCovers(page, 'Notes/Other.md')).toBe(false)
  })
})

describe('publishStateFor', () => {
  it('none when nothing matches', () => {
    expect(publishStateFor('a/b.md', [P('page', 'x/y.md')]).kind).toBe('none')
  })
  it('direct when exact page publish exists', () => {
    const s = publishStateFor('a/b.md', [P('page', 'a/b.md', 'tok1')])
    expect(s).toEqual({ kind: 'direct', token: 'tok1' })
  })
  it('inherited when covered by ancestor folder subtree', () => {
    const s = publishStateFor('Projects/deep/c.md', [P('subtree', 'Projects', 'folderTok')])
    expect(s).toEqual({ kind: 'inherited', via: 'Projects', viaMode: 'subtree', token: 'folderTok' })
  })
  it('direct wins over an ancestor subtree covering the same page', () => {
    const s = publishStateFor('Projects/c.md', [P('subtree', 'Projects', 'folderTok'), P('page', 'Projects/c.md', 'pageTok')])
    expect(s).toEqual({ kind: 'direct', token: 'pageTok' })
  })
})
