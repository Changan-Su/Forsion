import { describe, expect, it } from 'vitest'
import { buildWhatsNewEntries, compareVersions, parseWebsiteReleases, websiteReleaseUrl } from './websiteReleases'

describe('websiteReleases', () => {
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
})
