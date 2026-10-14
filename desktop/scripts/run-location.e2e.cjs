/**
 * 桌面新对话的「运行位置」胶囊(项目胶囊前面那一颗)—— 真 Electron(managed)× 真主进程中转口 × 真组件 / store,
 * 云端与两台引擎是假的(本机引擎 = 桩 A;「Mac mini」= 假云端的隧道后面的桩 B)。
 *
 * 钉住的契约(2026-10-14,桌面作为调用方):
 *  ① 胶囊恒在、缺省写「这台电脑」,它的左缘与输入卡左缘是同一条线(项目胶囊排在它后面);100% 与 110% 缩放都量。
 *  ② 点开是与项目胶囊同一套下拉:这台电脑(勾选)/ 我的其他电脑(在线、离线各是各的,离线的点不了)/ 管理设备;
 *     方向键移动焦点,Esc 关闭并把焦点还给胶囊。
 *  ③ 选一台还没允许过这台电脑的 → 发起确认(那台弹框),菜单里说「请在「Mac mini」上点允许」;那台允许后自动生效。
 *  ④ 生效后项目胶囊列的是那台的项目,「添加本地项目 / 添加文件夹」不出现;发第一条消息 = 会话建在那台的引擎上
 *     (落点是那台的默认工作区,不带这台电脑的路径),回复经隧道流回来;侧栏多出「Mac mini」分组。
 *  ⑤ 凭据不进渲染层:云端只收到主进程盖的 forsion_token;渲染层发往中转口的请求只带本次启动的口令。
 *  ⑥ 侧栏分组的「+」指的是这台电脑的文件夹:运行位置停在 Mac mini 时点它,会话建在本机引擎上,胶囊回到「这台电脑」。
 *
 * 需先 npm run build,且本检出有 tangu-agent/dist(managed 模式要起真引擎进程;发给它的请求由 route 改道到桩 A)。
 * 用法:npm run e2e:runlocation            截图落在临时目录,路径打在最后一行
 * 负对照:FORSION_E2E_ROOT=<没有这次改动的检出>/desktop node scripts/run-location.e2e.cjs —— ① 起就找不到胶囊。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = process.env.FORSION_E2E_ROOT || path.join(__dirname, '..')
const MINI = '7f0e8a52-0000-4000-8000-00000000000a'
const THINKPAD = '7f0e8a52-0000-4000-8000-00000000000b'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const FORSION_TOKEN = `${b64({ alg: 'none' })}.${b64({ userId: 'u-42', exp: 4102444800 })}.sig`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}

/** 假云端:名册 + 「Mac mini」的隧道(远程访问状态面 / 只读配置 / 引擎转给桩 B)。记下每条请求带的凭据。 */
function startCloud(miniUrl) {
  const seen = []
  /** 经隧道发给那台的请求体(查有没有夹带这台电脑的路径)。 */
  const bodies = []
  const state = { caller: 'unconfirmed', asked: 0 }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    seen.push({ method: req.method, path: u.pathname, auth: req.headers.authorization || '', caller: req.headers['x-forsion-caller'] || '' })
    if (u.pathname === '/api/units' && req.method === 'GET') {
      return json(200, { units: [
        { id: MINI, name: 'Mac mini', platform: 'darwin', kind: 'desktop', online: true, capsLive: true, caps: { engine: 'ready' } },
        { id: THINKPAD, name: 'ThinkPad X1', platform: 'win32', kind: 'desktop', online: false },
        { id: '7f0e8a52-0000-4000-8000-00000000000c', name: 'Pixel', platform: 'android', kind: 'phone', online: true },
      ] })
    }
    if (u.pathname === '/api/auth/me') return json(200, { user: { id: 'u-42', username: 'tester' } })
    const m = /^\/api\/units\/([^/]+)\/proxy(\/.*)$/.exec(u.pathname)
    if (!m || m[1] !== MINI) return json(404, { error: 'not found' })
    if (req.headers.authorization !== `Bearer ${FORSION_TOKEN}`) return json(401, { error: 'unauthorized' })
    const p = m[2]
    const access = () => ({ remoteSessions: true, caller: state.caller })
    if (p === '/unit/remote-access') return json(200, access())
    if (p === '/unit/remote-access/request') { state.asked++; if (state.caller === 'unconfirmed') state.caller = 'pending'; return json(200, access()) }
    if (p === '/unit/config') return json(200, { config: { homeDir: '/Users/mini', defaultWorkspaceDir: '/Users/mini/Forsion' } })
    if (!p.startsWith('/engine/')) return json(404, { error: 'not found' })
    // 会话档:那台还没允许 → 建会话被拒(与执行设备同一个码)
    if (state.caller !== 'trusted' && req.method === 'POST' && p === '/engine/agent/sessions') return json(403, { code: 'REMOTE_CALLER_UNCONFIRMED', state: state.caller })
    const up = http.request(`${miniUrl}${p.slice('/engine'.length)}${u.search}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*' } }, (r) => {
      res.writeHead(r.statusCode || 502, { 'Content-Type': r.headers['content-type'] || 'application/json', 'Cache-Control': 'no-cache' })
      r.pipe(res)
    })
    up.on('error', () => { if (!res.headersSent) json(502, { code: 'UNIT_TIMEOUT' }); else res.destroy() })
    res.on('close', () => up.destroy())
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { if (chunks.length) bodies.push(`${req.method} ${p} ${Buffer.concat(chunks).toString('utf8')}`) })
    req.pipe(up)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, bodies, state, close: () => server.close() })))
}

/** 桩引擎 + 「建会话」记录(桩自己不实现 POST /agent/sessions)。 */
async function startEngine(label, sessions) {
  const created = []
  const stub = await startStubEngine({
    sessions,
    models: [{ id: 'm1', name: `${label} 模型`, provider: 'stub', contextWindow: 128_000 }],
    override: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'POST') {
        const input = await body()
        created.push(input)
        const session = { id: `${label}-${created.length}`, title: 'New Chat', summary: '', archived: false, emoji: null, ...input, app_id: 'tangu', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        sessions.unshift(session)
        return { session }
      }
      const config = /^\/agent\/sessions\/([^/]+)\/config$/.exec(p)
      if (config && method === 'GET') return { agent_config: sessions.find((s) => s.id === config[1])?.agent_config || {} }
      if (/^\/agent\/sessions\/[^/]+\/messages$/.test(p) && method === 'GET') return { messages: [] }
      if (p === '/agent/special/config') return { config: { muse: { enabled: false }, historian: { enabled: false } } }
    },
  })
  return { stub, created, sessions }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error(`缺 ${ROOT}/out/main/main.js —— 先跑 npm run build`)
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-runloc-'))
  const userData = path.join(home, 'userdata')
  const workspace = path.join(home, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })

  const here = await startEngine('here', [])
  const mini = await startEngine('mini', [
    { id: 'mini-old', title: '整理 webapp 的路由', summary: '', archived: false, emoji: null, app_id: 'tangu', project_path: '/Users/mini/code/webapp', project_name: 'webapp', created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-12T08:00:00Z' },
  ])
  mini.stub.script([{ type: 'token', payload: { text: '我在 Mac mini 上。' } }, { type: 'done', payload: { content: '我在 Mac mini 上。' } }])
  here.stub.script([{ type: 'token', payload: { text: '好的。' } }, { type: 'done', payload: { content: '好的。' } }])
  const cloud = await startCloud(mini.stub.url)

  // ⚠️ config.json 必须先在:managed 模式起的是真引擎,它启动时见「有 auth.json、没有 config.json」就按旧配置迁移,
  //    把 auth.json 改名成 .bak —— 登录态跑到一半没了(菜单变成「登录后可选择其他电脑」;10-14 第一、二轮就卡在这)。
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ cloud: { url: cloud.url } }))
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token: FORSION_TOKEN, cloudUrl: cloud.url, username: 'tester' }), { mode: 0o600 })
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', backendUrl: here.stub.url, token: 'e2e', cloudUrl: cloud.url,
      sandbox: 'none', browserEnabled: false, defaultWorkspaceDir: workspace, modelId: 'm1', unitHostEnabled: false,
    }))
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: here.stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' },
  })
  const shot = (name) => path.join(home, name)
  /** 渲染层发出的请求头(⑤:里面不许出现 forsion_token)。 */
  const rendererRequests = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    app.context().on('request', (r) => { rendererRequests.push({ url: r.url(), headers: r.headers() }) })
    // 发给本机引擎的改道到桩 A;发给中转口的(`/units/<id>/proxy/…`)原样放行 —— 那正是被测的路。
    await app.context().route('**/agent/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/units/')) return route.continue()
      await route.continue({ url: `${here.stub.url}${url.pathname}${url.search}` })
    })
    const resize = async (w, h = 900) => { await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]); await win.waitForTimeout(350) }
    const zoom = async (f) => { await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), f); await win.waitForTimeout(350) }
    const windowShot = async (name) => fs.writeFileSync(shot(name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64'))
    await resize(1440)
    await win.waitForSelector('#root', { timeout: 40_000 })
    check('离开首启引导', await skipOnboarding(win))
    await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 40_000 })
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await skipOnboarding(win, 600)
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('[data-ribbon-id="space:tangu"], [data-id="space:tangu"]').first().click().catch(() => {})

    const view = win.locator('.t2-chat-view:visible').first()
    const bar = view.locator('.newchat-projectbar')
    const runloc = bar.locator('[data-run-location-picker]')
    const runPill = runloc.locator('.project-pill')
    const projectPill = bar.locator('.project-selector:not(.runloc) > .project-pill')
    const card = view.locator('.t2c-card')
    const box = async (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })
    const near = (a, b) => Math.abs(a - b) <= 1
    const where = () => runloc.getAttribute('data-run-location')

    // ── ① 胶囊恒在,写「这台电脑」,排在项目胶囊前面、与输入卡左缘对齐 ──
    await projectPill.waitFor({ timeout: 20_000 })
    const present = await runPill.waitFor({ timeout: 10_000 }).then(() => true, () => false)
    check('① 新对话的项目栏里有运行位置胶囊', present)
    if (!present) throw new Error('没有运行位置胶囊(这份检出没有这次改动?)')
    check('① 缺省写「这台电脑」', (await runPill.innerText()).trim() === '这台电脑' && await where() === 'home', await runPill.innerText())
    const aligned = async (label) => {
      const [r, p, c] = [await box(runPill), await box(projectPill), await box(card)]
      check(`① ${label}:运行位置胶囊左缘与输入卡左缘对齐`, near(r.left, c.left), { pill: +r.left.toFixed(1), card: +c.left.toFixed(1) })
      check(`① ${label}:项目胶囊排在它后面、同一行`, p.left >= r.right && near(p.top, r.top) && near(p.bottom, r.bottom), { run: [r.left, r.right].map(Math.round), project: [p.left, p.right].map(Math.round) })
    }
    await aligned('100%')
    await view.locator('.composer-anchor').screenshot({ path: shot('1-bar-100.png') })
    await zoom(1.1)
    await aligned('110% 缩放')
    await windowShot('1-window-110.png')
    await zoom(1)

    // ── ② 下拉 ──
    const menu = runloc.locator('.runloc-menu')
    const row = (id) => menu.locator(`[data-run-row="${id}"]`)
    await runPill.click()
    await menu.waitFor({ timeout: 5000 })
    await row(MINI).waitFor({ timeout: 10_000 })
    await win.waitForFunction((id) => document.querySelector(`[data-run-row="${id}"]`)?.getAttribute('data-status') === 'ready', MINI, { timeout: 10_000 }).catch(() => {})
    check('② 第一行是「这台电脑」,勾选着', (await row('home').innerText()).trim() === '这台电脑' && await row('home').getAttribute('aria-checked') === 'true')
    check('② 有「我的其他电脑」分组,手机不在里面', (await menu.locator('.menu-section').innerText()).trim() === '我的其他电脑' && await menu.locator('.runloc-row').count() === 2, await menu.locator('.runloc-row').allInnerTexts())
    check('② Mac mini:在线,可以点', /Mac mini/.test(await row(MINI).innerText()) && /在线/.test(await row(MINI).innerText()) && await row(MINI).isEnabled(), await row(MINI).innerText())
    check('② ThinkPad X1:离线,点不了', /离线/.test(await row(THINKPAD).innerText()) && await row(THINKPAD).isDisabled(), await row(THINKPAD).innerText())
    check('② 底下有「管理设备…」', await menu.locator('[data-run-manage]').count() === 1)
    const mb = await box(menu)
    const vp = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    check('② 菜单整个在窗口里', mb.left >= 0 && mb.top >= 0 && mb.right <= vp.w && mb.bottom <= vp.h, mb)
    const focused = () => win.evaluate(() => document.activeElement?.getAttribute('data-run-row') ?? (document.activeElement?.hasAttribute('data-run-manage') ? 'manage' : document.activeElement?.className ?? null))
    await win.waitForTimeout(120)
    check('② 打开时焦点在勾选的那一行', await focused() === 'home', await focused())
    await win.keyboard.press('ArrowDown')
    check('② ↓ 到 Mac mini', await focused() === MINI, await focused())
    await win.keyboard.press('ArrowDown')
    check('② 再 ↓ 跳过点不了的离线行,到「管理设备」', await focused() === 'manage', await focused())
    await win.keyboard.press('Home')
    check('② Home 回第一行', await focused() === 'home', await focused())
    await view.locator('.composer-anchor').screenshot({ path: shot('2-menu-100.png') })
    await zoom(1.1)
    await windowShot('2-menu-window-110.png')
    await zoom(1)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    check('② Esc 关闭,焦点回到胶囊', await menu.count() === 0 && await win.evaluate(() => document.activeElement?.classList.contains('runloc-pill')))

    // ── ③ 选 Mac mini:那台还没允许过 → 发起确认 → 允许后自动生效 ──
    await runPill.click()
    await row(MINI).click()
    await menu.locator('[data-run-notice]').waitFor({ timeout: 8000 }).catch(() => {})
    check('③ 向那台发起了一次确认', cloud.state.asked === 1, cloud.state.asked)
    check('③ 菜单里说去那台点允许', /请在「Mac mini」上点「允许」/.test(await menu.locator('[data-run-notice]').innerText().catch(() => '')), await menu.locator('[data-run-notice]').innerText().catch(() => '没有'))
    check('③ 允许之前运行位置没变', await where() === 'home', await where())
    await view.locator('.composer-anchor').screenshot({ path: shot('3-waiting-100.png') })
    cloud.state.caller = 'trusted' // 那台电脑上点了「允许」
    await win.waitForFunction((id) => document.querySelector('[data-run-location-picker]')?.getAttribute('data-run-location') === `unit:${id}`, MINI, { timeout: 10_000 }).catch(() => {})
    check('③ 那台允许后自动生效:胶囊写「Mac mini」,菜单收起', await where() === `unit:${MINI}` && /Mac mini/.test(await runPill.innerText()) && await menu.count() === 0, { where: await where(), pill: await runPill.innerText() })

    // ── ④ 项目胶囊换成那台的项目;建会话在那台 ──
    await win.waitForFunction(() => /Tangu 默认项目/.test(document.querySelector('.newchat-projectbar .project-selector:not(.runloc) > .project-pill')?.textContent || ''), null, { timeout: 8000 }).catch(() => {})
    await projectPill.click()
    const pmenu = bar.locator('.project-selector:not(.runloc) .project-menu')
    await pmenu.waitFor({ timeout: 5000 })
    await win.waitForFunction(() => /webapp/.test(document.querySelector('.newchat-projectbar .project-selector:not(.runloc) .project-menu')?.textContent || ''), null, { timeout: 8000 }).catch(() => {})
    const items = (await pmenu.locator('.project-menu-item').allInnerTexts()).map((x) => x.trim())
    check('④ 项目胶囊列的是那台的项目(默认工作区 + 那台会话里出现过的 + 不在项目中工作)', items.length === 3 && /默认项目/.test(items[0]) && items[1] === 'webapp', items)
    check('④ 没有「添加本地项目 / 云端项目」', !items.some((x) => /添加|新建/.test(x)), items)
    await view.locator('.composer-anchor').screenshot({ path: shot('4-remote-projects-100.png') })
    await win.keyboard.press('Escape')
    check('④ 「添加文件夹」不出现(那是这台电脑的文件夹)', await view.locator('[data-extra-folder-add]').count() === 0)
    await zoom(1.1)
    await windowShot('4-remote-window-110.png')
    await zoom(1)

    const ta = view.locator('.t2c-ta:visible').first()
    // 那台中途收回了允许(又要确认):建会话被拒 → 不建到别处去,胶囊上写着在等,设备名不被状态说明挤成省略号
    cloud.state.caller = 'pending'
    await ta.click()
    await ta.fill('你在哪台电脑上?')
    await win.keyboard.press('Enter')
    await win.waitForFunction(() => !!document.querySelector('[data-run-location-picker] .runloc-status'), null, { timeout: 8000 }).catch(() => {})
    check('④ 那台又要确认时建会话被拒:两台引擎都没有建出会话', mini.created.length === 0 && here.created.length === 0, { mini: mini.created.length, here: here.created.length })
    check('④ 胶囊上写着在等那台允许', /等待那台电脑允许/.test(await runPill.innerText()), await runPill.innerText())
    const nameFits = await runPill.locator('.project-pill-name').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    check('④ 带状态说明时设备名没有被截成省略号', nameFits, await runPill.evaluate((el) => Math.round(el.getBoundingClientRect().width)))
    await view.locator('.composer-anchor').screenshot({ path: shot('4-pill-waiting-100.png') })
    cloud.state.caller = 'trusted'
    await ta.click()
    if (!(await ta.inputValue())) await ta.fill('你在哪台电脑上?')
    await win.keyboard.press('Enter')
    for (let t0 = Date.now(); !mini.stub.seen.runs.length && Date.now() - t0 < 12_000;) await win.waitForTimeout(150)
    const init = mini.created[0]?.agent_config || {}
    check('④ 会话建在 Mac mini 的引擎上,本机引擎没有收到建会话', mini.created.length === 1 && here.created.length === 0, { mini: mini.created.length, here: here.created.length })
    check('④ 落点是那台的默认工作区', mini.created[0]?.project_path === '/Users/mini/Forsion' && init.cwd === '/Users/mini/Forsion' && init.execMode === 'host', { project_path: mini.created[0]?.project_path, cwd: init.cwd, execMode: init.execMode })
    check('④ 请求里没有这台电脑的任何路径', !JSON.stringify(mini.created[0] || {}).includes(home), Object.keys(init))
    check('④ run 也起在那台', mini.stub.seen.runs.length === 1 && here.stub.seen.runs.length === 0, { mini: mini.stub.seen.runs.length, here: here.stub.seen.runs.length })
    await win.waitForFunction(() => /我在 Mac mini 上/.test(document.querySelector('.t2-chat-view')?.textContent || ''), null, { timeout: 12_000 }).catch(() => {})
    check('④ 回复经隧道流回来了', /我在 Mac mini 上/.test(await view.innerText()))
    const section = win.locator(`[data-device-section="${MINI}"]`)
    await section.first().waitFor({ timeout: 8000 }).catch(() => {})
    check('④ 侧栏多出「Mac mini」分组', await section.count() >= 1 && /Mac mini/.test(await section.first().innerText().catch(() => '')), await section.count())
    // 右侧任务概览的「工作范围」:只有那台的默认目录;这台电脑的笔记库不在里面,也不给「添加工作文件夹」(那会把本机路径写进那台的会话)
    const scopeRows = await win.locator('.t2-tsum-row').evaluateAll((els) => els.map((el) => el.getAttribute('title') || el.textContent || ''))
    const addRoot = await win.locator('[aria-label^="添加工作文件夹"]').count()
    check('④ 别的电脑上的会话:工作范围不列这台电脑的笔记库,不给「添加工作文件夹」', scopeRows.some((r) => r.includes('/Users/mini/Forsion')) && !scopeRows.some((r) => /Amadeus/.test(r)) && addRoot === 0, { scopeRows, addRoot })
    // 整段下来,经隧道发给那台的请求体里没有这台电脑的任何路径(临时 home 的目录名是唯一的记号:默认工作区、笔记库都在它下面 / 以它为前缀)
    const leaked = cloud.bodies.filter((b) => b.includes(path.basename(home)))
    check('④ 发给那台的请求体里没有这台电脑的路径', cloud.bodies.length > 0 && leaked.length === 0, { sent: cloud.bodies.length, leaked: leaked.map((b) => b.slice(0, 200)) })
    await windowShot('5-remote-session-window.png')

    // ── ⑤ 凭据不进渲染层 ──
    const tunnel = cloud.seen.filter((r) => r.path.includes('/proxy/'))
    check('⑤ 云端隧道收到的每条请求都带主进程盖的 forsion_token', tunnel.length > 3 && tunnel.every((r) => r.auth === `Bearer ${FORSION_TOKEN}`), tunnel.length)
    const relay = await win.evaluate(() => window.tangu.unitRelay())
    const toRelay = rendererRequests.filter((r) => relay && r.url.startsWith(`${relay.base}/units/`))
    check('⑤ 渲染层发往中转口的请求带的是本次启动的口令', toRelay.length > 3 && toRelay.every((r) => r.headers.authorization === `Bearer ${relay.token}`), toRelay.length)
    check('⑤ 渲染层发出的请求头里从没出现 forsion_token', !rendererRequests.some((r) => JSON.stringify(r.headers).includes(FORSION_TOKEN)), rendererRequests.length)
    check('⑤ 中转口只在本机回环上', !!relay && /^http:\/\/127\.0\.0\.1:\d+$/.test(relay.base) && !JSON.stringify(relay).includes(FORSION_TOKEN), relay && relay.base)
    const bare = await fetch(`${relay.base}/units/${MINI}/proxy/engine/agent/sessions`).then((r) => r.status)
    check('⑤ 不带口令打中转口 → 401,一个字节都不转给云端', bare === 401, bare)

    // ── ⑥ 侧栏分组的「+」= 这台电脑的文件夹 ──
    await win.locator('[data-act="new-chat"]').first().click()
    await projectPill.waitFor({ timeout: 10_000 })
    await win.waitForTimeout(600)
    check('⑥ 新对话仍记着上次选的 Mac mini(那台在线)', await where() === `unit:${MINI}`, await where())
    // 同一个类名在这一行里先是「…」菜单、后才是「+」:按图标认(10-14 第三轮点成了「…」,本机一条会话都没建)
    const plus = win.locator('button.t2s-group-add:has(svg.lucide-plus)').first()
    if (await plus.count()) {
      await plus.click()
      for (let t0 = Date.now(); !here.created.length && Date.now() - t0 < 10_000;) await win.waitForTimeout(150)
      check('⑥ 点本机分组的「+」:会话建在本机引擎上,项目是这台电脑的目录', here.created.length === 1 && here.created[0]?.project_path === workspace && mini.created.length === 1, { here: here.created.length, path: here.created[0]?.project_path })
    } else check('⑥ 侧栏有本机分组的「+」', false, '没找到 .t2s-group-add')
    await win.locator('[data-act="new-chat"]').first().click()
    await projectPill.waitFor({ timeout: 10_000 })
    await runPill.click()
    await row('home').click()
    await win.waitForTimeout(500)
    check('⑥ 亲手选回「这台电脑」', await where() === 'home' && (await runPill.innerText()).trim() === '这台电脑', await where())
    await win.locator('[data-act="new-chat"]').first().click()
    await win.waitForTimeout(800)
    check('⑥ 之后的新对话留在这台电脑', await where() === 'home', await where())
  } catch (e) {
    check(`台架中断:${e && e.message}`, false)
    // 中断时把现场倒出来:一轮真 Electron 要排界面测试锁,不能靠「再跑一次看看」
    try {
      const win = app.windows()[0]
      const diag = await win.evaluate(async () => {
        const relay = await window.tangu.unitRelay().catch((err) => ({ error: String(err) }))
        const roster = await window.tangu.unitsList().catch((err) => ({ error: String(err) }))
        const picker = document.querySelector('[data-run-location-picker]')
        return {
          relay: relay && (relay.error ? relay : { base: relay.base, hasToken: !!relay.token, accountId: relay.accountId }),
          roster: roster && (roster.error ? roster : { status: roster.status, units: (roster.json?.units || []).map((u) => `${u.name}/${u.kind}/${u.online}`), detail: roster.json?.detail }),
          where: picker?.getAttribute('data-run-location'),
          menu: document.querySelector('.runloc-menu')?.innerText ?? null,
        }
      })
      console.log('现场  ', JSON.stringify(diag))
      console.log('云端收到', JSON.stringify(cloud.seen.slice(-25).map((r) => `${r.method} ${r.path}${r.auth ? ' [auth]' : ''}`)))
      fs.writeFileSync(shot('fail-window.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64'))
    } catch (err) { console.log('现场取不到:', err && err.message) }
  } finally {
    await app.close().catch(() => {})
    for (const s of [here.stub, mini.stub, cloud]) { try { s.close() } catch { /* ignore */ } }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图在 ${home}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
