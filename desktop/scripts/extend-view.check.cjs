/** Real Electron + disk-loaded server-admin + real core-models panel bytes.
 * API data is isolated in a local fixture server; never touches a real admin account.
 * Run: npm run build && npm run check:extendview. Screenshots: /tmp/forsion-extend-shots.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('url')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const REPO = path.resolve(ROOT, '../..')
const PLUGIN = process.env.SERVER_ADMIN_PLUGIN || path.join(REPO, 'Forsion-Instrumentality-Project/forsion-plugin-server-admin')
const SERVER = process.env.FORSION_SERVER_DIR || path.join(REPO, 'server')
const SHOTS = process.env.EXTEND_SHOTS || '/tmp/forsion-extend-shots'
const GROUPS_ONLY = process.argv.includes('--groups-only')
const passed = (message) => console.log('PASS  ' + message)
async function closeNativeExtension(win) {
  await win.locator('.wb-tab[data-transient="true"]').click({ button: 'right' })
  await win.locator('.ctx-menu button').filter({ hasText: /^\s*(关闭|Close)\s*$/ }).click()
}

async function main() {
  // All five core-* panels are served from disk; each fixture's mocks are active only while that app is open (activeApp).
  const APPS = [
    { appId: 'core-admin', displayName: '用户与会员', displayNameEn: 'Users & Membership' },
    { appId: 'core-billing', displayName: '计费与商店', displayNameEn: 'Billing & Shop' },
    { appId: 'core-incentive', displayName: '奖励与码', displayNameEn: 'Rewards & Codes' },
    { appId: 'core-models', displayName: '模型与用量', displayNameEn: 'Models & Usage' },
    { appId: 'core-platform', displayName: '平台设置', displayNameEn: 'Platform' },
  ]
  const fixtures = {}
  for (const a of APPS) fixtures[a.appId] = (await import(pathToFileURL(path.join(SERVER, `microserver/${a.appId}/admin/e2e.fixture.mjs`)).href)).default
  if (GROUPS_ONLY) {
    const mocks = fixtures['core-models'].mocks
    mocks.find((m) => m.path === '/api/admin/model-catalog').body = { groups: [{ id: 'core', name: '常用模型', sortOrder: 0 }, { id: 'preview', name: '预览模型', sortOrder: 1 }], multiplierBaseline: null }
    mocks.find((m) => m.path === '/api/admin/models').body.forEach((m, i) => { if (i < 4) { m.groupId = i < 2 ? 'core' : 'preview'; m.groupName = i < 2 ? '常用模型' : '预览模型' } })
    mocks.find((m) => m.path === '/api/admin/model-providers').body = [{ id: 'sf', name: 'SiliconFlow', kind: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelCount: 0, lastStatus: { models: { status: 'ok', count: 96 }, balance: { status: 'error', detail: 'Provider returned HTTP 410' } } }]
  }
  // core-admin's fixture is a stub (its assertions live in the plugin e2e); the same minimal data set gives its tables rows here.
  fixtures['core-admin'].mocks = [
    { path: '/api/admin/users', body: [
      { id: 'u1', username: 'admin', email: 'root@x.io', role: 'ADMIN', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'u2', username: 'alice', email: 'alice@x.io', role: 'USER', status: 'active', createdAt: '2026-02-01T00:00:00Z' },
    ] },
    { path: '/api/admin/membership/users', body: [{ userId: 'u2', tier: 'pro', status: 'active', expiresAt: '2026-12-31T00:00:00Z' }] },
    { path: '/api/admin/membership/plans', body: [{ id: 'plan-1', name: 'Pro 月付', tier: 'pro', isActive: true, dailyTokenLimit: 50000, weeklyTokenLimit: -1, pointsBonusMonthly: 10, pointsBonusQuarterly: 35, pointsBonusYearly: 150 }] },
    { path: /^\/api\/admin\/users\/[^/]+\/avatar$/, body: { avatar: null } },
  ]
  let activeApp = 'core-models'
  const mutations = []
  let failSave = false, holdNextSave = false, heldSave = null
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    const panelMatch = /^\/api\/apps\/([\w-]+)\/admin\/panel\.js$/.exec(p)
    if (p === '/admin/panel-lib.js' || (panelMatch && fixtures[panelMatch[1]])) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(fs.readFileSync(path.join(SERVER, p === '/admin/panel-lib.js' ? 'admin/panel-lib.js' : `microserver/${panelMatch[1]}/admin/panel.js`)))
      return
    }
    if (p === '/api/apps') return json({ apps: APPS.map((a) => ({ ...a, adminPanel: { enabled: true, mode: 'js-bundle', entry: 'panel.js', navLabel: a.displayName } })) })
    const mock = fixtures[activeApp].mocks.find((m) => (m.method || 'GET') === req.method && (m.path instanceof RegExp ? m.path.test(p) : m.path === p))
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const rec = { path: p, method: req.method, body, authorization: req.headers.authorization }
    if (req.method !== 'GET') mutations.push(rec)
    if (failSave && req.method === 'POST' && p === '/api/admin/models') return json({ detail: 'Fixture save failed' }, 500)
    if (holdNextSave && req.method === 'PUT' && p.startsWith('/api/admin/models/')) {
      holdNextSave = false; heldSave = () => json({ success: true }); return
    }
    if (mock) return json(typeof mock.body === 'function' ? mock.body(rec) : mock.body, mock.status || 200)
    return json({})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const stub = await startStubEngine()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-extend-'))
  const pluginDir = path.join(home, 'plugins/server-admin')
  fs.mkdirSync(pluginDir, { recursive: true })
  for (const name of ['manifest.json', 'main.js', 'README.md', 'CHANGELOG.md', 'icon.png']) {
    if (fs.existsSync(path.join(PLUGIN, name))) fs.copyFileSync(path.join(PLUGIN, name), path.join(pluginDir, name))
  }
  fs.cpSync(path.join(PLUGIN, 'spaces'), path.join(pluginDir, 'spaces'), { recursive: true })
  // Navigation probes only; mounting still goes through the real plugin bridge and workbench.
  fs.appendFileSync(path.join(pluginDir, 'main.js'), '\nwindow.__serverExtend = { models: () => panelListSource.open({ key: "app:core-models" }), open: (id) => panelListSource.open({ key: "app:" + id }), overview: openOverview };\n')
  fs.mkdirSync(path.join(home, 'plugins-data'), { recursive: true })
  fs.writeFileSync(path.join(home, 'plugins-data/server-admin.json'), JSON.stringify({ origin, token: 'fixture-admin', approvedOrigins: [origin] }))
  // A second disk plugin exercises the public surface, all edges and rule/command entry points.
  const probeDir = path.join(home, 'plugins/extend-probe')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({ id: 'extend-probe', name: 'Extend probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(probeDir, 'main.js'), `
    const p = window.__extendProbe = { mounts: 0, cleanups: 0, view: null, open: () => ctx.openView('main'), close: () => ctx.openView('other') };
    ctx.registerView({ id: 'main', title: 'Extend probe', mount(el, view) {
      p.view = view; el.innerHTML = '<button>Owner content</button>';
      return () => { p.old = view.extendView; p.view = null; };
    } });
    ctx.registerView({ id: 'side', title: 'Existing right view', mount(el) { el.innerHTML = '<input aria-label="Sidebar draft">'; p.sideElement = el; } });
    p.openSide = () => ctx.openView('side', { location: 'right' });
    ctx.registerView({ id: 'other', title: 'Other view', mount(el) { el.textContent = 'Other content'; } });
    const run = (args) => p.view.extendView.open({ id: 'probe-' + args.side, side: args.side, title: 'Extension ' + args.side,
      mount(el) { p.mounts++; el.innerHTML = '<input aria-label="Draft"><button>Save draft</button>'; return () => { p.cleanups++; }; } });
    const invoke = { description: 'Open the transient probe editor on an explicit edge.', params: { type: 'object', properties: { side: { type: 'string', enum: ['left','right','bottom'] } }, required: ['side'] }, run };
    ctx.registerCommand({ id: 'extend', title: 'Extend probe editor', invoke, run: () => run({ side: 'right' }) });
    p.invoke = invoke.run;
  `)
  fs.mkdirSync(SHOTS, { recursive: true })
  let app, win
  const errors = []
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(String(e)))
    await win.waitForSelector('#root', { timeout: 40000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.getByRole('button', { name: label, exact: true }).first()
      if (await b.count()) { await b.click(); break }
    }
    await win.waitForFunction(() => !!window.__serverExtend && !!window.__extendProbe, { timeout: 30000 })
    await win.evaluate(() => localStorage.setItem('forsion_tangu_ribbon_order', JSON.stringify(['space:server-admin'])))
    await win.reload()
    await win.waitForSelector('[data-id="space:server-admin"] button', { timeout: 30000 })
    await win.locator('[data-id="space:server-admin"] button').click()
    await win.waitForFunction(() => !!window.__serverExtend)
    await win.evaluate(() => window.__serverExtend.models())
    // On a host with ctx.table the models list is the native read-only DbTable (CSS grid rows, no <tbody>).
    await win.waitForSelector('[data-hook="mtable"] .amx-db')
    const DATA_ROWS = '[data-hook="mtable"] .amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)'
    assert.equal(await win.locator(DATA_ROWS).count(), 5)
    assert.equal(await win.locator('[data-hook="mtable"] table').count(), 0, 'native host must not fall back to the classic table')
    assert.equal(await win.locator('[data-hook="mtable"] .amx-db-addrow, [data-hook="mtable"] .amx-db-addcol, [data-hook="mtable"] .amx-db-rowdel').count(), 0, 'plugin tables are read-only')
    if (GROUPS_ONLY) {
      const heads = win.locator('[data-hook="mtable"] .amx-db-grouphead')
      assert.equal(await heads.count(), 3)
      assert.ok((await heads.nth(0).innerText()).includes('常用模型'))
      assert.ok((await heads.nth(1).innerText()).includes('预览模型'))
      await heads.first().click()
      assert.equal(await win.locator(DATA_ROWS).count(), 3)
      await heads.first().click()
      passed('admin model table starts in catalog order with collapsible groups and an unset group')
      const query = win.locator('[data-hook="mtable"] .amx-db-search')
      await query.evaluate((input) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://api.siliconflow.cn/v1')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      assert.equal(await query.inputValue(), '')
      assert.equal(await win.locator(DATA_ROWS).count(), 5)
      passed('background autofill does not filter the real admin model table')
      await win.mouse.move(30, 30)
      await win.screenshot({ path: path.join(SHOTS, 'model-groups-light.png') })
      await win.locator('[data-hook="mtable"] .amx-db-groupbtn').click()
      const menu = win.locator('.amx-db-group-menu')
      await menu.getByLabel('按属性分组', { exact: true }).selectOption('provider')
      assert.ok(await heads.count() > 1)
      await menu.getByLabel('按属性分组', { exact: true }).selectOption('group')
      await win.screenshot({ path: path.join(SHOTS, 'model-groups-menu.png') })
      await win.mouse.click(30, 30)
      await menu.waitFor({ state: 'detached' })
      await win.locator('[data-tab="providers"]').click()
      await win.waitForSelector('[data-hook="providers-table"] .amx-db')
      assert.ok((await win.locator('[data-hook="providers-table"]').innerText()).includes('官方余额接口已停用'))
      assert.equal(await win.locator('[data-hook="providers-table"] a[href="https://cloud.siliconflow.cn"]').count(), 1)
      await win.screenshot({ path: path.join(SHOTS, 'siliconflow-retired.png') })
      passed('SiliconFlow retirement is clear and links to the official console')
      assert.deepEqual(errors, [])
      return
    }
    const rowOrder = () => win.locator(DATA_ROWS).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-row')))
    const order0 = await rowOrder()
    const nameHeader = win.locator('[data-hook="mtable"] .amx-db-hrow .amx-db-th').first()
    await nameHeader.click()
    await win.waitForTimeout(80)
    await nameHeader.click()
    await win.waitForTimeout(80)
    const order2 = await rowOrder()
    assert.notDeepEqual(order2, order0, 'clicking the header twice must re-sort the native table')
    await nameHeader.click() // third click clears the sort
    await win.waitForTimeout(80)
    assert.deepEqual(await rowOrder(), order0)
    // Typing in the panel's search box re-renders the panel; the native table must be re-adopted, not remounted, and focus must stay.
    await win.locator('[data-hook="mtable"] .amx-db').evaluate((el) => { el.__stamp = 'first-mount' })
    await win.locator('[data-act="m-search"]').click()
    await win.keyboard.type('gp')
    await win.waitForTimeout(250)
    const afterSearch = await win.evaluate(() => ({
      focused: document.activeElement?.getAttribute('data-act'),
      stamp: document.querySelector('[data-hook="mtable"] .amx-db')?.__stamp,
      rows: document.querySelectorAll('[data-hook="mtable"] .amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)').length,
    }))
    assert.equal(afterSearch.focused, 'm-search', 'search keeps focus across re-renders')
    assert.equal(afterSearch.stamp, 'first-mount', 'same-id re-render must re-adopt the live table instead of remounting it')
    assert.ok(afterSearch.rows > 0 && afterSearch.rows < 5, 'search filters the native rows: ' + afterSearch.rows)
    await win.locator('[data-act="m-search"]').fill('')
    await win.waitForTimeout(250)
    assert.equal(await win.locator(DATA_ROWS).count(), 5)
    // Column menus are position:fixed popups; the plugin skin's container-type would clip them, so they escape to a body-level host.
    await nameHeader.click({ button: 'right' })
    await win.waitForSelector('.amx-db-pop')
    await win.waitForTimeout(300) // let the menu's entrance transition finish before measuring paint
    const pop = await win.locator('.amx-db-pop').first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      const mid = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))
      const cs = getComputedStyle(el)
      return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, hosted: !!el.closest('.amx-plugtable-pops') && el.closest('.amx-plugtable-pops').parentElement === document.body, onTop: !!mid && el.contains(mid), inPanel: !!el.closest('.fsa-adm'), opacity: cs.opacity, bg: cs.backgroundColor, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
    })
    assert.ok(pop.inside && pop.hosted && pop.onTop && !pop.inPanel, 'column menu must escape the panel and sit on top inside the viewport: ' + JSON.stringify(pop))
    assert.ok(pop.opacity === '1' && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(pop.bg), 'column menu must be painted opaque on the body-level host: ' + JSON.stringify(pop))
    await win.screenshot({ path: path.join(SHOTS, 'model-table-menu.png'), clip: { x: Math.max(0, pop.rect[0] - 40), y: Math.max(0, pop.rect[1] - 40), width: pop.rect[2] + 80, height: pop.rect[3] + 80 } })
    const popSection = win.locator('.amx-db-pop .amx-db-pop-sec')
    if (await popSection.count()) await popSection.first().click()
    else await win.locator('.amx-db-pop').first().click({ position: { x: 4, y: 4 } })
    assert.equal(await win.locator('.amx-db-pop').count(), 1, 'a click inside the menu must not close it')
    // mouse.click skips actionability: the fixed backdrop is meant to intercept this press and close the menu.
    const panelBox = await win.locator('.fsa-adm').first().boundingBox()
    await win.mouse.click(panelBox.x + 12, panelBox.y + 12)
    await win.waitForSelector('.amx-db-pop', { state: 'detached' })
    await win.screenshot({ path: path.join(SHOTS, 'model-table-light.png') })
    passed('models list is the native read-only DbTable: sorts in place, survives re-renders without remount, menus escape the panel')
    await win.waitForTimeout(300)
    const tabsBefore = await win.locator('.wb-view--main').count()
    const beforeModelLayout = await win.evaluate(() => JSON.parse(localStorage.getItem('tangu2_layout_v4')))
    const leftWidthBefore = await win.locator('.wb-view--left').evaluate((el) => el.closest('.dv-groupview').getBoundingClientRect().width)
    await win.locator('[data-act="m-new"]').click()
    await win.waitForSelector('.wb-extend [data-hook="mform"]')
    // A brand-new right group must expand with the sidebar tween instead of popping in at full width.
    const groupWidth = () => win.locator('.wb-extend').evaluate((el) => el.closest('.dv-groupview').getBoundingClientRect().width)
    const w0 = await groupWidth()
    await win.waitForTimeout(90)
    const w1 = await groupWidth()
    await win.waitForTimeout(400)
    const w2 = await groupWidth()
    assert.ok(w0 < w2 - 20 && w1 <= w2, `right group must tween open: ${w0} → ${w1} → ${w2}`)
    const workbenchWidth = await win.locator('.wb-dockview').evaluate((el) => el.getBoundingClientRect().width)
    const regularRightWidth = Math.round(Math.min(300, Math.max(240, workbenchWidth * 0.191)))
    const expectedTempWidth = Math.max(regularRightWidth, Math.min(Math.max(220, Math.min(680, Math.round(workbenchWidth * 0.6))), Math.round(regularRightWidth * 1.2)))
    assert.ok(Math.abs(w2 - expectedTempWidth) < 3, `new temporary View should open 20% wider than the regular panel default: ${w2} vs ${expectedTempWidth}`)
    // Side tab groups are icon-only, so the extension must name and close itself (the mobile drawer bar and bottom tabs already do).
    assert.equal((await win.locator('.wb-extend-head .wb-extend-title').innerText()).trim(), '新增模型')
    assert.equal(await win.locator('[data-hook="tab-body"] [data-hook="form-actions"]').count(), 0)
    const actions = await win.locator('.wb-extend [data-hook="form-actions"]').evaluate((el) => {
      const r = el.getBoundingClientRect(), s = el.closest('.fsa-adm').getBoundingClientRect()
      return { sticky: getComputedStyle(el).position === 'sticky', inView: r.bottom <= s.bottom + 1 && r.top >= s.top }
    })
    assert.ok(actions.sticky && actions.inView, 'save/cancel row must stay visible at the bottom of the extension: ' + JSON.stringify(actions))
    const nativeView = await win.locator('.wb-extend').evaluate((el) => {
      const view = el.closest('.wb-view--right')
      const group = view?.closest('.dv-groupview')
      return !!view && !!view.closest('.dv-content-container') &&
        !!group?.querySelector('.dv-tabs-and-actions-container .wb-tab[data-transient="true"]')
    })
    assert.ok(nativeView, 'temporary model editor must be a native Right Panel View with its own native tab')
    assert.equal(await win.locator('.wb-view--main').count(), tabsBefore)
    assert.equal(await win.locator('[data-hook="tab-body"] [data-hook="mform"]').count(), 0)
    const geometry = await win.evaluate(() => {
      const drawer = document.querySelector('.wb-extend').getBoundingClientRect()
      const owner = document.querySelector('.wb-view--main').getBoundingClientRect()
      return { width: drawer.width, outsideMain: drawer.left >= owner.right - 2, nestedInMain: !!document.querySelector('.wb-view--main .wb-extend') }
    })
    assert.ok(geometry.outsideMain && !geometry.nestedInMain, 'model form must expand the real Right Panel outside Main View: ' + JSON.stringify(geometry))
    passed('real server form expands the workbench Right Panel outside Main View')
    assert.equal(await win.locator('.wb-tab[data-transient="true"]').count(), 1)
    assert.equal(await win.locator('.wb-extend-panel-host, .wb-extend-group').count(), 0)
    await win.waitForTimeout(250)
    const persisted = await win.evaluate(() => JSON.parse(localStorage.getItem('tangu2_layout_v4')))
    assert.ok(!JSON.stringify(persisted).includes('__extend'))
    assert.deepEqual(persisted.sidebars, beforeModelLayout.sidebars, 'temporary expansion must not persist sidebar visibility or replace stash')
    await win.screenshot({ path: path.join(SHOTS, 'model-add-light.png') })
    await win.locator('[data-f="mf-id"]').fill('fixture-new')
    await win.locator('[data-f="mf-name"]').fill('Unsaved model')
    await win.locator('[data-f="mf-apikey"]').fill('fixture-key')
    await win.locator('[data-act="eye"][data-for="mf-apikey"]').click()
    assert.equal(await win.locator('[data-f="mf-apikey"]').getAttribute('type'), 'text')
    await win.locator('[data-tab="project"]').click()
    await win.waitForSelector('.wb-extend', { state: 'detached' }) // collapses with the sidebar tween, so it is not gone in the same tick
    await win.locator('[data-tab="models"]').click()
    await win.waitForSelector('.wb-extend [data-hook="mform"]')
    assert.equal(await win.locator('[data-f="mf-name"]').inputValue(), 'Unsaved model')
    passed('form controls work after relocation; tab changes preserve the in-memory draft')
    failSave = true
    await win.locator('[data-act="mf-save"]').click()
    await win.waitForTimeout(400)
    assert.equal(await win.locator('[data-f="mf-name"]').inputValue(), 'Unsaved model')
    failSave = false
    await win.locator('[data-act="mf-save"]').click()
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    const saved = mutations.filter((m) => m.path === '/api/admin/models' && m.method === 'POST').at(-1)
    assert.equal(saved.body.name, 'Unsaved model')
    assert.equal(saved.body.apiKey, 'fixture-key')
    assert.equal(saved.authorization, 'Bearer fixture-admin')
    await win.waitForTimeout(200)
    const leftWidthAfter = await win.locator('.wb-view--left').evaluate((el) => el.closest('.dv-groupview').getBoundingClientRect().width)
    assert.ok(Math.abs(leftWidthAfter - leftWidthBefore) < 3, 'temporary right expansion must not change the left panel width')
    passed('failed save preserves inputs; successful save sends exact values and restores the original panel layout')
    // The intentionally failed save creates a sticky error toast over the close button.
    await win.locator('.ntf-close').evaluateAll((buttons) => buttons.forEach((button) => button.click()))
    await win.locator('[data-act="m-edit"]').first().click()
    await win.waitForSelector('.wb-extend [data-hook="mform"]')
    assert.equal(await win.locator('[data-f="mf-name"]').inputValue(), 'GPT X <b>x</b>')
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await win.waitForTimeout(250) // Let the theme transition settle before visual QA.
    await win.screenshot({ path: path.join(SHOTS, 'model-edit-dark.png') })
    holdNextSave = true
    await win.locator('[data-f="mf-name"]').fill('Saved earlier editor')
    await win.locator('[data-act="mf-save"]').click()
    for (let i = 0; i < 50 && !heldSave; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(heldSave, 'the delayed save must actually reach the backend')
    await win.keyboard.press('Escape')
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    await win.locator('[data-act="m-new"]').click()
    await win.locator('[data-f="mf-name"]').fill('Keep newer draft')
    heldSave(); heldSave = null
    await win.waitForFunction(() => document.body.innerText.includes('模型已保存'))
    assert.equal(await win.locator('[data-f="mf-name"]').inputValue(), 'Keep newer draft')
    passed('a slow earlier save cannot dismiss or overwrite a newer editor')
    await win.locator('.ntf-close').evaluateAll((buttons) => buttons.forEach((button) => button.click()))
    // Repeated "add" while the same editor is open must keep the draft (no remount), and the header × must close it.
    await win.locator('[data-act="m-new"]').click()
    await win.waitForTimeout(150)
    assert.equal(await win.locator('[data-f="mf-name"]').inputValue(), 'Keep newer draft')
    await win.locator('.wb-extend-close').click()
    await win.waitForTimeout(60)
    assert.equal(await win.locator('.wb-extend').count(), 1, 'content stays mounted while the panel collapses with the sidebar tween')
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    assert.equal(await win.locator('[data-hook="tab-body"] [data-hook="mform"]').count(), 0)
    passed('repeat add keeps the open draft; the extension header close button collapses it with the sidebar tween')
    // Switching a real main tab must revoke its visible extension even if Dockview keeps the owner mounted.
    await win.locator('[data-act="m-new"]').click()
    await win.waitForSelector('.wb-extend')
    await win.locator('.dv-new-tab').first().click()
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    await win.locator('.wb-tab').filter({ hasText: '服务器管理' }).first().click()
    await win.waitForSelector('[data-act="pull-open"]')
    assert.equal(await win.locator('.wb-extend').count(), 0)
    passed('switching a real main tab closes the temporary Right Panel')
    await win.locator('[data-act="pull-open"]').click()
    await win.waitForSelector('.wb-extend [data-hook="pull"]')
    await win.locator('[data-act="pull-go"]').click()
    await win.waitForSelector('[data-pull]')
    await win.locator('.wb-extend input').first().focus()
    await win.keyboard.press('Escape')
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    passed('edit and upstream pull use the same transient surface; close and Escape clean it')
    await win.evaluate(() => window.__extendProbe.open())
    await win.waitForFunction(() => !!window.__extendProbe.view)
    for (const side of ['left', 'right', 'bottom']) {
      await win.evaluate((side) => window.__extendProbe.invoke({ side }), side)
      await win.waitForSelector(`.wb-extend[data-side="${side}"]`)
      // Bottom tabs are named and closable; only left/right draw the in-panel header.
      assert.equal(await win.locator('.wb-extend-head').count(), side === 'bottom' ? 0 : 1, side + ' header')
      const actual = await win.evaluate((side) => {
        const panel = document.querySelector('.wb-extend').getBoundingClientRect()
        const main = document.querySelector('.wb-view--main').getBoundingClientRect()
        return !document.querySelector('.wb-view--main .wb-extend') && (side === 'left' ? panel.right <= main.left + 2 : side === 'right' ? panel.left >= main.right - 2 : panel.top >= main.bottom - 2)
      }, side)
      assert.ok(actual, side + ' extension must occupy the real panel outside Main View')
    }
    await win.locator('.wb-extend input').fill('Keep this draft')
    const mounts = await win.evaluate(() => window.__extendProbe.mounts)
    await win.evaluate(() => window.__extendProbe.invoke({ side: 'bottom' }))
    assert.equal(await win.locator('.wb-extend input').inputValue(), 'Keep this draft')
    assert.equal(await win.evaluate(() => window.__extendProbe.mounts), mounts)
    await closeNativeExtension(win)
    await win.evaluate(() => window.__extendProbe.openSide())
    await win.waitForSelector('[aria-label="Sidebar draft"]')
    await win.locator('[aria-label="Sidebar draft"]').fill('Preserve existing sidebar')
    await win.waitForTimeout(250)
    const sideWidth = await win.locator('[aria-label="Sidebar draft"]').evaluate((el) => el.closest('.dv-groupview').getBoundingClientRect().width)
    await win.evaluate(() => window.__extendProbe.invoke({ side: 'right' }))
    await win.waitForSelector('.wb-extend')
    assert.equal(await win.locator('[aria-label="Sidebar draft"]').isVisible(), false)
    const nativeWidth = await win.locator('.wb-extend').evaluate((el) => el.closest('.dv-groupview').getBoundingClientRect().width)
    assert.ok(Math.abs(nativeWidth - sideWidth) < 3, 'temporary View must use the existing native panel width')
    await win.locator('.wb-extend input').fill('Native tab draft')
    await win.locator('.wb-tab[title="Existing right view"]').click()
    await win.waitForSelector('[aria-label="Sidebar draft"]', { state: 'visible' })
    assert.equal(await win.locator('.wb-extend').isVisible(), false)
    assert.equal(await win.locator('.wb-tab[data-transient="true"]').isVisible(), true)
    assert.equal(await win.locator('[aria-label="Sidebar draft"]').inputValue(), 'Preserve existing sidebar')
    // The controller must activate an existing native tab, without remounting its form.
    const mountsBeforeReopen = await win.evaluate(() => window.__extendProbe.mounts)
    await win.evaluate(() => window.__extendProbe.invoke({ side: 'right' }))
    await win.waitForSelector('.wb-extend input')
    assert.equal(await win.locator('.wb-extend input').inputValue(), 'Native tab draft')
    assert.equal(await win.evaluate(() => window.__extendProbe.mounts), mountsBeforeReopen)
    await win.locator('.wb-tab[title="Existing right view"]').click()
    await win.locator('.wb-tab[data-transient="true"]').click()
    assert.equal(await win.locator('.wb-extend input').inputValue(), 'Native tab draft')
    await win.screenshot({ path: path.join(SHOTS, 'native-right-tabs.png') })
    passed('native right tabs switch between regular and temporary Views; repeat open activates the existing draft')
    await closeNativeExtension(win)
    await win.waitForSelector('[aria-label="Sidebar draft"]', { state: 'visible' })
    assert.equal(await win.locator('[aria-label="Sidebar draft"]').inputValue(), 'Preserve existing sidebar')
    await win.waitForTimeout(200)
    const restoredWidth = await win.locator('[aria-label="Sidebar draft"]').evaluate((el) => el.closest('.dv-groupview').getBoundingClientRect().width)
    assert.ok(Math.abs(sideWidth - restoredWidth) < 3, 'existing panel width must be restored')
    passed('existing Right Panel keeps its content, draft and width after the extension closes')
    await win.evaluate(() => window.__extendProbe.invoke({ side: 'right' }))
    const totalMounts = await win.evaluate(() => window.__extendProbe.mounts)
    await win.evaluate(() => window.__extendProbe.close())
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    assert.equal(await win.evaluate(() => window.__extendProbe.cleanups), totalMounts)
    assert.ok(await win.evaluate(() => { try { window.__extendProbe.old.open({ id: 'late', title: 'Late', mount() {} }); return false } catch { return true } }))
    passed('programmatic/command entry, real left/right/bottom panels, repeat deduplication and owner disposal')
    await win.evaluate(() => window.__extendProbe.open())
    await win.waitForFunction(() => !!window.__extendProbe.view)
    await win.evaluate(() => window.__extendProbe.invoke({ side: 'right' }))
    await win.waitForSelector('.wb-extend')
    await win.locator('.dv-edge-right').click()
    await win.waitForSelector('.wb-view--right', { state: 'detached' })
    assert.equal(await win.locator('.wb-tab[data-transient="true"]').count(), 0)
    await win.locator('.dv-edge-right').click()
    await win.waitForSelector('[aria-label="Sidebar draft"]')
    assert.equal(await win.locator('.wb-extend').count(), 0)
    passed('native Right Panel toggle folds the whole group and restores regular Views without resurrecting the temporary View')
    // Every other core-* panel must reach the real DbTable too: the plugin e2e's fake host renders the classic fallback,
    // so this is the only instrument that exercises their specs against the native renderer (dark theme is still on).
    const settle = () => win.waitForFunction(() => { const a = document.querySelector('.fsa-adm'); return !!a && a.innerText.trim().length > 20 && !a.querySelector('[data-hook="loading"]') }, null, { timeout: 15000 })
    const tableState = () => win.evaluate(() => ({
      classic: [...document.querySelectorAll('.fsa-adm .data-table')].filter((t) => t.getAttribute('data-hook') !== 'ms-quota').length,
      native: document.querySelectorAll('.fsa-adm .amx-db').length,
      rows: document.querySelectorAll('.fsa-adm .amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)').length,
    }))
    let nativeTables = 0, nativeRows = 0
    for (const a of APPS) {
      if (a.appId === 'core-models') continue
      activeApp = a.appId
      const tabs = fixtures[a.appId].tabs || ['users', 'membership']
      await win.evaluate((id) => window.__serverExtend.open(id), a.appId)
      await win.waitForSelector(`.fsa-adm [data-act="tab"][data-tab="${tabs[0]}"]`, { timeout: 15000 })
      for (const tab of tabs) {
        await win.locator(`.fsa-adm [data-act="tab"][data-tab="${tab}"]`).click()
        await settle()
        await win.waitForTimeout(200)
        const st = await tableState()
        assert.equal(st.classic, 0, `${a.appId}/${tab}: a host with ctx.table must not show the classic table (${JSON.stringify(st)})`)
        nativeTables += st.native
        nativeRows += st.rows
        await win.screenshot({ path: path.join(SHOTS, `${a.appId}-${tab}.png`) })
      }
      passed(`${a.appId}: ${tabs.length} tabs render on the native host without classic tables`)
    }
    assert.ok(nativeTables >= 8 && nativeRows >= 10, `native tables across the other four panels: ${nativeTables} tables / ${nativeRows} rows`)
    // Billing's key pool table lives inside the Extend View card and must be native there as well.
    activeApp = 'core-billing'
    await win.evaluate((id) => window.__serverExtend.open(id), 'core-billing')
    await win.waitForSelector('.fsa-adm [data-act="tab"][data-tab="shop"]', { timeout: 15000 })
    await win.locator('.fsa-adm [data-act="tab"][data-tab="shop"]').click()
    await settle()
    await win.locator('[data-act="sh-keys"][data-id="sp-1"]').click()
    await win.waitForSelector('.wb-extend .amx-db', { timeout: 15000 })
    await win.screenshot({ path: path.join(SHOTS, 'billing-keys-extend.png') })
    await win.locator('.wb-extend-close').click()
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    passed('billing key pool renders the native table inside the Extend View')
    assert.deepEqual(errors, [], 'panels must not throw while rendering native tables')
    activeApp = 'core-models'
    await win.evaluate(() => window.__serverExtend.models())
    await win.waitForSelector('[data-act="m-new"]')
    await win.locator('[data-act="m-new"]').click()
    await win.waitForSelector('.wb-extend')
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(360, 500); w.setContentSize(520, 740) })
    await win.waitForTimeout(300)
    assert.ok(await win.evaluate(() => { const r = document.querySelector('.wb-extend').getBoundingClientRect(); return innerWidth <= 521 && r.width > 0 && r.right <= innerWidth + 1 && r.left >= 0 }))
    await win.screenshot({ path: path.join(SHOTS, 'model-narrow.png') })
    await win.waitForTimeout(250)
    const savedBeforeReload = await win.evaluate(() => JSON.parse(localStorage.getItem('tangu2_layout_v4')))
    assert.ok(!JSON.stringify(savedBeforeReload).includes('__extend'))
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 30000 })
    await win.waitForTimeout(500)
    assert.equal(await win.locator('.wb-extend').count(), 0)
    // The app's default startup preference is Home. Re-enter Server to restore its archived layout.
    await win.waitForSelector('[data-id="space:server-admin"] button')
    await win.locator('[data-id="space:server-admin"] button').click()
    // The server plugin's selected admin module is in-memory; the restored view asks for a module.
    await win.waitForFunction(() => !!window.__serverExtend)
    await win.evaluate(() => window.__serverExtend.models())
    await win.waitForSelector('[data-act="m-new"]')
    assert.equal(await win.locator('.wb-extend').count(), 0)
    assert.equal(await win.locator('[aria-label="Sidebar draft"]').inputValue(), '') // view restored from params, no persisted draft
    passed('narrow viewport stays in bounds; reload restores real views without a transient form')
    await win.evaluate(() => { localStorage.setItem('lcl.uiMode', 'mobile'); localStorage.removeItem('lcl.uiMode.auto') })
    await win.reload()
    await win.waitForSelector('.mb-shell', { timeout: 30000 })
    await win.waitForFunction(() => !!window.__serverExtend)
    await win.evaluate(() => window.__serverExtend.models())
    await win.waitForSelector('[data-act="m-new"]')
    await win.locator('[data-act="m-new"]').click()
    await win.waitForSelector('.mb-drawer--right.open .wb-extend [data-hook="mform"]')
    assert.ok(await win.locator('.wb-extend').evaluate((el) => !!el.closest('.mb-drawer-body .wb-native-extend')))
    assert.equal(await win.locator('.mb-drawer--right.open .mb-drawer-bar').isVisible(), true)
    assert.equal(await win.locator('.wb-extend-head').count(), 0) // The drawer bar already names and closes the View.
    await win.waitForFunction(() => getComputedStyle(document.querySelector('.mb-drawer--right.open')).transform === 'none')
    assert.ok(await win.locator('.wb-extend').evaluate((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1 }))
    await win.screenshot({ path: path.join(SHOTS, 'model-mobile.png') })
    const consumed = await win.evaluate(() => !window.dispatchEvent(new Event('forsion:mobile-back', { cancelable: true })))
    assert.ok(consumed)
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    passed('single-column mobile host receives the same extension; system back closes it')
    await win.evaluate(() => window.__extendProbe.open())
    await win.waitForFunction(() => !!window.__extendProbe.view)
    await win.evaluate(() => window.__extendProbe.openSide())
    await win.evaluate(() => window.__extendProbe.invoke({ side: 'right' }))
    await win.waitForSelector('.mb-drawer--right.open .wb-extend input')
    await win.locator('.wb-extend input').fill('Mobile native draft')
    const select = win.locator('.mb-drawer--right .mb-drawer-select')
    await select.selectOption({ label: 'Existing right view' })
    await win.waitForSelector('[aria-label="Sidebar draft"]')
    assert.equal(await win.locator('.wb-extend').isVisible(), false)
    await select.selectOption({ label: 'Extension right' })
    await win.waitForSelector('.wb-extend input')
    assert.equal(await win.locator('.wb-extend input').inputValue(), 'Mobile native draft')
    await win.waitForTimeout(300)
    assert.ok(await win.evaluate(() => !localStorage.getItem('lcl_sc_layout_v1').includes('__extend')))
    await win.locator('.mb-drawer--right .mb-drawer-bar .mb-icon-btn').click()
    await win.waitForSelector('.wb-extend', { state: 'detached' })
    assert.equal(await win.locator('.mb-drawer--right.open').count(), 0)
    passed('mobile native View selector preserves the temporary draft; native close folds the drawer; saved layout excludes it')
    assert.deepEqual(errors, [])
    passed('zero page errors')
  } catch (error) {
    if (win) { await win.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {}); console.error((await win.locator('body').innerText()).slice(-2500)) }
    throw error
  } finally {
    if (heldSave) heldSave()
    if (app) await app.close()
    await stub.close()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
