import { describe, expect, it } from 'vitest'
import { byExpiry, daysUntil, publishCovers, publishStateFor, type PublishRow } from './shareState'

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

describe('share expiry', () => {
  const at = (s: string): number => new Date(s).getTime()
  it('counts calendar days, so a share ending tomorrow morning reads as tomorrow', () => {
    expect(daysUntil(null)).toBe(null)
    expect(daysUntil('2026-10-31T23:00:00', at('2026-10-31T01:00:00'))).toBe(0)
    expect(daysUntil('2026-11-01T01:00:00', at('2026-10-31T23:00:00'))).toBe(1)
    expect(daysUntil('2026-10-29T12:00:00', at('2026-10-31T12:00:00'))).toBe(-2)
  })
  it('puts shares without participants last, then the soonest end first', () => {
    const s = (id: string, expiresAt: string | null, n: number) => ({ id, expiresAt, participants: new Array(n).fill({}) })
    const list = [s('empty', '2026-11-01T00:00:00Z', 0), s('forever', null, 2), s('late', '2026-11-20T00:00:00Z', 1), s('soon', '2026-11-02T00:00:00Z', 1)]
    expect([...list].sort(byExpiry).map((x) => x.id)).toEqual(['soon', 'late', 'forever', 'empty'])
  })
})
