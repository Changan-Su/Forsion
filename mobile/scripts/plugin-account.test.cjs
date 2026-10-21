const assert = require('node:assert/strict')
const path = require('node:path')
const { build } = require('esbuild')
;(async () => {
  const code = (await build({ entryPoints: [path.resolve(__dirname, '../src/pluginAccount.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })).outputFiles[0].text
  const mod = { exports: {} }; new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  const { createMobileAccount, accountApiUrl } = mod.exports
  for (const url of ['https://evil.test/api/drive', 'https://cloud.test/auth', 'https://user:pass@cloud.test/api/drive', '/../../auth', 'file:///api/drive']) assert.equal(accountApiUrl('https://cloud.test/api', url), null, url)
  assert.equal(accountApiUrl('https://cloud.test/api', '/drive'), 'https://cloud.test/api/drive')
  assert.equal(accountApiUrl('https://cloud.test/api', 'https://cloud.test/api/drive?x=1'), 'https://cloud.test/api/drive?x=1')
  let token = 'old-token', auth, last, mode = 'ok', done
  const account = createMobileAccount({ cloudApiBase: () => 'https://cloud.test/api', token: () => token,
    status: async () => ({ loggedIn: !!token, userId: 7, token: 'must not escape', username: 'legacy-account' }),
    login: async () => {}, logout: async () => {}, onAuthChanged: (cb) => { auth = cb; return () => {} }, saveDownload: async () => ({ ok: true }),
    fetch: async (url, init) => { last = { url, init }; if (mode === 'wait') return new Promise((resolve) => { done = resolve }); return new Response('legacy file bytes') },
  })
  assert.deepEqual(await account.status(), { loggedIn: true, cloudUrl: 'https://cloud.test/api', userId: '7', username: 'legacy-account' })
  const body = new FormData(); body.append('file', new Blob(['old content']), 'legacy.txt')
  await account.request('/drive/upload', { method: 'POST', body, headers: { Authorization: 'attacker', Cookie: 'attacker' }, credentials: 'include', redirect: 'follow' })
  assert.equal(last.init.body, body); assert.equal(last.init.headers.get('Authorization'), 'Bearer old-token'); assert.equal(last.init.headers.get('Cookie'), null)
  assert.equal(last.init.credentials, 'omit'); assert.equal(last.init.redirect, 'error'); assert.equal(last.init.headers.has('Content-Type'), false)
  let statusEvents = []; account.subscribe((s) => statusEvents.push(s))
  mode = 'wait'; const pending = account.request('/drive')
  token = ''; auth(); assert(last.init.signal.aborted); assert.deepEqual(statusEvents[0], { loggedIn: false })
  done(new Response('old account data')); await assert.rejects(pending, /Account changed/)
  const noAuth = await account.request('/drive'); assert.equal(noAuth.status, 401)
  token = 'new-token'; auth(); mode = 'ok'; await account.request('/drive'); assert.equal(last.init.headers.get('Authorization'), 'Bearer new-token')
  const unread = await account.request('/files/legacy/content'); token = ''; auth(); await assert.rejects(unread.text(), /Account changed/)
  token = 'clone-account'; auth(); const original = await account.request('/files/legacy/content'); const clone = original.clone(); await original.text(); token = ''; auth(); await assert.rejects(clone.text(), /Account changed/)
  console.log('PASS mobile account: API containment, multipart preservation, host headers, old-account identity, logout abort and stale response rejection, token replacement')
})().catch((e) => { console.error(e); process.exitCode = 1 })
