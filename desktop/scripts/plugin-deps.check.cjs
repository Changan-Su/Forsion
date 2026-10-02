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
 *  F 引擎插件页(桩引擎按新引擎形状给列表):开着却休眠的挂「等待前置插件」;关着且前置没齐的开关灰掉
 *
 * 用法:npx electron-vite build 之后 `npm run check:plugindeps`。渲染层改动不 build 就跑 = 测的是旧代码(调试铁律 2)。
 */
const fs = require('fs'), os = require('os'), path = require('path')
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
    ] } : undefined),
  })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'deps-test-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
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
    check('F 引擎插件关着、前置没装 → 开关灰掉', await waitFor(() => eng('eng-off').locator('input[type="checkbox"]').isDisabled()))
    check('F 对照:关着但没声明前置的照常可开', !(await eng('eng-base').locator('input[type="checkbox"]').isDisabled()))
    await pause(300) // 子页入场动画:没跑完就截是半透明的中间帧
    await fl.evaluate(() => document.getAnimations().forEach((a) => { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish() }))
    const shotEngine = path.join(temp, 'plugin-deps-engine.png')
    await fl.screenshot({ path: shotEngine })
    console.log(`SCREENSHOT ${shotEngine}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok) || results.length === 0) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
