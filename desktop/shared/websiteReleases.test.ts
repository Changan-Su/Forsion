import { describe, expect, it } from 'vitest'
import { buildWhatsNewEntries, compareVersions, parseWebsiteReleases, websiteReleaseUrl } from './websiteReleases'

describe('websiteReleases', () => {
  it('keeps revisions, prereleases with metadata and old overview articles in their actual order', () => {
    const versions = ['2.12', '2.13.7', '2.13.7+build.2', '2.13.7+build.10', '2.13.8-beta.1+build.1']
    const website = parseWebsiteReleases({ releases: versions.map(version => ({ version, markdown: { en: 'Notes' } })) })
    expect(website).toHaveLength(5)
    const entries = buildWhatsNewEntries({ website, changelog: [], installed: '2.13.7+build.2', locale: 'en' })
    expect(entries.map(e => [e.version, e.isNew, e.installed])).toEqual([
      [versions[4], true, false], [versions[3], true, false], [versions[2], false, true], [versions[1], false, false], [versions[0], false, false],
    ])
  })
  it('keeps only well-formed releases', () => {
    const list = parseWebsiteReleases({ releases: [
      { version: '2.13.4', date: '2026-10-14', scope: { zh: '7 段' }, markdown: { zh: '# A', en: '# B' } },
      { version: 'Unreleased', markdown: { zh: 'x' } },
      { version: '2.13.3', markdown: {} },
      null,
    ] })
    expect(list).toEqual([{ version: '2.13.4', date: '2026-10-14', scope: { zh: '7 段', en: undefined }, markdown: { zh: '# A', en: '# B' } }])
    expect(parseWebsiteReleases({ releases: 'nope' })).toEqual([])
    expect(parseWebsiteReleases(null)).toEqual([])
  })

  it('orders versions numerically, overviews after their patch line', () => {
    expect(compareVersions('2.13.10', '2.13.9')).toBeGreaterThan(0)
    expect(compareVersions('2.12', '2.12.0')).toBeLessThan(0)
    expect(compareVersions('2.12', '2.11.4')).toBeGreaterThan(0)
    expect(compareVersions('2.13.6', '2.13.5-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('2.13.5-beta.1', '2.13.5')).toBeLessThan(0)
    expect(parseWebsiteReleases({ releases: [{ version: '2.13.5-beta.1', markdown: { en: 'x' } }] })).toHaveLength(1)
  })

  it('merges website posts, bundled changelog and the pending update', () => {
    const entries = buildWhatsNewEntries({
      website: [{ version: '2.13.4', date: '2026-10-14', scope: { en: '7 demos' }, markdown: { en: '# Forsion 2.13.4' } }],
      changelog: [
        { version: 'Unreleased', date: '', lines: ['wip'] },
        { version: '2.13.4', date: '2026-10-14', lines: ['dup'] },
        { version: '2.13.2', date: '2026-10-11', lines: ['old'] },
      ],
      installed: '2.13.2',
      locale: 'zh',
      update: { version: '2.13.5', notes: '- new' },
    })
    expect(entries.map((e) => [e.version, e.isNew, e.installed])).toEqual([
      ['2.13.5', true, false], ['2.13.4', true, false], ['2.13.2', false, true],
    ])
    expect(entries[1]).toMatchObject({ markdown: '# Forsion 2.13.4', scope: '7 demos' }) // zh 缺 → 用 en
    expect(entries[0].notes).toBe('- new')
    expect(entries[2].lines).toEqual(['old'])
  })

  it('links to the website anchor', () => {
    expect(websiteReleaseUrl('2.13.4')).toBe('https://forsion.net/releases/#release-2-13-4')
  })

  it.each(['zh', 'en'] as const)('shows the consolidated edition once with %s website history or offline notes', (locale) => {
    for (const website of [null, [{ version: '2.13.5', date: '2026-10-20', scope: {}, markdown: { en: '# Old article' } }]]) {
      const entries = buildWhatsNewEntries({ website, locale, installed: '2.13.6', changelog: [
        { version: '2.13.6', date: '2026-10-21', lines: ['Canvas', 'Unified drive', 'Tasks'] },
        { version: '2.13.4', date: '', lines: ['History'] },
      ] })
      expect(entries.map(e => e.version)).toEqual(['2.13.6', '2.13.4'])
      expect(entries[0]).toMatchObject({ displayVersion: '2.13.5&2.13.6', installed: true, isNew: false, lines: ['Canvas', 'Unified drive', 'Tasks'] })
    }
  })

  it('keeps the numeric update identity when the combined website edition is newer', () => {
    const entries = buildWhatsNewEntries({ locale: 'en', installed: '2.13.5', changelog: [], website: [
      { version: '2.13.6', date: '2026-10-21', scope: {}, markdown: { en: '# Combined edition\nCanvas and drive' } },
      { version: '2.13.5', date: '2026-10-20', scope: {}, markdown: { en: '# Previous edition' } },
    ], update: { version: '2.13.6', notes: '- Update' } })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ version: '2.13.6', displayVersion: '2.13.5&2.13.6', isNew: true, installed: true, markdown: '# Combined edition\nCanvas and drive' })
    expect(websiteReleaseUrl(entries[0].version)).toContain('#release-2-13-6')
  })

  it('does not relabel the old edition before the combined content is available', () => {
    const entries = buildWhatsNewEntries({ website: null, locale: 'en', installed: '2.13.5', changelog: [
      { version: '2.13.5', date: '', lines: ['Existing article'] },
    ], update: { version: '2.13.6', notes: '- Pending update' } })
    expect(entries.map(e => e.version)).toEqual(['2.13.6', '2.13.5'])
    expect(entries.every(e => !e.displayVersion)).toBe(true)
  })

  it.each(['zh', 'en'] as const)('combines the 2.14 stable editions in the %s list without changing installer identity', locale => {
    for (const installed of ['2.13.7', '2.14.0', '2.14.1', '2.14.2']) {
      const entries = buildWhatsNewEntries({ locale, installed, website: [
        { version: '2.14.1', date: '2026-11-10', scope: {}, markdown: { zh: '# 合并更新', en: '# Combined release' } },
        { version: '2.14.0', date: '2026-11-09', scope: {}, markdown: { zh: '# 原文章', en: '# Previous article' } },
      ], changelog: [
        { version: '2.14.1', date: '', lines: ['Window fixes'] },
        { version: '2.14.0', date: '', lines: ['Main features'] },
        { version: '2.13.7', date: '', lines: ['History'] },
      ], update: { version: '2.14.1', notes: '- Update' } })
      expect(entries.map(e => e.version)).toEqual(['2.14.1', '2.13.7'])
      expect(entries[0]).toMatchObject({
        version: '2.14.1', displayVersion: '2.14.0–2.14.1',
        markdown: locale === 'zh' ? '# 合并更新' : '# Combined release',
        isNew: installed === '2.13.7' || installed === '2.14.0',
        installed: installed === '2.14.0' || installed === '2.14.1',
      })
      expect(entries[0].lines).toBeUndefined()
      expect(websiteReleaseUrl(entries[0].version)).toBe('https://forsion.net/releases/#release-2-14-1')
    }
  })

  it.each(['zh', 'en'] as const)('retains both bundled stable sections in the %s combined entry offline or with older website content', locale => {
    const changelog = [
      { version: '2.14.1', date: '2026-11-10', lines: ['Window fixes'] },
      { version: '2.14.0', date: '2026-11-09', lines: ['Main features', '  Nested detail'] },
      { version: '2.14.0-beta.1', date: '', lines: ['Preview'] },
    ]
    for (const website of [null, [{ version: '2.14.0', date: '2026-11-09', scope: {}, markdown: { en: '# Older website article' } }]]) {
      const input = { locale, installed: '2.14.0', website, changelog }
      for (let repeat = 0; repeat < 2; repeat++) {
        const entries = buildWhatsNewEntries(input)
        expect(entries.map(e => e.version)).toEqual(['2.14.1', '2.14.0-beta.1'])
        expect(entries[0]).toMatchObject({ displayVersion: '2.14.0–2.14.1', isNew: true, installed: true, lines: ['Window fixes', 'Main features', '  Nested detail'] })
      }
    }
    expect(changelog[0].lines).toEqual(['Window fixes'])
    expect(changelog[1].lines).toEqual(['Main features', '  Nested detail'])
  })

  it('keeps 2.14.0 separate while only pending 2.14.1 updater notes are available', () => {
    const entries = buildWhatsNewEntries({ website: null, locale: 'en', installed: '2.14.0', changelog: [
      { version: '2.14.0', date: '', lines: ['Existing stable release'] },
    ], update: { version: '2.14.1', notes: '- Window fixes' } })
    expect(entries.map(e => e.version)).toEqual(['2.14.1', '2.14.0'])
    expect(entries.every(e => !e.displayVersion)).toBe(true)
  })
})
