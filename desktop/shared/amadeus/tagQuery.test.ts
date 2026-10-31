import { describe, expect, it, vi } from 'vitest'
import {
  TAG_LINE_HITS_MAX,
  buildTagTree,
  filterTagTree,
  hasTagFilter,
  matchedTagInLine,
  parseSearchQuery,
  passesTagFilter,
  sortTagTree,
  splitTagText,
  tagCounts,
  tagDocFromRaw,
  tagLineHits,
  tagSearch,
  tagSearchRemote,
  type TagSearchDoc,
} from './tagQuery'

describe('parseSearchQuery', () => {
  it('splits tag:, -tag: and keywords, with or without #', () => {
    expect(parseSearchQuery('tag:#a  foo -tag:b  bar')).toEqual({ tags: ['a'], notTags: ['b'], text: 'foo bar' })
  })
  it('is case-insensitive on the operator and dedupes tags', () => {
    expect(parseSearchQuery('TAG:#Work tag:work -Tag:x')).toEqual({ tags: ['Work'], notTags: ['x'], text: '' })
  })
  it('accepts nested, Chinese and numeric-parent tags', () => {
    expect(parseSearchQuery('tag:#产品/路线图 tag:2026/').tags).toEqual(['产品/路线图', '2026'])
  })
  it('leaves malformed operators as keywords', () => {
    const q = parseSearchQuery('tag: tag:# tag:a.b tagged:x')
    expect(hasTagFilter(q)).toBe(false)
    expect(q.text).toBe('tag: tag:# tag:a.b tagged:x')
  })
})

describe('passesTagFilter', () => {
  const tags = ['产品/路线图', 'Forsion']
  it('matches by nested prefix and case-insensitively', () => {
    expect(passesTagFilter(tags, parseSearchQuery('tag:#产品'))).toBe(true)
    expect(passesTagFilter(tags, parseSearchQuery('tag:forsion'))).toBe(true)
    expect(passesTagFilter(tags, parseSearchQuery('tag:产'))).toBe(false)
  })
  it('intersects several tags and honours exclusion', () => {
    expect(passesTagFilter(tags, parseSearchQuery('tag:产品 tag:forsion'))).toBe(true)
    expect(passesTagFilter(tags, parseSearchQuery('tag:产品 tag:missing'))).toBe(false)
    expect(passesTagFilter(tags, parseSearchQuery('tag:产品 -tag:forsion'))).toBe(false)
    expect(passesTagFilter(tags, parseSearchQuery('-tag:missing'))).toBe(true)
  })
})

describe('tagLineHits', () => {
  const hits = (plain: string, query: string, fm: string[] = [], terms: string[] = []) => tagLineHits(plain, fm, parseSearchQuery(query), terms)
  it('lists every line with the tag, 1-based, with markdown syntax removed', () => {
    expect(hits('intro\n- **一** #a\n- 二 #a/b\nthree #other\n', 'tag:#a')).toEqual([
      { line: 2, text: '一 #a' },
      { line: 3, text: '二 #a/b' },
    ])
  })
  it('skips fenced and inline code, keeping line numbers aligned', () => {
    expect(hits('```\n#a in fence\n```\n`#a` inline\nreal #a\n', 'tag:a')).toEqual([{ line: 5, text: 'real #a' }])
  })
  it('reports a frontmatter tag as line 0, first', () => {
    expect(hits('body #a\n', 'tag:a', ['a', 'a/b', 'c'])).toEqual([
      { line: 0, text: 'tags: #a #a/b' },
      { line: 1, text: 'body #a' },
    ])
    expect(hits('no tag\n', 'tag:a', ['a'])).toEqual([{ line: 0, text: 'tags: #a' }])
  })
  it('caps the lines of one file', () => {
    const plain = Array.from({ length: TAG_LINE_HITS_MAX + 5 }, (_, i) => `memo ${i} #a`).join('\n')
    expect(hits(plain, 'tag:a')).toHaveLength(TAG_LINE_HITS_MAX)
  })
  it('narrows to lines that carry every tag or keyword, falling back to all target lines', () => {
    const month = 'one #a\ntwo #b\nthree #a #b cake\n'
    expect(hits(month, 'tag:a tag:b').map((h) => h.line)).toEqual([3])
    expect(hits(month, 'tag:a cake', [], ['cake']).map((h) => h.line)).toEqual([3])
    expect(hits('one #a\ntwo cake\n', 'tag:a cake', [], ['cake']).map((h) => h.line)).toEqual([1])
  })
  it('counts earlier uses of the tag over the whole note, even for lines narrowed away', () => {
    expect(hits('earlier #a\n[[Target]] #a #b\n', 'tag:a tag:b')).toEqual([{ line: 2, text: 'Target #a #b', tagIndex: 1 }])
  })
  it('keeps the tag visible when a long line is clipped, as a substring of the line', () => {
    const long = `${'字'.repeat(400)} #a ${'尾'.repeat(400)}`
    const [hit] = hits(long, 'tag:a')
    expect(hit.text.length).toBeLessThanOrEqual(200)
    expect(hit.text).toContain('#a')
    expect(long).toContain(hit.text)
  })
})

describe('tagSearch', () => {
  const doc = (path: string, plain: string, tags: string[], fmTags: string[] = []): TagSearchDoc => ({ path, title: path.replace('.md', ''), tags, fmTags, plain })
  const docs = [
    doc('one.md', 'x #a\n', ['a']),
    doc('two.md', 'x #a\ny #a\nsecret\n', ['a']),
    doc('three.md', 'z #b\n', ['b']),
    doc('fm.md', 'plain body\n', ['a'], ['a']),
  ]
  it('sorts by number of lines and returns hits', () => {
    const out = tagSearch(docs, parseSearchQuery('tag:a'), () => null)
    expect(out.map((h) => h.path)).toEqual(['two.md', 'fm.md', 'one.md'])
    expect(out[0].hits).toHaveLength(2)
    expect(out[1].hits).toEqual([{ line: 0, text: 'tags: #a' }])
  })
  it('applies the keyword search after the tag filter', () => {
    const textHit = vi.fn((d: TagSearchDoc) => (d.plain.includes('secret') ? { path: d.path, title: d.title, snippet: 'secret', line: 3, score: 9 } : null))
    const out = tagSearch(docs, parseSearchQuery('tag:a secret'), textHit, ['secret'])
    expect(out).toMatchObject([{ path: 'two.md', snippet: 'secret', line: 3, score: 9 }])
    expect(textHit).toHaveBeenCalledTimes(3) // b 被标签条件先筛掉,不必再搜
  })
  it('an exclusion-only query means every note without the tag, without line hits', () => {
    const out = tagSearch(docs, parseSearchQuery('-tag:a'), () => null)
    expect(out.map((h) => h.path)).toEqual(['three.md'])
    expect(out[0].hits).toBeUndefined()
    expect(out[0].snippet).toBe('z #b')
  })
})

describe('tagSearchRemote', () => {
  const files: Record<string, string> = {
    'a.md': '---\ntags: [p]\n---\nbody #p/x\n',
    'b.md': 'line #p/y\nsecond #q\n',
    'c.md': 'only #q\n',
  }
  const src = {
    // 云端 /tags 没有 total,/tags/pages 只认确切标签
    listTags: async () => [{ tag: 'p', count: 1 }, { tag: 'p/x', count: 1 }, { tag: 'p/y', count: 1 }, { tag: 'q', count: 2 }],
    pagesByTag: async (tag: string) => Object.keys(files).filter((p) => tagDocFromRaw(p, files[p]).tags.some((t) => t.toLowerCase() === tag)),
    allPages: async () => Object.keys(files),
    textSearch: async (text: string) => Object.keys(files).filter((p) => files[p].includes(text)).map((p) => ({ path: p, title: p, snippet: text, line: 1, score: 1 })),
    readText: async (p: string) => files[p] ?? null,
  }
  it('expands a nested prefix itself, because the server only matches exact tags', async () => {
    const out = await tagSearchRemote(parseSearchQuery('tag:p'), src)
    expect(out.map((h) => h.path).sort()).toEqual(['a.md', 'b.md'])
    expect(out.find((h) => h.path === 'a.md')?.hits).toEqual([{ line: 0, text: 'tags: #p' }, { line: 1, text: 'body #p/x' }])
  })
  it('intersects, excludes and applies keywords', async () => {
    expect((await tagSearchRemote(parseSearchQuery('tag:p tag:q'), src)).map((h) => h.path)).toEqual(['b.md'])
    expect((await tagSearchRemote(parseSearchQuery('tag:q -tag:p'), src)).map((h) => h.path)).toEqual(['c.md'])
    expect((await tagSearchRemote(parseSearchQuery('tag:q second'), src)).map((h) => h.path)).toEqual(['b.md'])
    expect((await tagSearchRemote(parseSearchQuery('-tag:p'), src)).map((h) => h.path)).toEqual(['c.md'])
  })
  it('does not intersect with the capped keyword search when a positive tag gives the candidates', async () => {
    const out = await tagSearchRemote(parseSearchQuery('tag:q second'), { ...src, textSearch: async () => [] })
    expect(out.map((h) => h.path)).toEqual(['b.md'])
    expect(out[0].hits).toEqual([{ line: 2, text: 'second #q' }])
  })
  it('skips a note that cannot be read', async () => {
    const out = await tagSearchRemote(parseSearchQuery('tag:q'), { ...src, readText: async (p) => (p === 'b.md' ? null : files[p]) })
    expect(out.map((h) => h.path)).toEqual(['c.md'])
  })
})

describe('tagCounts', () => {
  it('keeps count and order, adds a per-file total and parent-only prefixes', () => {
    expect(tagCounts([
      { tags: ['产品/路线图', '产品'] },
      { tags: ['产品/路线图', '产品/用户'] },
      { tags: ['设计'] },
    ])).toEqual([
      { tag: '产品/路线图', count: 2, total: 2 },
      { tag: '产品', count: 1, total: 2 },
      { tag: '产品/用户', count: 1, total: 1 },
      { tag: '设计', count: 1, total: 1 },
    ])
  })
  it('adds a parent that exists only as a prefix, in first-seen case', () => {
    expect(tagCounts([{ tags: ['Work/a'] }, { tags: ['work/b'] }])).toEqual([
      { tag: 'Work/a', count: 1, total: 1 },
      { tag: 'work/b', count: 1, total: 1 },
      { tag: 'Work', count: 0, total: 2 },
    ])
  })
  it('counts tags that differ only in case as one row', () => {
    expect(tagCounts([{ tags: ['Work'] }, { tags: ['work'] }])).toEqual([{ tag: 'Work', count: 2, total: 2 }])
  })
})

describe('buildTagTree', () => {
  it('nests by slash and uses the supplied totals', () => {
    const tree = buildTagTree(tagCounts([{ tags: ['p/a', 'p/b'] }, { tags: ['p/a'] }]))
    expect(tree).toMatchObject([{ tag: 'p', name: 'p', count: 0, total: 2 }])
    expect(tree[0].children.map((c) => [c.tag, c.name, c.total])).toEqual([['p/a', 'a', 2], ['p/b', 'b', 1]])
  })
  it('falls back to self plus children when a bridge has no total, synthesising parents', () => {
    const tree = buildTagTree([{ tag: 'p/a', count: 3 }, { tag: 'p/b', count: 2 }, { tag: 'r', count: 1 }, { tag: 'r/s', count: 4 }])
    expect(tree.map((n) => [n.tag, n.count, n.total])).toEqual([['p', 0, 5], ['r', 1, 5]])
  })
  it('merges case variants and prefers the spelling of the real row', () => {
    const tree = buildTagTree([{ tag: 'work/a', count: 1 }, { tag: 'Work', count: 2 }])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ tag: 'Work', count: 2, total: 3 })
  })
  it('ignores a tag with no segments', () => {
    expect(buildTagTree([{ tag: '/', count: 1 }])).toEqual([])
  })
})

describe('sortTagTree / filterTagTree', () => {
  const tree = buildTagTree([{ tag: 'b', count: 1 }, { tag: 'a/x', count: 2 }, { tag: 'a/y', count: 5 }, { tag: 'c', count: 9 }])
  it('sorts each level by total or by name without mutating', () => {
    const byCount = sortTagTree(tree, 'count')
    expect(byCount.map((n) => n.name)).toEqual(['c', 'a', 'b'])
    expect(byCount[1].children.map((n) => n.name)).toEqual(['y', 'x'])
    expect(sortTagTree(tree, 'name').map((n) => n.name)).toEqual(['a', 'b', 'c'])
    expect(tree[0].name).toBe('b')
  })
  it('keeps matches with their ancestors and opens those ancestors', () => {
    const { nodes, open } = filterTagTree(tree, 'Y')
    expect(nodes.map((n) => n.tag)).toEqual(['a'])
    expect(nodes[0].children.map((n) => n.tag)).toEqual(['a/y'])
    expect([...open]).toEqual(['a'])
  })
  it('accepts a leading # and returns the tree untouched for an empty filter', () => {
    expect(filterTagTree(tree, '#c').nodes.map((n) => n.tag)).toEqual(['c'])
    expect(filterTagTree(tree, '  ').nodes).toBe(tree)
  })
})

describe('splitTagText / matchedTagInLine', () => {
  it('splits text and tags, skipping numeric tokens and mid-word hashes', () => {
    expect(splitTagText('a #b c#d #1 #e')).toEqual([{ text: 'a ' }, { text: '#b', tag: 'b' }, { text: ' c#d #1 ' }, { text: '#e', tag: 'e' }])
  })
  it('handles a tag at the start of a line', () => {
    expect(splitTagText('#a done')).toEqual([{ text: '#a', tag: 'a' }, { text: ' done' }])
  })
  it('returns the tag actually matched, not the query', () => {
    expect(matchedTagInLine('x #other #work/urgent', ['work'])).toBe('work/urgent')
    expect(matchedTagInLine('tags: nothing', ['work'])).toBeNull()
  })
})
