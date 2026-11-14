/**
 * 设备的 Unit 窗(一台设备一扇独立窗)真 Electron 实机断言 + 截图。
 * 本机 = 隔离实例(桩引擎 + 本机假云端,夹具登录,不碰真账号);名册由假云端 /api/units 给(主进程经 Extend 读,和真机同一条路);
 * 中转 = 假云端把 /api/units/<id>/proxy/* 转给真的 Unit 网页(UNIT_DIST,缺省 <仓根>/.worktrees/biz-unit-host/unit/dist,local 模式;
 * 中转只认夹具账号的登录头(没带 / 带错 = 401,同真云端),转发时才换成那台 Unit 的主人令牌;收到的头如实记在 state.reqs)。找不到 Unit 网页就明确跳过。
 * ⚠️ 不走「本机开互联后连自己」:远端是自己起的临时 Unit,端口先查空闲。
 *
 * 判据:
 *   W1 从主窗面板「在新窗口打开」→ 只开出一扇这台设备的窗;再开一次不多开(叫到前面)
 *   W2 窗里只有设备页的框:胶囊「名字 · 我的设备」,没有「回到这台电脑」;系统窗口标题 = 设备名;页面走中转、远端账号卡藏起
 *   W3 窗里点左下角头像 → 账号面板打开,**没有** Unit 段
 *   W4 关掉 Unit 窗,主窗不受影响(还在、主窗的远程面没被打开)
 *   S1–S4 离线 / 没登录 / 不在名册 / 名册读失败 各画各的,且这几种状态下**一律没有 webview**(名册确认前不挂页面)
 *   S5 「打开 Forsion」把藏起来的主窗叫出来
 *   L1 非法 id 的链接(forsion://unit/bad?window=standalone)不开 Unit 窗
 *   I1 Unit 窗的渲染层直接调 units:openWindow / units:addToDesktop → 被真实 IPC 的发送方检查挡掉(对照:主窗同一调用放行到下一步)
 *   P1 设备页里 window.open → Unit 窗的远程面不动,链接开在另一扇独立视图窗的内置浏览器里
 *   G1 补头范围:设备页里的脚本打名册 / 改删别台 / 调用方凭据 / 别台的中转 → 假云端收到的不带登录头;打自己的中转带
 *   G2 同分区没绑定的内置浏览器标签页导航到这台的中转 → 不带登录头
 *   G3 主窗的设备页(远程面)同样先经主进程绑定,之后的中转请求带登录头
 *   A  登出:Unit 窗与主窗设备页的 webview 在握手阶段就卸掉;迟到的旧名册回包不把页面挂回来
 *   C1–C2 冷启动带链接 → Unit 窗出来、主窗建了但不露面;二启同理(第二个进程退出、第一个只开 Unit 窗)
 * 截图(SHOT_DIR,缺省系统临时目录):主窗 + Unit 窗并排、四种状态、悬停按钮、右键菜单、深色、110%。
 *
 * 跑:node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run e2e:unitwindow(量的是 out/,先 npm run build)
 * 负对照:UW_QUICK=1 只跑 W1 与 L1。
 */
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net'), os = require('os')
const { spawn, execFileSync } = require('child_process')
const { launch, boot, sleep, makeReporter, shotDir, ROOT } = require('./lib/uiux-electron.cjs')
const { workspaceEnv, MAC_FLAGS } = require('./lib/launch-electron.cjs')

const DESK = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DESK, '../../..')
const UNIT_DIST = process.env.UNIT_DIST || [path.join(REPO_ROOT, '.worktrees/biz-unit-host/unit/dist'), path.join(path.resolve(DESK, '../..'), '.worktrees/biz-unit-host/unit/dist')].find((p) => fs.existsSync(path.join(p, 'main.mjs')))
const SHOTS = shotDir('unitwindow')
const R0 = makeReporter()
const R = { ...R0, check: (name, ok, detail) => R0.check(name, ok, detail !== undefined && typeof detail !== 'string' ? JSON.stringify(detail) : detail) }
const log = (...a) => console.log('[unitwindow]', ...a)

const UID_ON = '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c'
const UID_OFF = '8b1d0c2e-1111-4e8a-9c21-000000000002'
const UID_GONE = 'aaaaaaaa-0000-4000-8000-000000000009'
const LINK = (id) => `forsion://unit/${id}?window=standalone`

const portFree = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))) })
async function freePort(from) { let p = from; while (!(await portFree(p))) p++; return p }

async function startUnit() {
  const port = await freePort(Number(process.env.UNIT_PORT || 3270))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unitwindow-unit-'))
  const dir = path.join(work, 'unit')
  execFileSync(process.execPath, [`${UNIT_DIST}/main.mjs`, 'init', dir, '--mode', 'local', '--port', String(port), '--base', '/web/'], { stdio: 'ignore' })
  const child = spawn(process.execPath, [`${UNIT_DIST}/main.mjs`, 'run', `${dir}/unit.json`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const web = `http://127.0.0.1:${port}/web/`
  for (let i = 0; i < 150; i++) { try { if ((await fetch(web)).status < 500 && fs.existsSync(path.join(dir, 'data/owner-token'))) break } catch { /* 未起 */ } await sleep(200) }
  const token = fs.readFileSync(path.join(dir, 'data/owner-token'), 'utf8').trim()
  log('unit up', web, 'pid', child.pid)
  return { port, token, close: () => { try { child.kill() } catch { /* 只收自己起的 PID */ } try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* */ } } }
}

/** 夹具账号的令牌(authFixture 写进 auth.json;中转只认它,和真云端一样没带 / 带错就 401)。 */
const FIXTURE_TOKEN = 'unitwindow-fixture-token'

/** 假云端:账号 / 额度 / 名册(mode 可切)+ 中转(/api/units/<UID_ON>/proxy/* → 那台 Unit 的 /web/*,其余未知路径原样转给它)。
 *  reqs 如实记下每条请求**收到的** Authorization(转发给 Unit 时才换成主人令牌),补头范围的断言看它。 */
function startCloud(unit) {
  const state = { mode: 'ok', hits: [], rosterDelay: 0, reqs: [] }
  const roster = () => [
    { id: UID_ON, name: '书桌 mini', platform: 'darwin', icon: '🦊', online: true, lanUrl: null },
    { id: UID_OFF, name: '客厅 PC', platform: 'win32', icon: null, online: false, lanUrl: null },
  ]
  const forward = (req, res, to) => {
    const headers = { ...req.headers, host: `127.0.0.1:${unit.port}`, authorization: `Bearer ${unit.token}` }
    const up = http.request({ host: '127.0.0.1', port: unit.port, method: req.method, path: to, headers }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res) })
    up.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(up)
  }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    state.reqs.push({ method: req.method, path: p, probe: u.searchParams.get('probe'), auth: req.headers.authorization ?? null })
    const tunnel = `/api/units/${UID_ON}/proxy/`
    if (p.startsWith(tunnel)) {
      state.hits.push(p)
      if (req.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) return send(401, { detail: 'unauthorized' })
      return forward(req, res, `/web/${p.slice(tunnel.length)}${u.search}`)
    }
    if (p === '/api/brain/users/me') return send(200, { username: 'linyi', nickname: '林一', membershipTier: 'plus' })
    if (p === '/api/units') {
      // rosterDelay:按请求到达时的状态作答、晚这么久才回(造「迟到的旧名册」)
      const mode = state.mode
      const answer = () => (mode === 'unauth' ? send(401, { detail: 'unauthorized' }) : mode === 'fail' ? send(502, { detail: 'bad gateway' }) : send(200, { units: roster() }))
      return state.rosterDelay ? void setTimeout(answer, state.rosterDelay) : answer()
    }
    if (p === '/api/token-quota/my') return send(200, { dailyLimit: 100, dailyUsed: 28, dailyRemaining: 72, dailyPercent: 28, weeklyLimit: 500, weeklyUsed: 140, weeklyRemaining: 360, weeklyPercent: 28, weeklyResetAt: '2026-11-16', resetCards: 1 })
    if (p.startsWith('/api/')) return send(404, { detail: 'not in fixture' })
    return forward(req, res, `${p}${u.search}`) // Unit 页面的绝对路径资源
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, state, close: () => srv.close() })))
}

/** 主进程眼里的窗口。 */
const wins = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => {
  const url = w.webContents.getURL()
  const q = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?'))) : new URLSearchParams()
  return { id: w.id, kind: q.get('window') || 'main', unit: q.get('unit'), wid: q.get('id'), visible: w.isVisible(), title: w.getTitle(), focused: w.isFocused() }
}))
async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms
  let v
  while (Date.now() < end) { v = await fn().catch(() => undefined); if (v) return v; await sleep(step) }
  return v
}
const unitWins = async (app, id) => (await wins(app)).filter((w) => w.unit === id || w.wid === `un_${id}`)
const unitPage = (app, id) => until(async () => app.windows().find((p) => p.url().includes(`unit=${id}`)), 15000)
const closeUnitWindows = (app) => app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (/[?&]unit=/.test(w.webContents.getURL())) w.close() })

/** 并排图:两张 PNG 在一扇隐藏窗里拼起来再截。 */
async function sideBySide(app, a, b, out) {
  const html = path.join(path.dirname(out), '.side-by-side.html')
  fs.writeFileSync(html, `<html><body style="margin:0;display:flex;gap:24px;background:#cfc9c0;padding:24px;align-items:flex-start"><img src="${path.basename(a)}" style="width:640px"><img src="${path.basename(b)}" style="width:520px"></body></html>`)
  const png = await app.evaluate(async ({ BrowserWindow }, html) => {
    const w = new BrowserWindow({ show: false, width: 640 + 520 + 72, height: 520 })
    await w.loadFile(html)
    await new Promise((r) => setTimeout(r, 500))
    const img = (await w.webContents.capturePage()).toPNG().toString('base64')
    w.destroy()
    return img
  }, html)
  fs.writeFileSync(out, Buffer.from(png, 'base64'))
  fs.rmSync(html, { force: true })
}
const captureById = async (app, id, file) => {
  const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), id)
  fs.writeFileSync(file, Buffer.from(png, 'base64'))
  return file
}

/** 第二个实例:同一个 userData,带着链接起,应当拿不到单实例锁、立刻退出(把 argv 交给第一个)。 */
function secondInstance(L, link) {
  return new Promise((resolve) => {
    const env = { FORSION_CLIP_ENTRANCE: '0', ...workspaceEnv(L.env) }
    const child = spawn(require('electron'), [`--user-data-dir=${L.userData}`, '--lang=zh-CN', ROOT, link, ...MAC_FLAGS], { cwd: ROOT, env, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout' }) }, 25000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }) })
  })
}

const authFixture = (cloud) => ({ home }) => { fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud.url, token: FIXTURE_TOKEN }), { mode: 0o600 }) }

/** 主窗面板:点账号卡开面板 → 右键那台 → 点菜单项(或悬停按钮)。 */
async function panelAction(win, name, act) {
  await win.evaluate(() => document.querySelector('.account-pop') || document.querySelector('.rb .ribbon-account, .rb .account-card')?.click())
  await win.waitForSelector('[data-testid="account-units"] .ap-unit[data-unit-id]', { timeout: 10_000 })
  await sleep(500)
  if (act === 'hover') {
    const row = win.locator('[data-testid="account-units"] .ap-unit-wrap', { hasText: name }).first()
    await row.hover()
    await sleep(200)
    return row.locator('.ap-unit-newwin')
  }
  if ((await win.locator('[data-testid="account-units"] .ap-unit-fold[aria-expanded="false"]').count())) await win.click('[data-testid="account-units"] .ap-unit-fold')
  await win.locator('[data-testid="account-units"] .ap-unit', { hasText: name }).first().click({ button: 'right' })
  await win.waitForSelector('.ap-unit-ctx', { timeout: 3000 })
  return win.locator(`.ap-unit-ctx [data-unit-act="${act}"]`)
}

async function main() {
  if (!UNIT_DIST) {
    console.log('SKIP  找不到真的 Unit 网页(.worktrees/biz-unit-host/unit/dist/main.mjs);设 UNIT_DIST 指过去再跑。本次未做实机断言。')
    process.exit(0)
  }
  const unit = await startUnit()
  const cloud = await startCloud(unit)
  const shots = []
  const shot = (name) => path.join(SHOTS, `unit-window-${name}.png`)
  let L = null
  try {
    // ══ 第一段:正常启动,从面板开 ══
    L = await launch({ tag: 'unitwindow', fixtures: { agents: [{ slug: 'xyra', name: 'Xyra', description: '', createdBy: 'user' }], sessions: [] }, beforeLaunch: authFixture(cloud) })
    const { app, win } = L
    await boot(app, win, { space: null, width: 1180, height: 780 })
    await win.evaluate(() => { localStorage.setItem('forsion_tangu_ribbon_expanded', '0') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await sleep(2500)

    // W1 一台一扇
    const hoverBtn = await panelAction(win, '书桌 mini', 'hover')
    if (process.env.UW_SHOTS !== '0') {
      const b = await hoverBtn.boundingBox().catch(() => null)
      if (b) await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await sleep(300)
      await captureById(app, (await wins(app)).find((w) => w.kind === 'main').id, shot('hover')); shots.push(shot('hover'))
    }
    await hoverBtn.click()
    const first = await until(async () => { const w = await unitWins(app, UID_ON); return w.length && w[0].visible ? w : undefined }, 20000)
    R.check('W1 面板悬停按钮「在新窗口打开」→ 开出这台设备的 Unit 窗', !!first && first.length === 1, first)
    await sleep(1500)
    const again = await panelAction(win, '书桌 mini', 'window')
    await again.click()
    await sleep(2500)
    const after = await unitWins(app, UID_ON)
    R.check('W1 再开一次不多开:还是只有一扇(叫到前面)', after.length === 1 && after[0].visible, after)

    // L1 非法 id 的链接
    const bad = await secondInstance(L, LINK('bad'))
    await sleep(2500)
    const badWins = (await wins(app)).filter((w) => w.unit === 'bad' || w.wid === 'un_bad')
    R.check('L1 非法 id 的链接(forsion://unit/bad)不开 Unit 窗', bad.code === 0 && badWins.length === 0, { bad, badWins })

    if (process.env.UW_QUICK) R.note('UW_QUICK:只跑 W1 与 L1(负对照用)')
    else await full(app, win)
  } finally {
    if (L) await L.close()
    cloud.close(); unit.close()
  }
  console.log('截图:\n' + shots.join('\n'))
  process.exit(R.summary() ? 1 : 0)

  async function full(app, win) {
    // W2 窗里只有设备页的框
    const page = await unitPage(app, UID_ON)
    await page.waitForSelector('.unitrs--whole .unitfr-pill', { timeout: 20_000 })
    await page.waitForSelector('.unitrs-web', { timeout: 20_000 }).catch(() => {})
    await sleep(4000)
    const frame = await page.evaluate(() => ({
      pill: document.querySelector('.unitfr-pill')?.textContent ?? '',
      back: !!document.querySelector('.unitfr-back'),
      web: document.querySelector('.unitrs-web')?.getAttribute('src') ?? null,
      avatar: !!document.querySelector('.unitfr-avatar'),
      badge: !!document.querySelector('.unitfr-avatar .unitfr-badge'),
    }))
    const uw = (await unitWins(app, UID_ON))[0]
    R.check('W2 胶囊 = 名字 · 我的设备,没有「回到这台电脑」', frame.pill === '🦊书桌 mini我的设备' && !frame.back, frame)
    R.check('W2 系统窗口标题 = 设备名', uw?.title === '书桌 mini', uw?.title)
    R.check('W2 页面走中转(假云端的 /api/units/<id>/proxy/),左下角宿主头像带角标', !!frame.web && frame.web.startsWith(`${cloud.url}/api/units/${UID_ON}/proxy/`) && frame.avatar && frame.badge && cloud.state.hits.length > 0, { web: frame.web, hits: cloud.state.hits.length })
    const remoteAcct = await app.evaluate(async ({ webContents }, origin) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(origin)).pop()
      if (!wc) return 'no-webview'
      return wc.executeJavaScript(`(() => { const a = document.querySelector('.rb .ribbon-account, .rb .account-card'); return a ? getComputedStyle(a).visibility : 'none' })()`, true)
    }, `${cloud.url}/api/units/${UID_ON}/proxy/`)
    R.check('W2 远端自己的账号卡藏起(没有账号卡也算)', remoteAcct === 'hidden' || remoteAcct === 'none', remoteAcct)

    // G1 补头范围:设备页里的脚本去打名册 / 管理接口和别台的中转 —— 假云端收到的请求不带登录头;同一页打自己的中转带
    const probes = [
      ['GET', '/api/units', 'roster'], ['GET', '/api/units/', 'roster-slash'],
      ['PATCH', `/api/units/${UID_OFF}`, 'patch-other'], ['DELETE', `/api/units/${UID_OFF}`, 'delete-other'],
      ['POST', `/api/units/${UID_ON}/caller-token`, 'caller-token'], ['POST', `/api/units/${UID_OFF}/caller-secret`, 'caller-secret-other'],
      ['GET', `/api/units/${UID_OFF}/proxy/`, 'proxy-other'],
      ['GET', `/api/units/${UID_ON}/proxy/`, 'proxy-own'],
    ]
    const fired = await app.evaluate(async ({ webContents }, { origin, probes }) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(origin)).pop()
      if (!wc) return 'no-webview'
      return wc.executeJavaScript(`Promise.all(${JSON.stringify(probes)}.map(([m, p, tag]) => fetch(p + '?probe=g1-' + tag, { method: m, headers: m === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' }).then((r) => r.status, (e) => String(e))))`, true)
    }, { origin: `${cloud.url}/api/units/${UID_ON}/proxy/`, probes })
    await sleep(500)
    const seen = (tag) => cloud.state.reqs.filter((r) => r.probe === `g1-${tag}`)
    const leaked = probes.filter(([, , tag]) => tag !== 'proxy-own').map(([m, p, tag]) => ({ tag, m, p, got: seen(tag) })).filter((x) => !x.got.length || x.got.some((r) => r.auth))
    for (const [m, p, tag] of probes.filter(([, , t]) => t !== 'proxy-own')) {
      const got = seen(tag)
      R.check(`G1 设备页脚本 ${m} ${p.replace(UID_OFF, '<别台>').replace(UID_ON, '<这台>')} → 假云端收到了、且不带登录头`, got.length > 0 && got.every((r) => !r.auth), { fired, got })
    }
    const own = seen('proxy-own')
    R.check('G1 同一页打这台自己的中转 → 带登录头', own.length > 0 && own.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}`), { fired, own, leaked: leaked.length })
    await captureById(app, uw.id, shot('light')); shots.push(shot('light'))

    // W3 窗里的账号面板没有 Unit 段
    await page.click('.unitfr-avatar')
    await page.waitForSelector('.account-pop', { timeout: 8000 }).catch(() => {})
    await sleep(700)
    const pop = await page.evaluate(() => ({ pop: !!document.querySelector('.account-pop'), units: !!document.querySelector('[data-testid="account-units"]') }))
    R.check('W3 Unit 窗里点头像 → 账号面板打开,没有 Unit 段', pop.pop && !pop.units, pop)
    await captureById(app, uw.id, shot('panel')); shots.push(shot('panel'))
    await page.click('.unitfr-avatar').catch(() => {})

    // I1 Unit 窗的渲染层直接调主窗才许调的 IPC:真实的发送方检查把它挡掉(对照:主窗同一个调用走到了「开发模式恒拒」)
    const before = (await wins(app)).length
    const fromUnit = await page.evaluate(async (off) => ({
      open: await window.tangu.unitsOpenWindow(off).catch((e) => ({ threw: String(e) })),
      desk: await window.tangu.unitsAddToDesktop({ id: off }).catch((e) => ({ threw: String(e) })),
    }), UID_OFF)
    await sleep(1500)
    const fromMain = await win.evaluate(async (off) => window.tangu.unitsAddToDesktop({ id: off }), UID_OFF)
    R.check('I1 Unit 窗直接调 units:openWindow → 被拒、没有多开窗', fromUnit.open?.ok === false && (await wins(app)).length === before, { open: fromUnit.open, before, after: (await wins(app)).length })
    R.check('I1 Unit 窗直接调 units:addToDesktop → 被拒(untrusted sender);主窗同一调用走到开发模式恒拒', fromUnit.desk?.ok === false && fromUnit.desk?.detail === 'untrusted sender' && fromMain?.code === 'unpackaged', { unit: fromUnit.desk, main: fromMain })

    // P1 设备页里触发 window.open:Unit 窗的远程面不动,链接开在另一扇独立视图窗的内置浏览器里
    const popupUrl = `http://127.0.0.1:${unit.port}/web/?popup=1`
    const opened = await app.evaluate(async ({ webContents }, { origin, url }) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(origin)).pop()
      if (!wc) return 'no-webview'
      await wc.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank'); true`, true)
      return 'ok'
    }, { origin: `${cloud.url}/api/units/${UID_ON}/proxy/`, url: popupUrl })
    const popupWin = await until(async () => (await wins(app)).find((w) => w.kind === 'detached' && !w.unit && w.visible), 15000)
    await sleep(1200)
    const unitStill = await page.evaluate(() => ({ active: !!document.querySelector('.unitrs--whole:not(.unitrs-hidden)'), web: document.querySelectorAll('.unitrs-web').length, fail: !!document.querySelector('.unitfr-fail') }))
    const popupPage = popupWin ? app.windows().find((p) => p.url().includes(`id=${popupWin.wid}`)) : null
    const popupSrc = popupPage ? await until(() => popupPage.evaluate(() => document.querySelector('webview')?.getAttribute('src') || ''), 10000) : ''
    R.check('P1 设备页里 window.open → Unit 窗的远程面仍在、仍可用', opened === 'ok' && unitStill.active && unitStill.web === 1 && !unitStill.fail, { opened, unitStill })
    R.check('P1 链接开在另一扇独立视图窗的内置浏览器里(同一分区)', !!popupWin && String(popupSrc).startsWith(popupUrl.split('?')[0]), { popupWin, popupSrc })
    // G2 同分区的普通标签页(上面那扇内置浏览器,没绑定)由宿主直接导航到这台的中转(Sec-Fetch-Site: none)→ 不带登录头
    const tabNav = await app.evaluate(async ({ webContents }, { prefix, url }) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(prefix)).pop()
      if (!wc) return 'no-webview'
      try { await wc.loadURL(url) } catch (e) { return String(e) }
      return 'ok'
    }, { prefix: popupUrl.split('?')[0], url: `${cloud.url}/api/units/${UID_ON}/proxy/?probe=g2-tab` })
    await sleep(500)
    const tabReqs = cloud.state.reqs.filter((r) => r.probe === 'g2-tab')
    R.check('G2 同分区没绑定的标签页导航到这台的中转 → 假云端收到的请求不带登录头', tabReqs.length > 0 && tabReqs.every((r) => !r.auth), { tabNav, tabReqs })
    if (popupWin) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), popupWin.id)
    await sleep(500)

    // 主窗 + Unit 窗并排
    const mainId = (await wins(app)).find((w) => w.kind === 'main').id
    await captureById(app, mainId, shot('main-only'))
    await sideBySide(app, shot('main-only'), shot('light'), shot('side-by-side')); shots.push(shot('side-by-side'))

    // 右键菜单截图(主窗)
    await panelAction(win, '书桌 mini', 'window')
    await sleep(700) // 菜单淡入完再拍
    await captureById(app, mainId, shot('ctx-menu')); shots.push(shot('ctx-menu'))
    await win.keyboard.press('Escape'); await sleep(200); await win.keyboard.press('Escape'); await sleep(500)

    // W4 关窗,主窗不受影响
    await closeUnitWindows(app)
    await until(async () => (await unitWins(app, UID_ON)).length === 0 || undefined, 10000)
    const mainAfter = (await wins(app)).find((w) => w.kind === 'main')
    const mainRemote = await win.evaluate(() => !!document.querySelector('.unitrs:not(.unitrs-hidden)'))
    R.check('W4 关掉 Unit 窗:主窗还在、还显示,主窗没被切到那台', !!mainAfter?.visible && !mainRemote, { mainAfter, mainRemote })

    // S 各种状态:开窗后看状态文案,且没有 webview
    const stateOf = async (id) => {
      const p = await unitPage(app, id)
      await p.waitForSelector('[data-unit-window-state]', { timeout: 15_000 }).catch(() => {})
      await sleep(600)
      return { p, s: await p.evaluate(() => ({ state: document.querySelector('[data-unit-window-state]')?.getAttribute('data-unit-window-state') ?? null, text: document.querySelector('.unitfr-fail-title')?.textContent ?? null, btn: document.querySelector('.unitfr-fail .btn')?.textContent ?? null, web: document.querySelectorAll('.unitrs-web, webview').length })) }
    }
    const openVia = (id) => win.evaluate((id) => window.tangu.unitsOpenWindow(id), id)
    const stateShot = async (id, name) => { const w = (await unitWins(app, id))[0]; if (w) { await captureById(app, w.id, shot(name)); shots.push(shot(name)) } }

    await openVia(UID_OFF)
    let r = await stateOf(UID_OFF)
    R.check('S1 离线 →「不在线」+「重试」,没有 webview', r.s.state === 'offline' && r.s.text === '不在线' && r.s.btn === '重试' && r.s.web === 0, r.s)
    await stateShot(UID_OFF, 'offline'); await closeUnitWindows(app); await sleep(800)

    cloud.state.mode = 'unauth'
    await openVia(UID_ON)
    r = await stateOf(UID_ON)
    R.check('S2 没登录(名册 401)→「先在 Forsion 里登录」+「打开 Forsion」,没有 webview', r.s.state === 'signedOut' && r.s.text === '先在 Forsion 里登录' && r.s.btn === '打开 Forsion' && r.s.web === 0, r.s)
    await stateShot(UID_ON, 'signed-out')
    // S5 「打开 Forsion」叫出藏起来的主窗
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).hide(), mainId)
    await r.p.click('.unitfr-fail .btn')
    const shown = await until(async () => (await wins(app)).find((w) => w.kind === 'main' && w.visible), 8000)
    R.check('S5「打开 Forsion」→ 主窗出来', !!shown)
    await closeUnitWindows(app); await sleep(800)

    cloud.state.mode = 'ok'
    await openVia(UID_GONE)
    r = await stateOf(UID_GONE)
    R.check('S3 名册里没有这台 →「这台设备不在当前账号名下」+「打开 Forsion」,没有 webview', r.s.state === 'missing' && r.s.text === '这台设备不在当前账号名下' && r.s.web === 0, r.s)
    await stateShot(UID_GONE, 'missing'); await closeUnitWindows(app); await sleep(800)

    cloud.state.mode = 'fail'
    await openVia(UID_ON)
    r = await stateOf(UID_ON)
    R.check('S4 名册读失败(502)→「暂时连不上 Forsion 云端」+「重试」(不是「不在名下」),没有 webview', r.s.state === 'unknown' && r.s.text === '暂时连不上 Forsion 云端' && r.s.btn === '重试' && r.s.web === 0, r.s)
    await stateShot(UID_ON, 'roster-error')
    cloud.state.mode = 'ok'
    await r.p.click('.unitfr-fail .btn')
    await r.p.waitForSelector('.unitrs-web', { timeout: 15_000 }).catch(() => {})
    R.check('S4 云端恢复后点「重试」→ 页面挂上', (await r.p.locator('.unitrs-web').count()) === 1)
    await closeUnitWindows(app); await sleep(800)

    // 深色 / 110% 各一张 Unit 窗
    for (const [name, set] of [['dark', { forsion_theme_pref: 'dark' }], ['zoom110', { forsion_theme_pref: 'light', forsion_ui_zoom: '1.1' }]]) {
      await win.evaluate((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v) }, set)
      await openVia(UID_ON)
      const p = await unitPage(app, UID_ON)
      await p.waitForSelector('.unitrs-web', { timeout: 20_000 }).catch(() => {})
      await sleep(5000)
      await stateShot(UID_ON, name)
      await closeUnitWindows(app); await sleep(800)
    }
    await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_ui_zoom', '1') })
    // A 换账号(登出):握手阶段就卸掉旧页面 —— Unit 窗与主窗设备页都是;迟到的旧名册回包不把页面挂回来
    await openVia(UID_ON)
    const ap = await unitPage(app, UID_ON)
    await ap.waitForSelector('.unitrs-web', { timeout: 20_000 }).catch(() => {})
    // 主窗也切到那台(设备页);G3 从这里起数假云端收到的中转请求
    const mark = cloud.state.reqs.length
    await app.evaluate(({ BrowserWindow }, p) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
      w.webContents.send('window:mainAction', 'unit-route', p)
    }, JSON.stringify({ kind: 'unit', id: UID_ON, name: '书桌 mini', via: 'tunnel' }))
    await win.waitForSelector('.unitrs-web', { timeout: 10_000 }).catch(() => {})
    // G3 主窗的设备页同样经主进程绑定:绑上了才从空白页换成中转地址,且这之后假云端收到的中转请求带登录头
    const tunnelUrl = `${cloud.url}/api/units/${UID_ON}/proxy/`
    const mainSrc = await until(() => win.evaluate((u) => { const s = document.querySelector('.unitrs-web')?.getAttribute('src') || ''; return s.startsWith(u) ? s : '' }, tunnelUrl), 10000)
    await sleep(1500)
    const mainHits = cloud.state.reqs.slice(mark).filter((r) => r.path.startsWith(`/api/units/${UID_ON}/proxy/`))
    R.check('G3 主窗设备页:绑定后换上中转地址,收到的中转请求都带登录头', !!mainSrc && mainHits.length > 0 && mainHits.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}`), { mainSrc, hits: mainHits.length, noAuth: mainHits.filter((r) => !r.auth).length })
    const pre = { unit: await ap.locator('.unitrs-web').count(), main: await win.locator('.unitrs-web').count() }
    // 再开一扇正在等名册的窗(名册故意慢 4 秒),趁它在途时登出
    cloud.state.rosterDelay = 4000
    await openVia(UID_OFF)
    const lp = await unitPage(app, UID_OFF)
    await lp.waitForSelector('[data-unit-window="loading"]', { timeout: 10_000 }).catch(() => {})
    // 每个窗口自己记:webview 什么时候没了、「切换完成」的广播(auth:changed)什么时候到 —— 前者必须早于后者(握手阶段)
    const arm = (p) => p.evaluate(() => {
      const w = window
      w.__unloadAt = 0; w.__authAt = 0
      w.tangu.onAuthChanged(() => { if (!w.__authAt) w.__authAt = performance.now() })
      new MutationObserver(() => { if (!w.__unloadAt && !document.querySelector('.unitrs-web')) w.__unloadAt = performance.now() }).observe(document.body, { childList: true, subtree: true })
    })
    await arm(ap); await arm(win)
    const watch = Promise.all([ap, win].map((p) => p.waitForFunction(() => !!window.__authAt, null, { timeout: 15_000 }).catch(() => {})))
    cloud.state.mode = 'unauth' // 之后再读名册就是 401;在途那份(请求时设备还在)照旧按 200 迟到
    const t0 = Date.now()
    const out = await win.evaluate(async () => { try { await window.tangu.forsionLogout(); return 'ok' } catch (e) { return String(e) } })
    const tDone = Date.now()
    await watch
    await sleep(6000) // 等那份迟到的旧名册(200 + 设备在)回来
    cloud.state.rosterDelay = 0
    const after1 = await ap.evaluate(() => ({ state: document.querySelector('.unitwin')?.getAttribute('data-unit-window'), web: document.querySelectorAll('.unitrs-web').length }))
    const after2 = await lp.evaluate(() => ({ state: document.querySelector('.unitwin')?.getAttribute('data-unit-window'), web: document.querySelectorAll('.unitrs-web').length }))
    const mainAfterOut = await win.evaluate(() => ({ web: document.querySelectorAll('.unitrs-web').length, active: !!document.querySelector('.unitrs:not(.unitrs-hidden)') }))
    R.check('A 登出前两边都开着那台的页面', pre.unit === 1 && pre.main === 1, pre)
    R.check('A 登出:Unit 窗的 webview 被卸掉,显示「先在 Forsion 里登录」', after1.web === 0 && after1.state === 'signedOut', { out, after1 })
    R.check('A 登出:主窗设备页的 webview 也被卸掉', mainAfterOut.web === 0 && !mainAfterOut.active, mainAfterOut)
    const order = { unit: await ap.evaluate(() => ({ unload: window.__unloadAt, auth: window.__authAt })), main: await win.evaluate(() => ({ unload: window.__unloadAt, auth: window.__authAt })) }
    const early = (o) => !!o.unload && !!o.auth && o.unload < o.auth
    R.check('A 卸掉发生在握手阶段:两边 webview 都在「切换完成」广播到达之前就没了', early(order.unit) && early(order.main), { t0, tDone, order })
    R.check('A 迟到的旧名册(设备还在)不把页面挂回来:那扇等名册的窗停在「没登录」、没有 webview', after2.web === 0 && after2.state === 'signedOut', after2)
    await closeUnitWindows(app); await sleep(800)
    await L.close(); L = null

    // ══ 第二段:冷启动带链接 / 二启 ══
    L = await launch({ tag: 'unitwindow-cold', fixtures: { agents: [], sessions: [] }, beforeLaunch: authFixture(cloud), args: [LINK(UID_ON)] })
    const app2 = L.app
    const cw = await until(async () => { const w = await unitWins(app2, UID_ON); return w.length && w[0].visible ? w : undefined }, 40000)
    R.check('C1 冷启动带链接 → Unit 窗出来', !!cw, await wins(app2))
    await sleep(3000)
    const m1 = (await wins(app2)).find((w) => w.kind === 'main')
    R.check('C1 主窗建了但不露面', !!m1 && !m1.visible, m1)
    await closeUnitWindows(app2)
    await until(async () => (await unitWins(app2, UID_ON)).length === 0 || undefined, 10000)
    const second = await secondInstance(L, LINK(UID_ON))
    const sw = await until(async () => { const w = await unitWins(app2, UID_ON); return w.length && w[0].visible ? w : undefined }, 20000)
    const m2 = (await wins(app2)).find((w) => w.kind === 'main')
    R.check('C2 二启带链接:第二个进程退出,第一个开出 Unit 窗', second.code === 0 && !!sw, { second, sw })
    R.check('C2 主窗仍然不露面', !!m2 && !m2.visible, m2)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
