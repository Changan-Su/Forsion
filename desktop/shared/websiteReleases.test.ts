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
})
