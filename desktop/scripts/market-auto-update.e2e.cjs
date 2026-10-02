/** Real Electron/IPC/filesystem/managed engine. Public market + zip/GitHub/npm archives are local fixtures.
 * The periodic tick is invoked through the same check IPC. Native dialog responses and final app relaunch are intercepted.
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert/strict')
const { execFileSync } = require('child_process'), { createHash } = require('crypto'), JSZip = require('jszip')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'outputs', 'market-auto-update')
const lang = process.argv.includes('--en') ? 'en' : 'zh'
const labels = lang === 'zh' ? { installed: '已安装', option: '自动更新', restart: '重启更新', later: '稍后重启', dark: '切换明暗模式' } : { installed: 'Installed', option: 'Auto-update', restart: 'Restart to update', later: 'Restart later', dark: 'Toggle light/dark mode' }
async function until(check, description) {
  const deadline = Date.now() + 45000
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${description}`); await new Promise((r) => setTimeout(r, 100)) }
}
function packageFiles(id, type, version) {
  if (type === 'plugin') return {
    'tangu-plugin.json': JSON.stringify({ id, name: id, version, apiVersion: 1, entry: 'index.mjs' }),
    'index.mjs': `export default { activate(ctx) { ctx.registerPlugin({ id: '${id}', name: '${id}', description: 'Auto update fixture' }); ctx.registerRoutes(({userRouter}) => userRouter.get('/agent/auto-update-fixture', (_req,res) => res.json({version:'${version}'}))) } }`,
  }
  return { 'manifest.json': JSON.stringify({ id, name: id, version, apiVersion: 1 }), 'main.js': `window.__autoUpdateVersions = { ...window.__autoUpdateVersions, '${id}': '${version}' }` }
}
function writeFiles(dir, files) { fs.mkdirSync(dir, { recursive: true }); for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content) }
async function archive(home, item, version) {
  const files = packageFiles(item.installSlug, item.type, version)
  if (item.source !== 'npm') { const zip = new JSZip(); for (const [name, content] of Object.entries(files)) zip.file(name, content); return zip.generateAsync({ type: 'nodebuffer' }) }
  const temp = path.join(home, 'tar-fixture'); fs.rmSync(temp, { recursive: true, force: true })
  writeFiles(path.join(temp, 'package'), { ...files, 'package.json': JSON.stringify({ name: '@fixture/market-plugin', version }) })
  const tar = path.join(home, 'package.tgz'); execFileSync('tar', ['--format=ustar', '-czf', tar, '-C', temp, 'package'])
  return fs.readFileSync(tar)
}
async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), 'Run npm run build first'); fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-market-auto-')), userData = path.join(home, 'userdata')
  const items = [
    { id: 'ui-zip', name: 'ZIP Plugin', type: 'amadeus-plugin', installSlug: 'ui-zip', source: 'zip' },
    { id: 'engine-github', name: 'GitHub Plugin', type: 'plugin', installSlug: 'engine-github', source: 'github' },
    { id: 'ui-npm', name: 'npm Plugin', type: 'amadeus-plugin', installSlug: 'ui-npm', source: 'npm' },
  ].map((x) => ({ ...x, latestVersion: '1.0.0', author: 'Fixture author', summary: 'Automatic update test fixture', downloads: 0, tags: [] }))
  const archives = {}, downloads = {}
  for (const item of items) writeFiles(path.join(home, item.type === 'plugin' ? 'tangu/plugins' : 'plugins', item.installSlug), packageFiles(item.installSlug, item.type, '1.0.0'))
  fs.mkdirSync(path.join(home, 'plugins-data')); fs.writeFileSync(path.join(home, 'plugins-data', 'ui-zip.json'), '{"preference":"kept"}')
  fs.writeFileSync(path.join(home, 'config.json'), '{"plugins":{"global":{"engine-github":{"__enabled":true,"custom":"kept"}}}}')
  let base, app, win, panel
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture')
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body) }
    if (u.pathname === '/api/market/items') return send(200, { items: items.filter((x) => !u.searchParams.get('type') || x.type === u.searchParams.get('type')) })
    const match = /^\/api\/market\/items\/([^/]+)(\/install)?$/.exec(u.pathname)
    if (match) {
      const item = items.find((x) => x.id === match[1]); if (!item) return send(404, {})
      if (!match[2]) return send(200, { ...item, readme: '# Fixture plugin' })
      const npm = item.source === 'npm' ? { npmPackage: '@fixture/market-plugin', version: item.latestVersion, integrity: `sha512-${createHash('sha512').update(archives[item.id]).digest('base64')}` } : {}
      return send(200, { type: item.type, installSlug: item.installSlug, source: item.source, downloadUrl: `${base}/archive/${item.id}`, ...npm })
    }
    const dl = /^\/archive\/([^/]+)$/.exec(u.pathname)
    if (dl && archives[dl[1]]) { downloads[dl[1]] = (downloads[dl[1]] || 0) + 1; return send(200, archives[dl[1]], 'application/octet-stream') }
    return send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  fs.mkdirSync(`${userData}-dev`); fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', cloudUrl: base, unitHostEnabled: false }))
  const env = { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: base }; delete env.TANGU_BACKEND_URL
  async function launch() {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, `--lang=${lang === 'zh' ? 'zh-CN' : 'en-US'}`, ROOT], cwd: ROOT, env, timeout: 60000 })
    win = await app.firstWindow(); win.setDefaultTimeout(15000); await win.waitForSelector('#root'); await win.waitForTimeout(1000)
    for (const label of ['跳过引导', 'Skip onboarding', 'Skip']) { const skip = win.getByRole('button', { name: label, exact: true }); if (await skip.count()) await skip.click() }
    await win.waitForSelector('.rb'); await until(async () => (await win.evaluate(() => window.tangu.backendStatus())).state === 'ready', 'managed engine ready')
    // Redirect the official npm archive URL to our local bytes; SHA-512 and all unpacking still use real product code.
    await app.evaluate(({ net }, base) => {
      const original = net.fetch.bind(net); globalThis.__originalMarketFetch = original
      net.fetch = (url, init) => String(url).startsWith('https://registry.npmjs.org/@fixture/market-plugin/-/') ? original(`${base}/archive/ui-npm`, init) : original(url, init)
    }, base)
  }
  async function openMarket() {
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'market', title: 'Market', builtin: 'market', params: { n: Date.now() } }))
    await until(async () => { panel = app.windows().find((w) => w.url().includes('window=floating') && !w.isClosed()); return !!panel && await panel.locator('.mk-body').count() }, 'market panel')
    panel.setDefaultTimeout(15000); await panel.getByRole('button', { name: labels.installed, exact: true }).click(); await panel.locator('[data-market-auto-update="ui-zip"] input').waitFor()
    await panel.evaluate(() => document.fonts.ready)
  }
  try {
    await launch(); await openMarket()
    assert.equal(await panel.locator('[data-market-auto-update] input:checked').count(), 0)
    await win.evaluate(() => window.tangu.marketCheckUpdates()); assert.deepEqual(downloads, {})
    for (const item of items) await panel.locator(`[data-market-auto-update="${item.id}"] input`).check()
    await until(async () => (await win.evaluate(() => window.tangu.marketUpdateStatus())).items.filter((x) => x.autoUpdate).length === 3, 'preferences persist')
    await panel.locator('[data-market-auto-update="ui-zip"] input').uncheck()
    await until(async () => !(await win.evaluate(() => window.tangu.marketUpdateStatus())).items.find((x) => x.id === 'ui-zip').autoUpdate, 'unchecked preference')
    await panel.locator('[data-market-auto-update="ui-zip"] input').check()
    await until(async () => !(await win.evaluate(() => window.tangu.marketUpdateStatus())).checking, 'initial check completes')
    await panel.locator('.mk-card-title', { hasText: 'ZIP Plugin' }).click(); await panel.locator('.mk-detail-sidebar').waitFor()
    assert.equal(await panel.locator('[data-market-auto-update="ui-zip"] input:checked').count(), 1)
    await panel.close(); panel = null
    for (const item of items) { item.latestVersion = '1.1.0'; archives[item.id] = await archive(home, item, '1.1.0') }
    await win.evaluate(() => window.tangu.marketCheckUpdates())
    const state = await win.evaluate(() => window.tangu.marketUpdateStatus())
    assert.equal(state.items.filter((x) => x.pendingVersion === '1.1.0' && x.phase === 'staged').length, 3, JSON.stringify(state))
    assert.deepEqual(downloads, { 'ui-zip': 1, 'engine-github': 1, 'ui-npm': 1 })
    for (const item of items) {
      const root = path.join(home, item.type === 'plugin' ? 'tangu/plugins' : 'plugins', item.installSlug)
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, item.type === 'plugin' ? 'tangu-plugin.json' : 'manifest.json'))).version, '1.0.0')
    }
    await win.locator('[data-restart-update]').waitFor()
    await win.locator('.ntf').filter({ hasText: 'ZIP Plugin 1.1.0' }).waitFor()
    await win.evaluate(() => window.tangu.marketCheckUpdates()); assert.equal(Object.values(downloads).reduce((a,b) => a+b, 0), 3)
    assert.equal(await win.locator('.ntf').filter({ hasText: 'ZIP Plugin 1.1.0' }).count(), 1)
    await openMarket(); assert.equal(await panel.locator('[data-market-auto-update] input:checked').count(), 3)
    await panel.waitForTimeout(400); await panel.screenshot({ path: path.join(OUT, `${lang}-installed-light.png`), animations: 'disabled' })
    await panel.locator('.mk-card-title', { hasText: 'ZIP Plugin' }).click(); await panel.locator('.mk-detail-sidebar').waitFor()
    await panel.screenshot({ path: path.join(OUT, `${lang}-detail-light.png`), animations: 'disabled' })
    await panel.locator('.mk-detail-back').click()
    await win.getByRole('button', { name: labels.dark, exact: true }).click()
    await panel.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=floating')); w.setMinimumSize(560, 500); w.setSize(720, 680) })
    await panel.waitForTimeout(400); await panel.screenshot({ path: path.join(OUT, `${lang}-installed-dark-narrow.png`), animations: 'disabled' })
    assert.ok(await panel.evaluate(() => document.querySelector('.settings-main').scrollWidth <= document.querySelector('.settings-main').clientWidth + 1))
    // Restart from inside the market reaches the same busy-task confirmation as the pinned button.
    await app.evaluate(({ app, dialog }) => {
      const originalFetch = globalThis.fetch
      const state = globalThis.__marketRestart = { originalFetch, originalDialog: dialog.showMessageBox, originalQuit: app.quit.bind(app), originalRelaunch: app.relaunch.bind(app), response: 0, dialogs: [], quit: 0, relaunch: 0 }
      globalThis.fetch = (url, init) => String(url).endsWith('/agent/remote/restart-status') ? Promise.resolve(new Response(JSON.stringify({ tasks: 2, processes: 0 }))) : originalFetch(url, init)
      dialog.showMessageBox = async (_win, options) => { state.dialogs.push(options); return { response: state.response, checkboxChecked: false } }
      app.quit = () => { state.quit++ }; app.relaunch = () => { state.relaunch++ }
    })
    await panel.locator('.mk-card').filter({ hasText: 'ZIP Plugin' }).getByRole('button', { name: labels.restart, exact: true }).click()
    await until(() => app.evaluate(() => globalThis.__marketRestart.dialogs.length === 1), 'busy restart dialog')
    assert.equal(await app.evaluate(() => globalThis.__marketRestart.dialogs[0].buttons[0]), labels.later)
    assert.equal(await app.evaluate(() => globalThis.__marketRestart.quit), 0)
    assert.equal((await win.evaluate(() => window.tangu.backendStatus())).state, 'ready')
    await panel.close(); panel = null
    await app.evaluate(() => { globalThis.__marketRestart.response = 1 })
    await win.locator('[data-restart-update]').click(); await until(() => app.evaluate(() => globalThis.__marketRestart.quit === 1), 'restart requested')
    assert.equal((await win.evaluate(() => window.tangu.backendStatus())).state, 'stopped')
    await app.evaluate(({ app, dialog, net }) => { const s = globalThis.__marketRestart; app.quit = s.originalQuit; app.relaunch = s.originalRelaunch; dialog.showMessageBox = s.originalDialog; globalThis.fetch = s.originalFetch; net.fetch = globalThis.__originalMarketFetch })
    await app.close(); app = null
    await launch()
    const applied = await win.evaluate(() => window.tangu.marketUpdateStatus())
    assert.equal(applied.items.filter((x) => x.installedVersion === '1.1.0' && x.autoUpdate && !x.pendingVersion).length, 3, JSON.stringify(applied))
    assert.equal(await win.locator('[data-restart-update]').count(), 0)
    for (const item of items) {
      const root = path.join(home, item.type === 'plugin' ? 'tangu/plugins' : 'plugins', item.installSlug)
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, item.type === 'plugin' ? 'tangu-plugin.json' : 'manifest.json'))).version, '1.1.0')
    }
    const backend = await win.evaluate(() => window.tangu.backendStatus())
    const route = await fetch(`${backend.url}/agent/auto-update-fixture`, { headers: { Authorization: `Bearer ${backend.token}` } })
    assert.equal((await route.json()).version, '1.1.0')
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'plugins-data/ui-zip.json'))).preference, 'kept')
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'))).plugins.global['engine-github'].custom, 'kept')
    await openMarket(); assert.equal(await panel.locator('[data-market-auto-update] input:checked').count(), 3)
    await panel.locator('[data-market-auto-update="ui-zip"] input').uncheck()
    await win.evaluate(() => window.tangu.marketUninstall('amadeus-plugin', 'ui-npm'))
    assert.equal((await win.evaluate(() => window.tangu.marketUpdateStatus())).items.some((x) => x.id === 'ui-npm'), false)
    console.log(`PASS ${lang}: per-plugin opt-in/card/detail, real zip/GitHub/npm download + integrity pipeline, closed-market staging, notification dedupe, task cancellation/force, restart activation, real engine route, persisted choices and preserved data; ${OUT}`)
  } catch (error) {
    console.log('Update state:', await win?.evaluate(() => window.tangu.marketUpdateStatus()).catch(() => null))
    if (panel) await panel.screenshot({ path: path.join(OUT, `${lang}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    if (app) {
      await app.evaluate(({ app, dialog, net }) => { const s = globalThis.__marketRestart; if (s) { app.quit = s.originalQuit; app.relaunch = s.originalRelaunch; dialog.showMessageBox = s.originalDialog; globalThis.fetch = s.originalFetch } if (globalThis.__originalMarketFetch) net.fetch = globalThis.__originalMarketFetch }).catch(() => {})
      await app.close()
    }
    await new Promise((r) => server.close(r)); fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
