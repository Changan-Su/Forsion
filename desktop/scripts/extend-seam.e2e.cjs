/**
 * Forsion Extend 主进程半身 × 真 Electron(electron/cloudHost.ts):清单里带 desktop 的内置包,启动时验签装载,
 * 云端账号面 IPC(个人中心 / 会员页 / 额度 / 反馈 / cloud:fetch)由它注册,不再住在 main.ts。
 *
 * 钉住:
 *  ① dev 随包(node_modules/@forsion/extend)播种进 <home>/plugins/forsion-extend/(含 SIGNATURE),[cloud-host] 装载成功;
 *  ② 渲染层 window.tangu.accountQuota / submitFeedback / cloudFetch / openPayCenter 都在;未登录 accountQuota → {status:401,json:null};
 *     cloudFetch 绝对 URL → bad_path(token 不出主进程、边界仍在);②b Connect 三个桥键由 Extend 0.2 注册,越界 publish 被拒;
 *  ③ 已装副本被改过(用户目录可写:版本抬高、入口改动、没重签)→ 下次启动播种把它换回可信的随包那份(永不降级的唯一例外),
 *     装载的是换回来的已装副本,账号面仍在;
 *  ④ 负对照 --absent:随包缺席 → preload 按 cloud:present 删键,四个键全 undefined(渲染层门控自动隐藏,不是 reject)。
 *  ⑤ 设备互联的云端通道(0.5 起):已登录 + 打开「允许其他设备连接本机」+ 本机假 hub → 设备通道经 Extend 登记的工厂入册、连上通道、
 *     报 caps;名册四键随包出现,切换器里列出账号名下的另一台设备。④d 负对照:同样配置、随包缺席 → 一个请求都不打 hub,
 *     局域网面照起(unitHostStatus 有端口)、切换器照样上架但没有名册行。
 *
 * 需先 npm run build(读 out/)。用法:npm run e2e:extend;负对照:node scripts/extend-seam.e2e.cjs --absent
 * 前置:node_modules/@forsion/extend 是签过名的 npm 包(npm install 装的;本地 pack 的也行,签名用同一把钥匙)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const ABSENT = process.argv.includes('--absent')
const BUNDLED = path.join(ROOT, 'node_modules', '@forsion', 'extend')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 本机假 unit-hub:入册 → 通道(SSE,ready 帧 + 心跳)→ caps;名册两台(本机 + 另一台)。其余一律 404(whoami / 云同步也打到这里,404 不会转登出)。 */
const HUB_UNIT = 'e2e-unit-0001'
function startFakeHub() {
  const hits = []
  const server = http.createServer((req, res) => {
    const url = req.url || ''
    hits.push({ method: req.method, url, auth: String(req.headers.authorization || ''), secret: String(req.headers['x-unit-secret'] || '') })
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'POST' && url === '/api/units/register') { req.resume(); return json(200, { unitId: HUB_UNIT, secret: 'e2e-unit-secret' }) }
    if (req.method === 'GET' && url === `/api/units/${HUB_UNIT}/channel`) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\nevent: ready\ndata: {"caps":[]}\n\n')
      const hb = setInterval(() => res.write(': hb\n\n'), 10_000)
      res.on('close', () => clearInterval(hb))
      return
    }
    if (req.method === 'POST' && url === `/api/units/${HUB_UNIT}/caps`) { req.resume(); return json(200, {}) }
    if (req.method === 'GET' && url === '/api/units') {
      return json(200, { units: [{ id: HUB_UNIT, name: 'E2E This Mac', online: true, kind: 'desktop' }, { id: 'e2e-unit-0002', name: 'E2E Other Mac', online: false, kind: 'desktop' }] })
    }
    req.resume()
    json(404, { detail: 'not found' })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, hits, close: () => { server.closeAllConnections(); server.close() },
  })))
}
/** 预置「已登录(auth.json 指向假 hub)+ 允许其他设备连接本机」。shell 配置在 dev userData(--user-data-dir + '-dev')里,已有就合并。 */
function presetUnitHost(home, hubUrl) {
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: hubUrl, token: 'e2e-token' }))
  const ud = path.join(home, 'userdata-dev')
  fs.mkdirSync(ud, { recursive: true })
  const shellPath = path.join(ud, 'tangu-desktop-config.json')
  let shell = {}
  try { shell = JSON.parse(fs.readFileSync(shellPath, 'utf8')) } catch { /* 首次 */ }
  fs.writeFileSync(shellPath, JSON.stringify({ ...shell, unitHostEnabled: true }, null, 2))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 打开切换器读它列出的行(标题文字)。临时家目录是首启:先点掉首启引导,否则它盖住外壳、点不到切换器。 */
async function switcherRows(win) {
  if (!(await skipOnboarding(win))) return ['<首启引导没点掉>']
  if (!(await win.$('.unitsw-pill'))) return null
  await win.click('.unitsw-pill', { timeout: 10_000 })
  await win.waitForSelector('.unitsw-menu', { timeout: 5000 })
  await win.waitForTimeout(1000) // refresh():名册 + 通道状态 + 已配对设备并发取
  return win.$$eval('.unitsw-menu .unitsw-title', (els) => els.map((e) => e.textContent || ''))
}

async function launch(home, stubUrl) {
  const logs = []
  const app = await electron.launch({
    // -ApplePersistenceIgnoreState:所有台架与用户 dev 实例共用同一个 node_modules/electron/dist/Electron.app,前一个实例被杀后
    // macOS 会弹「应用在重新打开窗口时意外退出」模态框,主进程卡在 NSAlert runModal、永远不出窗口(同日日志「Electron 台架启动卡死」)。
    // ⚠️ 单短横的 Cocoa 参数必须放在应用路径之后:放前面会被 Electron 当成应用路径,launch 直接超时。
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    // ELECTRON_ENABLE_LOGGING:主进程 console 实时走 stderr;不开的话 stdout 是管道时要到进程退出才冲出来,起不来窗口就什么也看不到。
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 90_000,
  })
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => logs.push(String(d)))
  // 机器满载时(别的会话在打包)冷启动可能超过 Playwright 默认的 30s;超时把主进程日志尾巴带出来,别只报「没窗口」。
  // 卡住的主进程连 SIGTERM 都不理,app.close() 会一起挂死 —— 直接 SIGKILL。
  const win = await app.firstWindow({ timeout: 120_000 }).catch(async (e) => {
    try { app.process().kill('SIGKILL') } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 500))
    throw new Error(`${e.message}\n--- main log tail ---\n${logs.join('').split('\n').filter((l) => !/AppleShowScrollBars|^\s*$/.test(l)).slice(-15).join('\n')}`)
  })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(1500)
  const bridge = await win.evaluate(async () => {
    const t = window.tangu || {}
    const out = {
      accountQuota: typeof t.accountQuota, submitFeedback: typeof t.submitFeedback, cloudFetch: typeof t.cloudFetch, openPayCenter: typeof t.openPayCenter,
      connectStore: typeof t.connectStore, connectPublish: typeof t.connectPublish, connectMeta: typeof t.connectMeta,
      // 账号核心(Extend 0.3 起):登录 / 状态 / 多账号也是 Extend 的通道
      authStatus: typeof t.authStatus, forsionLogin: typeof t.forsionLogin, authAccounts: typeof t.authAccounts, forsionSwitchAccount: typeof t.forsionSwitchAccount,
      // 云同步 + collab(Extend 0.4 起):两个桥随通道存在
      amadeusSync: typeof window.amadeusSync, amadeusCollab: typeof window.amadeusCollab,
      // 设备名册(Extend 0.5 起);unitHostStatus 留宿主(局域网面)
      unitsList: typeof t.unitsList, unitsUpdate: typeof t.unitsUpdate, unitsRemove: typeof t.unitsRemove, unitsOpenInBrowser: typeof t.unitsOpenInBrowser,
      unitHostStatus: typeof t.unitHostStatus,
      // 渲染层门控的可见结果:账号卡(ribbon 底部)与设置里的 Forsion 子页是否存在
      dom: {
        accountCard: !!document.querySelector('.ribbon-account, .account-card'),
        unitSwitcher: !!document.querySelector('.unitsw-pill'),
      },
    }
    if (typeof t.unitsList === 'function') out.units = await t.unitsList()
    if (window.amadeusSync) out.syncStatus = await window.amadeusSync.get()
    if (typeof t.authStatus === 'function') out.status = await t.authStatus()
    if (typeof t.authAccounts === 'function') out.accounts = await t.authAccounts()
    if (typeof t.accountQuota === 'function') out.quota = await t.accountQuota()
    if (typeof t.cloudFetch === 'function') out.evil = await t.cloudFetch({ path: 'https://evil.test/x' })
    // Connect(Extend 0.2 起):meta 读不存在的目录 → {};publish 越界目录 → 拒(不打云端)
    if (typeof t.connectMeta === 'function') out.meta = await t.connectMeta('/nonexistent/project-dir')
    if (typeof t.connectPublish === 'function') out.publishOutside = await t.connectPublish({ dir: '/tmp', name: 'x', slug: 'x', entry: 'index.html' })
    return out
  })
  return { app, win, logs: () => logs.join(''), bridge }
}

;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-extend-seam-'))
  const stub = await startStubEngine({ models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off'] }] })
  const hub = await startFakeHub()
  const installed = path.join(home, 'plugins', 'forsion-extend')
  let hidden = null
  try {
    if (ABSENT) {
      hidden = `${BUNDLED}.absent-${process.pid}`
      fs.renameSync(BUNDLED, hidden)
      presetUnitHost(home, hub.url) // ④d:已登录 + 打开互联,缺包时设备通道不该碰 hub
      const { app, win, logs, bridge } = await launch(home, stub.url)
      await sleep(5000) // 给「本该入册」的那一轮留足时间(有 Extend 时入册在开窗后一两秒内)
      const hostStatus = await win.evaluate(() => window.tangu?.unitHostStatus?.())
      const rows = await switcherRows(win)
      await app.close().catch(() => {})
      const unitHits = hub.hits.filter((h) => h.url.startsWith('/api/units'))
      check('④d 设备名册与云端通道(0.5 起)也随包消失:名册四键 undefined、一个请求都不打 hub;局域网面照起(unitHostStatus 有端口、通道未运行)',
        bridge.unitsList === 'undefined' && bridge.unitsUpdate === 'undefined' && bridge.unitsRemove === 'undefined' && bridge.unitsOpenInBrowser === 'undefined'
        && bridge.unitHostStatus === 'function' && unitHits.length === 0 && hostStatus?.running === false && typeof hostStatus?.webPort === 'number'
        && logs().includes('没有 Forsion Extend 的设备通道'),
        JSON.stringify({ unitsList: bridge.unitsList, unitHits: unitHits.map((h) => `${h.method} ${h.url}`), hostStatus }))
      check('④e 切换器照样上架(本地 / 按地址直连 / 允许其他设备连接本机都不经云端),但没有名册行',
        bridge.dom?.unitSwitcher === true && Array.isArray(rows) && rows.some((r) => r.includes('通过地址连接')) && !rows.some((r) => r.includes('E2E Other Mac')),
        JSON.stringify(rows))
      check('④ 随包缺席:播种跳过、装载器没装、cloud:present=[] → 账号面与 Connect 的桥键全从 window.tangu 删掉', bridge.accountQuota === 'undefined' && bridge.submitFeedback === 'undefined' && bridge.cloudFetch === 'undefined' && bridge.openPayCenter === 'undefined' && bridge.connectStore === 'undefined' && bridge.connectPublish === 'undefined' && !fs.existsSync(installed), JSON.stringify(bridge))
      check('④b 账号核心(0.3 起)也随包消失:authStatus / forsionLogin / authAccounts / forsionSwitchAccount 全 undefined,账号卡不画', bridge.authStatus === 'undefined' && bridge.forsionLogin === 'undefined' && bridge.authAccounts === 'undefined' && bridge.forsionSwitchAccount === 'undefined' && bridge.dom?.accountCard === false, JSON.stringify({ authStatus: bridge.authStatus, dom: bridge.dom }))
      check('④c 云同步 + collab(0.4 起)也随包消失:window.amadeusSync / amadeusCollab 都不暴露', bridge.amadeusSync === 'undefined' && bridge.amadeusCollab === 'undefined', JSON.stringify({ amadeusSync: bridge.amadeusSync, amadeusCollab: bridge.amadeusCollab }))
      check('④ 主进程日志:随包来源缺失被记下(不是静默)', logs().includes('随包来源缺失'), logs().split('\n').filter((l) => l.includes('builtin')).join(' / ').slice(0, 200))
    } else {
      const bundledVersion = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'manifest.json'), 'utf8')).version
      // 本机 node_modules 里的那份必须就是 package.json 钉的版本:「声明 0.1、实装 0.2」会让这份台架假绿而干净安装红(Codex)
      const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies['@forsion/extend']
      check(`⓪ node_modules 里的 @forsion/extend@${bundledVersion} = package.json 钉的 ${pinned}`, bundledVersion === pinned)
      const run1 = await launch(home, stub.url)
      await run1.app.close().catch(() => {})
      const seeded = fs.existsSync(path.join(installed, 'SIGNATURE')) && JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8')).version === bundledVersion
      check(`① 随包 @forsion/extend@${bundledVersion} 播种进 <home>/plugins/forsion-extend(含 SIGNATURE),[cloud-host] 装载成功`, seeded && run1.logs().includes(`[cloud-host] 已装载 forsion-extend@${bundledVersion}`), run1.logs().split('\n').filter((l) => l.includes('cloud-host') || l.includes('builtin-plugins')).join(' / ').slice(0, 300))
      check('② 渲染层四个云端键都在;未登录 accountQuota → 401;cloudFetch 绝对 URL → bad_path', run1.bridge.accountQuota === 'function' && run1.bridge.submitFeedback === 'function' && run1.bridge.cloudFetch === 'function' && run1.bridge.openPayCenter === 'function' && run1.bridge.quota?.status === 401 && run1.bridge.quota?.json === null && run1.bridge.evil?.error === 'bad_path', JSON.stringify(run1.bridge))
      check('②b Connect(0.2 起)由 Extend 注册:三个 connect 键在;meta 读不存在目录 → {};publish 越界目录被拒且不打云端', run1.bridge.connectStore === 'function' && run1.bridge.connectPublish === 'function' && run1.bridge.connectMeta === 'function' && JSON.stringify(run1.bridge.meta) === '{}' && run1.bridge.publishOutside?.ok === false && /只能发布|不存在/.test(String(run1.bridge.publishOutside?.detail)), JSON.stringify({ meta: run1.bridge.meta, publishOutside: run1.bridge.publishOutside }))
      check('②d 云同步 + collab(0.4 起)由 Extend 注册:amadeusSync / amadeusCollab 两个桥都在;未登录 sync:get → auth-required / side=local', run1.bridge.amadeusSync === 'object' && run1.bridge.amadeusCollab === 'object' && run1.bridge.syncStatus?.state === 'auth-required' && run1.bridge.syncStatus?.side === 'local' && run1.logs().includes('[forsion-extend] amadeus cloud sync registered'), JSON.stringify(run1.bridge.syncStatus))
      check('②c 账号核心(0.3 起)由 Extend 注册:authStatus 未登录 → loggedIn=false / tokenSource=null / 不含 token;authAccounts=[];账号卡画出来了', run1.bridge.authStatus === 'function' && run1.bridge.forsionLogin === 'function' && run1.bridge.status?.loggedIn === false && run1.bridge.status?.tokenSource === null && !('token' in (run1.bridge.status || {})) && Array.isArray(run1.bridge.accounts) && run1.bridge.accounts.length === 0 && run1.bridge.dom?.accountCard === true && run1.logs().includes('[forsion-extend] account core registered'), JSON.stringify({ status: run1.bridge.status, accounts: run1.bridge.accounts, dom: run1.bridge.dom }))

      check('②e 设备名册(0.5 起)由 Extend 注册:名册四键在;未登录 unitsList → 401;装载日志有 unit hub registered;切换器上架',
        run1.bridge.unitsList === 'function' && run1.bridge.unitsUpdate === 'function' && run1.bridge.unitsRemove === 'function' && run1.bridge.unitsOpenInBrowser === 'function'
        && run1.bridge.units?.status === 401 && run1.logs().includes('[forsion-extend] unit hub registered') && run1.bridge.dom?.unitSwitcher === true,
        JSON.stringify({ units: run1.bridge.units, unitsList: run1.bridge.unitsList }))

      // ③ 用户目录里的副本被改:抬版本 + 改入口 + 不重签
      const evil = fs.readFileSync(path.join(installed, 'dist', 'desktop.mjs'), 'utf8') + '\n// tampered'
      fs.writeFileSync(path.join(installed, 'dist', 'desktop.mjs'), evil)
      const m = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'))
      fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify({ ...m, version: '9.9.9' }))
      const run2 = await launch(home, stub.url)
      await run2.app.close().catch(() => {})
      const healed = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8')).version === bundledVersion
        && !fs.readFileSync(path.join(installed, 'dist', 'desktop.mjs'), 'utf8').includes('// tampered')
      check('③ 改过的已装副本:播种验签失败后换回随包那份(9.9.9 → 随包版本),装载的是换回来的已装副本,账号面仍在', healed && run2.logs().includes('已装副本验签失败') && run2.logs().includes(`[cloud-host] 已装载 forsion-extend@${bundledVersion}(${installed})`) && run2.bridge.accountQuota === 'function' && run2.bridge.quota?.status === 401, run2.logs().split('\n').filter((l) => l.includes('cloud-host') || l.includes('builtin-plugins] forsion')).join(' / ').slice(0, 400))

      // ⑤ 设备互联的云端通道走接缝:已登录 + 打开互联 → 真 Electron 里由 Extend 登记的工厂建通道,入册 / 通道 / caps 都打到假 hub
      presetUnitHost(home, hub.url)
      const run3 = await launch(home, stub.url)
      let connected = null
      for (let i = 0; i < 40; i++) {
        connected = await run3.win.evaluate(() => window.tangu?.unitHostStatus?.())
        if (connected?.connected && hub.hits.some((h) => h.url === `/api/units/${HUB_UNIT}/caps`)) break
        await sleep(250)
      }
      const units3 = await run3.win.evaluate(() => window.tangu?.unitsList?.())
      const rows3 = await switcherRows(run3.win)
      await run3.app.close().catch(() => {})
      const reg = hub.hits.find((h) => h.method === 'POST' && h.url === '/api/units/register')
      const chan = hub.hits.find((h) => h.method === 'GET' && h.url === `/api/units/${HUB_UNIT}/channel`)
      const caps = hub.hits.find((h) => h.method === 'POST' && h.url === `/api/units/${HUB_UNIT}/caps`)
      check('⑤ 设备通道经 Extend 工厂连上假 hub:入册带账号 Bearer、通道带设备密钥、ready 之后报 caps;unitHostStatus connected + 入册的 unit id',
        !!reg && reg.auth === 'Bearer e2e-token' && !!chan && chan.secret === 'e2e-unit-secret' && !!caps && connected?.connected === true && connected?.unitId === HUB_UNIT,
        JSON.stringify({ hits: hub.hits.filter((h) => h.url.startsWith('/api/units')).map((h) => `${h.method} ${h.url}`), status: connected }))
      check('⑤b 名册随包出现:unitsList → 200 两台;切换器列出另一台(本机那行被滤掉)',
        units3?.status === 200 && units3?.json?.units?.length === 2 && Array.isArray(rows3) && rows3.some((r) => r.includes('E2E Other Mac')) && !rows3.some((r) => r.includes('E2E This Mac')),
        JSON.stringify({ units: units3?.status, rows: rows3 }))
    }
  } catch (e) {
    check('台架本身没炸', false, String(e?.stack || e).slice(0, 400))
  } finally {
    if (hidden) fs.renameSync(hidden, BUNDLED)
    stub.close()
    hub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${ABSENT ? '(负对照)' : ''}`)
  process.exit(failed ? 1 : 0)
})()
