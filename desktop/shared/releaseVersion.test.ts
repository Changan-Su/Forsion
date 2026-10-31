import { expect, it } from 'vitest'
import { compareReleaseVersions, isNewer, isPrerelease, isRevisionUpgrade, parseReleaseVersion } from './releaseVersion.mjs'

it('orders reserved revisions numerically after their base, before the next core version', () => {
  const ordered = ['2.13.7-beta.1', '2.13.7-rc.1', '2.13.7', '2.13.7+build.1', '2.13.7+build.2', '2.13.7+build.10', '2.13.8-beta.1', '2.13.8']
  for (let i = 1; i < ordered.length; i++) {
    expect(isNewer(ordered[i], ordered[i - 1])).toBe(true)
    expect(isNewer(ordered[i - 1], ordered[i])).toBe(false)
  }
  expect(isRevisionUpgrade('2.13.7+build.10', '2.13.7+build.2')).toBe(true)
  expect(isRevisionUpgrade('2.13.8', '2.13.7')).toBe(false)
  expect(isPrerelease('2.13.7+build.1')).toBe(false)
  expect(isPrerelease('2.13.7-build-1')).toBe(true)
})

it('keeps SemVer prerelease precedence, including very large numeric identifiers', () => {
  expect(compareReleaseVersions('1.0.0-99999999999999999999', '1.0.0-100000000000000000000')).toBe(-1)
  expect(compareReleaseVersions('1.0.0-99999999999999999999', '1.0.0-a')).toBe(-1)
  expect(isNewer('2.13.8-beta.1+build.2', '2.13.8-beta.1+build.1')).toBe(true)
  expect(isNewer('2.13.8-beta.2', '2.13.8-beta.1+build.999')).toBe(true)
  expect(isPrerelease('2.13.8-beta.1+build.2')).toBe(true)
})

it('ignores other metadata and accepts a tag prefix without misclassifying metadata hyphens', () => {
  expect(compareReleaseVersions('2.13.7+sha.a-b', 'v2.13.7')).toBe(0)
  expect(compareReleaseVersions('2.13.7+build.0', '2.13.7')).toBe(0)
  expect(isPrerelease('2.13.7+sha.a-b')).toBe(false)
  expect(parseReleaseVersion(' v2.13.8-rc.1+build.2 ')?.version).toBe('2.13.8-rc.1+build.2')
})

it.each(['', '2.13', '2.13.6.1', '2.013.7', '2.13.7-beta.01', '2.13.7-beta..1', '2.13.7+build', '2.13.7+build.x', '2.13.7+build.01', '2.13.7+build.1.extra', '2.13.7+build.9007199254740992', '9007199254740992.0.0', '2.13.7/evil'])('refuses malformed or unsafe release identity %s', version => {
  expect(parseReleaseVersion(version)).toBeNull()
  expect(isNewer(version, '2.13.7')).toBe(false)
})
