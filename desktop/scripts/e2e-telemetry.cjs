/**
 * 帮助改进 Forsion(匿名遥测)端到端,契约 v2:真 Electron(隔离 home)× 本地构建并签名的 Forsion Extend × 本地收件桩(兼商店夹具)。
 * 隔离 home 预置一份假登录(auth.json:cloudUrl = 收件桩、JWT 形状的假 token):Extend 11-05 起没登录一条都不发。
 *   ① 首启引导四屏(开始 / 外观 / 关于你 / 团队):开始那屏「帮助改进」那行(StartScreen 的 ImproveRow)登录后开关开、
 *      详情不自己弹,这一行进了可视区就记看过告知(11-07)→ 走完
 *   ② ⌘P 快速查找打开、Esc 关 → app_counts searchOpen / searchCloseEmpty + command_use quick-find / hotkey
 *   ③ 商店装一个夹具条目(安装信息接口回 404)→ plugin_install { id: 商店条目 UUID, stage: resolve, outcome: error, errorClass: http }
 *   ④ 渲染层抛错(带主目录、引号、密钥样式)→ crash 不带原文
 *   ⑤ 宿主 → Extend 这一侧(FORSION_TELEMETRY_TRACE 旁路,main.ts):上面这些都交出去了、形状对
 *   ⑥ Extend 第一跳(启动后 60 s)→ 收件桩:onboarding / plugin_install / crash 到了,和宿主交出的逐字段一致;请求里没有凭据、原文
 *   ⑦ 退出:before-quit 把本小时的计数交给 Extend、落进它的 queue.jsonl → 同一个 home 再起:第一跳带上 app_counts / command_use + startup
 * 契约 v3(§19)另加:
 *   ④b 新装第一次发消息(桩引擎一条 done 的 run)→ first_run { outcome: done };主窗插件清单(Forsion 插件 + 桩里的引擎插件)→ plugin_inventory;
 *      quotaPrompt / modelCount 经 preload 交给主进程(表外的入口 / 键被丢)→ 退出时攒成 quota_prompt / model_feedback;
 *      带 entry 的 openPayCenter 对**当前 EXTEND 检出**照常成功(entry 追加在第四位,前三位 undefined;老 Extend 不看第四位)。
 *   first_run / plugin_inventory 只在 Extend 报「可发」时才交出:两个负对照里旁路一条都没有。
 *   收件桩那一侧:EXTEND 的白名单 ≥ 3 才核这四条到了;老 Extend(< 3)核它们一条都没混进批次(HOST_EVENTS 外的丢掉)。
 * 负对照(都要实跑):
 *   NEG=1         不带 FORSION_TELEMETRY=force(= 开发版)→ 宿主照样交出(旁路里有),收件桩一批都收不到、Extend 不落队列。
 *   NEG=signedout 从头到尾不登录(带 force):引导里那一行开关灰着也是关、写「登录后才能开」、详情不弹、Extend 不记看过告知;
 *                 之后把告知直接记成看过、只留「没登录」这一道闸 → 收件桩一批都收不到、Extend 不落队列。
 *
 *   EXTEND=<Forsion-Extend 检出(遥测 v2,已 build + sign)> [OUT=<截图目录>] [NEG=1|signedout] npm run e2e:telemetry
 *   先在 DESK 里 npx electron-vite build;跑的时候占 GUI 锁(node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run e2e:telemetry)。
 *   整轮约 3 分钟(Extend 两次第一跳各 60 s)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const assert = require('assert/strict')
const DESK = process.env.DESK || path.resolve(__dirname, '..')
const EXTEND = process.env.EXTEND
const OUT = process.env.OUT
const NEG = process.env.NEG || ''
if (!EXTEND) { console.error('need EXTEND=<Forsion-Extend checkout, built and signed>'); process.exit(2) }
if (!['', '1', 'signedout'].includes(NEG)) { console.error('NEG must be 1 or signedout'); process.exit(2) }
const DEV_BUILD = NEG === '1'
const SIGN_IN = NEG !== 'signedout'
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { startStubEngine } = require(path.join(DESK, 'scripts/lib/stub-engine.cjs'))

/** 商店夹具:一个 Forsion 插件条目,id 是商店条目 UUID(公开 id),目录名是作者自起的。 */
const ITEM = { id: '7d3f0c52-6a41-4c8e-9f0b-2e5d8a1c4b67', name: 'Telemetry Fixture', type: 'amadeus-plugin', installSlug: 'telemetry-fixture', source: 'github',
  latestVersion: '1.0.0', author: 'Fixture', summary: 'Telemetry e2e fixture', downloads: 0, tags: [] }

/** JWT 形状的假 token:账号核心按 payload.userId 认账号,不是 JWT 形状就当没有账号(同 extend-seam.e2e)。 */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'e2e-telemetry-user', username: 'e2e_user', iat: Math.floor(Date.now() / 1000) })}.e2e`

/** 收件桩(兼假云端):POST /api/telemetry/batch 记下请求头与请求体;带 token 的 whoami 回一个用户(401/403 会被当成失效转登出);
 *  商店列表 / 详情给夹具,安装信息 404;别的路径 404。 */
function startSink() {
  const batches = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const u = new URL(req.url, 'http://sink')
      const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
      if (req.method === 'POST' && u.pathname === '/api/telemetry/batch') { batches.push({ headers: req.headers, body: JSON.parse(body) }); return res.writeHead(204).end() }
      if (req.method === 'GET' && u.pathname === '/api/brain/users/me' && /^Bearer \S+/.test(req.headers.authorization || '')) {
        return send(200, { id: 'e2e-telemetry-user', username: 'e2e_user', role: 'USER', nickname: 'E2E', avatar: null, email: null, emailVerified: false, phone: null, phoneVerified: false, membershipTier: 'free' })
      }
      if (u.pathname === '/api/market/items') return send(200, { items: !u.searchParams.get('type') || u.searchParams.get('type') === ITEM.type ? [ITEM] : [] })
      if (u.pathname === `/api/market/items/${ITEM.id}`) return send(200, { ...ITEM, readme: '# Fixture' })
      send(404, {})
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, batches, close: () => { server.closeAllConnections(); server.close() },
  })))
}

/** 按 package.json files 白名单把 Extend 包拷进隔离 home 的 plugins/forsion-extend(同用户 dev 的装法)。 */
function installExtend(home) {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTEND, 'package.json'), 'utf8'))
  const dest = path.join(home, 'plugins', 'forsion-extend')
  fs.mkdirSync(dest, { recursive: true })
  for (const f of ['package.json', ...(pkg.files || [])]) {
    const src = path.join(EXTEND, f)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, f), { recursive: true })
  }
  return pkg.version
}

const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-telemetry-e2e-'))
  const version = installExtend(home)
  const sink = await startSink()
  const trace = path.join(home, 'telemetry-trace.jsonl')
  const queue = path.join(home, 'telemetry', 'queue.jsonl')
  if (SIGN_IN) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: sink.url, token: TOKEN }), { mode: 0o600 })
  // 团队那屏读 / 写 /agent/special/config、写第一次见面(muse/intro);桩引擎缺省没有这几条 → 那屏卡住
  const specialConfig = {
    historian: { enabled: true, modelId: '', everyRounds: 7, firstRoundTrigger: true, autoEmoji: false, mode: 'independent', prompt: '', harnessCandidates: true },
    muse: { enabled: true, modelId: '', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5,
      supervisorPollMinutes: 5, activeHours: { start: 9, end: 17 }, allowedFolders: [], mode: 'ask', heartbeatMinutes: 120, notify: 'digest', escalateTo: '' },
  }
  const stub = await startStubEngine({ models: [{ id: 'cloud-1', name: 'GPT-6 Luna', provider: 'OpenAI', source: 'forsion', modelType: 'llm' }],
    override: async ({ path: p, method }) => (p === '/agent/special/config' ? { config: specialConfig } : p === '/agent/special/muse/intro' ? { ok: true, config: specialConfig }
      // 插件清单读引擎插件:一个引擎内置(公开 id)+ 一个用户自己放的(只计个数)
      : p === '/agent/plugins' && method === 'GET' ? { plugins: [
        { id: 'forsion-calendar-engine', name: 'Calendar', source: 'builtin', enabled: true, version: '1.0.0', scopes: ['global'], settings: null },
        { id: 'my-own-engine-plugin', name: 'Mine', source: 'folder', enabled: false, version: '0.1.0', scopes: ['global'], settings: null },
      ] } : undefined) })
  const shot = async (page, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `${name}.png`) }) } }
  const traced = (event) => readJsonl(trace).filter((e) => e.event === event)
  let app
  try {
    const launch = () => electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', DESK], cwd: DESK,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: sink.url, TANGU_HARNESS_QUIET: '',
        PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock'), PI_COMPUTER_USE_WINDOWS_HELPER_PATH: path.join(home, 'no-helper.exe'),
        FORSION_TELEMETRY: DEV_BUILD ? '' : 'force', FORSION_TELEMETRY_TRACE: trace }, timeout: 45000 })
    app = await launch()
    const win = await app.firstWindow()
    win.setDefaultTimeout(20000)
    await win.waitForSelector('.ob-flow')
    await win.waitForFunction(() => !document.getElementById('tangu-splash'), null, { timeout: 30000 })
    await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows().find((x) => x.isVisible()); b.setContentSize(1280, 800) })
    // 团队屏「开始使用」之后那一下请辅助功能:换成只记账的桩,不弹系统设置(同首启台架;等界面出来再换,主进程已注册过自己的)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('permissions:request')
      ipcMain.handle('permissions:request', () => ({ platform: process.platform, appName: 'Forsion', computerUseAvailable: true, helperInstalled: false, helperRunning: false,
        permissions: { computerAccessibility: 'unknown', computerScreen: 'unknown', microphone: 'not-determined', camera: 'not-determined', screen: 'not-determined' } }))
    })
    const telemetryView = () => win.evaluate(() => window.tangu.cloudInvoke('telemetry:get'))
    /** telemetry:set 是异步落盘的:轮询 telemetry:get 直到满足(最多 10 s)。 */
    const viewUntil = async (pred, what) => {
      const end = Date.now() + 10_000
      let v
      while (Date.now() < end) { v = await telemetryView(); if (pred(v)) return v; await win.waitForTimeout(200) }
      throw new Error(`${what}: ${JSON.stringify(v)}`)
    }

    // ① 引导四屏
    const step = () => win.evaluate(() => document.querySelector('.ob-flow')?.getAttribute('data-step') ?? null)
    assert.equal(await step(), 'start', 'fresh install starts at the start screen')
    const row = win.locator('[data-ob-improve]')
    const improve = row.locator('[role="switch"]')
    await improve.waitFor({ timeout: 20000 })
    if (SIGN_IN) {
      await win.waitForFunction(() => document.querySelector('[data-ob-improve] [role="switch"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 20000 })
      // 登录了、没看过告知:这一行露出来就记 noticeSeen,详情不自动弹(11-07);后面能发出去就证明记上了
      await win.waitForTimeout(800)
      assert.equal(await win.locator('.ob3-pop').count(), 0, 'help-improve details do not open on their own')
      await shot(win, 'onboarding-start-improve')
    } else {
      // 没登录:开关灰着也是关、写「登录后才能开」、详情不弹、不记看过告知
      await win.waitForTimeout(800) // 读 telemetry:get 是异步的:给它一个机会再断言
      assert.equal(await improve.getAttribute('aria-checked'), 'false', 'signed out: switch off')
      assert.ok(await improve.isDisabled(), 'signed out: switch disabled')
      assert.ok((await row.innerText()).includes('登录后才能开'), 'signed out: says sign in first')
      assert.equal(await win.locator('.ob3-pop').count(), 0, 'signed out: details not opened')
      const v = await telemetryView()
      assert.equal(v.signedIn, false, 'Extend: not signed in')
      assert.equal(v.noticeSeen, false, 'Extend: signed out does not count as notice seen')
      await shot(win, 'onboarding-start-signed-out')
      // 只留「没登录」这一道闸:告知记成看过(开关缺省开)。不这样的话负对照分不出拦住发送的是登录还是告知。
      await win.evaluate(() => window.tangu.cloudInvoke('telemetry:set', { noticeSeen: true }))
      await viewUntil((x) => x.noticeSeen === true, 'signed out: notice marked seen')
    }
    const seen = []
    for (let i = 0; i < 6; i++) {
      const s = await step()
      if (!s) break
      seen.push(s)
      await win.locator('.ob3-foot [data-ob-primary]').click()
      await win.waitForFunction((was) => (document.querySelector('.ob-flow')?.getAttribute('data-step') ?? null) !== was
        || !!document.querySelector('.ob3-error'), s, { timeout: 30000 })
      const err = await win.locator('.ob3-error').count() ? await win.locator('.ob3-error').innerText() : ''
      assert.equal(err, '', `step ${s} save error`)
    }
    assert.deepEqual(seen, ['start', 'theme', 'you', 'team'], 'walked the four screens')
    await win.waitForSelector('.ob-flow', { state: 'detached' })

    // ② ⌘P 快速查找 → Esc
    await win.waitForTimeout(800)
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
    await win.waitForSelector('.amx-qf', { timeout: 10000 })
    await win.keyboard.press('Escape')
    await win.waitForSelector('.amx-qf', { state: 'detached' })

    // ③ 商店装夹具条目 → 安装信息 404
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'market', title: 'Market', builtin: 'market', params: { n: Date.now() } }))
    let market
    for (const until = Date.now() + 30000; !market && Date.now() < until; await win.waitForTimeout(200)) {
      market = app.windows().find((w) => w.url().includes('window=floating') && !w.isClosed())
    }
    assert.ok(market, 'market panel opened')
    market.setDefaultTimeout(20000)
    const install = market.locator(`[data-market-install="${ITEM.id}"]`).first()
    await install.waitFor()
    await install.click()
    await market.waitForFunction((id) => document.querySelector(`[data-market-install="${id}"]`)?.getAttribute('data-install-state') === 'failed', ITEM.id, { timeout: 30000 })
    await shot(market, 'market-install-failed')
    await market.close()

    // ④ 渲染层抛一个错(带主目录路径、引号、密钥样式)
    await win.evaluate((h) => { setTimeout(() => { throw new Error(`boom at ${h}/secret/notes.md key sk-abcdefghijklmnopqrstuv "my title"`) }, 0) }, os.homedir())
    await win.waitForTimeout(800)

    // ④b 契约 v3
    const ACTIVE = !NEG // 两个负对照里 telemetry:get 都报不可发
    // first_run:新装、会话列表读回来是空的 → 第一次 run 结束(done)交出;不可发时一条都不交
    let ta = win.locator('.t2c-ta').first()
    if (!(await ta.isVisible().catch(() => false))) {
      await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
      await win.reload({ waitUntil: 'domcontentloaded' })
      ta = win.locator('.t2c-ta').first()
    }
    await ta.waitFor({ timeout: 30000 })
    await ta.fill('hello')
    await ta.press('Enter')
    for (const until = Date.now() + 15000; !stub.seen.runs.length && Date.now() < until;) await win.waitForTimeout(200)
    assert.ok(stub.seen.runs.length >= 1, 'first message started a run')
    if (ACTIVE) {
      for (const until = Date.now() + 15000; !traced('first_run').length && Date.now() < until;) await win.waitForTimeout(300)
    } else await win.waitForTimeout(2000)
    const firstRun = traced('first_run')
    if (ACTIVE) {
      assert.equal(firstRun.length, 1, `one first_run: ${JSON.stringify(firstRun)}`)
      assert.equal(firstRun[0].props.outcome, 'done'); assert.equal(firstRun[0].props.errorClass, undefined)
      assert.ok(Number.isInteger(firstRun[0].props.sinceFirstLaunchS) && firstRun[0].props.sinceFirstLaunchS >= 0, `sinceFirstLaunchS = ${firstRun[0].props.sinceFirstLaunchS}`)
    } else assert.equal(firstRun.length, 0, `not sendable: no first_run handed over: ${JSON.stringify(firstRun)}`)
    // quota_prompt / model_feedback 的接缝:经 preload 交给主进程;表外的入口(agent-tool 不是提示入口)/ 键被丢
    await win.evaluate(() => {
      const r = (k, p) => window.tangu.telemetryReport(k, p)
      r('quotaPrompt', { entry: 'chat-banner', action: 'shown' }); r('quotaPrompt', { entry: 'chat-banner', action: 'shown' })
      r('quotaPrompt', { entry: 'chat-banner', action: 'upgrade' }); r('quotaPrompt', { entry: 'agent-tool', action: 'shown' }); r('quotaPrompt', { entry: 'chat-banner', action: 'buy' })
      r('modelCount', { key: 'regenerate', modelId: 'cloud-1' }); r('modelCount', { key: 'regenerate', modelId: 'cloud-1' })
      r('modelCount', { key: 'stop', modelId: 'cloud-1' }); r('modelCount', { key: 'like', modelId: 'cloud-1' }); r('modelCount', { key: 'stop', modelId: '' })
    })
    // 带 entry 的 openPayCenter × 当前 EXTEND 检出:照常成功、只开一次外部浏览器(桩掉 shell.openExternal,不真开)
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u) } })
    const pay = await win.evaluate(() => window.tangu.openPayCenter({ entry: 'chat-banner' }))
    const opened = await app.evaluate(() => globalThis.__opened)
    if (SIGN_IN) {
      assert.equal(pay?.ok, true, `openPayCenter with entry accepted: ${JSON.stringify(pay)}`)
      assert.equal(opened.length, 1, 'opened the pay page once')
      assert.ok(opened[0].startsWith(`${sink.url}/pay?tab=membership`), 'pay page on the default tab (entry did not shift tab / plan / period)')
    } else assert.notEqual(pay?.error, 'invalid_tab', `signed out: not rejected for the extra arg: ${JSON.stringify(pay)}`)
    // plugin_inventory:外部插件读进来 + 20 s 后才读;可发时等它出来,不可发时一条都不交
    if (ACTIVE) {
      for (const until = Date.now() + 60000; !traced('plugin_inventory').length && Date.now() < until;) await win.waitForTimeout(1000)
      const inv = traced('plugin_inventory').map((e) => e.props)
      const day = new Date().toISOString().slice(0, 10)
      assert.ok(inv.length >= 2, `plugin_inventory handed over: ${JSON.stringify(inv)}`)
      assert.ok(inv.every((x) => x.day === day), 'inventory day = UTC today')
      assert.deepEqual(inv[0], { day, id: 'local', source: 'local', localCount: inv[0].localCount }, 'local summary first')
      assert.ok(inv[0].localCount >= 1, 'the user engine plugin counted as local')
      const eng = inv.find((x) => x.id === 'forsion-calendar-engine')
      assert.deepEqual(eng, { day, id: 'forsion-calendar-engine', source: 'builtin', installed: 1, enabled: 1 }, 'engine builtin listed by id')
      assert.ok(!JSON.stringify(inv).includes('my-own-engine-plugin'), 'local plugin ids not handed over')
      assert.ok(inv.every((x) => x.id === 'local' || (x.installed === 1 && (x.enabled === 0 || x.enabled === 1))), 'item shape')
    }

    // ⑤ 宿主 → Extend:旁路里看交出去的
    const onboarding = traced('onboarding')
    assert.equal(onboarding.length, 1, `one onboarding event: ${JSON.stringify(onboarding)}`)
    const ob = onboarding[0].props
    assert.equal(ob.mode, 'full'); assert.equal(ob.outcome, 'finish'); assert.equal(ob.screens, 4); assert.equal(ob.backJumps, 0); assert.equal(ob.signedIn, SIGN_IN)
    for (const k of ['msStart', 'msTheme', 'msYou', 'msTeam']) assert.ok(Number.isInteger(ob[k]) && ob[k] >= 0, `${k} = ${ob[k]}`)
    const inst = traced('plugin_install')
    assert.equal(inst.length, 1, `one plugin_install: ${JSON.stringify(inst)}`)
    assert.deepEqual({ ...inst[0].props, durationMs: 0 }, { id: ITEM.id, entry: 'store', kind: 'amadeus-plugin', source: 'github', stage: 'resolve', outcome: 'error', errorClass: 'http', durationMs: 0 })
    const crash = traced('crash').find((e) => e.props.process === 'renderer')
    assert.ok(crash, 'renderer crash handed to Extend')
    const hostRaw = fs.readFileSync(trace, 'utf8')
    assert.ok(!hostRaw.includes(TOKEN) && !hostRaw.includes('e2e-telemetry-user') && !hostRaw.includes(sink.url), 'no token / account / cloud url in host events')
    assert.ok(!hostRaw.includes('boom') && !hostRaw.includes('my title') && !hostRaw.includes('sk-abcdef'), 'host hands over stack frames only (no message head)')
    const features = traced('feature').map((e) => e.props.name === 'setting_change' ? `setting_change:${e.props.key}=${e.props.value}` : e.props.name)
    // 启动 / 跨窗同步不许冒出 setting_change(只有用户真改了才报)。唯一允许的一条:新装机团队那屏电脑历史预先开着,
    // 点「开始使用」= 用户确认打开(异步落下,可能赶不上这一刻)
    const changes = features.filter((f) => f.startsWith('setting_change:'))
    assert.ok(changes.every((f) => f === 'setting_change:computerHistory.enabled=on'), `only user-confirmed setting changes: ${JSON.stringify(changes)}`)
    console.log(`host → Extend (launch 1): ${JSON.stringify(readJsonl(trace).map((e) => e.event))}; features ${JSON.stringify(features)}`)

    // 发送前先核闸:正向四道全开;两个负对照各只关一道(开发版 = 不是正式包;signedout = 没登录),其余都开着
    const view = await telemetryView()
    assert.deepEqual({ signedIn: view.signedIn, enabled: view.enabled, noticeSeen: view.noticeSeen, packaged: view.packaged, active: view.active },
      { signedIn: SIGN_IN, enabled: true, noticeSeen: true, packaged: !DEV_BUILD, active: !NEG }, 'telemetry gates before sending')

    /** 退出时攒好的 v3 聚合:quota_prompt 按入口一条、model_feedback 按模型一条;表外的没混进来。 */
    const checkAggregates = () => {
      const qp = traced('quota_prompt').map((e) => e.props)
      assert.deepEqual(qp, [{ entry: 'chat-banner', shown: 2, upgrade: 1 }], `quota_prompt at quit: ${JSON.stringify(qp)}`)
      const mf = traced('model_feedback').map((e) => e.props)
      assert.equal(mf.length, 1, `one model_feedback: ${JSON.stringify(mf)}`)
      // 模型 id 原样交给 Extend(由它按 publicModelId 换成公开 id);providerKind 宿主按 Extend 同一规则算:不是 pr- / codex/ / 本地 → byok
      assert.deepEqual(mf[0], { modelId: 'cloud-1', providerKind: 'byok', regenerate: 2, stop: 1 }, 'model_feedback counts')
    }

    // ⑥ 等 Extend 第一跳(启动后 60 s)
    const deadline = Date.now() + 120_000
    while (!sink.batches.length && Date.now() < deadline) await win.waitForTimeout(2000)
    if (NEG) {
      assert.equal(sink.batches.length, 0, DEV_BUILD ? 'dev build (no force) sends nothing' : 'signed out sends nothing')
      assert.ok(!fs.existsSync(queue), DEV_BUILD ? 'dev build queues nothing' : 'signed out queues nothing')
      await app.close(); app = null
      assert.ok(traced('app_counts').length >= 1, 'host still flushed its counts at quit (Extend drops them)')
      assert.equal(traced('plugin_inventory').length, 0, 'not sendable: no plugin_inventory handed over (waited out the first-hop window)')
      assert.equal(traced('first_run').length, 0, 'not sendable: still no first_run')
      checkAggregates()
      console.log(`NEG=${NEG} ok: host handed over ${readJsonl(trace).length} events, sink got 0 batches, no queue file`)
      return
    }
    assert.ok(sink.batches.length >= 1, 'a batch reached the sink')
    const schemaFile = path.join(EXTEND, 'src/core/telemetry-schema.json')
    const schemaV = fs.existsSync(schemaFile) ? JSON.parse(fs.readFileSync(schemaFile, 'utf8')).version : undefined
    const check = (batches) => {
      for (const b of batches) {
        assert.ok(!b.headers.authorization && !b.headers.cookie, 'no auth headers')
        if (schemaV !== undefined) assert.equal(b.body.v, schemaV, 'envelope schema version')
        assert.match(b.body.installId, /^[0-9a-f-]{36}$/); assert.equal(b.body.app, 'desktop')
      }
      const raw = JSON.stringify(batches)
      assert.ok(!raw.includes(os.homedir()), 'home dir scrubbed')
      assert.ok(!raw.includes('sk-abcdef') && !raw.includes(TOKEN) && !raw.includes('e2e-telemetry-user'), 'no key / token / account id')
      assert.ok(!raw.includes('my title') && !raw.includes('secret/notes') && !raw.includes('boom'), 'error text (message + stack head) not sent')
      return batches.flatMap((b) => b.body.events)
    }
    const all = check(sink.batches)
    const got = (event) => all.filter((e) => e.event === event)
    assert.deepEqual(got('onboarding').map((e) => e.props), [ob], 'onboarding arrived as handed over')
    assert.deepEqual(got('plugin_install').map((e) => e.props), [inst[0].props], 'plugin_install arrived as handed over')
    const sentCrash = got('crash').find((e) => e.props.process === 'renderer')
    assert.ok(sentCrash, 'renderer crash arrived')
    assert.equal(sentCrash.props.message, undefined, 'no message field')
    assert.match(sentCrash.props.stack || '', /^\s+at /, 'stack keeps frames only')
    console.log(`sink (launch 1): ${sink.batches.length} batch(es), events ${JSON.stringify(all.map((e) => e.event))}`)
    // v3 新事件:Extend 白名单 ≥ 3 才认;老 Extend 一条都不混进批次(第一跳里能有的是 first_run / plugin_inventory)
    if (schemaV >= 3) {
      assert.equal(got('first_run').length, 1, 'first_run arrived')
      assert.ok(got('plugin_inventory').length >= 2, 'plugin_inventory arrived')
    } else {
      assert.equal(got('first_run').length + got('plugin_inventory').length, 0, `old Extend (schema ${schemaV}) drops v3 events: ${JSON.stringify(all.map((e) => e.event))}`)
    }

    // ⑦ 退出 → 计数落进 Extend 的队列 → 再起一次,第一跳带上
    await app.close(); app = null
    const counts = traced('app_counts')
    assert.equal(counts.length, 1, `host flushed one app_counts at quit: ${JSON.stringify(counts)}`)
    assert.equal(counts[0].props.searchOpen, 1); assert.equal(counts[0].props.searchCloseEmpty, 1)
    const cmd = traced('command_use').find((e) => e.props.id === 'quick-find' && e.props.source === 'hotkey')
    assert.ok(cmd && cmd.props.n === 1, `command_use quick-find / hotkey: ${JSON.stringify(traced('command_use'))}`)
    checkAggregates()
    const queued = readJsonl(queue).map((e) => e.event)
    assert.ok(queued.includes('app_counts') && queued.includes('command_use'), `counts survived quit in Extend's queue: ${JSON.stringify(queued)}`)
    sink.batches.length = 0
    app = await launch()
    const win2 = await app.firstWindow()
    const has = (event, pred = () => true) => sink.batches.some((b) => b.body.events.some((e) => e.event === event && pred(e)))
    const isStartup = (e) => e.props.kind === 'startup'
    const until = Date.now() + 120_000
    while (!(has('app_counts') && has('perf', isStartup)) && Date.now() < until) await win2.waitForTimeout(2000)
    const all2 = check(sink.batches)
    const sentCounts = all2.filter((e) => e.event === 'app_counts')
    assert.deepEqual(sentCounts.map((e) => e.props), [counts[0].props], 'app_counts arrived as handed over')
    assert.ok(all2.some((e) => e.event === 'command_use' && e.props.id === 'quick-find' && e.props.source === 'hotkey' && e.props.n === 1), 'command_use arrived')
    const startup = all2.find((e) => e.event === 'perf' && isStartup(e))
    assert.ok(startup && startup.props.startupMs > 0, `second launch startup: ${JSON.stringify(startup?.props)}`)
    console.log(`sink (launch 2): ${JSON.stringify(all2.map((e) => `${e.event}:${e.props.kind || e.props.id || ''}`))}`)
    console.log(`app_counts: ${JSON.stringify(sentCounts[0].props)}`)
    if (schemaV >= 3) {
      assert.ok(all2.some((e) => e.event === 'quota_prompt' && e.props.entry === 'chat-banner' && e.props.shown === 2), 'quota_prompt arrived')
      assert.ok(all2.some((e) => e.event === 'model_feedback' && e.props.regenerate === 2), 'model_feedback arrived')
    } else {
      assert.ok(!all2.some((e) => e.event === 'quota_prompt' || e.event === 'model_feedback'), `old Extend (schema ${schemaV}) drops v3 aggregates`)
    }
    console.log(`extend ${version}; screenshots → ${OUT || '(none)'}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close(); sink.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
