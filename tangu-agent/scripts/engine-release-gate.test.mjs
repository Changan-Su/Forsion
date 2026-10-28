import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cmp, desktopProblems, hotUpdateDistTag, hotUpdateProblems, runGate } from './engine-release-gate.mjs'

const desktop = { desktop: '2.13.6', engine: '3.0.0', ref: 'v2.13.6', newestPublished: '2.13.6', previousEngine: '2.13.5' }
test('desktop may share its number with a published engine; engine may be above or below desktop', () => {
  assert.deepEqual(desktopProblems(desktop), [])
  assert.deepEqual(desktopProblems({ ...desktop, desktop: '9.0.0', ref: 'v9.0.0' }), [])
})
test('same engine version may be reused unchanged, but never with different sources', () => {
  const same = { ...desktop, engine: '2.13.6', sameVersionBaseline: 'tangu-v2.13.6', engineChanged: false }
  assert.deepEqual(desktopProblems(same), [])
  assert.match(desktopProblems({ ...same, engineChanged: true }).join(), /bump the engine version only/)
})
test('unknown reused versions, downgrades and wrong desktop tags are rejected', () => {
  assert.match(desktopProblems({ ...desktop, engine: '2.13.6' }).join(), /no verified/)
  assert.match(desktopProblems({ ...desktop, previousEngine: '3.1.0' }).join(), /downgrade/)
  assert.match(desktopProblems({ ...desktop, ref: 'v2.13.7' }).join(), /does not match/)
})
const hot = { version: '2.0.1', baseEngine: '2.0.0', baseDesktop: '8.0.0', ref: 'tangu-v2.0.1', publish: true, dependenciesMatch: true, schemaChanges: [], newestPublished: '2.0.0', distTag: 'latest' }
test('hot update compares against baseline engine, not independently higher shell', () => {
  assert.deepEqual(hotUpdateProblems(hot), [])
  assert.match(hotUpdateProblems({ ...hot, baseEngine: '2.0.2' }).join(), /not newer than bundled engine/)
})
test('independent numbering retains tag, npm, dependencies and schema guards', () => {
  assert.match(hotUpdateProblems({ ...hot, ref: 'tangu-v8.0.1' }).join(), /does not match/)
  assert.match(hotUpdateProblems({ ...hot, newestPublished: '2.0.1' }).join(), /already published/)
  assert.match(hotUpdateProblems({ ...hot, dependenciesMatch: false }).join(), /dependencies/)
  assert.match(hotUpdateProblems({ ...hot, schemaChanges: ['src/db/migrate.ts'] }).join(), /migration/)
})

const roots = []
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })))
function fixture(shell = '8.0.0', engine = '2.0.0', extra = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'independent-release-')); roots.push(repo)
  const root = path.join(repo, 'tangu-agent')
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
  const write = (file, data) => { const dest = path.join(repo, file); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, data) }
  const pkg = version => JSON.stringify({ name: '@forsion/tangu-agent', version, dependencies: { express: '1.0.0' } })
  write('desktop/package.json', JSON.stringify({ version: shell }))
  write('tangu-agent/package.json', pkg(engine))
  write('tangu-agent/src/main.ts', 'export const initial = true\n')
  for (const [file, data] of Object.entries(extra)) write(file, data)
  git('init'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Release fixture')
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'base'); git('tag', `v${shell}`); git('remote', 'add', 'origin', repo)
  return { repo, root, git, write, pkg }
}
test('real git baseline produces distinct minimum desktop and manual engine versions', () => {
  const f = fixture(), output = path.join(f.repo, 'output')
  f.write('tangu-agent/package.json', f.pkg('2.0.1'))
  runGate(f.root, ['main', 'workflow_dispatch'], { GITHUB_OUTPUT: output })
  assert.match(readFileSync(output, 'utf8'), /base=8.0.0\nbase_engine=2.0.0\npack_version=2.0.0\npublish=false\ndist_tag=latest\n/)
  runGate(f.root, ['tangu-v2.0.1', 'push'], {}, { readPublishedVersion: () => '2.0.0' })
  f.write('tangu-agent/src/db/migrate.ts', 'export const schema = 2\n')
  f.git('add', '.'); f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'new migration')
  assert.throws(() => runGate(f.root, ['tangu-v2.0.1', 'push'], {}, { readPublishedVersion: () => '2.0.0' }), /migration files changed/)
})
test('candidate desktop tag cannot hide changed sources under an already bundled engine number', () => {
  const f = fixture(), registry = { readPublishedVersion: () => '2.0.0' }
  f.write('desktop/package.json', JSON.stringify({ version: '8.0.1' }))
  f.git('add', '.'); f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'shell only'); f.git('tag', 'v8.0.1')
  runGate(f.root, ['--desktop-release', 'v8.0.1'], {}, registry)
  f.write('tangu-agent/src/main.ts', 'export const initial = false\n')
  assert.throws(() => runGate(f.root, ['--desktop-release', 'v8.0.1'], {}, registry), /bump the engine version only/)
})
test('desktop-number hot-update tag is unrelated to a new engine identity', () => {
  const f = fixture('2.13.5', '2.13.5')
  f.git('tag', 'tangu-v2.13.6')
  f.write('desktop/package.json', JSON.stringify({ version: '2.13.6' }))
  f.write('tangu-agent/package.json', f.pkg('2.13.7'))
  runGate(f.root, ['--desktop-release', 'v2.13.6'], {}, { readPublishedVersion: () => '2.13.6' })
})

test('installer prereleases retain independent versions and proper version ordering', () => {
  assert.deepEqual(desktopProblems({ ...desktop, desktop: '2.13.6-beta.1', ref: 'v2.13.6-beta.1', engine: '3.0.0-beta.1' }), [])
  assert.equal(cmp('3.0.0-beta.10', '3.0.0-beta.2'), 1)
  assert.equal(cmp('3.0.0-beta.1', '3.0.0'), -1)
  assert.equal(cmp('3.0.0', '3.0.0-beta.1'), 1)
})

test('desktop revisions keep their own ordering and do not become engine npm identities', () => {
  assert.deepEqual(desktopProblems({ ...desktop, desktop: '2.13.7+build.2', ref: 'v2.13.7+build.2' }), [])
  assert.equal(cmp('2.13.7+build.10', '2.13.7+build.2'), 1)
  assert.match(desktopProblems({ ...desktop, engine: '3.0.0+build.1' }).join(), /no build metadata/)
  const f = fixture('8.0.0+build.2')
  f.write('tangu-agent/package.json', f.pkg('2.0.1'))
  runGate(f.root, ['tangu-v2.0.1', 'push'], {}, { readPublishedVersion: () => '2.0.0' })
  const metadataHost = fixture('8.0.0+sha.a-b')
  metadataHost.write('tangu-agent/package.json', metadataHost.pkg('2.0.1'))
  runGate(metadataHost.root, ['tangu-v2.0.1', 'push'], {}, { readPublishedVersion: () => '2.0.0' })
})

test('new desktop releases ignore old tags from before the engine directory existed', () => {
  const f = fixture('2.13.5', '2.13.5')
  f.git('rm', '-r', 'tangu-agent'); f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'legacy layout'); f.git('tag', 'v2.2.4')
  f.git('checkout', 'v2.13.5', '--', 'tangu-agent')
  f.write('desktop/package.json', JSON.stringify({ version: '2.13.6' }))
  f.write('tangu-agent/package.json', f.pkg('2.13.7'))
  runGate(f.root, ['--desktop-release', 'v2.13.6'], {}, { readPublishedVersion: () => '2.13.6' })
})
test('hotfix from an older desktop cannot reuse a newer installer-only engine identity', () => {
  const f = fixture(), registry = { readPublishedVersion: () => '2.0.1' }
  f.write('desktop/package.json', JSON.stringify({ version: '8.1.0' }))
  f.write('tangu-agent/package.json', f.pkg('3.0.0'))
  f.git('add', '.'); f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'new desktop'); f.git('tag', 'v8.1.0')
  f.git('checkout', '--detach', 'v8.0.0')
  f.write('tangu-agent/package.json', f.pkg('3.0.0'))
  assert.throws(() => runGate(f.root, ['tangu-v3.0.0', 'push'], {}, registry), /already shipped in a desktop installer/)
})

test('each publish targets one dist-tag: own line when the installer reads it, latest only for legacy stable lines', () => {
  assert.equal(hotUpdateDistTag('2.13.9', true), 'desktop-2.13.9')
  assert.equal(hotUpdateDistTag('2.13.9-beta.1', true), 'desktop-2.13.9-beta.1')
  assert.equal(hotUpdateDistTag('2.13.9+build.2', true), 'desktop-2.13.9')
  assert.equal(hotUpdateDistTag('2.13.7', false), 'latest')
  assert.equal(hotUpdateDistTag('2.13.8-beta.2', false), null)
  assert.match(hotUpdateProblems({ ...hot, baseDesktop: '2.13.8-beta.2', distTag: null }).join(), /only reads the latest dist-tag/)
})
test('a hotfix cut from a beta installer uses that beta as its line and baseline', () => {
  const line = { 'desktop/shared/engineLine.mjs': 'export {}\n' }
  const f = fixture('8.1.0-beta.1', '2.0.0', line), output = path.join(f.repo, 'output')
  f.write('tangu-agent/package.json', f.pkg('2.0.1'))
  runGate(f.root, ['tangu-v2.0.1', 'push'], { GITHUB_OUTPUT: output }, { readPublishedVersion: () => '2.0.0' })
  assert.match(readFileSync(output, 'utf8'), /base=8.1.0-beta.1\n.*publish=true\ndist_tag=desktop-8.1.0-beta.1\n/s)
  const revision = fixture('8.1.0+build.2', '2.0.0', line), revisionOut = path.join(revision.repo, 'output')
  revision.write('tangu-agent/package.json', revision.pkg('2.0.1'))
  runGate(revision.root, ['tangu-v2.0.1', 'push'], { GITHUB_OUTPUT: revisionOut }, { readPublishedVersion: () => '2.0.0' })
  assert.match(readFileSync(revisionOut, 'utf8'), /base=8.1.0\n.*dist_tag=desktop-8.1.0\n/s) // the original 8.1.0 build must accept it too
  const prereleaseEngine = fixture('8.1.0-beta.1', '2.0.0-beta.1', line)
  prereleaseEngine.write('tangu-agent/package.json', prereleaseEngine.pkg('2.0.1'))
  assert.throws(() => runGate(prereleaseEngine.root, ['tangu-v2.0.1', 'push'], {}, { readPublishedVersion: () => '2.0.0' }), /only replace a stable bundled engine/)
  const legacy = fixture('8.1.0-beta.1')
  legacy.write('tangu-agent/package.json', legacy.pkg('2.0.1'))
  assert.throws(() => runGate(legacy.root, ['tangu-v2.0.1', 'push'], {}, { readPublishedVersion: () => '2.0.0' }), /only reads the latest dist-tag/)
})
