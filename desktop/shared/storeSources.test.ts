import { describe, expect, it } from 'vitest'
import {
  canonicalSource, declaredSourcesOf, isSourceCardId, MAX_INDEX_ITEMS, packageOrigin, parseSourceInput, parseStoreIndex, pickText,
  sourceCardId, sourceInstallSlug, splitSourceCardId,
} from './storeSources'
import { isSafeSlug } from './marketPackage'

const pkg = { github: 'pixel-lab/image-skills', ref: 'v1.2.0', path: 'skills/poster' }
const item = (over: Record<string, unknown> = {}) => ({ id: 'poster', type: 'skill', name: { zh: '海报排版', en: 'Poster layout' }, version: '1.2.0', package: pkg, ...over })

describe('parseSourceInput', () => {
  it('reads GitHub repositories in the usual spellings', () => {
    expect(parseSourceInput('github:pixel-lab/image-skills')).toEqual({ kind: 'github', repo: 'pixel-lab/image-skills' })
    expect(parseSourceInput('https://github.com/pixel-lab/image-skills.git')).toEqual({ kind: 'github', repo: 'pixel-lab/image-skills' })
    expect(parseSourceInput('github.com/pixel-lab/image-skills/')).toEqual({ kind: 'github', repo: 'pixel-lab/image-skills' })
    expect(parseSourceInput('https://github.com/pixel-lab/image-skills/tree/main/catalog/v2')).toEqual({ kind: 'github', repo: 'pixel-lab/image-skills', ref: 'main', dir: 'catalog/v2' })
  })
  it('reads npm packages and Forsion Git repositories', () => {
    expect(parseSourceInput('npm:@pixel/image-skills')).toEqual({ kind: 'npm', name: '@pixel/image-skills' })
    expect(parseSourceInput('https://www.npmjs.com/package/@pixel/image-skills')).toEqual({ kind: 'npm', name: '@pixel/image-skills' })
    expect(parseSourceInput('git.forsion.net/acme/design-skills')).toEqual({ kind: 'forsion-git', repo: 'acme/design-skills' })
    expect(parseSourceInput('https://git.forsion.net/acme/x/src/branch/dev/store')).toEqual({ kind: 'forsion-git', repo: 'acme/x', ref: 'dev', dir: 'store' })
    // Gitea names may carry `.` / `_` (organisations do); GitHub owners can't.
    expect(parseSourceInput('forsion-git:acme.team/kit')).toEqual({ kind: 'forsion-git', repo: 'acme.team/kit' })
    expect(parseSourceInput('forsion-git:a_b/kit')).toEqual({ kind: 'forsion-git', repo: 'a_b/kit' })
    expect(parseSourceInput('github:acme.team/kit')).toBeNull()
    expect(parseSourceInput('forsion-git:.acme/kit')).toBeNull()
  })
  it('takes other https addresses as a catalog file, http only on this computer', () => {
    expect(parseSourceInput('https://example.com/forsion-store.json#x')).toEqual({ kind: 'url', url: 'https://example.com/forsion-store.json' })
    expect(parseSourceInput('http://localhost:8080/forsion-store.json')).toEqual({ kind: 'url', url: 'http://localhost:8080/forsion-store.json' })
    expect(parseSourceInput('http://example.com/forsion-store.json')).toBeNull()
    expect(parseSourceInput('https://user:pw@example.com/x.json')).toBeNull()
    expect(parseSourceInput('file:///etc/passwd')).toBeNull()
  })
  it('rejects malformed repositories and paths', () => {
    expect(parseSourceInput('github:pixel-lab')).toBeNull()
    expect(parseSourceInput('https://github.com/a/b/tree/../x')).toBeNull()
    expect(parseSourceInput('https://github.com/a/b/blob/main/x')).toBeNull()
    expect(parseSourceInput('npm:Bad Name')).toBeNull()
    expect(parseSourceInput('')).toBeNull()
  })
  it('spells each source one way', () => {
    expect(canonicalSource(parseSourceInput('github.com/a/b.git')!)).toBe('https://github.com/a/b')
    expect(canonicalSource({ kind: 'github', repo: 'a/b', dir: 'c' })).toBe('https://github.com/a/b/tree/HEAD/c')
    expect(canonicalSource({ kind: 'npm', name: 'x' })).toBe('https://www.npmjs.com/package/x')
  })
})

describe('parseStoreIndex', () => {
  it('keeps valid items and drops broken ones', () => {
    const index = parseStoreIndex({
      schema: 1, title: { zh: '图片 Skills 大全' }, author: 'Pixel Lab',
      items: [
        item(),
        item({ id: 'poster' }), // duplicate
        item({ id: 'Bad_ID' }),
        item({ id: 'no-type', type: 'widget' }),
        item({ id: 'no-version', version: 'latest' }),
        item({ id: 'traversal', package: { github: 'a/b', ref: 'v1', path: '../x' } }),
        item({ id: 'npm-ok', package: { npm: '@p/x', version: '1.2.0' } }),
        item({ id: 'npm-mismatch', package: { npm: '@p/x', version: '1.0.0' } }),
        item({ id: 'url-nohash', package: { url: 'https://e.com/x.zip' } }),
        item({ id: 'url-ok', package: { url: 'https://e.com/x.zip', sha256: 'A'.repeat(64) } }),
      ],
    })
    expect(index.items.map((x) => x.id)).toEqual(['poster', 'npm-ok', 'url-ok'])
    expect(index.items[2].package).toEqual({ kind: 'url', url: 'https://e.com/x.zip', sha256: 'a'.repeat(64) })
    expect(index.items[0].package).toEqual({ kind: 'github', repo: 'pixel-lab/image-skills', ref: 'v1.2.0', path: 'skills/poster' })
    expect(pickText(index.title, 'en')).toBe('图片 Skills 大全')
  })
  it('throws on a file that is not a catalog', () => {
    expect(() => parseStoreIndex([])).toThrow('source: index-invalid')
    expect(() => parseStoreIndex({ schema: 2, items: [] })).toThrow('source: index-schema')
  })
  it('caps the number of items', () => {
    const items = Array.from({ length: MAX_INDEX_ITEMS + 5 }, (_, i) => item({ id: `i${i}` }))
    const index = parseStoreIndex({ schema: 1, items })
    expect(index.items).toHaveLength(MAX_INDEX_ITEMS)
    expect(index.truncated).toBe(true)
  })
})

describe('identities', () => {
  it('card ids and install folders stay apart from store ids and slugs', () => {
    const id = sourceCardId('0a1b2c3d', 'poster-layout-and-more-words-up-to-forty-eightx')
    expect(isSourceCardId(id)).toBe(true)
    expect(isSourceCardId('3f1c2a9e-1b2c-4d5e-8f90-123456789abc')).toBe(false)
    expect(splitSourceCardId(id)).toEqual({ source: '0a1b2c3d', item: 'poster-layout-and-more-words-up-to-forty-eightx' })
    expect(isSafeSlug(sourceInstallSlug('0a1b2c3d', 'poster-layout-and-more-words-up-to-forty-eightx'))).toBe(true)
  })
  it('names where a package downloads from', () => {
    expect(packageOrigin({ kind: 'github', repo: 'Pixel-Lab/X', ref: 'v1' })).toBe('github:pixel-lab/x')
    expect(packageOrigin({ kind: 'url', url: 'https://cdn.example.com/a.zip', sha256: 'a'.repeat(64) })).toBe('url:cdn.example.com')
  })
})

describe('declaredSourcesOf', () => {
  it('keeps valid manifest declarations only', () => {
    expect(declaredSourcesOf('image-skills', [
      { id: 'main', title: { zh: '图片 Skills 大全', en: 'Image skills' }, index: 'github:pixel-lab/image-skills', icon: 'image' },
      { id: 'main', title: 'dup', index: 'github:a/b' },
      { id: 'bad', title: 'x', index: 'ftp://x' },
      { id: 'no-title', index: 'github:a/b' },
    ])).toEqual([{ pluginId: 'image-skills', id: 'main', title: { zh: '图片 Skills 大全', en: 'Image skills' }, index: 'github:pixel-lab/image-skills', icon: 'image' }])
    expect(declaredSourcesOf('x', 'nope')).toEqual([])
  })
})
