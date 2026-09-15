import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pick = ({ desktopVersion, desktopTag, desktopCommit, unitRevision, prerelease }) => ({ desktopVersion, desktopTag, desktopCommit, unitRevision, prerelease })

test('derives the Desktop baseline from git and only refuses a checkout behind the latest release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'unit-baseline-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Unit test')
  git('config', 'user.email', 'unit-test@localhost')
  const packages = async (desktop, engine = desktop) => {
    for (const [name, version] of [['desktop', desktop], ['tangu-agent', engine]]) {
      await mkdir(join(dir, name), { recursive: true })
      await writeFile(join(dir, name, 'package.json'), JSON.stringify({ version }))
    }
  }
  await mkdir(join(dir, 'unit'))
  for (const name of ['check-sync.mjs', 'releasePolicy.mjs']) await cp(new URL(name, import.meta.url), join(dir, 'unit', name))
  await packages('2.10.0')
  git('add', '.')
  git('commit', '-m', 'Desktop 2.10.0')
  const release = git('rev-parse', 'HEAD')
  const check = () => JSON.parse(execFileSync(process.execPath, ['unit/check-sync.mjs'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))

  assert.throws(check, /No Desktop release tag/)
  git('tag', 'v2.10.0')
  assert.deepEqual(pick(check()), { desktopVersion: '2.10.0', desktopTag: 'v2.10.0', desktopCommit: release, unitRevision: 0, prerelease: false })

  await writeFile(join(dir, 'unit/note.txt'), 'after the release')
  git('add', '.')
  git('commit', '-m', 'Unit change after the release')
  assert.equal(check().unitRevision, 1)

  await packages('2.11.0')
  git('commit', '-am', 'Bump Desktop to 2.11.0')
  const bump = check()
  assert.equal(bump.prerelease, true)
  assert.equal(bump.desktopTag, 'v2.10.0')
  assert.equal(bump.desktopVersion, '2.11.0')
  assert.equal(bump.unitRevision, 2)
  git('tag', 'v2.11.0')
  assert.deepEqual(pick(check()), { desktopVersion: '2.11.0', desktopTag: 'v2.11.0', desktopCommit: git('rev-parse', 'HEAD'), unitRevision: 0, prerelease: false })

  git('checkout', '-q', '-b', 'stale', release)
  assert.throws(check, /behind the latest Desktop release v2\.11\.0/)

  await packages('2.10.0', '2.10.1')
  git('commit', '-q', '-am', 'Engine drifted from Desktop')
  assert.throws(check, /same version/)
})
