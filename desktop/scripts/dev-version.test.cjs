const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { inspectVersions } = require('./dev-version.check.cjs')

test('checks Desktop and engine against their own identities, including combined prerelease/revision headings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dev-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [component, version] of [['desktop', '2.13.8-rc.1+build.2'], ['tangu-agent', '3.0.0']]) {
    const dir = join(root, component)
    await mkdir(dir)
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version }))
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }))
  }
  const desktop = join(root, 'desktop')
  await writeFile(join(desktop, 'CHANGELOG.md'), '## Unreleased\n- WIP\n## 2.13.8-rc.1+build.2 (2026-10-22)\n- Preview')
  assert.deepEqual((await inspectVersions(desktop)).errors, [])
  await writeFile(join(root, 'tangu-agent/package-lock.json'), JSON.stringify({ version: '2.13.8', packages: { '': { version: '2.13.8' } } }))
  assert.equal((await inspectVersions(desktop)).errors.length, 2)
  await writeFile(join(desktop, 'CHANGELOG.md'), '## 2.13.8.1\n- Invalid')
  assert.match((await inspectVersions(desktop)).errors.join(), /CHANGELOG.md/)
})
