import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revisionFixture } from './lib/update-fixture.mjs'
import { isNewer, parseReleaseVersion } from '../../desktop/shared/releaseVersion.mjs'

for (const [installed, expected, beta] of [
  ['2.13.7', '2.13.7+build.1', false],
  ['2.13.7+build.9', '2.13.7+build.10', false],
  ['2.13.8-rc.1', '2.13.8-rc.1+build.1', true],
  ['2.13.8-beta.1+build.2', '2.13.8-beta.1+build.3', true],
]) test(`generates an eligible revision fixture for ${installed}`, () => {
  const next = revisionFixture(installed)
  assert.deepEqual(next, { version: expected, beta })
  assert.ok(parseReleaseVersion(next.version))
  assert.equal(isNewer(next.version, installed), true)
})
