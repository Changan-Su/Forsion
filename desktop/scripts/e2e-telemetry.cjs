/**
 * 帮助改进 Forsion(匿名遥测)端到端:真 Electron(隔离 home)× 本地构建并签名的 Forsion Extend × 本地收件桩。
 *   引导第 7 步「帮助改进」页签缺省选中、开关开 → 走完引导 → 渲染层抛一个错、开一个 Space →
 *   设置 → Forsion 云端 → 隐私与数据 → 展开清单 → 等 Extend 第一跳把批次发到收件桩,核内容(报错原文不发、栈只留帧、无 token)→
 *   同一个 home 再起一次:startup 第一跳就到(头一次那条在看过告知之前,本就不收)。
 * 负对照:NEG=1 不带 FORSION_TELEMETRY=force(= 开发版)→ 收件桩一批都收不到。
 *
 *   EXTEND=<Forsion-Extend 检出(已 build + sign)> [OUT=<截图目录>] [NEG=1] npm run e2e:telemetry
 *   先在 DESK 里 npx electron-vite build;跑的时候占 GUI 锁(devlock.cjs run --vehicle=e2e)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const assert = require('assert/strict')
const DESK = process.env.DESK || path.resolve(__dirname, '..')
const EXTEND = process.env.EXTEND
const OUT = process.env.OUT
const NEG = process.env.NEG === '1'
if (!EXTEND) { console.error('need EXTEND=<Forsion-Extend checkout, built and signed>'); process.exit(2) }
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { startStubEngine } = require(path.join(DESK, 'scripts/lib/stub-engine.cjs'))

/** 收件桩:只认 POST /api/telemetry/batch,记下请求头与请求体;别的路径 404。 */
function startSink() {
  const batches = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/telemetry/batch') {
        batches.push({ headers: req.headers, body: JSON.parse(body) })
        res.writeHead(204).end()
      } else res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, batches, close: () => server.close() })))
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
  const version = installExtend(home)
  const sink = await startSink()
  // 引导「后台」那步要读 /agent/special/config,桩引擎缺省没有这条 → 那步卡住
  const specialConfig = {
    historian: { enabled: true, modelId: '', everyRounds: 7, firstRoundTrigger: true, autoEmoji: false, mode: 'independent', prompt: '', harnessCandidates: true },
    muse: { enabled: true, modelId: '', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5,
      supervisorPollMinutes: 5, activeHours: { start: 9, end: 17 }, allowedFolders: [], mode: 'ask', heartbeatMinutes: 120, notify: 'digest', escalateTo: '' },
  }
  const stub = await startStubEngine({ models: [{ id: 'cloud-1', name: 'GPT-6 Luna', provider: 'OpenAI', source: 'forsion', modelType: 'llm' }],
    override: async ({ path: p }) => (p === '/agent/special/config' ? { config: specialConfig } : undefined) })
  const shot = async (page, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `${name}.png`) }) } }
  let app
  try {
    const launch = () => electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', DESK], cwd: DESK,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: sink.url, TANGU_HARNESS_QUIET: '',
        PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock'), FORSION_TELEMETRY: NEG ? '' : 'force' }, timeout: 45000 })
    app = await launch()
    const win = await app.firstWindow()
    win.setDefaultTimeout(20000)
    await win.waitForSelector('.ob-flow')
    await win.waitForFunction(() => !document.getElementById('tangu-splash'), null, { timeout: 30000 })
    await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows().find((x) => x.isVisible()); b.setContentSize(1280, 800) })
    const step = async () => { await win.waitForSelector('.ob-flow', { timeout: 30000 }); return win.locator('.ob-flow').getAttribute('data-step') }
    const next = async () => {
      const before = await step()
      await win.locator('.ob-footer .btn.primary').click()
      await win.waitForFunction((s) => document.querySelector('.ob-flow')?.getAttribute('data-step') !== s, before)
    }
    for (let i = 0; i < 12 && (await step()) !== 'permissions'; i++) await next()
    assert.equal(await step(), 'permissions', 'reached step 7')
    // ① 页签在、缺省选中、开关开
    const tab = win.locator('.ob-sections button', { hasText: '帮助改进' })
    await tab.waitFor({ timeout: 20000 })
    assert.equal(await tab.getAttribute('aria-pressed'), 'true', 'improve tab selected by default')
    const sw = win.locator('.ob-permission-pane [role="switch"]').first()
    await sw.waitFor()
    assert.equal(await sw.getAttribute('aria-checked'), 'true', 'switch on')
    assert.ok(!(await win.locator('.ob-content').innerText()).includes('不会发送'), 'no "never sent" block')
    await win.waitForTimeout(400); await shot(win, 'onboarding-improve')
    // ② 走完引导;摘要里有「帮助改进」一行
    for (let i = 0; i < 4 && (await step()) !== 'done'; i++) await next()
    assert.ok((await win.locator('.ob-summary').innerText()).includes('帮助改进'), 'done summary row')
    await shot(win, 'onboarding-done')
    await win.locator('.ob-footer .btn.primary').click()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    // ③ 渲染层抛一个错(带主目录路径、引号、密钥样式),开一个 Space
    await win.evaluate((h) => { setTimeout(() => { throw new Error(`boom at ${h}/secret/notes.md key sk-abcdefghijklmnopqrstuv "my title"`) }, 0) }, os.homedir())
    await win.waitForTimeout(800)
    // ④ 设置 → Forsion 云端 → 隐私与数据
    const opened = app.waitForEvent('window', { timeout: 20000 })
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
    const settings = await opened
    await settings.waitForSelector('.settings-main', { timeout: 30000 })
    const nav = settings.locator('.settings-nav')
    await nav.getByRole('button', { name: 'Forsion 云端' }).first().click()
    await nav.getByRole('button', { name: '隐私与数据', exact: true }).first().click()
    await settings.waitForSelector('[data-fx-page="privacy"]', { timeout: 20000 })
    const page = settings.locator('[data-fx-page="privacy"]')
    assert.equal(await page.locator('[role="switch"]').first().getAttribute('aria-checked'), 'true', 'settings switch on (notice seen)')
    await settings.mouse.move(1000, 700); await settings.waitForTimeout(400); await shot(settings, 'settings-privacy')
    await page.getByRole('button', { name: '具体收集什么' }).click()
    await settings.waitForTimeout(300); await shot(settings, 'settings-privacy-open')
    // ⑤ 等 Extend 的第一跳(启动后 60 s)把队列发出去
    const deadline = Date.now() + 120_000
    while (!sink.batches.length && Date.now() < deadline) await win.waitForTimeout(2000)
    if (NEG) {
      assert.equal(sink.batches.length, 0, 'dev build (no force) sends nothing')
      console.log('NEG ok: nothing sent')
      return
    }
    assert.ok(sink.batches.length >= 1, 'a batch reached the sink')
    const all = sink.batches.flatMap((b) => b.body.events)
    const raw = JSON.stringify(sink.batches)
    for (const b of sink.batches) {
      assert.ok(!b.headers.authorization && !b.headers.cookie, 'no auth headers')
      assert.equal(b.body.v, 1); assert.match(b.body.installId, /^[0-9a-f-]{36}$/); assert.equal(b.body.app, 'desktop')
    }
    assert.ok(!raw.includes(os.homedir()), 'home dir scrubbed')
    assert.ok(!raw.includes('sk-abcdef'), 'key scrubbed')
    assert.ok(!raw.includes('my title') && !raw.includes('secret/notes') && !raw.includes('boom'), 'error text (message + stack head) not sent')
    const crash = all.find((e) => e.event === 'crash' && e.props.process === 'renderer')
    assert.ok(crash, `renderer crash event: ${JSON.stringify(all.map((e) => e.event))}`)
    assert.equal(crash.props.message, undefined, 'no message field')
    assert.match(crash.props.stack || '', /^\s+at /, 'stack keeps frames only')
    // 头一次启动的 startup 在看过告知之前就报了 → Extend 不收(看过告知之前的一律不要);第二次启动见 ⑦
    console.log(`ok: ${sink.batches.length} batch(es), events ${JSON.stringify(all.map((e) => `${e.event}:${e.props.process || e.props.kind || e.props.name || ''}`))}`)
    console.log(`crash: ${crash.props.errorName} / ${crash.props.stack.split('\n')[0].trim()}`)
    // ⑥ 查看最近发送的内容
    await page.getByRole('button', { name: '查看' }).click()
    await settings.waitForSelector('pre.fx-sent')
    assert.ok((await settings.locator('pre.fx-sent').innerText()).includes('"event": "crash"'), 'sent log shows the batch')
    await shot(settings, 'settings-privacy-sent')
    // ⑦ 同一个 home 再起一次(告知已看过):startup 第一跳就到;桩引擎 = 外接引擎、没开设备互联 → 宿主不空等引擎,只带首帧
    await app.close(); app = null
    sink.batches.length = 0
    app = await launch()
    const win2 = await app.firstWindow()
    const isStartup = (e) => e.event === 'perf' && e.props.kind === 'startup'
    const until = Date.now() + 120_000
    while (!sink.batches.some((b) => b.body.events.some(isStartup)) && Date.now() < until) await win2.waitForTimeout(2000)
    const startup = sink.batches.flatMap((b) => b.body.events).find(isStartup)
    assert.ok(startup, 'second launch: startup perf event in the first batch')
    assert.ok(startup.props.startupMs > 0 && startup.props.engineReadyMs === undefined, `startup props: ${JSON.stringify(startup.props)}`)
    console.log(`second launch startup: ${JSON.stringify(startup.props)}`)
    console.log(`extend ${version}; screenshots → ${OUT || '(none)'}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close(); sink.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
