/** Extend's real signed bundle, Electron/IPC and multipart HTTP. Cloud/review is a local fixture that answers `?dryRun=1`
 * the way the server does (checks only, nothing saved); never submits to production. Requires a built desktop
 * (`npm run build`, reads out/), a built Extend that has the split submission page (0.9.4+), and the local Extend signing key.
 * Extend defaults to ../../Forsion-Extend; set EXTEND_DIR to use another checkout. `--en` runs the English UI. */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert/strict')
const { createPrivateKey } = require('crypto'), { pathToFileURL } = require('url')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs'), { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), EXTEND = path.resolve(process.env.EXTEND_DIR || path.join(ROOT, '../../Forsion-Extend')), OUT = path.join(ROOT, 'outputs/market-submissions')
const lang = process.argv.includes('--en') ? 'en' : 'zh'
const L = lang === 'zh'
  ? { fresh: '新投稿', submit: '提交审核', name: '名称', summary: '简介', npm: 'npm 公开包', repo: 'GitHub 公开仓库', submitted: '投稿已提交', updated: '新版本已提交审核', info: '修改已提交审核', edit: '编辑', submitInfo: '提交修改', checkNew: '检查新版本', ver: (v) => `提交 v${v} 审核`, pendingAll: /^待审核 \d+$/, refresh: '刷新', retry: '重试', cancel: '取消', back: '返回列表', pendingVer: (v) => `v${v} 更新待审核` }
  : { fresh: 'New submission', submit: 'Submit for review', name: 'Name', summary: 'Summary', npm: 'Public npm package', repo: 'Public GitHub repository', submitted: 'Submitted.', updated: 'Update submitted for review', info: 'Changes submitted for review', edit: 'Edit', submitInfo: 'Submit changes', checkNew: 'Check for a new version', ver: (v) => `Submit v${v} for review`, pendingAll: /^Pending review \d+$/, refresh: 'Refresh', retry: 'Retry', cancel: 'Cancel', back: 'Back to list', pendingVer: (v) => `v${v} update pending review` }
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url')
const token = `${b64({ alg: 'HS256' })}.${b64({ userId: 'fixture-user', username: 'fixture' })}.fixture`
async function until(fn, name) { const end = Date.now() + 30000; while (!await fn()) { assert.ok(Date.now() < end, `Timed out: ${name}`); await new Promise((r) => setTimeout(r, 100)) } }
async function signedBundle(home) {
  const dir = path.join(home, 'plugins/forsion-extend'); fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  const files = ['package.json', 'manifest.json', 'dist/main.js', 'dist/desktop.mjs']
  for (const f of files) fs.copyFileSync(path.join(EXTEND, f), path.join(dir, f))
  // Only the isolated candidate has a newer version. No repository or installed npm package is changed.
  for (const f of ['package.json', 'manifest.json']) { const p = path.join(dir, f), data = JSON.parse(fs.readFileSync(p)); data.version = '99.0.0-e2e'; fs.writeFileSync(p, JSON.stringify(data)) }
  const privateKey = process.env.EXTEND_SIGNING_KEY || fs.readFileSync(path.join(os.homedir(), '.forsion-dev/secrets/forsion-extend-signing/key.pem'), 'utf8')
  const { signFiles } = await import(pathToFileURL(path.join(EXTEND, 'scripts/signature.mjs')).href)
  const signature = await signFiles(dir, files, createPrivateKey(privateKey)); fs.writeFileSync(path.join(dir, 'SIGNATURE'), JSON.stringify(signature))
}
async function main() {
  assert.ok(fs.readFileSync(path.join(EXTEND, 'dist/main.js'), 'utf8').includes('fx-sub-split'), `Extend at ${EXTEND} has no split submission page: build a 0.9.4+ checkout or set EXTEND_DIR`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-submissions-')), uploads = [], reads = [], appLogs = []
  fs.mkdirSync(OUT, { recursive: true }); await signedBundle(home)
  const zh = lang === 'zh'
  const items = [
    { id: 'zip', name: 'Paper Digest', summary: zh ? '读论文时把摘录、结论和引用整理成一页笔记。' : 'Turns paper excerpts into a one-page note.', type: 'skill', source: 'zip', status: 'approved', version: '1.1.0', downloads: 46, tags: ['research'], createdAt: '2026-10-11T08:00:00Z', versions: [{ version: '1.1.0', createdAt: '2026-10-20T08:00:00Z' }, { version: '1.0.0', createdAt: '2026-10-11T09:00:00Z' }], rejectedUpdate: { kind: 'zip', version: '1.0.5', note: 'Missing entry file' } },
    { id: 'gh', name: 'Focus Timer', summary: zh ? '番茄钟与专注记录，在右栏里开始、暂停和回看。' : 'Pomodoro and focus log in the right panel.', type: 'plugin', source: 'github', githubRepoUrl: 'https://github.com/fixture/focus-timer', status: 'approved', version: '0.2.1', downloads: 128, platforms: ['desktop'], createdAt: '2026-09-17T08:00:00Z', versions: [{ version: '0.2.1', createdAt: '2026-10-02T08:00:00Z' }] },
    { id: 'npm', name: 'Table Helper', summary: zh ? 'Markdown 表格排序、对齐与 CSV 互转。' : 'Sort, align and convert Markdown tables.', type: 'amadeus-plugin', source: 'npm', npmPackage: '@fixture/table-helper', status: 'approved', version: '2.0.3', downloads: 311 },
    { id: 'rejected', name: 'Daily Review', type: 'skill', source: 'zip', status: 'rejected', version: '0.1.0', reviewNote: zh ? 'SKILL.md 缺少 description，触发条件写清楚后再投。' : 'SKILL.md has no description. Say when it should trigger, then resubmit.' },
    { id: 'waiting', name: 'Waiting plugin', type: 'plugin', source: 'zip', status: 'approved', version: '1.0.0', pendingUpdate: { kind: 'zip', version: '2.0.0' } },
  ]
  const byId = (id) => items.find((it) => it.id === id)
  let state = 'ready', rejectNext = false, base, app, win, market, settings
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fixture'), p = u.pathname, dry = u.searchParams.get('dryRun') === '1'
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (p === '/api/brain/users/me' || p === '/api/auth/me') return send(200, { id: 'fixture-user', username: 'fixture', nickname: 'Fixture', role: 'USER', membershipTier: 'free' })
    if (p === '/api/market/mine' && req.method === 'GET') { reads.push(req.headers.authorization); return state === 'signedout' ? send(401, {}) : state === 'error' ? send(503, { detail: 'Fixture offline' }) : send(200, { items, dryRun: true }) }
    if (p === '/api/market/items') return send(200, { items: [] })
    const update = p.match(/^\/api\/market\/mine\/([^/]+)\/update$/)
    if (p === '/api/market/submit' || update) {
      const chunks = []; for await (const c of req) chunks.push(c)
      const body = Buffer.concat(chunks), fields = {}, raw = body.toString('utf8')
      for (const m of raw.matchAll(/Content-Disposition: form-data; name="([^"\r\n]+)"\r\n\r\n([\s\S]*?)\r\n--/g)) fields[m[1]] = m[2]
      uploads.push({ p, dry, fields, body, zip: raw.includes('name="zip"'), type: String(req.headers['content-type']), auth: req.headers.authorization })
      if (rejectNext) { rejectNext = false; return send(400, { error: 'market_npm_invalid', detail: '中文服务端原因' }) }
      const report = { icon: false, readme: true, metadata: {}, warnings: [] }
      if (update) {
        const it = byId(update[1])
        if (fields.mode === 'info') { if (dry) return send(200, { dryRun: true, kind: 'info' }); it.pendingUpdate = { kind: 'info', version: it.version }; return send(200, { id: it.id, pendingUpdate: true }) }
        const next = it.source === 'github' ? '0.3.0' : '1.2.0'
        if (dry) return send(200, it.source === 'zip' ? { id: it.id, dryRun: true, kind: 'zip', version: next, current: it.version, manifest: { file: 'SKILL.md', type: 'skill', name: 'paper-digest' }, ...report } : { id: it.id, dryRun: true, kind: 'remote', version: next, tag: `v${next}`, current: it.version })
        it.pendingUpdate = { kind: it.source === 'zip' ? 'zip' : 'remote', version: next }; delete it.rejectedUpdate; return send(200, { id: it.id, pendingUpdate: true })
      }
      if (dry) return send(200, { dryRun: true, kind: 'zip', version: '1.0.0', current: null, manifest: { file: 'tangu-plugin.json', type: 'plugin', name: 'Fixture ZIP plugin' }, ...report })
      const id = `new-${uploads.length}`; items.unshift({ id, name: fields.name, type: fields.type, source: fields.source, status: 'pending' }); return send(201, { id, status: 'pending' })
    }
    req.resume(); return send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  fs.writeFileSync(path.join(home, 'config.json'), '{}'); fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token, cloudUrl: base }))
  fs.mkdirSync(path.join(home, 'userdata-dev')); fs.writeFileSync(path.join(home, 'userdata-dev/tangu-desktop-config.json'), JSON.stringify({ cloudUrl: base, mode: 'external', unitHostEnabled: false }))
  const stub = await startStubEngine()
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, `--lang=${zh ? 'zh-CN' : 'en-US'}`, ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: base, TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => appLogs.push(String(d)))
    win = await app.firstWindow(); win.setDefaultTimeout(15000); await win.waitForSelector('#root'); await win.waitForTimeout(1200); await skipOnboarding(win)
    assert.equal((await win.evaluate(() => window.tangu.authStatus())).loggedIn, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'plugins/forsion-extend/manifest.json'))).version, '99.0.0-e2e')
    async function panel(kind, params = {}) {
      await win.evaluate(([kind, params]) => window.tangu.openFloatingPanel({ id: kind, title: kind, builtin: kind, params: { ...params, n: Date.now() } }), [kind, params])
      let page; await until(async () => { page = app.windows().find((w) => !w.isClosed() && w.url().includes('window=floating') && w.url().includes(kind)); return !!page }, `${kind} window`)
      page.setDefaultTimeout(15000); return page
    }
    const resize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('id=market')).setContentSize(w, h) }, [w, h])
    market = await panel('market'); await market.locator('.settings-nav').waitFor(); await resize(1280, 900)
    // Nav labels are owned by the marketplace host; Extend owns the page itself.
    await market.locator('.settings-nav button').filter({ hasText: zh ? '投稿' : /Submit/ }).click()
    const page = market.locator('[data-fx-page="submission"]'), detail = page.locator('[data-detail-id]'), drop = page.locator('.fx-sub-drop input[type=file]')
    const pick = (id) => page.locator(`[data-submission-id="${id}"]`).click()
    const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor()
    await page.locator('[data-submission-id="zip"]').waitFor()
    assert.equal(await market.locator('[data-plugin-settings="forsion-extend:submission"]').count(), 1)
    await market.evaluate(() => document.fonts.ready)
    // 一条在审的更新:没有换包入口,「编辑」也锁着
    await pick('waiting'); await detail.filter({ hasText: L.pendingVer('2.0.0') }).waitFor()
    assert.equal(await drop.count(), 0); assert.equal(await detail.getByRole('button', { name: L.edit, exact: true }).isDisabled(), true)

    // ZIP 条目换包:先检查(?dryRun=1,同一份字节),再「提交 v1.2.0 审核」
    const zipBytes = Buffer.from([80, 75, 3, 4, 5, 10, 255])
    await pick('zip'); await drop.setInputFiles({ name: 'paper-digest-1.2.0.zip', mimeType: 'application/zip', buffer: zipBytes })
    await page.locator('.fx-sub-checks').waitFor()
    assert.ok((await page.locator('.fx-sub-checks').innerText()).includes('v1.1.0 → v1.2.0'))
    await market.screenshot({ path: path.join(OUT, `${lang}-zip-check-light.png`) })
    let last = uploads.at(-1); assert.equal(last.p, '/api/market/mine/zip/update'); assert.equal(last.dry, true); assert.ok(last.body.includes(zipBytes)); assert.deepEqual(last.fields, {})
    await page.getByRole('button', { name: L.ver('1.2.0'), exact: true }).click(); await status(L.updated)
    last = uploads.at(-1); assert.equal(last.dry, false); assert.ok(last.body.includes(zipBytes)); assert.equal(uploads.length, 2)
    await detail.filter({ hasText: L.pendingVer('1.2.0') }).waitFor(); assert.equal(await detail.getAttribute('data-detail-id'), 'zip')

    // GitHub 条目:检查上游 → 上游框 → 提交;不传包
    await pick('gh'); await page.getByRole('button', { name: L.checkNew, exact: true }).click(); await page.locator('.fx-sub-upstream').waitFor()
    assert.ok((await page.locator('.fx-sub-upstream').innerText()).includes('v0.3.0'))
    await market.screenshot({ path: path.join(OUT, `${lang}-github-check-light.png`) })
    await page.getByRole('button', { name: L.ver('0.3.0'), exact: true }).click(); await status(L.updated)
    assert.ok(uploads.slice(-2).every((u) => u.p === '/api/market/mine/gh/update' && !u.zip)); assert.deepEqual(uploads.slice(-2).map((u) => u.dry), [true, false])

    // 只改信息:mode=info,只带改过的字段
    await pick('npm'); await detail.getByRole('button', { name: L.edit, exact: true }).click()
    await page.getByLabel(L.summary, { exact: true }).fill('Sort and align Markdown tables.'); await page.getByRole('button', { name: L.submitInfo, exact: true }).click(); await status(L.info)
    assert.deepEqual(uploads.at(-1).fields, { mode: 'info', summary: 'Sort and align Markdown tables.' })

    // 新投稿:npm 先被拒(输入保留、不显示中文原因),再提交;GitHub;ZIP 先检查、名称从包里带出
    await page.getByRole('button', { name: L.fresh, exact: true }).click()
    await page.getByRole('radio', { name: 'npm', exact: true }).click(); await page.getByLabel(L.name, { exact: true }).fill('Fixture npm plugin'); await page.getByLabel(L.npm, { exact: true }).fill('@fixture/plugin')
    rejectNext = true; await page.getByRole('button', { name: L.submit, exact: true }).click()
    await page.locator('.fx-msg.is-error').waitFor(); assert.equal(await page.getByLabel(L.name, { exact: true }).inputValue(), 'Fixture npm plugin')
    if (!zh) assert.ok(!(await page.locator('.fx-msg.is-error').innerText()).includes('中文'))
    await page.getByRole('button', { name: L.submit, exact: true }).click(); await status(L.submitted)
    last = uploads.at(-1); assert.equal(last.fields.npmPackage, '@fixture/plugin'); assert.equal(last.fields.source, 'npm'); assert.equal(last.fields.githubRepoUrl, undefined)
    await page.getByRole('button', { name: L.fresh, exact: true }).click(); await page.getByRole('radio', { name: 'GitHub', exact: true }).click()
    await page.getByLabel(L.name, { exact: true }).fill('Fixture GitHub plugin'); await page.getByLabel(L.repo, { exact: true }).fill('https://github.com/fixture/plugin'); await page.getByRole('button', { name: L.submit, exact: true }).click(); await status(L.submitted)
    assert.equal(uploads.at(-1).fields.githubRepoUrl, 'https://github.com/fixture/plugin')
    await page.getByRole('button', { name: L.fresh, exact: true }).click(); await drop.setInputFiles({ name: 'plugin.zip', mimeType: 'application/zip', buffer: zipBytes })
    await page.locator('.fx-sub-checks').waitFor(); assert.equal(await page.getByLabel(L.name, { exact: true }).inputValue(), 'Fixture ZIP plugin')
    last = uploads.at(-1); assert.equal(last.p, '/api/market/submit'); assert.equal(last.dry, true); assert.deepEqual(last.fields, { source: 'zip' })
    await market.screenshot({ path: path.join(OUT, `${lang}-new-zip-light.png`) })
    await page.getByRole('button', { name: L.submit, exact: true }).click(); await status(L.submitted)
    last = uploads.at(-1); assert.equal(last.dry, false); assert.ok(last.body.includes(zipBytes)); assert.match(last.type, /^multipart\/form-data/); assert.equal(last.fields.version, undefined)
    assert.ok(uploads.every((u) => u.auth === `Bearer ${token}`)); assert.ok(reads.every((a) => a === `Bearer ${token}`))

    // 设置里的同一页看到同一份数据
    settings = await panel('settings', { tab: 'forsion/fx:forsion-extend:submission' }); await settings.locator('[data-fx-page="submission"] [data-submission-id="zip"]').waitFor()
    assert.ok((await settings.locator('[data-submission-id="zip"]').innerText()).includes('1.2.0'))
    await settings.screenshot({ path: path.join(OUT, `${lang}-settings-light.png`) })
    await settings.close(); settings = null

    // 筛选 + 深色 + 窄:单列,列表 ↔ 详情,无横向滚动
    await page.getByRole('radio', { name: L.pendingAll }).click()
    await market.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    // 宽屏上点过条目 → 变窄后接着看那一条;「返回列表」回到列表
    await resize(430, 860); await market.waitForTimeout(400)
    assert.equal(await detail.isVisible(), true); assert.equal(await page.locator('.fx-sub-list').isVisible(), false)
    await page.getByRole('button', { name: L.back, exact: true }).click()
    assert.equal(await page.locator('.fx-sub-list').isVisible(), true); assert.equal(await detail.isVisible(), false)
    await market.screenshot({ path: path.join(OUT, `${lang}-list-dark-narrow.png`) })
    await pick('zip'); await page.getByRole('button', { name: L.back, exact: true }).waitFor(); assert.equal(await page.locator('.fx-sub-list').isVisible(), false)
    await market.screenshot({ path: path.join(OUT, `${lang}-detail-dark-narrow.png`) })
    const overflow = await market.locator('.mk-body').evaluate((el) => el.scrollWidth > el.clientWidth + 1); assert.equal(overflow, false)
    await resize(1280, 900)

    state = 'error'; await page.getByRole('button', { name: L.refresh, exact: true }).click(); await market.getByRole('button', { name: L.retry, exact: true }).waitFor(); assert.ok((await market.locator('.fx-error-state').innerText()).includes('Fixture offline'))
    state = 'ready'; await market.getByRole('button', { name: L.retry, exact: true }).click(); await page.locator('[data-submission-id="zip"]').waitFor()
    state = 'signedout'; await page.getByRole('button', { name: L.refresh, exact: true }).click(); await market.locator('.fx-signin-body').waitFor(); assert.equal(await market.locator('.fx-sub-split').count(), 0)
    console.log(`PASS ${lang}: signed Extend split page; ZIP update + new ZIP checked first (?dryRun=1, same bytes) then submitted; GitHub upstream check + submit without a package; details-only edit sends changed fields; npm/GitHub create with localized errors; settings mirrors; filter, dark, narrow list↔detail without overflow; error retry; signed-out; ${OUT}`)
  } catch (e) { if (market && !market.isClosed()) await market.screenshot({ path: path.join(OUT, `${lang}-failed.png`) }).catch(() => {}); console.error(appLogs.slice(-20).join('')); throw e }
  finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r)); await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
