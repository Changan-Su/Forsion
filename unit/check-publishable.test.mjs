import assert from 'node:assert/strict'
import test from 'node:test'
import { publishBlocker } from './check-publishable.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

test('CI skips npm for exact tagged revision/prerelease artifacts but refuses dirty or mismatched sources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'unit-publish-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'output')
  const run = tag => execFileSync(process.execPath, [fileURLToPath(new URL('check-publishable.mjs', import.meta.url)), root, tag, '--github-output'], { env: { ...process.env, GITHUB_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const version of ['2.12.2+build.1', '2.12.3-beta.1']) {
    const tag = `v${version}`, metadata = { ...release, desktopTag: tag, taggedRelease: true, prerelease: version.includes('-') }
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...pkg, version }))
    await writeFile(join(root, 'release.json'), JSON.stringify(metadata))
    await writeFile(output, '')
    run(tag)
    assert.equal(await readFile(output, 'utf8'), 'publish=false\n')
    assert.match(publishBlocker(metadata, { ...pkg, version }, tag), /artifact-only|pre-release/)
    await writeFile(join(root, 'release.json'), JSON.stringify({ ...metadata, sourceDirty: true }))
    assert.throws(() => run(tag), /exact clean release tag/)
  }
})
