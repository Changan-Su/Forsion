/**
 * 帮助改进 Forsion(匿名遥测)端到端:真 Electron(隔离 home)× 本地构建并签名的 Forsion Extend × 本地假云端(收件桩 + whoami)。
 * 按现在的首启引导四屏(开始 → 外观 → 关于你 → 认识你的 Agents 团队)走,「帮助改进」是「开始」屏账号卡底那一行(StartScreen 的 ImproveRow):
 *   ① 没登录:那一行在、开关灰着也是关、写「登录后才能开」、详情不自己弹;Extend 记的 signedIn / noticeSeen 都是 false。
 *   ② 引导开着时登录(同终端里 `tangu login`:直接写 auth.json —— 引导里那颗「通过浏览器登录」会把模式切成托管、拉起真引擎,
 *      台架用的是外接桩引擎,不走它)→ 去下一屏再回来:账号卡写「已登录」、开关能拨且缺省开、详情自动弹一次 = 看过告知
 *      (Extend 的 noticeSeen 变 true);再回来一次不再弹。
 *   ③ 走完四屏(团队屏把电脑历史关掉再「开始使用」,不碰这台机器的助手)→ 渲染层抛一个错 → 设置 → Forsion 云端 → 隐私与数据:开关开着 →
 *      等 Extend 第一跳(启动后 60 s)把批次发到收件桩,核内容(不带 token / cookie、报错原文不发、栈只留帧、主目录与密钥样式都洗掉)→「查看」最近发送的内容;
 *   ④ 同一个 home 再起一次(仍登录、告知已看过):startup 第一跳就到(头一次那条在看过告知之前,本就不收)。
 * 负对照(都要实跑):
 *   NEG=1         开发版(不带 FORSION_TELEMETRY=force):登录了、看过告知,收件桩照样一批都收不到。
 *   NEG=signedout 从头到尾不登录(带 force):引导里开关一直灰着、详情不弹;之后把告知直接记成看过、只留「没登录」这一道闸;
 *                 设置页开关灰着;收件桩一批都收不到。
 *
 *   EXTEND=<Forsion-Extend 检出(已 build + sign)> [OUT=<截图目录>] [NEG=1|signedout] npm run e2e:telemetry
 *   先在 DESK 里 npx electron-vite build;跑的时候占 GUI 锁(node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run e2e:telemetry)。
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

/** JWT 形状的假 token:账号核心按 payload.userId 认账号,不是 JWT 形状就当没有账号(同 extend-seam.e2e)。 */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'e2e-telemetry-user', username: 'e2e_user', iat: Math.floor(Date.now() / 1000) })}.e2e`

/** 假云端:收 POST /api/telemetry/batch(记下请求头与请求体);带 token 的 whoami 回一个用户(401/403 会被当成失效转登出);别的一律 404。 */
function startCloud() {
  const batches = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload)) }
      if (req.method === 'POST' && req.url === '/api/telemetry/batch') {
        batches.push({ headers: req.headers, body: JSON.parse(body) })
        return res.writeHead(204).end()
      }
      if (req.method === 'GET' && req.url === '/api/brain/users/me' && /^Bearer \S+/.test(req.headers.authorization || '')) {
        return json(200, { id: 'e2e-telemetry-user', username: 'e2e_user', role: 'USER', nickname: 'E2E', avatar: null, email: null, emailVerified: false, phone: null, phoneVerified: false, membershipTier: 'free' })
      }
      json(404, {})
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

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-telemetry-e2e-'))
  // 先放一份 config.json:引擎首启时 config.json 不在,会把散落的旧 JSON(含 auth.json)收进去、原文件改名 .bak(同 extend-seam.e2e)
  fs.writeFileSync(path.join(home, 'config.json'), '{}')
  const version = installExtend(home)
  const cloud = await startCloud()
  // 引导「关于你」「团队」两屏要读写的几条,桩引擎缺省没有(形状同 check:first-run)
  const specialConfig = {
    historian: { enabled: true, modelId: '', everyRounds: 7, firstRoundTrigger: true, autoEmoji: false, mode: 'independent', prompt: '', harnessCandidates: true },
    muse: { enabled: true, modelId: '', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5,
      supervisorPollMinutes: 5, activeHours: { start: 9, end: 17 }, allowedFolders: [], mode: 'ask', heartbeatMinutes: 120, notify: 'digest', escalateTo: '' },
  }
  const human = { scope: 'human', path: 'human/MEMORY.md', content: '', version: 'h1', exists: false, updatedAt: null, history: [], maxLength: 2000 }
  const agents = [{ slug: 'xyra', name: 'Xyra', description: '', createdBy: 'builtin' }, { slug: 'muse', name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', description: '', createdBy: 'builtin' }]
  const stub = await startStubEngine({ models: [{ id: 'cloud-1', name: 'GPT-6 Luna', provider: 'OpenAI', source: 'forsion', modelType: 'llm' }],
    override: async ({ path: p, method, body }) => {
      if (p === '/agent/special/config') {
        if (method === 'POST') { const patch = await body(); if (patch.muse) Object.assign(specialConfig.muse, patch.muse) }
        return { config: specialConfig }
      }
      if (p === '/agent/special/muse/intro' && method === 'POST') { await body(); return { ok: true, config: specialConfig } }
      if (p === '/agent/human/MEMORY.md') {
        if (method === 'PUT') { const b = await body(); Object.assign(human, { content: b.content, version: 'h2', exists: true }); return { document: human, change: null } }
        return human
      }
      if (p === '/agent/agents' && method === 'GET') return { agents }
      return undefined
    } })
  const shot = async (page, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `${name}.png`) }) } }
  const telemetryState = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'extend-telemetry.json'), 'utf8')) } catch { return {} } }
  let app
  try {
    const launch = () => electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', DESK], cwd: DESK,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: cloud.url, TANGU_HARNESS_QUIET: '',
        PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock'), PI_COMPUTER_USE_WINDOWS_HELPER_PATH: path.join(home, 'no-helper.exe'),
        FORSION_TELEMETRY: DEV_BUILD ? '' : 'force' }, timeout: 45000 })
    app = await launch()
    const win = await app.firstWindow()
    win.setDefaultTimeout(20000)
    await win.waitForSelector('.ob-flow')
    await win.waitForFunction(() => !document.getElementById('tangu-splash'), null, { timeout: 30000 })
    await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows().find((x) => x.isVisible()); b.setContentSize(1280, 800) })
    // 团队屏「开始使用」之后那一下请辅助功能:换成只记账的桩,不弹系统设置(同 check:first-run;等界面出来再换,主进程已注册过自己的)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('permissions:request')
      ipcMain.handle('permissions:request', () => ({ platform: process.platform, appName: 'Forsion', computerUseAvailable: true, helperInstalled: false, helperRunning: false,
        permissions: { computerAccessibility: 'unknown', computerScreen: 'unknown', microphone: 'not-determined', camera: 'not-determined', screen: 'not-determined' } }))
    })
    const step = () => win.locator('.ob-flow').getAttribute('data-step')
    const move = async (locator) => {
      const before = await step()
      await locator.click()
      await win.waitForFunction((s) => document.querySelector('.ob-flow')?.getAttribute('data-step') !== s, before)
    }
    const next = () => move(win.locator('[data-ob-primary]'))
    const back = () => move(win.locator('.ob3-back'))
    const telemetryView = () => win.evaluate(() => window.tangu.cloudInvoke('telemetry:get'))
    /** telemetry:set 是异步落盘的:轮询 telemetry:get 直到满足(最多 10 s),别拿弹窗露出来当「已经记上」。 */
    const viewUntil = async (pred, what) => {
      const end = Date.now() + 10_000
      let v
      while (Date.now() < end) { v = await telemetryView(); if (pred(v)) return v; await win.waitForTimeout(200) }
      throw new Error(`${what}: ${JSON.stringify(v)}`)
    }
    const row = win.locator('[data-ob-improve]')
    const sw = row.locator('[role="switch"]')
    const pop = row.locator('.ob3-pop')
    assert.equal(await step(), 'start', 'starts on the start screen')
    await win.waitForSelector('[data-ob-account]')

    // ① 没登录:开关灰着也是关、写「登录后才能开」、详情不自己弹
    await row.waitFor()
    await win.waitForTimeout(800) // 读 telemetry:get 是异步的:给自动弹出一个机会再断言它没弹
    assert.equal(await sw.getAttribute('aria-checked'), 'false', 'signed out: switch off')
    assert.ok(await sw.isDisabled(), 'signed out: switch disabled')
    assert.ok((await row.innerText()).includes('登录后才能开'), 'signed out: says sign in first')
    assert.equal(await pop.count(), 0, 'signed out: details not auto-opened')
    let view = await telemetryView()
    assert.equal(view.signedIn, false, 'Extend: not signed in')
    assert.equal(view.noticeSeen, false, 'Extend: notice not seen')
    await shot(win, 'start-signed-out')

    if (SIGN_IN) {
      // ② 引导开着时登录(写 auth.json)→ 去下一屏再回来:开始屏重读登录状态
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud.url, token: TOKEN }), { mode: 0o600 })
      await next()
      await back()
      await win.locator('[data-ob-account] .ob3-chip').waitFor({ timeout: 20000 }) // 「已登录」
      await pop.waitFor({ timeout: 20000 })
      await win.waitForFunction(() => {
        const s = document.querySelector('[data-ob-improve] [role="switch"]')
        return s && !s.disabled && s.getAttribute('aria-checked') === 'true'
      })
      assert.ok((await pop.innerText()).includes('发送崩溃报告和使用统计'), 'details popup: title')
      assert.ok(!(await pop.innerText()).includes('不会发送'), 'details popup: no "never sent" block')
      await shot(win, 'start-signed-in-notice')
      view = await viewUntil((v) => v.noticeSeen === true, 'Extend: auto-opened details count as notice seen')
      assert.equal(view.signedIn, true, 'Extend: signed in')
      assert.equal(view.enabled, true, 'Extend: on by default')
      // 只弹一次:关掉,去下一屏再回来,不再弹
      await win.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })
      await next()
      await back()
      await row.waitFor()
      await win.waitForTimeout(800)
      assert.equal(await pop.count(), 0, 'notice seen: details not auto-opened again')
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'still on after coming back')
    } else {
      // 只留「没登录」这一道闸:告知记成看过(开关缺省开)。不这样的话负对照分不出拦住发送的是登录还是告知。
      await win.evaluate(() => window.tangu.cloudInvoke('telemetry:set', { noticeSeen: true }))
      await viewUntil((v) => v.noticeSeen === true, 'signed out: notice marked seen')
    }

    // ③ 走完四屏:团队屏把电脑历史关掉(不碰这台机器的助手)再「开始使用」
    for (let i = 0; i < 4 && (await step()) !== 'team'; i++) await next()
    assert.equal(await step(), 'team', 'reached the team screen')
    await win.waitForSelector('[data-ob-muse]')
    const ch = win.locator('[data-ob-history] [role="switch"]')
    if (await ch.count()) {
      await win.waitForFunction(() => !document.querySelector('[data-ob-history] [role="switch"]')?.disabled)
      if (await ch.getAttribute('aria-checked') === 'true') await ch.click()
      assert.equal(await ch.getAttribute('aria-checked'), 'false', 'computer history left off')
    }
    await win.locator('[data-ob-primary]').click()
    await win.waitForSelector('.ob-flow', { state: 'detached', timeout: 30000 })
    // 渲染层抛一个错(带主目录路径、引号、密钥样式)
    await win.evaluate((h) => { setTimeout(() => { throw new Error(`boom at ${h}/secret/notes.md key sk-abcdefghijklmnopqrstuv "my title"`) }, 0) }, os.homedir())
    await win.waitForTimeout(800)
    // 设置 → Forsion 云端 → 隐私与数据
    const opened = app.waitForEvent('window', { timeout: 20000 })
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
    const settings = await opened
    await settings.waitForSelector('.settings-main', { timeout: 30000 })
    const nav = settings.locator('.settings-nav')
    await nav.getByRole('button', { name: 'Forsion 云端' }).first().click()
    await nav.getByRole('button', { name: '隐私与数据', exact: true }).first().click()
    await settings.waitForSelector('[data-fx-page="privacy"]', { timeout: 20000 })
    const page = settings.locator('[data-fx-page="privacy"]')
    const settingsSwitch = page.locator('[role="switch"]').first()
    if (SIGN_IN) assert.equal(await settingsSwitch.getAttribute('aria-checked'), 'true', 'settings switch on (signed in, notice seen)')
    else {
      assert.equal(await settingsSwitch.getAttribute('aria-checked'), 'false', 'signed out: settings switch off')
      assert.ok(await settingsSwitch.isDisabled(), 'signed out: settings switch disabled')
    }
    await settings.mouse.move(1000, 700); await settings.waitForTimeout(400); await shot(settings, 'settings-privacy')
    await page.getByRole('button', { name: '具体收集什么' }).click()
    await settings.waitForTimeout(300); await shot(settings, 'settings-privacy-open')
    // 发送前先核闸:正向四道全开;两个负对照各只关一道(开发版 = 不是正式包;signedout = 没登录),其余三道都开着
    view = await telemetryView()
    const gates = { signedIn: view.signedIn, enabled: view.enabled, noticeSeen: view.noticeSeen, packaged: view.packaged, active: view.active }
    const expected = { signedIn: SIGN_IN, enabled: true, noticeSeen: true, packaged: !DEV_BUILD, active: !NEG }
    assert.deepEqual(gates, expected, 'telemetry gates before sending')
    // 等 Extend 的第一跳(启动后 60 s)把队列发出去
    const deadline = Date.now() + 120_000
    while (!cloud.batches.length && Date.now() < deadline) await win.waitForTimeout(2000)
    if (NEG) {
      assert.equal(cloud.batches.length, 0, DEV_BUILD ? 'dev build (no force) sends nothing' : 'signed out sends nothing')
      console.log(`NEG=${NEG} ok: nothing sent; Extend state ${JSON.stringify({ ...telemetryState(), installId: undefined })}`)
      return
    }
    assert.ok(cloud.batches.length >= 1, 'a batch reached the sink')
    const all = cloud.batches.flatMap((b) => b.body.events)
    const raw = JSON.stringify(cloud.batches)
    for (const b of cloud.batches) {
      assert.ok(!b.headers.authorization && !b.headers.cookie, 'no auth headers')
      assert.ok(Number.isInteger(b.body.v) && b.body.v >= 1, `envelope version ${b.body.v}`)
      assert.match(b.body.installId, /^[0-9a-f-]{36}$/); assert.equal(b.body.app, 'desktop')
    }
    assert.ok(!raw.includes(TOKEN) && !raw.includes('e2e-telemetry-user'), 'no token / account id in the batch')
    assert.ok(!raw.includes(os.homedir()), 'home dir scrubbed')
    assert.ok(!raw.includes('sk-abcdef'), 'key scrubbed')
    assert.ok(!raw.includes('my title') && !raw.includes('secret/notes') && !raw.includes('boom'), 'error text (message + stack head) not sent')
    const crash = all.find((e) => e.event === 'crash' && e.props.process === 'renderer')
    assert.ok(crash, `renderer crash event: ${JSON.stringify(all.map((e) => e.event))}`)
    assert.equal(crash.props.message, undefined, 'no message field')
    assert.match(crash.props.stack || '', /^\s+at /, 'stack keeps frames only')
    console.log(`ok: ${cloud.batches.length} batch(es), events ${JSON.stringify(all.map((e) => `${e.event}:${e.props.process || e.props.kind || e.props.name || ''}`))}`)
    console.log(`crash: ${crash.props.errorName} / ${crash.props.stack.split('\n')[0].trim()}`)
    // 查看最近发送的内容
    await page.getByRole('button', { name: '查看' }).click()
    await settings.waitForSelector('pre.fx-sent')
    assert.ok((await settings.locator('pre.fx-sent').innerText()).includes('"event": "crash"'), 'sent log shows the batch')
    await shot(settings, 'settings-privacy-sent')
    // ④ 同一个 home 再起一次(仍登录、告知已看过):startup 第一跳就到;桩引擎 = 外接引擎、没开设备互联 → 宿主不空等引擎,只带首帧
    await app.close(); app = null
    cloud.batches.length = 0
    app = await launch()
    const win2 = await app.firstWindow()
    const isStartup = (e) => e.event === 'perf' && e.props.kind === 'startup'
    const until = Date.now() + 120_000
    while (!cloud.batches.some((b) => b.body.events.some(isStartup)) && Date.now() < until) await win2.waitForTimeout(2000)
    const startup = cloud.batches.flatMap((b) => b.body.events).find(isStartup)
    assert.ok(startup, 'second launch: startup perf event in the first batch')
    assert.ok(startup.props.startupMs > 0 && startup.props.engineReadyMs === undefined, `startup props: ${JSON.stringify(startup.props)}`)
    console.log(`second launch startup: ${JSON.stringify(startup.props)}`)
    console.log(`extend ${version}; screenshots → ${OUT || '(none)'}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close(); cloud.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
