/** Extend's real signed bundle, Electron/IPC and multipart HTTP. Cloud/review is a local fixture;
 * never submits to production. Requires a built Extend and the local Extend signing key. */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert/strict')
const { createPrivateKey } = require('crypto'), { pathToFileURL } = require('url')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs'), { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), EXTEND = path.resolve(ROOT, '../../Forsion-Extend'), OUT = path.join(ROOT, 'outputs/market-submissions')
const lang = process.argv.includes('--en') ? 'en' : 'zh'
const L = lang === 'zh' ? { nav: '投稿', page: '插件投稿', fresh: '新投稿', submit: '提交审核', name: '名称', source: '发布渠道', npm: 'npm 公开包', repo: 'GitHub 公开仓库', zip: 'ZIP 包', version: '版本号', update: '提交新版本', published: '已上架', pending: '待审核', refresh: '刷新', retry: '重试', signin: '登录 Forsion', cancel: '取消', submitted: '投稿已提交', updated: '新版已提交审核', filter: '按状态筛选', dark: '切换明暗模式' } : { nav: 'Submit', page: 'Submissions', fresh: 'New submission', submit: 'Submit for review', name: 'Name', source: 'Source', npm: 'Public npm package', repo: 'Public GitHub repository', zip: 'ZIP archive', version: 'Version', update: 'Submit new version', published: 'Published', pending: 'Pending review', refresh: 'Refresh', retry: 'Retry', signin: 'Sign in to Forsion', cancel: 'Cancel', submitted: 'Submitted.', updated: 'Update submitted for review', filter: 'Filter by status', dark: 'Toggle light/dark mode' }
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url')
const token = `${b64({ alg: 'HS256' })}.${b64({ userId: 'fixture-user', username: 'fixture' })}.fixture`
async function until(fn, name) { const end = Date.now() + 30000; while (!await fn()) { assert.ok(Date.now() < end, `Timed out: ${name}`); await new Promise((r) => setTimeout(r, 100)) } }
async function signedBundle(home) {
  const dir = path.join(home, 'plugins/forsion-extend'); fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  const files = ['package.json', 'manifest.json', 'dist/main.js', 'dist/desktop.mjs']
  for (const f of files) fs.copyFileSync(path.join(EXTEND, f), path.join(dir, f))
  // Only the isolated candidate has a newer version. No repository or installed npm package is changed.
  for (const f of ['package.json', 'manifest.json']) { const p = path.join(dir, f), data = JSON.parse(fs.readFileSync(p)); data.version = '0.7.2-e2e'; fs.writeFileSync(p, JSON.stringify(data)) }
  const privateKey = process.env.EXTEND_SIGNING_KEY || fs.readFileSync(path.join(os.homedir(), '.forsion-dev/secrets/forsion-extend-signing/key.pem'), 'utf8')
  const { signFiles } = await import(pathToFileURL(path.join(EXTEND, 'scripts/signature.mjs')).href)
  const signature = await signFiles(dir, files, createPrivateKey(privateKey)); fs.writeFileSync(path.join(dir, 'SIGNATURE'), JSON.stringify(signature))
}
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-submissions-')), uploads = [], reads = [], appLogs = []
  fs.mkdirSync(OUT, { recursive: true }); await signedBundle(home)
  const items = [
    { id: 'zip', name: 'Canvas helper', summary: lang === 'zh' ? '共享画布操作与快捷指令' : 'Shared canvas actions and shortcuts', type: 'plugin', source: 'zip', status: 'approved', version: '1.0.0', downloads: 23, rejectedUpdate: { version: '1.1.0', note: 'Missing entry file' } },
    { id: 'npm', name: 'Markdown tools', type: 'amadeus-plugin', source: 'npm', status: 'pending', version: '2.0.0' },
    { id: 'gh', name: 'GitHub plugin', type: 'plugin', source: 'github', status: 'rejected', reviewNote: 'Missing manifest' },
    { id: 'waiting', name: 'Waiting plugin', type: 'plugin', source: 'zip', status: 'approved', version: '1.0.0', pendingUpdate: { version: '2.0.0' } },
  ]
  let state = 'ready', rejectNext = false, base, app, win, market, settings
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://fixture').pathname
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (p === '/api/brain/users/me' || p === '/api/auth/me') return send(200, { id: 'fixture-user', username: 'fixture', nickname: 'Fixture', role: 'USER', membershipTier: 'free' })
    if (p === '/api/market/mine' && req.method === 'GET') { reads.push(req.headers.authorization); return state === 'signedout' ? send(401, {}) : state === 'error' ? send(503, { detail: 'Fixture offline' }) : send(200, { items }) }
    if (p === '/api/market/items') return send(200, { items: [] })
    if (p === '/api/market/submit' || /^\/api\/market\/mine\/[^/]+\/update$/.test(p)) {
      const chunks = []; for await (const c of req) chunks.push(c)
      const body = Buffer.concat(chunks), fields = {}, raw = body.toString('utf8')
      for (const m of raw.matchAll(/Content-Disposition: form-data; name="([^"\r\n]+)"\r\n\r\n([\s\S]*?)\r\n--/g)) fields[m[1]] = m[2]
      uploads.push({ p, fields, body, type: String(req.headers['content-type']), auth: req.headers.authorization })
      if (rejectNext) { rejectNext = false; return send(400, { error: 'market_npm_invalid', detail: '中文服务端原因' }) }
      if (p.endsWith('/update')) { items[0].pendingUpdate = { version: fields.version }; delete items[0].rejectedUpdate; return send(200, { id: 'zip', pendingUpdate: true }) }
      const id = `new-${uploads.length}`; items.push({ id, name: fields.name, type: fields.type, source: fields.source, status: 'pending' }); return send(201, { id, status: 'pending' })
    }
    req.resume(); return send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  fs.writeFileSync(path.join(home, 'config.json'), '{}'); fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token, cloudUrl: base }))
  fs.mkdirSync(path.join(home, 'userdata-dev')); fs.writeFileSync(path.join(home, 'userdata-dev/tangu-desktop-config.json'), JSON.stringify({ cloudUrl: base, mode: 'external', unitHostEnabled: false }))
  const stub = await startStubEngine()
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, `--lang=${lang === 'zh' ? 'zh-CN' : 'en-US'}`, ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: base, TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => appLogs.push(String(d)))
    win = await app.firstWindow(); win.setDefaultTimeout(15000); await win.waitForSelector('#root'); await win.waitForTimeout(1200); await skipOnboarding(win)
    assert.equal((await win.evaluate(() => window.tangu.authStatus())).loggedIn, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'plugins/forsion-extend/manifest.json'))).version, '0.7.2-e2e')
    async function panel(kind, params = {}) {
      await win.evaluate(([kind, params]) => window.tangu.openFloatingPanel({ id: kind, title: kind, builtin: kind, params: { ...params, n: Date.now() } }), [kind, params])
      let page; await until(async () => { page = app.windows().find((w) => !w.isClosed() && w.url().includes('window=floating') && w.url().includes(kind)); return !!page }, `${kind} window`)
      page.setDefaultTimeout(15000); return page
    }
    market = await panel('market'); await market.locator('.settings-nav').waitFor()
    // Nav labels are owned by the marketplace host; Extend owns the page itself.
    await market.locator('.settings-nav button').filter({ hasText: lang === 'zh' ? '投稿' : /Submit/ }).click()
    await market.locator('[data-fx-page="submission"] [data-submission-id="zip"]').waitFor()
    assert.equal(await market.locator('[data-plugin-settings="forsion-extend:submission"]').count(), 1)
    assert.equal(await market.locator('[data-submission-id="waiting"] button').count(), 0)
    await market.evaluate(() => document.fonts.ready); await market.screenshot({ path: path.join(OUT, `${lang}-market-light.png`) })
    await market.getByRole('button', { name: L.fresh, exact: true }).click()
    await market.getByLabel(L.name, { exact: true }).fill('Fixture npm plugin'); await market.getByLabel(L.source, { exact: true }).selectOption('npm'); await market.getByLabel(L.npm, { exact: true }).fill('@fixture/plugin')
    await market.screenshot({ path: path.join(OUT, `${lang}-npm-form-light.png`) })
    rejectNext = true; await market.getByRole('button', { name: L.submit, exact: true }).click()
    await market.locator('.fx-msg.is-error').waitFor(); assert.equal(await market.getByLabel(L.name, { exact: true }).inputValue(), 'Fixture npm plugin')
    if (lang === 'en') assert.ok(!(await market.locator('.fx-msg.is-error').innerText()).includes('中文'))
    await market.getByRole('button', { name: L.submit, exact: true }).click(); await market.getByRole('status').filter({ hasText: L.submitted }).waitFor()
    assert.equal(uploads[1].fields.npmPackage, '@fixture/plugin'); assert.equal(uploads[1].fields.source, 'npm'); assert.equal(uploads[1].fields.githubRepoUrl, undefined)
    await market.getByRole('button', { name: L.fresh, exact: true }).click(); await market.getByLabel(L.name, { exact: true }).fill('Fixture GitHub plugin'); await market.getByLabel(L.repo, { exact: true }).fill('https://github.com/fixture/plugin'); await market.getByRole('button', { name: L.submit, exact: true }).click(); await market.getByRole('status').filter({ hasText: L.submitted }).waitFor()
    assert.equal(uploads[2].fields.githubRepoUrl, 'https://github.com/fixture/plugin')
    const zipBytes = Buffer.from([80, 75, 3, 4, 5, 10, 255])
    await market.getByRole('button', { name: L.fresh, exact: true }).click(); await market.getByLabel(L.name, { exact: true }).fill('Fixture ZIP plugin'); await market.getByLabel(L.source, { exact: true }).selectOption('zip'); await market.getByLabel(L.zip, { exact: true }).setInputFiles({ name: 'plugin.zip', mimeType: 'application/zip', buffer: zipBytes }); await market.getByLabel(L.version, { exact: true }).fill('1.0.0'); await market.getByRole('button', { name: L.submit, exact: true }).click(); await market.getByRole('status').filter({ hasText: L.submitted }).waitFor()
    assert.ok(uploads[3].body.includes(zipBytes)); assert.match(uploads[3].type, /^multipart\/form-data/)
    await market.locator('[data-submission-id="zip"]').getByRole('button', { name: L.update, exact: true }).click(); await market.getByLabel(L.zip, { exact: true }).setInputFiles({ name: 'update.zip', mimeType: 'application/zip', buffer: zipBytes }); await market.getByLabel(L.version, { exact: true }).fill('1.2.0'); await market.getByRole('button', { name: L.submit, exact: true }).click(); await market.getByRole('status').filter({ hasText: L.updated }).waitFor()
    assert.equal(uploads[4].p, '/api/market/mine/zip/update'); assert.equal(uploads[4].fields.summary, ''); assert.ok(uploads[4].body.includes(zipBytes))
    assert.ok(uploads.every((u) => u.auth === `Bearer ${token}`)); assert.ok(reads.every((a) => a === `Bearer ${token}`))
    settings = await panel('settings', { tab: 'forsion/fx:forsion-extend:submission' }); await settings.locator('[data-fx-page="submission"] [data-submission-id="zip"]').waitFor()
    assert.ok((await settings.locator('[data-submission-id="zip"]').innerText()).includes('1.2.0'))
    await settings.screenshot({ path: path.join(OUT, `${lang}-settings-light.png`) })
    await settings.close(); settings = null
    await market.getByLabel(L.filter, { exact: true }).selectOption('pending')
    await market.getByRole('button', { name: L.fresh, exact: true }).click(); await market.getByLabel(L.source, { exact: true }).selectOption('zip')
    await market.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('id=market')); w.setSize(780, 780) })
    await market.setViewportSize({ width: 780, height: 780 }); await market.screenshot({ path: path.join(OUT, `${lang}-zip-form-dark-narrow.png`) })
    const overflow = await market.locator('.mk-body').evaluate((el) => el.scrollWidth > el.clientWidth + 1); assert.equal(overflow, false)
    await market.getByRole('button', { name: L.cancel, exact: true }).click()
    state = 'error'; await market.getByRole('button', { name: L.refresh, exact: true }).click(); await market.getByRole('button', { name: L.retry, exact: true }).waitFor(); assert.ok((await market.locator('.fx-error-state').innerText()).includes('Fixture offline'))
    state = 'ready'; await market.getByRole('button', { name: L.retry, exact: true }).click(); await market.locator('[data-submission-id="zip"]').waitFor()
    state = 'signedout'; await market.getByRole('button', { name: L.refresh, exact: true }).click(); await market.locator('.fx-signin-body').waitFor(); assert.equal(await market.locator('.fx-sub-form').count(), 0)
    console.log(`PASS ${lang}: signed Extend/native shared page, my submissions/review reasons/filter, GitHub/npm/ZIP create + ZIP update via real IPC/multipart with exact bytes and private credentials, settings reflects update, error retry, signed-out, light/dark/narrow; ${OUT}`)
  } catch (e) { if (market && !market.isClosed()) await market.screenshot({ path: path.join(OUT, `${lang}-failed.png`) }).catch(() => {}); throw e }
  finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r)); await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
