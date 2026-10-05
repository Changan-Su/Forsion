import { describe, expect, it } from 'vitest'
import { gatePluginManifest } from '../../shared/amadeus/ipc'
import { APP_VERSION, CHANGELOG, CHANGELOG_EN, changelogFor, latestReleasedVersion, parseChangelog } from './changelog'
import { version } from '../../package.json'
import { startupAppearanceHtml } from '../startupAppearancePlugin'

describe('released app version', () => {
  it('keeps Unreleased in the changelog but selects the first released version', () => {
    const entries = parseChangelog([
      '## Unreleased (2026-09-11)',
      '- Work in progress',
      '## v2.9.9 (2026-09-08)',
      '- Released',
    ].join('\n'))

    expect(entries.map((entry) => entry.version)).toEqual(['Unreleased', 'v2.9.9'])
    expect(latestReleasedVersion(entries)).toBe('2.9.9')
  })

  it('never feeds the Unreleased heading into plugin minAppVersion gating', () => {
    expect(APP_VERSION).toBe(version)
    expect(gatePluginManifest({ minAppVersion: '2.9.0' }, APP_VERSION)).toBeNull()
  })

  it('stamps the same version on the startup splash', () => {
    expect(startupAppearanceHtml().transformIndexHtml('<!-- forsion-startup-runtime -->')).toContain(`<script>window.FORSION_APP_VERSION="${APP_VERSION}";`)
  })
})

describe('English changelog (W-11)', () => {
  it('takes the English section when there is one and marks Chinese fallbacks', () => {
    const zh = parseChangelog('## 2.0.0 (2026-09-01)\n- 新\n## 1.0.0 (2026-06-15)\n- 旧')
    const en = parseChangelog('## 2.0.0 (2026-09-01)\n- New')
    const out = changelogFor('en', zh, en)
    expect(out.map((e) => [e.version, e.lines[0], !!e.fallback])).toEqual([['2.0.0', 'New', false], ['1.0.0', '旧', true]])
    expect(changelogFor('zh', zh, en)).toBe(zh)
  })
  it('every English heading matches a Chinese one, and every released version ships English notes', () => {
    const zhVersions = new Set(CHANGELOG.map((e) => e.version))
    expect(CHANGELOG_EN.filter((e) => !zhVersions.has(e.version)).map((e) => e.version)).toEqual([])
    // 发版时中英一起写:CHANGELOG.en.md 缺哪一节,英文界面就只能显示中文原文(forsion-release skill 已写进流程)
    const enVersions = new Set(CHANGELOG_EN.map((e) => e.version))
    expect(CHANGELOG.filter((e) => !enVersions.has(e.version)).map((e) => e.version)).toEqual([])
    for (const e of CHANGELOG_EN) expect(e.lines.join('\n'), `${e.version} 的英文版里还有汉字`).not.toMatch(/[\u4e00-\u9fa5]/)
  })
})
