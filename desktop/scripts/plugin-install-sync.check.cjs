/**
 * 「插件装完要刷新 / 重启才出现」的真 Electron 仪器(2026-09-25)。
 *
 * 病根:设置 / 市场自 09-20 住在独立浮窗(独立渲染进程、独立 store),装 / 卸 / 更新后的热重载只刷得动浮窗自己;
 * 插件视图、命令、Space 真正住的主窗要等刷新或重启。修法 = 浮窗广播 extensions-changed,各窗只 reloadOne 点名的 id。
 *
 * 隔离 TANGU_HOME + 假引擎 + 本机假市场(真走 market:install 的下载 / 解压 / 落盘)。夹具插件把 setup / dispose
 * 次数记在**各自窗口**的全局变量上,「主窗装没装上」就是一个可直接读的数。
 *
 *  A 市场浮窗装 Forsion 插件 → 主窗不刷新就跑了它的 setup              ⚠ 负对照靶子:摘掉 announce 广播,A 必须红
 *  B 主窗原有的插件没被连带拆装(收方只重载点名的 id,不 reloadExternal —— 那会关掉用户开着的插件视图)
 *  C 市场里更新 → 主窗换成新代码(旧实例 dispose、新代码 setup)
 *  D 市场里卸载 → 主窗那份实例被拆掉
 *  E 手动拷进插件目录 + 设置浮窗「重新加载」→ 主窗也装上
 *  F 引擎插件装完引擎说要重启 → 提示条说「重启后端后才完整生效」;外接引擎不给重启按钮(按了也重启不了它)
 *  G(--managed,真引擎)贡献路由的引擎插件 → 提示条带「重启后端」→ 点了真重启 → 「已重启」,引擎不再标它待重启
 *  —— 以下四条是 Codex 评审指出「台架会放过」的缺口 ——
 *  R 同版本重装(版本号没变、代码换了)→ 主窗也换成新代码(比不出版本差,只能靠市场点名装的那个 id)
 *  O 两个插件同时装 → 主窗与市场浮窗都各自装上两个。⚠ 只是冒烟:摘掉 amadeusPlugins 的对账队列实跑两次仍绿
 *    (两次全量重载交错的窗口太窄,这套夹具撞不上),队列的正确性靠构造,不靠这条
 *  H 捆绑包升级删掉了内嵌引擎插件 → 提示「重启后端」(旧引擎代码还在跑,新包里却看不见它)
 *  P 插件引导卡「配套推荐」装引擎插件、引擎要重启 → 卡里就地说(那张卡住在浮窗里,全局 toast 不渲染)
 *  S 市场装 Space → 主窗 ribbon 不刷新就出现;市场卸载 → 主窗撤掉(loadUserSpaces 只增不撤,删除要走 space-removed)
 *
 * 用法:npx electron-vite build 之后 `node scripts/plugin-install-sync.check.cjs [--managed]`
 * (--managed 另起一轮托管模式,要求 ../tangu-agent 已 build)。渲染层改动不 build 就跑 = 测旧代码(调试铁律 2)。
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const JSZip = require('jszip')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const MANAGED = process.argv.includes('--managed')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-plugin-sync-'))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { if (await fn()) return true; await pause(100) }
  return false
}

// Forsion 插件 main.js = new Function('ctx', code) 的函数体;计数挂在所在窗口的 window 上。
const counterPlugin = (setupKey, disposeKey) =>
  `window.${setupKey} = (window.${setupKey} || 0) + 1\nreturn () => { window.${disposeKey} = (window.${disposeKey} || 0) + 1 }\n`
const forsionPlugin = (id, version, code) => ({
  'manifest.json': JSON.stringify({ id, name: id, version, minAppVersion: '0.0.1', description: 'plugin-install-sync.check 夹具' }),
  'main.js': code,
})
const zipOf = async (files) => { const z = new JSZip(); for (const [n, c] of Object.entries(files)) z.file(n, c); return z.generateAsync({ type: 'nodebuffer' }) }
function writeDir(dir, files) { fs.mkdirSync(dir, { recursive: true }); for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c) }

/** 本机假市场:只有 market:list / detail / install 用到的四条路,其余一律 404(应用别的云调用会打到这里,404 即无害)。 */
async function startMarket(items, zips) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body) }
    const type = u.searchParams.get('type')
    if (u.pathname === '/api/market/items') return send(200, { items: items.filter((it) => !type || it.type === type) })
    let m = u.pathname.match(/^\/api\/market\/items\/([^/]+)\/install$/)
    if (m) { const it = items.find((x) => x.id === m[1]); return it ? send(200, { type: it.type, installSlug: it.installSlug, downloadUrl: `${base}/dl/${it.id}.zip`, source: 'zip' }) : send(404, {}) }
    m = u.pathname.match(/^\/api\/market\/items\/([^/]+)$/)
    if (m) { const it = items.find((x) => x.id === m[1]); return it ? send(200, { ...it, readme: `# ${it.name}` }) : send(404, {}) }
    m = u.pathname.match(/^\/dl\/([^/]+)\.zip$/)
    if (m && zips[m[1]]) return send(200, zips[m[1]], 'application/zip')
    send(404, { error: 'not_found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { url: base, close: () => new Promise((resolve) => server.close(resolve)) }
}

const card = (id, type, name, latestVersion) => ({
  id, type, source: 'zip', name, summary: `${name}(台架夹具)`, author: 'harness', installSlug: id, downloads: 0,
  latestVersion, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})
// 引擎插件:贡献一条路由 → 真引擎的 activateNewPlugins 报 needsRestart(路由挂不到已建好的 app 上)。
const routePlugin = {
  'tangu-plugin.json': JSON.stringify({ id: 'route-fixture', name: 'Route Fixture', version: '1.0.0', apiVersion: 1, entry: 'index.mjs' }),
  // registerPlugin:引擎插件不自报元数据就进不了 /agent/plugins(G 的最后一条靠它读 needsRestart)。
  'index.mjs': "export default { activate(ctx) {\n"
    + "  ctx.registerPlugin({ id: 'route-fixture', name: 'Route Fixture', description: 'plugin-install-sync.check 夹具' })\n"
    + "  ctx.registerRoutes(({ userRouter }) => userRouter.get('/route-fixture/ping', (_req, res) => res.json({ ok: true })))\n} }\n",
}

async function launch({ home, userData, config, env = {} }) {
  fs.mkdirSync(userData + '-dev', { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify(config))
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, PI_CU_SOCKET_PATH: path.join(temp, `bridge-${path.basename(userData)}.sock`), ...env } })
  const main = await app.firstWindow()
  await main.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
  check(`[${path.basename(userData)}] 主窗已离开首启引导`, await skipOnboarding(main))
  return { app, main }
}

async function openPanel(app, main, opts) {
  await main.evaluate((o) => window.tangu.openFloatingPanel(o), opts)
  let fl
  await waitFor(async () => { fl = app.windows().find((p) => p.url().includes('window=floating') && !p.isClosed()); return !!fl }, 15000)
  if (!fl) throw new Error(`${opts.builtin} floating window missing`)
  fl.on('dialog', (d) => void d.accept()) // 卸载的 window.confirm
  return fl
}

async function marketInstall(mk, name) {
  await mk.fill('.mk-search input', name)
  const btn = mk.locator('.mk-card', { has: mk.locator('.mk-card-title', { hasText: name }) }).locator('.mk-card-foot button').first()
  await btn.waitFor({ timeout: 15000 })
  await btn.click()
  await waitFor(async () => (await btn.getAttribute('data-install-state')) === null && !(await btn.isDisabled()), 20000)
}
const noticeText = (mk) => mk.locator('.mk-notice').innerText().catch(() => '')

// 捆绑包:Forsion 插件目录里内嵌 tangu-plugins/<id>/ 引擎插件(宿主靠标志文件认,见 collectBundleInfo)。
const bundlePlugin = (version, withEngine) => ({
  ...forsionPlugin('bundle-fixture', version, counterPlugin('__bundleSetups', '__bundleDisposed')),
  ...(withEngine ? {
    'tangu-plugins/bundle-engine/tangu-plugin.json': JSON.stringify({ id: 'bundle-engine', name: 'Bundle Engine', version, apiVersion: 1, entry: 'index.mjs' }),
    'tangu-plugins/bundle-engine/index.mjs': 'export default { activate() {} }\n',
  } : {}),
})

async function syncRound() {
  const home = path.join(temp, 'home')
  writeDir(path.join(home, 'plugins', 'keep-fixture'), forsionPlugin('keep-fixture', '1.0.0', counterPlugin('__keepSetups', '__keepDisposed')))
  // P 的宿主:一道没满足的闸(设置还是占位默认值)+ 配套推荐一个引擎插件。重新启用它 = 注意力在场 → 检查卡自己弹。
  writeDir(path.join(home, 'plugins', 'rec-host'), {
    'manifest.json': JSON.stringify({ id: 'rec-host', name: 'Rec Host', version: '1.0.0', minAppVersion: '0.0.1', description: 'plugin-install-sync.check 夹具',
      onboarding: { intro: '夹具', requires: [{ kind: 'setting', key: 'name' }], recommends: [{ type: 'plugin', slug: 'rec-engine', name: 'Rec Engine' }], en: { intro: 'Fixture' } } }),
    'main.js': "ctx.registerSetting({ key: 'name', label: 'Name', type: 'text', default: '占位名' })\n",
  })
  const items = [
    card('sync-fixture', 'amadeus-plugin', 'Sync Fixture', '1.1.0'), card('route-fixture', 'plugin', 'Route Fixture', '1.0.0'),
    card('multi-alpha', 'amadeus-plugin', 'Multi Alpha', '1.0.0'), card('multi-beta', 'amadeus-plugin', 'Multi Beta', '1.0.0'),
    card('bundle-fixture', 'amadeus-plugin', 'Bundle Fixture', '1.1.0'), card('rec-engine', 'plugin', 'Rec Engine', '1.0.0'),
    card('sync-space', 'space', 'Sync Space', '1.0.0'),
  ]
  // 市场上架的是 1.1.0,第一次下到的包是 1.0.0 → 装完卡片显示「更新」,换包后点它走真实的更新路径(C / H)。
  const zips = {
    'sync-fixture': await zipOf(forsionPlugin('sync-fixture', '1.0.0', counterPlugin('__syncSetups', '__syncDisposed'))),
    'route-fixture': await zipOf(routePlugin),
    'multi-alpha': await zipOf(forsionPlugin('multi-alpha', '1.0.0', counterPlugin('__alphaSetups', '__alphaDisposed'))),
    'multi-beta': await zipOf(forsionPlugin('multi-beta', '1.0.0', counterPlugin('__betaSetups', '__betaDisposed'))),
    'bundle-fixture': await zipOf(bundlePlugin('1.0.0', true)),
    'rec-engine': await zipOf({ ...routePlugin, 'tangu-plugin.json': JSON.stringify({ id: 'rec-engine', name: 'Rec Engine', version: '1.0.0', apiVersion: 1, entry: 'index.mjs' }) }),
    // 目录名(sync-space)故意 ≠ 配方 id,验「卸载按配方 id 撤」而不是按目录名
    'sync-space': await zipOf({ 'space.json': JSON.stringify({ id: 'sync-space-recipe', name: 'Sync Space', version: '1.0.0', layout: { main: [{ type: 'changelog' }] } }) }),
  }
  const market = await startMarket(items, zips)
  const engine = { rescanNeedsRestart: true } // 假引擎的重扫结论,按场景改
  const stub = await startStubEngine({
    sessions: [],
    override: ({ path: p, method }) => {
      if (p === '/agent/plugins/rescan' && method === 'POST') return { ok: true, addedIds: [], needsRestart: engine.rescanNeedsRestart, plugins: [] }
      if (/^\/agent\/plugins\/[^/]+\/enabled$/.test(p)) return { ok: true, enabled: true }
      return undefined
    },
  })
  let app
  try {
    const launched = await launch({ home, userData: path.join(temp, 'userdata'),
      config: { mode: 'external', backendUrl: stub.url, token: 'sync-test-token', cloudUrl: market.url }, env: { TANGU_BACKEND_URL: stub.url } })
    app = launched.app
    const main = launched.main
    const g = (key) => main.evaluate((k) => window[k] || 0, key)
    check('前提:主窗启动时装上了原有插件 keep-fixture', await waitFor(async () => (await g('__keepSetups')) === 1, 20000))

    let mk = await openPanel(app, main, { id: 'market', title: 'Market', builtin: 'market' })
    await mk.waitForSelector('.mk-search input', { timeout: 30000 })
    await marketInstall(mk, 'Sync Fixture')
    check('A 市场浮窗装 Forsion 插件 → 主窗不刷新就装上了', await waitFor(async () => (await g('__syncSetups')) === 1), `setup=${await g('__syncSetups')}`)
    check('B 主窗原有插件没被连带拆装', (await g('__keepSetups')) === 1 && (await g('__keepDisposed')) === 0,
      `keep setup=${await g('__keepSetups')} dispose=${await g('__keepDisposed')}`)

    zips['sync-fixture'] = await zipOf(forsionPlugin('sync-fixture', '1.1.0', counterPlugin('__syncV2Setups', '__syncV2Disposed')))
    await marketInstall(mk, 'Sync Fixture') // 此时按钮是「更新」
    check('C 市场里更新 → 主窗换成新代码', await waitFor(async () => (await g('__syncV2Setups')) === 1 && (await g('__syncDisposed')) === 1),
      `v1 dispose=${await g('__syncDisposed')} v2 setup=${await g('__syncV2Setups')}`)

    zips['sync-fixture'] = await zipOf(forsionPlugin('sync-fixture', '1.1.0', counterPlugin('__syncV3Setups', '__syncV3Disposed')))
    await marketInstall(mk, 'Sync Fixture') // 版本已是最新 → 按钮是「重新安装」,包里代码却换了
    check('R 同版本重装 → 主窗也换成新代码', await waitFor(async () => (await g('__syncV3Setups')) === 1 && (await g('__syncV2Disposed')) === 1),
      `v2 dispose=${await g('__syncV2Disposed')} v3 setup=${await g('__syncV3Setups')}`)

    await mk.locator('.mk-card', { has: mk.locator('.mk-card-title', { hasText: 'Sync Fixture' }) }).locator('button[aria-label="卸载"]').click()
    check('D 市场里卸载 → 主窗那份实例被拆掉', await waitFor(async () => (await g('__syncV3Disposed')) === 1), `v3 dispose=${await g('__syncV3Disposed')}`)
    check('B′ 装 / 更新 / 重装 / 卸一圈后原有插件仍只 setup 过一次', (await g('__keepSetups')) === 1 && (await g('__keepDisposed')) === 0)

    // O:两张卡的安装按钮连点,不等第一个装完。
    await mk.fill('.mk-search input', 'Multi')
    const multiBtn = (name) => mk.locator('.mk-card', { has: mk.locator('.mk-card-title', { hasText: name }) }).locator('.mk-card-foot button').first()
    await multiBtn('Multi Alpha').waitFor({ timeout: 15000 })
    await multiBtn('Multi Alpha').click()
    await multiBtn('Multi Beta').click()
    const live = (win, s, d) => win.evaluate(([a, b]) => (window[a] || 0) - (window[b] || 0), [s, d])
    check('O 同时装两个 → 主窗两个都装上', await waitFor(async () => (await live(main, '__alphaSetups', '__alphaDisposed')) === 1 && (await live(main, '__betaSetups', '__betaDisposed')) === 1, 20000),
      `alpha=${await live(main, '__alphaSetups', '__alphaDisposed')} beta=${await live(main, '__betaSetups', '__betaDisposed')}`)
    check('O 市场浮窗自己也没把先装的那个抹掉', (await live(mk, '__alphaSetups', '__alphaDisposed')) === 1 && (await live(mk, '__betaSetups', '__betaDisposed')) === 1,
      `alpha=${await live(mk, '__alphaSetups', '__alphaDisposed')} beta=${await live(mk, '__betaSetups', '__betaDisposed')}`)

    // H:捆绑包 1.0.0 带内嵌引擎插件(引擎说新的不用重启)→ 1.1.0 把它删了 → 旧引擎代码还在,要重启。
    engine.rescanNeedsRestart = false
    await marketInstall(mk, 'Bundle Fixture')
    const h1 = await noticeText(mk)
    check('H 前提:首装捆绑包、引擎不要重启 → 不提示重启', h1.includes('已安装并加载') && !h1.includes('重启后端'), h1.replace(/\s+/g, ' '))
    zips['bundle-fixture'] = await zipOf(bundlePlugin('1.1.0', false))
    await marketInstall(mk, 'Bundle Fixture')
    const h2 = await noticeText(mk)
    check('H 升级删掉了内嵌引擎插件 → 提示重启后端', h2.includes('重启后端后才完整生效'), h2.replace(/\s+/g, ' '))
    engine.rescanNeedsRestart = true

    await marketInstall(mk, 'Route Fixture')
    const f = await noticeText(mk)
    check('F 引擎插件要重启才生效 → 提示条如实说「重启后端」', f.includes('重启后端后才完整生效'), f.replace(/\s+/g, ' '))
    check('F 外接引擎不给重启按钮', (await mk.locator('[data-market-restart]').count()) === 0)

    // S:SpaceButton 收起态把名字放在 title 上,展开态是正文;ribbon 放不下的收进「更多」悬停浮层 —— 三处都认
    const hasSpace = async () => {
      if (await main.evaluate((n) => !!document.querySelector(`[title="${n}"]`)
        || [...document.querySelectorAll('button, [role="button"]')].some((b) => b.textContent.trim() === n), 'Sync Space')) return true
      for (const more of await main.locator('.rb-more').all()) {
        await more.hover().catch(() => {})
        const hit = await main.locator('.rb-fly').filter({ hasText: 'Sync Space' }).count().catch(() => 0)
        await main.mouse.move(1, 1)
        if (hit) return true
      }
      return false
    }
    await marketInstall(mk, 'Sync Space')
    const sOk = await waitFor(hasSpace)
    check('S 市场装 Space → 主窗 ribbon 不刷新就出现', sOk, sOk ? '' : JSON.stringify({
      notice: (await noticeText(mk)).replace(/\s+/g, ' '),
      list: await main.evaluate(async () => (await window.tangu.spacesList())?.map((x) => x.slug)),
      titles: await main.evaluate(() => [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).filter(Boolean).slice(0, 40)),
    }))
    await mk.locator('.mk-card', { has: mk.locator('.mk-card-title', { hasText: 'Sync Space' }) }).locator('button[aria-label="卸载"]').click()
    check('S 市场卸载 Space → 主窗撤掉', await waitFor(async () => !(await hasSpace())))
    await mk.close()

    writeDir(path.join(home, 'plugins', 'drop-fixture'), forsionPlugin('drop-fixture', '1.0.0', counterPlugin('__dropSetups', '__dropDisposed')))
    const st = await openPanel(app, main, { id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins' } })
    await st.getByRole('button', { name: '重新加载', exact: true }).click({ timeout: 30000 })
    check('E 手动拷进插件目录 + 设置里「重新加载」→ 主窗也装上', await waitFor(async () => (await g('__dropSetups')) === 1), `setup=${await g('__dropSetups')}`)
    check('E 「重新加载」点名了全部插件,没变的照样不拆装', (await g('__keepSetups')) === 1 && (await g('__keepDisposed')) === 0)

    // P:关掉再打开闸插件 → 检查卡弹出 → 在卡里装配套推荐的引擎插件(假引擎说要重启)
    const hostBox = st.locator('[data-plugin-id="rec-host"] input[type="checkbox"]')
    await hostBox.click()
    await pause(300)
    await hostBox.click()
    const obCard = st.locator('.plugin-onboarding-card')
    await obCard.waitFor({ timeout: 15000 })
    await obCard.getByRole('button', { name: '安装', exact: true }).click({ timeout: 15000 })
    check('P 引导卡装的引擎插件要重启 → 卡里就地说', await waitFor(() => obCard.locator('[data-rec-restart-hint]').count().then((n) => n === 1), 15000))
    check('P 外接引擎不给重启按钮', (await obCard.locator('[data-rec-restart]').count()) === 0)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
    await market.close()
  }
}

async function managedRound() {
  const entry = path.join(ROOT, '..', 'tangu-agent', 'dist', 'standalone', 'main.js')
  if (!fs.existsSync(entry)) { check('G 前提:tangu-agent 已 build', false, entry); return }
  const home = path.join(temp, 'home-managed')
  fs.mkdirSync(home, { recursive: true })
  const market = await startMarket([card('route-fixture', 'plugin', 'Route Fixture', '1.0.0')], { 'route-fixture': await zipOf(routePlugin) })
  let app
  try {
    const launched = await launch({ home, userData: path.join(temp, 'userdata-managed'), config: { mode: 'managed', cloudUrl: market.url } })
    app = launched.app
    const main = launched.main
    const ready = await waitFor(() => main.evaluate(async () => (await window.tangu.backendStatus?.())?.state === 'ready').catch(() => false), 60000)
    check('G 前提:托管引擎起来了', ready)
    const mk = await openPanel(app, main, { id: 'market', title: 'Market', builtin: 'market' })
    await mk.waitForSelector('.mk-search input', { timeout: 30000 })
    await marketInstall(mk, 'Route Fixture')
    const restart = mk.locator('[data-market-restart]')
    check('G 真引擎报路由要重启 → 提示条带「重启后端」按钮', await waitFor(() => restart.count().then((n) => n === 1), 15000), (await noticeText(mk)).replace(/\s+/g, ' '))
    const shot = path.join(temp, 'market-restart-notice.png')
    await mk.screenshot({ path: shot })
    console.log(`SCREENSHOT ${shot}`)
    const pidBefore = await main.evaluate(async () => (await window.tangu.backendStatus())?.pid)
    await restart.click()
    check('G 点了真重启 → 提示「已重启」', await waitFor(async () => (await noticeText(mk)).includes('后端已重启'), 60000), (await noticeText(mk)).replace(/\s+/g, ' '))
    const after = await main.evaluate(async () => window.tangu.backendStatus())
    check('G 引擎进程确实换了', !!after?.pid && after.pid !== pidBefore, `${pidBefore} → ${after?.pid}`)
    const probe = await main.evaluate(async (url) => {
      const cfg = await window.tangu.getConfig()
      const r = await fetch(`${url}/agent/plugins`, { headers: { Authorization: `Bearer ${cfg.token}` } })
      const j = await r.json().catch(() => ({}))
      return { status: r.status, ids: (j.plugins || []).map((p) => p.id), hit: (j.plugins || []).find((p) => p.id === 'route-fixture') }
    }, after?.url)
    check('G 重启后引擎认得它、不再标待重启', !!probe.hit && probe.hit.needsRestart === false,
      JSON.stringify({ status: probe.status, ids: probe.ids, needsRestart: probe.hit?.needsRestart }))
  } finally {
    if (app) await app.close().catch(() => {})
    await market.close()
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  await syncRound()
  if (MANAGED) await managedRound()
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok) || results.length === 0) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
