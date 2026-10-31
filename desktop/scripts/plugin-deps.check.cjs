/**
 * 插件前置依赖(manifest requiresPlugins,2026-10-02)的真 Electron 仪器。
 *
 * 契约:前置没齐的插件装着但开不了;用户开着时挂「等待前置插件」,前置就位自动激活;前置停用 → 依赖方先停、
 * 回来自动恢复;详情页「前置插件」逐条给状态与入口,「运行占用」列着它此刻挂了什么。
 *
 * 夹具(隔离 TANGU_HOME 现生成,不依赖外部插件仓):
 *  - deps-app:requiresPlugins = [{ id: 'deps-lib', minVersion: '1.0.0', name: 'Deps Lib' }];setup 订语言 + 注册命令
 *  - deps-lib:一开始不在磁盘上,断言途中写进插件目录再点「重新加载」
 *
 * 断言(都打在设置浮窗里):
 *  A 前置没装 + 用户开着 → 卡片挂「等待前置插件」,详情页前置行 = missing
 *  B 用户把它关掉 → 开关灰掉(前置没齐开不了)。⚠ 负对照靶子:PluginSwitch 去掉 unmet 判断 → B 必须红
 *  C 装上前置并重新加载 → 开关可点;打开 → 在跑:前置行 = ok,「运行占用」列出语言订阅
 *  D 关前置 → 弹确认且点名依赖方 → 依赖方暂停,回到「等待前置插件」
 *  E 开前置 → 依赖方自动恢复
 *  F 引擎插件页(桩引擎按新引擎形状给列表):开着却休眠的挂「等待前置插件」;关着且前置没齐的开关灰掉;
 *    上一次启停超时还在收尾的挂「正在收尾」
 *
 * 商店一键补前置(2026-10-30,真安装:本地 HTTP 桩 → 下载 zip → 主进程落盘 → 重载 → reconcile):
 *  G 装依赖方 → 提示条带一键按钮、不自动消失、卡片挂徽标 → 点一下,连同前置自己缺的一路装完 → 依赖方在跑。
 *    设置浮窗与主窗都不点「重新加载」就看到它跑起来;详情页前置行全 ok、按钮收起。
 *    store-lib 用真实形态的 market-<UUID> slug + dep.market,store-base 用老式 slug = manifest id,两条对应规则都走到
 *  H 前置不在商店(诱饵条目显示名相同、slug 不同)、商店版本也不够 → 不给安装按钮,如实写;重开商店回详情页仍看得到。
 *    ⚠ 负对照靶子:marketDeps.ts 的 depCard 改成按显示名匹配 → H 必须红
 *  I 下载失败 → 错误常驻、按钮变「重试」,再点装上
 *
 * 用法:npx electron-vite build 之后 `npm run check:plugindeps`。渲染层改动不 build 就跑 = 测的是旧代码(调试铁律 2)。
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const JSZip = require('jszip')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-plugin-deps-'))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const APP = 'deps-app', LIB = 'deps-lib'

function writePlugin(home, id, manifest, code) {
  const dir = path.join(home, 'plugins', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, version: '1.0.0', minAppVersion: '0.0.1', ...manifest }, null, 2))
  fs.writeFileSync(path.join(dir, 'main.js'), code) // new Function('ctx', code) 的函数体
}

const LIB_UUID = '11111111-1111-4111-8111-111111111111'
const storeItem = (id, name, installSlug, over = {}) => ({ id, type: 'amadeus-plugin', source: 'zip', name, installSlug, latestVersion: '1.0.0', author: 'Fixture', summary: 'plugin-deps.check 商店夹具', downloads: 0, tags: [], ...over })
const STORE = [
  storeItem('item-store-app', 'Store App', 'store-app'),
  storeItem(LIB_UUID, 'Store Lib', `market-${LIB_UUID}`),
  storeItem('item-store-base', 'Store Base', 'store-base'),
  storeItem('item-ghost-twin', 'Ghost Lib', 'ghost-twin'), // 诱饵:显示名和 lonely-app 缺的前置一样,slug 不同
  storeItem('item-lonely-app', 'Lonely App', 'lonely-app'),
  storeItem('item-flaky-app', 'Flaky App', 'flaky-app'),
  storeItem('item-flaky-lib', 'Flaky Lib', 'flaky-lib'),
]
const STORE_PACKAGES = {
  'item-store-app': ['store-app', { requiresPlugins: [{ id: 'store-lib', market: `market-${LIB_UUID}`, name: 'Store Lib' }] }],
  [LIB_UUID]: ['store-lib', { requiresPlugins: [{ id: 'store-base', name: 'Store Base' }] }],
  'item-store-base': ['store-base', {}],
  'item-ghost-twin': ['ghost-twin', {}],
  'item-lonely-app': ['lonely-app', { requiresPlugins: [{ id: 'ghost-lib', name: 'Ghost Lib' }, { id: 'store-lib', minVersion: '9.0.0', market: `market-${LIB_UUID}`, name: 'Store Lib' }] }],
  'item-flaky-app': ['flaky-app', { requiresPlugins: [{ id: 'flaky-lib', name: 'Flaky Lib' }] }],
  'item-flaky-lib': ['flaky-lib', {}],
}
function storeZip([id, manifest]) {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, ...manifest }))
  zip.file('main.js', `ctx.subscribeLocale?.(() => {})\nctx.registerCommand({ id: '${id}-hello', title: '${id}', run() {} })\n`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
async function startStoreStub() {
  const failOnce = new Set(['item-flaky-lib'])
  const hits = {}
  let base
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fixture')
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body) }
    if (u.pathname === '/api/market/items') return send(200, { items: STORE.filter((x) => !u.searchParams.get('type') || x.type === u.searchParams.get('type')) })
    const m = /^\/api\/market\/items\/([^/]+)(\/install)?$/.exec(u.pathname)
    const item = m && STORE.find((x) => x.id === m[1])
    if (item) return send(200, m[2] ? { type: item.type, installSlug: item.installSlug, source: 'zip', downloadUrl: `${base}/archive/${item.id}` } : { ...item, readme: '# Fixture' })
    const dl = /^\/archive\/([^/]+)$/.exec(u.pathname)
    if (dl && STORE_PACKAGES[dl[1]]) {
      hits[dl[1]] = (hits[dl[1]] || 0) + 1
      if (failOnce.delete(dl[1])) return send(503, {})
      return send(200, await storeZip(STORE_PACKAGES[dl[1]]), 'application/zip')
    }
    return send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  return { url: base, hits, close: () => new Promise((r) => server.close(r)) }
}

async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn().catch(() => false)) return true
    await pause(100)
  }
  return false
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  const home = path.join(temp, 'home')
  writePlugin(home, APP, {
    name: 'Deps App', description: 'plugin-deps.check 的依赖方夹具,不是产品插件',
    requiresPlugins: [{ id: LIB, minVersion: '1.0.0', name: 'Deps Lib' }],
  }, `ctx.subscribeLocale?.(() => {})\nctx.registerCommand({ id: 'deps-app-hello', title: 'Deps hello', run() {} })\n`)
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(userData + '-dev', { recursive: true })
  const engPlugin = (id, over) => ({ id, name: id, description: 'plugin-deps.check 引擎侧夹具', scopes: ['global'], settings: null, source: 'folder', version: '1.0.0', ...over })
  const stub = await startStubEngine({
    sessions: [],
    handle: ({ path: p, method }) => (p === '/agent/plugins' && method === 'GET' ? { plugins: [
      engPlugin('eng-base', { enabled: false, active: false }),
      engPlugin('eng-user', { enabled: true, active: false, requiresPlugins: [{ id: 'eng-base' }], waitingFor: [{ id: 'eng-base', reason: 'off' }] }),
      engPlugin('eng-off', { enabled: false, active: false, requiresPlugins: [{ id: 'eng-missing' }] }),
      engPlugin('eng-settling', { enabled: true, active: false, settling: true }),
    ] } : undefined),
  })
  const store = await startStoreStub()
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'deps-test-token', cloudUrl: store.url }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: store.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const main = await app.firstWindow()
    await main.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
    check('主窗已离开首启引导', await skipOnboarding(main))

    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins' } }))
    let fl
    await waitFor(async () => { fl = app.windows().find((p) => p.url().includes('window=floating')); return !!fl }, 10000)
    if (!fl) throw new Error('settings floating window missing')
    const dialogs = []
    fl.on('dialog', (d) => { dialogs.push(d.message()); void d.accept() })
    // 插件页默认落在「核心能力」子页;外置插件卡片在「已安装插件」子页(09 月设置重排后)
    await fl.locator('.settings-nav-subitem', { hasText: '已安装插件' }).click()
    await fl.waitForSelector(`[data-plugin-id="${APP}"]`, { timeout: 30000 })
    const card = (id) => fl.locator(`[data-plugin-id="${id}"]`)
    const waiting = (id) => card(id).locator('[data-plugin-waiting]').count().then((n) => n > 0)
    const openDetail = async (id) => { await card(id).click(); await fl.waitForSelector(`[data-plugin-detail="${id}"]`, { timeout: 10000 }) }
    const back = async () => { await fl.locator('[data-plugin-back]').click(); await fl.waitForSelector(`[data-plugin-id="${APP}"]`, { timeout: 10000 }) }
    const depState = () => fl.locator(`[data-plugin-detail="${APP}"] [data-dep-id="${LIB}"]`).getAttribute('data-dep-state')

    // A
    check('A 前置没装、用户开着 → 列表挂「等待前置插件」', await waitFor(() => waiting(APP)))
    await openDetail(APP)
    check('A 详情页前置行 = missing', await waitFor(async () => (await depState()) === 'missing'), String(await depState().catch(() => null)))
    await fl.evaluate(() => document.getAnimations().forEach((a) => { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish() }))
    const shotMissing = path.join(temp, 'plugin-deps-missing.png')
    await fl.screenshot({ path: shotMissing })
    console.log(`SCREENSHOT ${shotMissing}`)

    // B
    const appSwitch = () => fl.locator(`[data-plugin-detail="${APP}"] [data-plugin-switch]`)
    await appSwitch().click() // 关
    check('B 关掉后前置仍没齐 → 开关灰掉(开不了)', await waitFor(() => appSwitch().isDisabled()))
    await back()

    // C
    writePlugin(home, LIB, { name: 'Deps Lib', description: 'plugin-deps.check 的前置夹具,不是产品插件' }, `ctx.registerCommand({ id: 'deps-lib-ping', title: 'Deps ping', run() {} })\n`)
    await fl.locator('details.plugin-management-group summary', { hasText: '开发工具' }).click().catch(() => {})
    await fl.getByRole('button', { name: '重新加载' }).click()
    await fl.waitForSelector(`[data-plugin-id="${LIB}"]`, { timeout: 15000 })
    const listSwitch = (id) => card(id).locator('[data-plugin-switch]')
    check('C 装上前置后开关恢复可点', await waitFor(async () => !(await listSwitch(APP).isDisabled())))
    await listSwitch(APP).click() // 开
    await openDetail(APP)
    check('C 打开后在跑:前置行 = ok', await waitFor(async () => (await depState()) === 'ok'), String(await depState().catch(() => null)))
    const foot = fl.locator(`[data-plugin-detail="${APP}"] [data-plugin-footprint]`)
    check('C 「运行占用」出现(只在跑的插件才有)', await waitFor(() => foot.count().then((n) => n === 1)))
    await foot.locator('summary').click()
    check('C 「运行占用」列出语言订阅', await waitFor(async () => (await foot.innerText()).includes('订阅')), (await foot.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160))
    await fl.evaluate(() => document.getAnimations().forEach((a) => { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish() }))
    const shotOk = path.join(temp, 'plugin-deps-running.png')
    await fl.screenshot({ path: shotOk })
    console.log(`SCREENSHOT ${shotOk}`)
    await back()

    // D
    await listSwitch(LIB).click() // 关前置
    check('D 关前置先确认,并点名依赖方', await waitFor(async () => dialogs.some((m) => m.includes('Deps App'))), dialogs.join(' / ').slice(0, 160))
    check('D 依赖方暂停 → 回到「等待前置插件」', await waitFor(() => waiting(APP)))
    const shotPaused = path.join(temp, 'plugin-deps-paused.png')
    await fl.screenshot({ path: shotPaused })
    console.log(`SCREENSHOT ${shotPaused}`)

    // E
    await listSwitch(LIB).click() // 开前置
    check('E 前置回来 → 依赖方自动恢复', await waitFor(async () => !(await waiting(APP))))
    await openDetail(APP)
    check('E 恢复后在跑(「运行占用」回来)', await waitFor(() => foot.count().then((n) => n === 1)))

    // F
    await fl.locator('.settings-nav-subitem', { hasText: 'Tangu 引擎插件' }).click()
    const eng = (id) => fl.locator(`[data-engine-plugin="${id}"]`)
    await fl.waitForSelector('[data-engine-plugin="eng-user"]', { timeout: 15000 })
    check('F 引擎插件开着却休眠 → 挂「等待前置插件」', await waitFor(() => eng('eng-user').locator('[data-plugin-waiting]').count().then((n) => n === 1)))
    check('F 引擎插件关着、前置没装 → 开关灰掉', await waitFor(() => eng('eng-off').locator('[role="switch"]').isDisabled()))
    check('F 对照:关着但没声明前置的照常可开', !(await eng('eng-base').locator('[role="switch"]').isDisabled()))
    check('F 上一次启停还在收尾 → 挂「正在收尾」,不是「加载失败」', await waitFor(async () =>
      (await eng('eng-settling').locator('[data-plugin-settling]').count()) === 1 && (await eng('eng-settling').locator('[data-plugin-failed]').count()) === 0))
    await pause(300) // 子页入场动画:没跑完就截是半透明的中间帧
    await fl.evaluate(() => document.getAnimations().forEach((a) => { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish() }))
    const shotEngine = path.join(temp, 'plugin-deps-engine.png')
    await fl.screenshot({ path: shotEngine })
    console.log(`SCREENSHOT ${shotEngine}`)

    // G
    const shotOf = async (w, name) => {
      await w.evaluate(() => document.getAnimations().forEach((a) => { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish() }))
      const file = path.join(temp, `plugin-deps-${name}.png`)
      await w.screenshot({ path: file })
      console.log(`SCREENSHOT ${file}`)
    }
    const floatingStore = () => app.windows().find((w) => !w.isClosed() && w.url().includes('window=floating') && w !== fl)
    const openStore = async () => {
      await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'market', title: 'Market', builtin: 'market', params: { n: Date.now() } }))
      let w
      if (!await waitFor(async () => { w = floatingStore(); return !!w && (await w.locator('.mk-body').count()) > 0 }, 15000)) throw new Error('market window missing')
      await w.getByRole('button', { name: '插件', exact: true }).click()
      await w.waitForSelector('[data-market-install="item-store-app"]', { timeout: 15000 })
      return w
    }
    let mk = await openStore()
    const mkNotice = () => mk.locator('[data-market-notice]')
    const noticeText = () => mkNotice().innerText().catch(() => '')
    const mkOneClick = (id) => mk.locator(`.mk-notice [data-market-deps-install="${id}"]`)
    await mk.locator('[data-market-install="item-store-app"]').click()
    check('G 装完提示条带一键按钮', await waitFor(() => mkOneClick('store-app').count().then((n) => n === 1), 15000), (await noticeText()).replace(/\s+/g, ' ').slice(0, 120))
    check('G 提示条点名缺的前置', (await noticeText()).includes('Store Lib'))
    check('G 卡片挂「等待前置插件」', await waitFor(() => mk.locator('[data-market-waiting="item-store-app"]').count().then((n) => n === 1)))
    await pause(4600)
    check('G 提示条不再 4 秒后消失', (await mkOneClick('store-app').count()) === 1)
    await shotOf(mk, 'store-notice')
    await mkOneClick('store-app').click()
    check('G 一键后依赖方在跑(提示条只在真跑起来才这么说)', await waitFor(async () => (await noticeText()).includes('已开始运行'), 20000), (await noticeText()).replace(/\s+/g, ' ').slice(0, 120))
    check('G 前置连同它自己缺的都落盘', fs.existsSync(path.join(home, 'plugins', `market-${LIB_UUID}`, 'manifest.json')) && fs.existsSync(path.join(home, 'plugins', 'store-base', 'manifest.json')))
    check('G 卡片徽标撤掉', await waitFor(() => mk.locator('[data-market-waiting="item-store-app"]').count().then((n) => n === 0)))
    await fl.locator('.settings-nav-subitem', { hasText: '已安装插件' }).click()
    check('G 设置浮窗不点「重新加载」就看到依赖方在跑', await waitFor(async () => (await card('store-app').count()) === 1 && !(await waiting('store-app')), 15000))
    await openDetail('store-app')
    const storeFoot = fl.locator('[data-plugin-detail="store-app"] [data-plugin-footprint]')
    check('G 「运行占用」出现', await waitFor(() => storeFoot.count().then((n) => n === 1)))
    await back()
    await mk.locator('.mk-card-title', { hasText: 'Store App' }).click()
    await mk.waitForSelector('[data-market-deps="store-app"]', { timeout: 10000 })
    const depRows = () => mk.locator('[data-market-deps] [data-dep-id]')
    const depStates = () => depRows().evaluateAll((els) => els.map((e) => e.dataset.depState))
    check('G 详情页前置全部运行中', (await depStates()).every((s) => s === 'ok') && (await depStates()).length === 1, JSON.stringify(await depStates()))
    check('G 详情页一键按钮收起', (await mk.locator('[data-market-deps] [data-market-deps-install]').count()) === 0)
    await shotOf(mk, 'store-detail-done')
    await mk.locator('.mk-detail-back').click()

    // H
    await mk.locator('[data-market-install="item-lonely-app"]').click()
    check('H 商店装不了 → 提示条如实说、不给按钮', await waitFor(async () => (await noticeText()).includes('Ghost Lib') && (await noticeText()).includes('商店里没有'), 15000), (await noticeText()).replace(/\s+/g, ' ').slice(0, 140))
    check('H 提示条没有一键按钮(诱饵条目不算数)', (await mk.locator('.mk-notice [data-market-deps-install]').count()) === 0)
    await mk.close()
    await waitFor(async () => !floatingStore())
    mk = await openStore()
    await mk.locator('.mk-card-title', { hasText: 'Lonely App' }).click()
    check('H 重开商店,详情页仍列出前置', await waitFor(() => mk.locator('[data-market-deps="lonely-app"]').count().then((n) => n === 1), 15000))
    const depRow = (id) => mk.locator(`[data-market-deps] [data-dep-id="${id}"]`)
    check('H 不在商店的前置写明', (await depRow('ghost-lib').innerText()).includes('商店里没有'), (await depRow('ghost-lib').innerText()).replace(/\s+/g, ' '))
    check('H 商店版本不够写明', (await depRow('store-lib').innerText()).includes('版本还不够'), (await depRow('store-lib').innerText()).replace(/\s+/g, ' '))
    check('H 详情页没有一键按钮', (await mk.locator('[data-market-deps] [data-market-deps-install]').count()) === 0)
    await shotOf(mk, 'store-detail-absent')
    await depRow('ghost-lib').getByRole('button', { name: '在商店中查找' }).click()
    check('H 「在商店中查找」落到搜索', await waitFor(async () => (await mk.locator('.mk-search input').inputValue().catch(() => '')) === 'Ghost Lib'))
    await mk.locator('.mk-search input').fill('')
    await mk.getByRole('button', { name: '插件', exact: true }).click()

    // I
    await mk.locator('[data-market-install="item-flaky-app"]').click()
    await mkOneClick('flaky-app').waitFor({ timeout: 15000 })
    await mkOneClick('flaky-app').click()
    check('I 下载失败 → 错误常驻,按钮变「重试」', await waitFor(async () => (await mk.locator('[data-market-notice="error"]').count()) === 1 && (await mkOneClick('flaky-app').innerText()).includes('重试'), 15000), (await noticeText()).replace(/\s+/g, ' ').slice(0, 140))
    await mkOneClick('flaky-app').click()
    check('I 重试装上,依赖方在跑', await waitFor(async () => (await noticeText()).includes('已开始运行'), 15000), (await noticeText()).replace(/\s+/g, ' ').slice(0, 120))
    check('I 确实下载了两次', store.hits['item-flaky-lib'] === 2, JSON.stringify(store.hits))
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
    await store.close()
  }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok) || results.length === 0) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
