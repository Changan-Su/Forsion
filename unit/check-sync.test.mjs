import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('detects a newer Desktop tag and refuses a baseline bump without merging its commit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'unit-upstream-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'desktop')
  git('config', 'user.name', 'Unit test')
  git('config', 'user.email', 'unit-test@localhost')
  const packages = async (version) => {
    for (const name of ['desktop', 'tangu-agent']) {
      await mkdir(join(dir, name), { recursive: true })
      await writeFile(join(dir, name, 'package.json'), JSON.stringify({ version }))
    }
  }
  await packages('2.10.0')
  git('add', '.')
  git('commit', '-m', 'Desktop baseline')
  const oldCommit = git('rev-parse', 'HEAD')
  git('tag', 'v2.10.0')
  git('checkout', '-b', 'unit')
  await mkdir(join(dir, 'unit'))
  for (const name of ['check-sync.mjs', 'releasePolicy.mjs']) await cp(new URL(name, import.meta.url), join(dir, 'unit', name))
  const baseline = async (version, commit) => writeFile(join(dir, 'unit/upstream.json'), JSON.stringify({
    desktopVersion: version, desktopTag: `v${version}`, desktopCommit: commit, unitRevision: 1,
  }))
  await baseline('2.10.0', oldCommit)
  git('add', '.')
  git('commit', '-m', 'Independent Unit')
  const check = () => execFileSync(process.execPath, ['unit/check-sync.mjs'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(JSON.parse(check()).desktopCommit, oldCommit)
  git('checkout', 'desktop')
  await packages('2.11.0')
  git('commit', '-am', 'New Desktop release')
  const nextCommit = git('rev-parse', 'HEAD')
  git('tag', 'v2.11.0')
  git('checkout', 'unit')
  assert.throws(check, /Unit needs synchronization/)
  await baseline('2.11.0', nextCommit)
  await packages('2.11.0')
  assert.throws(check, /merge-base --is-ancestor/)
  await packages('2.10.0')
  await baseline('2.10.0', oldCommit)
  git('merge', '--no-ff', 'desktop', '-m', 'Synchronize Desktop')
  await baseline('2.11.0', nextCommit)
  assert.equal(JSON.parse(check()).desktopVersion, '2.11.0')
})
