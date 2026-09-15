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
  git('tag', 'v2.9.0') // older release on the same commit: numeric ordering, not lexicographic ("v2.9.0" > "v2.10.0" as strings)
  assert.equal(check().desktopTag, 'v2.10.0')

  await writeFile(join(dir, 'unit/note.txt'), 'after the release')
  git('add', '.')
  git('commit', '-m', 'Unit change after the release')
  assert.deepEqual([check().unitRevision, check().prerelease], [1, true]) // same version, different source: not the release build

  await packages('2.11.0')
  git('commit', '-am', 'Bump Desktop to 2.11.0')
  const bump = check()
  assert.equal(bump.prerelease, true)
  assert.equal(bump.desktopTag, 'v2.10.0')
  assert.equal(bump.desktopVersion, '2.11.0')
  assert.equal(bump.unitRevision, 2)
  git('tag', '-a', 'v2.11.0', '-m', 'Desktop 2.11.0') // annotated: ^{commit} must peel it
  const current = git('rev-parse', 'HEAD')
  assert.deepEqual(pick(check()), { desktopVersion: '2.11.0', desktopTag: 'v2.11.0', desktopCommit: current, unitRevision: 0, prerelease: false })

  git('branch', 'hotfix', release)
  git('tag', 'v2.10.1', 'hotfix') // a lower release outside HEAD's history is not drift
  assert.equal(check().desktopTag, 'v2.11.0')

  await packages('2.10.5')
  git('commit', '-q', '-am', 'Package versions fell behind the tag')
  assert.throws(check, /behind the baseline tag v2\.11\.0/)
  git('reset', '-q', '--hard', current)

  const shallow = `${dir}-shallow`
  t.after(() => rm(shallow, { recursive: true, force: true }))
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${dir}`, shallow], { stdio: 'ignore' })
  assert.throws(() => execFileSync(process.execPath, ['unit/check-sync.mjs'], { cwd: shallow, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /Shallow clone/)

  git('checkout', '-q', '-b', 'stale', release)
  assert.throws(check, /behind the latest Desktop release v2\.11\.0/)

  await packages('2.10.0', '2.10.1')
  git('commit', '-q', '-am', 'Engine drifted from Desktop')
  assert.throws(check, /same version/)
})
