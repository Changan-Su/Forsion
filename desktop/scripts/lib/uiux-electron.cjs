/**
 * UI/UX 观测仪器(check:sidewidth / check:firstclick / check:firstenter)共用的真 Electron 起手式。
 * 正典:docs/ToBeImproved/UIUX评审_2026-09-25.md U-20 / U-40 / U-41。
 *
 * 形态照 check:orbitside:桩引擎(lib/stub-engine.cjs)+ 隔离 user-data-dir / TANGU_HOME / 笔记库,
 * `--lang=zh-CN` 钉语言。量的是 out/ 产物 —— 改了源码不 `npx electron-vite build` 就是白测。
 *
 * ⚠️ 启动失败多半是 dev 版 Electron 占着单实例锁;本仪器**不替你杀进程**(node_modules 软链到主检出时,
 *    按路径 pkill 会误杀用户正在用的 dev 实例),报错后自己关掉再跑。
 */
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./stub-engine.cjs')

const ROOT = path.join(__dirname, '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 截图目录:SHOT_DIR 覆写,缺省落系统临时目录(DESIGN.md §8:几何全绿 ≠ 看起来对,自己看)。 */
function shotDir(tag) {
  const dir = process.env.SHOT_DIR || path.join(os.tmpdir(), `forsion-${tag}-shots`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 断言收集器:PASS/FAIL 逐行打印 + 最后汇总。NOTE 行只记观测、不算分。 */
function makeReporter() {
  const results = []
  return {
    results,
    check(name, ok, detail) {
      results.push({ name, ok: !!ok })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
    },
    note(name, detail) { console.log(`NOTE  ${name}${detail ? '  | ' + detail : ''}`) },
    summary() {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${results.length - failed.length}/${results.length} 通过`)
      return failed.length
    },
  }
}

/** 本地 agent 名册 + 会话名册的最小夹具(项目组两条会话 + 一条私聊):够侧栏长出一级行与二级行。 */
function defaultFixtures(projectDir) {
  const at = (t) => ({ created_at: '2026-09-16 09:00:00', updated_at: `2026-09-16 ${t}` })
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null }
  return {
    agents: [
      { slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user', libraryDir: '/tmp/uiux-lib/xyra/Library' },
      { slug: 'orbit-one', name: 'Orbit One', description: 'Instrument agent', createdBy: 'user', libraryDir: '/tmp/uiux-lib/orbit-one/Library' },
    ],
    sessions: [
      { ...base, ...at('11:00:00'), id: 'fx-p1', title: 'Probe session one', project_path: projectDir, project_name: 'Probe Project', projectless: false },
      { ...base, ...at('10:30:00'), id: 'fx-p2', title: 'Probe session two', project_path: projectDir, project_name: 'Probe Project', projectless: false },
      { ...base, ...at('10:00:00'), id: 'fx-p3', title: 'Probe session three', project_path: projectDir, project_name: 'Probe Project', projectless: false },
    ],
  }
}

/** 桩引擎前面挂一层延迟代理:命中 delay.match 的 GET 晚 delay.ms 毫秒才转发(模拟真引擎/网络慢),其余原样转发(含 SSE)。 */
function startDelayProxy(stubUrl, delay) {
  const target = new URL(stubUrl)
  const server = http.createServer((req, res) => {
    let p = ''
    try { p = new URL(req.url || '/', 'http://x').pathname } catch { res.writeHead(400); res.end('{}'); return }
    const forward = () => {
      const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
        (ur) => { res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res) })
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{}') })
      req.pipe(up)
    }
    if (req.method === 'GET' && delay.match.test(p)) setTimeout(forward, delay.ms)
    else forward()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(() => r())),
  })))
}

/**
 * 起一份隔离的 Electron。opts:
 *  - delay:{ match: RegExp, ms } —— 给桩引擎的某些 GET 加延迟(见 startDelayProxy)
 *  - tag:临时目录前缀
 *  - overrideHome:true = 连 HOME 一起覆写(造物托管根 = <HOME>/Forsion-Dev/Project,不覆写会读用户真目录)
 *  - fixtures:{ agents, sessions }(缺省 defaultFixtures)
 * 返回 { app, win, home, projectDir, stub, close }。
 */
async function launch(opts = {}) {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    throw new Error('缺 out/main/main.js —— 先在本检出跑 npx electron-vite build')
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-${opts.tag || 'uiux'}-`))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  const projectDir = path.join(home, 'Probe Project')
  const defaultDir = path.join(home, 'Default Workspace')
  for (const dir of [userData, `${userData}-dev`, vault, projectDir, defaultDir, path.join(home, 'Forsion-Dev', 'Project')]) fs.mkdirSync(dir, { recursive: true })
  const fx = opts.fixtures || defaultFixtures(projectDir)
  // 起到一半失败(桩 / 代理 / 写配置 / 起 Electron / 等首窗)也要把已起的东西全收掉,不留进程与临时目录。
  let stub = null
  let proxy = null
  let app = null
  const close = async () => {
    if (app) await app.close().catch(() => {})
    if (proxy) await proxy.close().catch(() => {})
    try { if (stub) stub.close() } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  try {
    stub = await startStubEngine({ agents: fx.agents, sessions: fx.sessions })
    proxy = opts.delay ? await startDelayProxy(stub.url, opts.delay) : null
    const backend = proxy ? proxy.url : stub.url
    // 未打包时主进程用 `<dir>-dev`,两份都种;笔记库也预置 —— 日历 Space 的可用性判定要 amadeusAvailable()。
    for (const dir of [userData, `${userData}-dev`]) {
      fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: backend, token: 'e2e', defaultWorkspaceDir: defaultDir }), 'utf8')
      fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }), 'utf8')
    }
    const env = { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: backend }
    if (opts.overrideHome) env.HOME = home
    try {
      app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env })
    } catch (e) {
      console.error('启动失败:多半是已有 dev 版 Electron 占着单实例锁。自己关掉那个实例再跑(本仪器不代为 pkill)。')
      throw e
    }
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.error('[renderer pageerror]', String((e && e.stack) || e).slice(0, 600)))
    return { app, win, home, projectDir, stub, close }
  } catch (e) {
    await close()
    throw e
  }
}

/** 首启:定窗口尺寸 → 点掉引导 → 等工作区;space 给了就钉成启动 Space 并 reload 落进去。 */
async function boot(app, win, { space = 'tangu', width = 1440, height = 900 } = {}) {
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w: width, h: height })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await sleep(2000)
  const skip = win.getByRole('button', { name: /^(Skip onboarding|跳过引导)$/ }).first()
  await skip.waitFor({ timeout: 8000 }).then(() => skip.click()).catch(() => {})
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  if (space) {
    await win.evaluate((s) => { localStorage.setItem('forsion_default_space', s); localStorage.removeItem('forsion_tangu_session_mode') }, space)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await sleep(2000)
  }
}

/** Space id → 显示名(zh/en;id 找不到时的后备,以及「…」溢出浮层里没有 data-id 的行)。 */
const SPACE_NAMES = {
  tangu: ['Tangu'],
  inbox: ['收件箱', 'Inbox'],
  amadeus: ['Note', 'Amadeus'],
  calendar: ['日历', 'Calendar'],
  artificial: ['造物', 'Creations'],
}

/** 点 ribbon 上某个 Space,返回**是否真的切到了它**(活动 Space == id)。
 *  定位优先级(Codex 第一轮 F-1):① 条上格子的 data-id="space:<id>" ② 可访问名 aria-label(收起态 Ribbon 只有它,
 *  没有 title 也没有 .rb-label —— 以前只认后两者,默认收起的 Ribbon 上一个都点不中)③ 展开态的 .rb-label ④ 「…」溢出浮层。
 *  溢出浮层同样先按行的 data-id 找;按名字找时 aria-label / title / .rb-label **各自**比对 —— 有未读时 aria-label 是
 *  「收件箱,3 条未读」,不等于显示名,不能让它用 || 挡掉后面准确的 .rb-label(Codex 第三轮 H2-2)。
 *  real=true 走真鼠标(hit-test 在内);否则 element.click()。 */
async function enterSpace(win, id, { real = false, timeout = 4000 } = {}) {
  const names = SPACE_NAMES[id] || [id]
  const find = (root, byId) => `(() => {
    const names = ${JSON.stringify(names)}
    const byName = (x) => [x.getAttribute('aria-label'), x.getAttribute('title'), (x.querySelector('.rb-label')?.textContent || '').trim()]
      .some((v) => !!v && names.includes(v))
    const b = ${byId ? `document.querySelector('${root ? `${root} .rb-fly-row` : '.rb-slot'}[data-id="space:${id}"] .rb-space')` : `[...document.querySelectorAll('${root} .rb-space')].find(byName)`}
    if (!b) return null
    const r = b.getBoundingClientRect()
    if (!${real}) b.click()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`
  let hit = (await win.evaluate(find(null, true))) || (await win.evaluate(find('.rb-top', false))) || (await win.evaluate(find('.rb-home', false)))
  if (!hit) {
    const more = win.locator('.rb-top .rb-more').first()
    if (await more.count().catch(() => 0)) {
      await more.hover()
      await sleep(500)
      hit = (await win.evaluate(find('.rb-fly', true))) || (await win.evaluate(find('.rb-fly', false)))
    }
  }
  if (!hit) return false
  if (real) await win.mouse.click(hit.x, hit.y)
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if ((await activeSpace(win)) === id) return true
    await sleep(80)
  }
  return false
}

/** 当前活动 Space id(spaceRegistry 写的 localStorage 键)。 */
const activeSpace = (win) => win.evaluate(() => localStorage.getItem('forsion_tangu_active_space'))

/** 用 Electron 的 capturePage 截整窗(不依赖 Playwright 截图的可见性判定)。 */
async function captureWindow(app, file) {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(file, Buffer.from(png, 'base64'))
  return file
}

module.exports = { ROOT, sleep, shotDir, makeReporter, defaultFixtures, launch, boot, enterSpace, SPACE_NAMES, activeSpace, captureWindow }
