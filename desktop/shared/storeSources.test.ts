import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  auditWarns, BUILTIN_SKILLS_SH, isBuiltinSourceId, MAX_ADAPT_NOTE, parseAdaptView, parseCollected,
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
  it('pins GitHub / Forsion Git packages to a commit', () => {
    const C = 'a'.repeat(40), D = 'b'.repeat(40)
    const index = parseStoreIndex({
      schema: 1,
      items: [
        item({ id: 'pinned', package: { github: 'a/b', ref: 'v1', commit: C.toUpperCase() } }),
        item({ id: 'ref-is-commit', package: { forsionGit: 'acme/kit', ref: D } }),
        item({ id: 'same', package: { github: 'a/b', ref: C, commit: C } }),
        item({ id: 'short-commit', package: { github: 'a/b', ref: 'v1', commit: 'abc1234' } }),
        item({ id: 'bad-commit', package: { github: 'a/b', ref: 'v1', commit: 42 } }),
        item({ id: 'two-commits', package: { github: 'a/b', ref: C, commit: D } }),
        item({ id: 'no-ref', package: { github: 'a/b', commit: C } }),
        item({ id: 'upper-ref', package: { github: 'a/b', ref: C.toUpperCase() } }),
        item({ id: 'upper-conflict', package: { github: 'a/b', ref: D.toUpperCase(), commit: C } }),
      ],
    })
    // A malformed commit drops the item: falling back to the ref would let the author believe it is pinned.
    expect(index.items.map((x) => x.id)).toEqual(['pinned', 'ref-is-commit', 'same', 'upper-ref'])
    expect(index.items[3].package).toMatchObject({ ref: C.toUpperCase(), commit: C })
    expect(index.items[0].package).toEqual({ kind: 'github', repo: 'a/b', ref: 'v1', commit: C })
    expect(index.items[1].package).toEqual({ kind: 'forsion-git', repo: 'acme/kit', ref: D, commit: D })
    // Pinning doesn't change where a package downloads from (an update to a new commit is not "moved").
    expect(packageOrigin(index.items[0].package)).toBe('github:a/b')
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

describe('collected skills (built-in skills.sh source)', () => {
  const collected = (over: Record<string, unknown> = {}) => ({
    installs: 840000, rank: 12, trendingRank: null, audit: { gen: 'safe', socket: 'low', snyk: 'medium' }, override: false, license: 'MIT',
    scripts: 2, files: 5, requirements: { cli: true, apiKeys: ['OPENAI_API_KEY'], desktopOnly: true }, writtenFor: ['claude-code'],
    adapted: true, adaptCount: 4, unsupportedCount: 1, requires: ['grill-me'], upstreamDeleted: false, pageUrl: 'https://skills.sh/mattpocock/skills/wayfinder', ...over,
  })
  it('the built-in id is the one both sides hard-code', () => {
    expect(createHash('sha256').update(`builtin:${BUILTIN_SKILLS_SH.title}`).digest('hex').slice(0, 8)).toBe(BUILTIN_SKILLS_SH.id)
    expect(isBuiltinSourceId(BUILTIN_SKILLS_SH.id)).toBe(true)
    expect(isBuiltinSourceId('0a1b2c3d')).toBe(false)
  })
  it('reads the collected block and fills absent optional fields', () => {
    expect(parseCollected(collected())).toMatchObject({ installs: 840000, rank: 12, trendingRank: null, scripts: 2, requires: ['grill-me'], missingPrereq: false, writtenFor: ['claude-code'] })
    const { writtenFor: _w, requires: _r, license: _l, adaptCount: _a, unsupportedCount: _u, ...minimal } = collected()
    expect(parseCollected(minimal)).toMatchObject({ writtenFor: [], requires: [], license: null, adaptCount: 0, unsupportedCount: 0 })
    // A provider the audit doesn't name yet is unknown, not safe.
    expect(parseCollected(collected({ audit: { gen: 'safe' } }))?.audit).toEqual({ gen: 'safe', socket: 'unknown', snyk: 'unknown' })
  })
  it('drops the whole block on a present-but-wrong field', () => {
    for (const bad of [
      { installs: -1 }, { scripts: '2' }, { audit: { snyk: 'meh' } }, { requirements: { cli: 'yes', desktopOnly: false } },
      { requirements: { cli: false, desktopOnly: false, apiKeys: ['lower_case'] } }, { writtenFor: ['cursor'] }, { requires: ['../x'] },
      { pageUrl: 'https://evil.example/x' }, { pageUrl: 'http://skills.sh/x' }, { adapted: 1 },
    ]) expect(parseCollected(collected(bad)), JSON.stringify(bad)).toBeUndefined()
    expect(parseCollected(collected({ pageUrl: 'https://www.skills.sh/a/b/c' }))?.pageUrl).toBe('https://www.skills.sh/a/b/c')
  })
  it('a medium-or-worse audit asks for a confirmation', () => {
    expect(auditWarns(parseCollected(collected()))).toBe(true)
    expect(auditWarns(parseCollected(collected({ audit: { gen: 'safe', socket: 'low', snyk: 'safe' } })))).toBe(false)
    expect(auditWarns(undefined)).toBe(false)
  })
  it('keeps a valid collected block on a catalog item and drops a broken one without dropping the item', () => {
    const pinned = { github: 'mattpocock/skills', ref: 'main', commit: 'a'.repeat(40), path: 'skills/wayfinder' }
    const idx = parseStoreIndex({ schema: 1, title: 'skills.sh', items: [item({ id: 'wayfinder', package: pinned, collected: collected() }), item({ id: 'tdd', package: pinned, collected: collected({ installs: 'many' }) })] })
    expect(idx.items.map((x) => x.id)).toEqual(['wayfinder', 'tdd'])
    expect(idx.items[0].collected?.adapted).toBe(true)
    expect(idx.items[1].collected).toBeUndefined()
  })
  it('reads an adaptation view entry by entry, and refuses one without a note or commit', () => {
    const view = parseAdaptView({
      note: 'In Tangu: "/grill-me" means use_skill grill-me.', commit: 'B'.repeat(40), requires: ['grill-me', 'grill-me', 'Bad Id'], setup: 'setup-x', external: ['GitHub CLI (gh)', 'x'.repeat(81)],
      entries: [
        { line: 12, quote: 'use the /grill-me skill', action: 'use-skill', target: 'grill-me', by: 'table' },
        { line: 12, quote: 'dup', action: 'use-skill', target: 'grill-me', by: 'ai' },
        { line: 13, quote: 'use a skill', action: 'use-skill', by: 'table' },
        { line: 0, quote: 'line zero', action: 'todo', by: 'ai' },
        { line: 20, quote: 'TodoWrite', action: 'todo', by: 'ai' },
        { line: 21, quote: 'x', action: 'rm -rf', by: 'ai' },
      ],
      unsupported: [{ line: 30, quote: 'hooks:', feature: 'hooks' }, { line: 31, quote: 'y', feature: 'magic' }],
    })
    expect(view).toEqual({
      entries: [{ line: 12, quote: 'use the /grill-me skill', action: 'use-skill', target: 'grill-me', by: 'table' }, { line: 20, quote: 'TodoWrite', action: 'todo', by: 'ai' }],
      unsupported: [{ line: 30, quote: 'hooks:', feature: 'hooks' }], requires: ['grill-me'], setup: 'setup-x', external: ['GitHub CLI (gh)'],
      note: 'In Tangu: "/grill-me" means use_skill grill-me.', commit: 'b'.repeat(40),
    })
    expect(parseAdaptView({ note: 'x', commit: 'short' })).toBeNull()
    expect(parseAdaptView({ note: '', commit: 'a'.repeat(40) })).toBeNull()
    expect(parseAdaptView({ note: 'x'.repeat(MAX_ADAPT_NOTE + 1), commit: 'a'.repeat(40) })).toBeNull()
  })
})
