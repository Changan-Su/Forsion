import assert from 'node:assert/strict'
import test from 'node:test'
import { publishBlocker } from './check-publishable.mjs'

const release = { desktopTag: 'v2.12.2', unitRevision: 0, prerelease: false, sourceDirty: false }
const pkg = { name: '@forsion/unit', version: '2.12.2' }

test('the tagged release build is publishable', () => {
  assert.equal(publishBlocker(release, pkg, 'v2.12.2'), null)
})

test('a build from main shares the release version and must not be published', () => {
  assert.match(publishBlocker({ ...release, unitRevision: 165, prerelease: true }, pkg, 'v2.12.2'), /pre-release/)
  // Version already bumped past the tag: revision 0 is impossible, but prerelease alone must still block.
  assert.match(publishBlocker({ ...release, prerelease: true }, { ...pkg, version: '2.12.3' }, 'v2.12.2'), /pre-release/)
})

test('dirty checkouts, foreign tags and foreign packages are refused', () => {
  assert.match(publishBlocker({ ...release, sourceDirty: true }, pkg, 'v2.12.2'), /uncommitted/)
  assert.match(publishBlocker(release, pkg, 'v2.12.3'), /does not match/)
  assert.match(publishBlocker(release, pkg, 'v2.12.2-beta.1'), /does not match/)
  assert.match(publishBlocker(release, { ...pkg, name: '@forsion/extend' }, 'v2.12.2'), /package name/)
})
