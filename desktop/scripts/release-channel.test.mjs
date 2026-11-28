import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseFlags } from './release-channel.mjs'

test('numeric revisions can become latest while backfills and downgrades never replace it', () => {
  assert.equal(releaseFlags('v2.13.7+build.10', 'v2.13.7+build.2'), '--latest')
  assert.equal(releaseFlags('v2.13.7+build.1', 'v2.14.0'), '--latest=false')
  assert.equal(releaseFlags('v2.13.7+build.1', 'v2.13.7+build.2'), '--latest=false')
  assert.equal(releaseFlags('v2.13.7', 'v2.13.7'), '--latest')
  assert.equal(releaseFlags('v2.13.7+sha.foo', 'v2.13.7'), '--latest=false')
})
test('only prerelease identifiers mark previews; metadata hyphens do not', () => {
  assert.equal(releaseFlags('v2.14.0-rc.1+build.1', 'v2.13.7'), '--prerelease --latest=false')
  assert.equal(releaseFlags('v2.13.8+sha.a-b', 'v2.13.7'), '--latest')
  assert.throws(() => releaseFlags('v2.13.7.1', 'v2.13.7'), /Invalid/)
  assert.throws(() => releaseFlags('v2.13.8', 'unknown'), /Invalid/)
})
test('test channel = prerelease tags only (the Android local-engine launcher ships there first)', async () => {
  const { isTestChannel } = await import('./release-channel.mjs')
  assert.equal(isTestChannel('v2.15.0-beta.1'), true)
  assert.equal(isTestChannel('v2.15.0-rc.1+build.3'), true)
  assert.equal(isTestChannel('v2.15.0'), false)
  assert.equal(isTestChannel('v2.13.8+sha.a-b'), false)
  assert.throws(() => isTestChannel('nope'), /Invalid/)
})
