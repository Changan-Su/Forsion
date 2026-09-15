import { describe, expect, it } from 'vitest'
import { gatePluginManifest } from '../../shared/amadeus/ipc'
import { APP_VERSION, latestReleasedVersion, parseChangelog } from './changelog'
import { version } from '../../package.json'

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
})
