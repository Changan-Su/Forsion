import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkUnitUpstream } from './check-unit-upstream.mjs'
const fixture = (override = {}) => async (url) => {
  const data = {
    '/web/unit/meta': { projection: 'public', version: '2.13.6', account: {}, capabilities: { amadeus: {}, tangu: {} } },
    '/web/unit/plugins': { plugins: [{ id: 'forsion-extend', version: '0.9.3', locked: true, code: 'verified' }] },
    '/web/unit/spaces': { spaces: [{ slug: 'penzor', json: '{}' }] }, ...override,
  }[url.pathname]
  return new Response(JSON.stringify(data), { status: data === null ? 404 : 200 })
}
test('requires the actual public account, signed Extend and cloud drive before a gateway switch', async () => {
  assert.equal((await checkUnitUpstream('https://unit.test', fixture())).ok, true)
  for (const patch of [
    { '/web/unit/meta': null },
    { '/web/unit/meta': { projection: 'public' } },
    { '/web/unit/plugins': { plugins: [] } },
    { '/web/unit/plugins': { plugins: [{ id: 'server-admin' }] } },
    { '/web/unit/spaces': { spaces: [] } },
  ]) await assert.rejects(checkUnitUpstream('https://unit.test', fixture(patch)))
})
