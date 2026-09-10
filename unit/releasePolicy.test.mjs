import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSourcePaths, checkBundleInputs, validateDistribution } from './releasePolicy.mjs'

test('rejects commercial source paths while allowing the local engine and generic host', () => {
  checkSourcePaths(['unit/backendWorker.ts', 'tangu-agent/src/routes/admin.ts', 'desktop/shared/unitPreferences.ts'])
  for (const path of ['server/src/index.ts', 'unit/plugins/server-admin/main.js', 'desktop/plugins/forsion-plugin-server-admin/main.js', 'unit/microserver/billing/index.ts']) {
    assert.throws(() => checkSourcePaths([path]), /Commercial Server/)
  }
})

test('actual bundle graphs cannot import sibling commercial application code', () => {
  checkBundleInputs(['/checkout/Genesis/unit/main.ts', '\0virtual:react', '/dependencies/node_modules/react/index.js'], '/checkout/Genesis')
  assert.throws(() => checkBundleInputs(['../server/src/unitPlugin.ts'], '/checkout/Genesis'), /outside Genesis/)
  assert.throws(() => checkBundleInputs(['/checkout/Genesis/unit/plugins/server-admin/main.js'], '/checkout/Genesis'), /Commercial Server/)
  assert.throws(() => checkBundleInputs(['/dependencies/node_modules/forsion-backend-service/index.js'], '/checkout/Genesis'), /Commercial Server/)
})

test('rejects stale commercial packages, hidden credentials, symlinks and disguised backend packages in release output', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'unit-release-policy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const file of ['main.mjs', 'backendWorker.mjs', 'package.json', 'release.json']) await writeFile(join(dir, file), '{}')
  await validateDistribution(dir)
  await mkdir(join(dir, 'plugins/calendar'), { recursive: true })
  await writeFile(join(dir, 'plugins/calendar/manifest.json'), JSON.stringify({ id: 'calendar' }))
  await validateDistribution(dir)
  await mkdir(join(dir, 'plugins/server-admin'))
  await assert.rejects(validateDistribution(dir), /Commercial Server/)
  await rm(join(dir, 'plugins/server-admin'), { recursive: true })
  await writeFile(join(dir, 'plugins/calendar/.env'), 'FIXTURE_ONLY')
  await assert.rejects(validateDistribution(dir), /Private configuration/)
  await rm(join(dir, 'plugins/calendar/.env'))
  await symlink(join(dir, 'package.json'), join(dir, 'plugins/calendar/external.json'))
  await assert.rejects(validateDistribution(dir), /self-contained/)
  await rm(join(dir, 'plugins/calendar/external.json'))
  await writeFile(join(dir, 'plugins/calendar/manifest.json'), JSON.stringify({ id: 'calendar', backend: { main: 'private.mjs' } }))
  await assert.rejects(validateDistribution(dir), /Unexpected bundled plugin/)
})
