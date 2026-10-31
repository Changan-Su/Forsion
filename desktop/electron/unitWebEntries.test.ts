import { describe, expect, it } from 'vitest'
import { validateWebEntries } from '../../unit/webEntries'

const packs = new Map([
  ['notes', { spaces: new Set(['notes']) }],
  ['calendar', { spaces: new Set(['calendar']), requires: ['notes'] }],
])
describe('public Web entry configuration', () => {
  it('keeps explicit plugin dependencies in the published surface', () => {
    const entries = [{ basePath: '/web/', plugins: ['notes', 'calendar'], defaultSpace: 'notes' }]
    expect(validateWebEntries(entries, '/admin/', false, packs)).toBe(entries)
  })
  it.each(['/admin/', '/admin/web/', '/api/', '/api/web/', '/web/../', '/web', '/'])('rejects conflicting/unsafe path %s', (basePath) => {
    expect(() => validateWebEntries([{ basePath, plugins: ['notes'] }], '/admin/', false, packs)).toThrow()
  })
  it('refuses missing packages/dependencies/default Space, duplicated surfaces, and local Units', () => {
    for (const plugins of [['missing'], ['notes', 'notes'], ['calendar']]) expect(() => validateWebEntries([{ basePath: '/web/', plugins }], '/admin/', false, packs)).toThrow()
    const entry = { basePath: '/web/', plugins: ['notes'] }
    expect(() => validateWebEntries([entry, entry], '/admin/', false, packs)).toThrow()
    expect(() => validateWebEntries([{ ...entry, defaultSpace: 'private' }], '/admin/', false, packs)).toThrow()
    expect(() => validateWebEntries([entry], '/admin/', true, packs)).toThrow()
  })
})
