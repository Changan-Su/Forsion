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
 *   G4 Unit 窗设备页 window.open 自己的中转 → 独立视图窗里那张页带登录头、加载成功;开别台的中转 → 不带
 *   G5 主窗设备页 window.open 自己的中转 → 内置浏览器标签带登录头、加载成功
 *   G6 主窗 中转 → 直连地址 → 回中转:第二次仍先挂空白页、绑上再导航,带登录头加载成功
 *   G7 已绑定的设备页导航到外站(不发 referrer),外站脚本 window.open 这台的中转 → 新页不带登录头
 *   A  登出:Unit 窗与主窗设备页的 webview 在握手阶段就卸掉;迟到的旧名册回包不把页面挂回来
 *   C1–C2 冷启动带链接 → Unit 窗出来、主窗建了但不露面;二启同理(第二个进程退出、第一个只开 Unit 窗)
 *   SH 别人共享给当前账号的 Unit(第三段,另起一份隔离实例)。要一份会把 `{ shared: true }` 透传给云端的 Extend:
 *      设了 EXTEND_SHARED(一份 build 过的 Extend 检出)就把它装进隔离实例(版本抬高,用本机的 Extend 签名钥签);
 *      没设就看随包的 Extend 认不认(dist 里有 shared=1),认就直接用;都不满足就打 NOTE 跳过这一段。
 *      假云端只在 ?shared=1 时回 `shared`;那台的页面在 http://<id>.localhost:<端口> 上(另起的「子域」服务,转给同一台真 Unit)。
 *      SH1 面板:「我的设备」之后按组分、组标题、灰字、休眠中字样、点不动的行不是按钮;右键只有「切换到这台」,打开 Space 的行没有菜单
 *      SH2 点能进的行 → 整窗切过去、胶囊「名字 · 组标题」、页面加载自子域;面板里那一行选中
 *      SH3 子域上的请求带登录头,页面自带的占位 `authorization: Bearer tunnel`(小写)被换掉;页面脚本打云端名册 / 云端中转 / 别台子域 → 不带
 *      SH4 宿主把这张已绑定的 webview 直接导航到云端中转(Sec-Fetch-Site: none,只剩前缀在把关)→ 不带
 *      SH5 enter = none 的行(哪怕名册给了合格地址)绑不上;addToDesktop 对共享行拒;共享页 window.open 自己子域 → 新页带头,云端 / 别台子域 → 不带
 *      SH6 503 →「正在唤醒…」并按间隔自动重试到成功;间隔 / 封顶调短后到点出「没能唤醒」+ 重试 + 回到这台电脑;403 →「你现在不能进入这台 Unit」,没有重试
 *      SH7 名册里这一行改成 enter = none,窗口重新拿到焦点 → 退回这台电脑并说一句
 *      SH8 enter = none 的行点了 → 切到假插件(商店身份 market-<UUID>,manifest id 对上)的 Space;点不动的行点了什么都不发生
 *      SH9 拿共享行的 id 开 Unit 窗(IPC、forsion://unit/<id>?window=standalone 链接各一次)→「这台设备不在当前账号名下」、没有 webview、不发带头的请求
 *      UW_SHARED_ONLY=1 只跑这一段。
 * 截图(SHOT_DIR,缺省系统临时目录):主窗 + Unit 窗并排、四种状态、悬停按钮、右键菜单、深色、110%;共享:面板(亮 / 暗)、整窗、唤醒中、不能进入。
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

const UID_SH = '9c0e1d2f-2222-4e8a-9c21-000000000003' // 共享过来、能进
const UID_SH_NONE = '9c0e1d2f-3333-4e8a-9c21-000000000004' // 共享过来、不能进,点了开插件 Space
const UID_SH_INERT = '9c0e1d2f-4444-4e8a-9c21-000000000005' // 共享过来、不能进,插件没装 → 点不动
const SHARED_PLUGIN_DIR = 'market-5b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const EXTEND_SHARED = process.env.EXTEND_SHARED || null
/** 随包的 Extend(隔离实例首启时种进去的那份)。 */
const BUNDLED_EXTEND = path.join(DESK, 'node_modules/@forsion/extend')
const extendPassesShared = (dir) => { try { return fs.readFileSync(path.join(dir, 'dist/desktop.mjs'), 'utf8').includes('shared=1') } catch { return false } }

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
  const state = { mode: 'ok', hits: [], rosterDelay: 0, reqs: [], shared: null, rosterQueries: [] }
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
    // n = 收到几枚 Authorization(按原始头数;node 合并后的 req.headers 只留一枚,看不出页面自带的占位值有没有被换掉)
    let n = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'authorization') n++
    state.reqs.push({ method: req.method, path: p, probe: u.searchParams.get('probe'), auth: req.headers.authorization ?? null, n })
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
      // 共享过来的 Unit:只在 ?shared=1 时回(和真云端一样,不带参数时回包与旧版逐字节一致)
      const withShared = u.searchParams.get('shared') === '1' && state.shared
      state.rosterQueries.push(u.search)
      const answer = () => (mode === 'unauth' ? send(401, { detail: 'unauthorized' }) : mode === 'fail' ? send(502, { detail: 'bad gateway' }) : send(200, { units: roster(), ...(withShared ? { shared: state.shared() } : {}) }))
      return state.rosterDelay ? void setTimeout(answer, state.rosterDelay) : answer()
    }
    if (p === '/api/token-quota/my') return send(200, { dailyLimit: 100, dailyUsed: 28, dailyRemaining: 72, dailyPercent: 28, weeklyLimit: 500, weeklyUsed: 140, weeklyRemaining: 360, weeklyPercent: 28, weeklyResetAt: '2026-11-16', resetCards: 1 })
    if (p.startsWith('/api/')) return send(404, { detail: 'not in fixture' })
    return forward(req, res, `${p}${u.search}`) // Unit 页面的绝对路径资源
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, state, close: () => srv.close() })))
}

/** 外站:另起的本地源,页面不发 referrer(攻击者能自己定 referrer 策略,只能靠「发起页此刻在哪」挡)。 */
function startOutside() {
  const srv = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta name="referrer" content="no-referrer"><title>outside</title><p>outside</p>') })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() })))
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
  const outside = await startOutside()
  const shots = []
  const shot = (name) => path.join(SHOTS, `unit-window-${name}.png`)
  let L = null
  try {
    if (!process.env.UW_SHARED_ONLY) await firstSegments()
    if (!process.env.UW_QUICK) {
      if (L) { await L.close(); L = null }
      await sharedSegment()
    }
  } finally {
    if (L) await L.close()
    cloud.close(); unit.close(); outside.close()
  }
  console.log('截图:\n' + shots.join('\n'))
  process.exit(R.summary() ? 1 : 0)

  async function firstSegments() {
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
  }

  async function full(app, win) {
    /** 设备页(按宿主窗口挑)里 window.open 一个地址。 */
    const openFromDevicePage = (hostKind, url) => app.evaluate(async ({ webContents }, { prefix, url, hostKind }) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(prefix)
        && (hostKind === 'unit' ? /[?&]unit=/.test(w.hostWebContents?.getURL() || '') : !/[?&]window=/.test(w.hostWebContents?.getURL() || ''))).pop()
      if (!wc) return 'no-webview'
      await wc.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank'); true`, true)
      return 'ok'
    }, { prefix: `${cloud.url}/api/units/${UID_ON}/proxy/`, url, hostKind })
    /** 新开的那张页(按地址里的 probe 认)加载成功了吗:不是 401 的 JSON、有脚本。 */
    const popupLoaded = (probe) => until(() => app.evaluate(async ({ webContents }, probe) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().includes(`probe=${probe}`)).pop()
      if (!wc || wc.isLoading()) return undefined
      return wc.executeJavaScript(`({ ok: !document.body.innerText.includes('unauthorized') && document.querySelectorAll('script').length > 0, text: document.body.innerText.slice(0, 80) })`, true)
    }, probe), 15000)
    const probeReqs = (probe) => cloud.state.reqs.filter((r) => r.probe === probe)
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
    // G1b 页面自带小写的占位 `authorization: Bearer tunnel` 打自己的中转 → 到假云端只有一枚、是夹具令牌(宿主替换,不是追加)
    const firedPh = await app.evaluate(async ({ webContents }, { origin, url }) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(origin)).pop()
      if (!wc) return 'no-webview'
      return wc.executeJavaScript(`fetch(${JSON.stringify(url)}, { headers: { authorization: 'Bearer tunnel' } }).then((r) => r.status, (e) => String(e))`, true)
    }, { origin: `${cloud.url}/api/units/${UID_ON}/proxy/`, url: `/api/units/${UID_ON}/proxy/?probe=g1-placeholder` })
    await sleep(300)
    const ph = seen('placeholder')
    R.check('G1b 中转:页面自带小写 `authorization: Bearer tunnel` → 假云端只收到一枚、是夹具令牌', ph.length > 0 && ph.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}` && r.n === 1), { firedPh, ph })
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

    // G4 Unit 窗的设备页 window.open 自己中转下的地址 → 新开的独立视图窗那张页带登录头、加载成功;开别台的中转 → 不带
    const ownUrl = `${cloud.url}/api/units/${UID_ON}/proxy/?probe=g4-own`
    const g4open = await openFromDevicePage('unit', ownUrl)
    const g4win = await until(async () => (await wins(app)).find((w) => w.kind === 'detached' && !w.unit && w.visible), 15000)
    const g4load = await popupLoaded('g4-own')
    const g4reqs = probeReqs('g4-own')
    R.check('G4 Unit 窗设备页 window.open 自己的中转 → 新页带登录头且加载成功', g4open === 'ok' && !!g4win && g4reqs.length > 0 && g4reqs.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}`) && g4load?.ok === true, { g4open, g4win: !!g4win, g4reqs, g4load })
    if (g4win) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), g4win.id)
    await sleep(500)
    const g4other = await openFromDevicePage('unit', `${cloud.url}/api/units/${UID_OFF}/proxy/?probe=g4-other`)
    const g4owin = await until(async () => (await wins(app)).find((w) => w.kind === 'detached' && !w.unit && w.visible), 15000)
    await until(async () => probeReqs('g4-other').length > 0 || undefined, 10000)
    const g4oreqs = probeReqs('g4-other')
    R.check('G4 Unit 窗设备页 window.open 别台的中转 → 新页不带登录头', g4other === 'ok' && g4oreqs.length > 0 && g4oreqs.every((r) => !r.auth), { g4other, g4oreqs })
    if (g4owin) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), g4owin.id)
    await sleep(500)

    // G7 Unit 窗已绑定的设备页被导航到外站(绑定还在),外站脚本 window.open 这台的中转 → 新页不带登录头
    const g7 = await app.evaluate(async ({ webContents }, { prefix, outside, url }) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(prefix) && /[?&]unit=/.test(w.hostWebContents?.getURL() || '')).pop()
      if (!wc) return 'no-webview'
      try { await wc.loadURL(outside) } catch (e) { return 'load:' + String(e) }
      if (!wc.getURL().startsWith(outside)) return 'not-outside:' + wc.getURL()
      await wc.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank'); true`, true)
      return 'ok'
    }, { prefix: `${cloud.url}/api/units/${UID_ON}/proxy/`, outside: outside.url, url: `${cloud.url}/api/units/${UID_ON}/proxy/?probe=g7-outside` })
    const g7win = await until(async () => (await wins(app)).find((w) => w.kind === 'detached' && !w.unit && w.visible), 15000)
    await until(async () => probeReqs('g7-outside').length > 0 || undefined, 10000)
    const g7reqs = probeReqs('g7-outside')
    R.check('G7 已绑定的设备页导航到外站后,外站 window.open 这台的中转 → 新页不带登录头', g7 === 'ok' && g7reqs.length > 0 && g7reqs.every((r) => !r.auth), { g7, g7reqs })
    if (g7win) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), g7win.id)
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
    // G6 中转 → 直连地址 → 回中转:第二张中转 webview 仍先挂空白页、绑上再导航,带登录头加载成功
    const routeMain = (p) => app.evaluate(({ BrowserWindow }, p) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
      w.webContents.send('window:mainAction', 'unit-route', p)
    }, JSON.stringify(p))
    await routeMain({ kind: 'addr', url: `http://127.0.0.1:${unit.port}/web/` })
    await until(() => win.evaluate(() => (document.querySelector('.unitrs-web')?.getAttribute('src') || '').includes('/web/') || undefined), 10000)
    await sleep(1500)
    await win.evaluate(() => {
      const seen = (window.__g6Srcs = [])
      const rec = () => { const s = document.querySelector('.unitrs-web')?.getAttribute('src'); if (s && seen[seen.length - 1] !== s) seen.push(s) }
      rec(); new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
    })
    const g6mark = cloud.state.reqs.length
    await routeMain({ kind: 'unit', id: UID_ON, name: '书桌 mini', via: 'tunnel' })
    const g6src = await until(() => win.evaluate((u) => { const s = document.querySelector('.unitrs-web')?.getAttribute('src') || ''; return s.startsWith(u) ? s : '' }, tunnelUrl), 10000)
    const g6load = await until(() => app.evaluate(async ({ webContents, BrowserWindow }, u) => {
      const main = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === main.webContents && w.getURL().startsWith(u)).pop()
      if (!wc || wc.isLoading()) return undefined
      return wc.executeJavaScript(`({ ok: !document.body.innerText.includes('unauthorized') && document.querySelectorAll('script').length > 0 })`, true)
    }, tunnelUrl), 15000)
    const g6srcs = await win.evaluate(() => window.__g6Srcs)
    const g6hits = cloud.state.reqs.slice(g6mark).filter((r) => r.path.startsWith(`/api/units/${UID_ON}/proxy/`))
    R.check('G6 中转 → 直连 → 回中转:第二次先挂空白页再换中转地址,中转请求都带登录头、页面加载成功',
      !!g6src && g6srcs.includes('about:blank') && g6srcs.indexOf('about:blank') < g6srcs.findIndex((x) => x.startsWith(tunnelUrl)) && g6hits.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}`) && g6load?.ok === true,
      { g6srcs, hits: g6hits.length, noAuth: g6hits.filter((r) => !r.auth).length, g6load })
    const pre = { unit: await ap.locator('.unitrs-web').count(), main: await win.locator('.unitrs-web').count() }
    // G5 主窗设备页 window.open 自己中转下的地址 → 开在内置浏览器标签里,那张页带登录头、加载成功
    const g5open = await openFromDevicePage('main', `${cloud.url}/api/units/${UID_ON}/proxy/?probe=g5-own`)
    const g5load = await popupLoaded('g5-own')
    const g5reqs = probeReqs('g5-own')
    R.check('G5 主窗设备页 window.open 自己的中转 → 内置浏览器新标签带登录头且加载成功', g5open === 'ok' && g5reqs.length > 0 && g5reqs.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}`) && g5load?.ok === true, { g5open, g5reqs, g5load })
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

  // ══ 第三段:别人共享给当前账号的 Unit ══
  async function sharedSegment() {
    let installExtend = false
    if (EXTEND_SHARED) {
      if (!extendPassesShared(EXTEND_SHARED) || !fs.existsSync(path.join(EXTEND_SHARED, 'scripts/signature.mjs'))) {
        R.note('SH 跳过:EXTEND_SHARED 指的那份 Extend 不认 { shared: true } 或没有签名脚本(先在那份检出里 build)')
        return
      }
      installExtend = true
    } else if (!extendPassesShared(BUNDLED_EXTEND)) {
      R.note('SH 跳过:随包的 Extend 还不会把 { shared: true } 透传给云端;设 EXTEND_SHARED 指一份会的 build 过的 Extend')
      return
    }
    const sub = await startSubdomain(unit)
    const SUB = `http://${UID_SH}.localhost:${sub.port}`
    const WEB = `${SUB}/api/units/${UID_SH}/proxy/web/`
    const shRows = { frameEnter: 'frame', sleeping: true }
    const sharedRow = (id, name, enter, extra = {}) => ({
      id, name, platform: 'linux', icon: null, online: true,
      shared: { group: { id: 'group-1', title: { zh: '星河工作室', en: 'Galaxy Studio' } }, roleLabel: { zh: '管理员', en: 'Admin' }, enter, ...(extra.open ? { open: extra.open } : {}) },
      ...(extra.webUrl ? { webUrl: extra.webUrl } : {}), ...(extra.sleeping ? { sleeping: true } : {}),
    })
    cloud.state.shared = () => [
      sharedRow(UID_SH, '工作室 Unit', shRows.frameEnter, { webUrl: shRows.frameEnter === 'frame' ? WEB : undefined, sleeping: shRows.sleeping }),
      // 不能进,但名册「误」给了合格地址:绑定只认 enter(SH5 / 负对照 enter)
      sharedRow(UID_SH_NONE, '插件那台', 'none', { open: { kind: 'space', plugin: 'shared-probe' }, webUrl: `http://${UID_SH_NONE}.localhost:${sub.port}/api/units/${UID_SH_NONE}/proxy/web/` }),
      sharedRow(UID_SH_INERT, '另一台', 'none', { open: { kind: 'space', plugin: 'not-installed' } }),
    ]
    cloud.state.mode = 'ok'
    cloud.state.rosterDelay = 0
    try {
      L = await launch({ tag: 'unitwindow-shared', fixtures: { agents: [], sessions: [] }, beforeLaunch: async (ctx) => { authFixture(cloud)(ctx); if (installExtend) await installSharedExtend(ctx.home); installSharedPlugin(ctx.home) } })
      const { app, win } = L
      await boot(app, win, { space: null, width: 1180, height: 780 })
      await win.evaluate(() => { localStorage.setItem('forsion_tangu_ribbon_expanded', '0') })
      await win.reload({ waitUntil: 'domcontentloaded' })
      await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
      await sleep(3000)
      const mainId = (await wins(app)).find((w) => w.kind === 'main').id
      const UNITS = '[data-testid="account-units"]'
      const openPanel = async () => {
        if (await win.locator('.account-pop').count()) return
        await win.evaluate(() => (document.querySelector('.unitrs--whole:not(.unitrs-hidden) .unitfr-avatar') || document.querySelector('.rb .ribbon-account, .rb .account-card'))?.click())
        await win.waitForSelector(`${UNITS} [data-unit-shared]`, { timeout: 10_000 }).catch(() => {})
        await sleep(600)
      }
      const closePanel = async () => { await win.keyboard.press('Escape'); await sleep(400) }
      const readShared = () => win.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .ap-sec, ${sel} [data-unit-shared]`)).map((n) => ({
        sec: n.classList.contains('ap-sec') ? n.textContent.trim() : null, group: n.getAttribute('data-shared-group'),
        id: n.getAttribute('data-unit-id'), tag: n.tagName, name: n.querySelector('.ap-unit-name')?.textContent.trim() ?? null,
        state: n.querySelector('.ap-unit-state')?.textContent.trim() ?? null, current: n.getAttribute('aria-current') === 'true', check: !!n.querySelector('.ap-unit-check'),
      })), UNITS)
      const remote = () => win.evaluate(() => ({
        active: !!document.querySelector('.unitrs--whole:not(.unitrs-hidden)'), web: document.querySelector('.unitrs-web')?.getAttribute('src') ?? null,
        pill: document.querySelector('.unitfr-pill')?.textContent ?? '', fail: document.querySelector('.unitfr-fail')?.getAttribute('data-unitfr-state') ?? null,
        failText: document.querySelector('.unitfr-fail')?.textContent ?? '', retry: !!Array.from(document.querySelectorAll('.unitfr-fail .btn')).find((b) => /重试/.test(b.textContent)),
      }))
      const guest = (fn, arg) => app.evaluate(async ({ webContents, BrowserWindow }, { origin, fn, arg }) => {
        const main = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
        const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === main.webContents && w.getURL().startsWith(origin)).pop()
        if (!wc) return 'no-webview'
        return wc.executeJavaScript(`(${fn})(${JSON.stringify(arg)})`, true)
      }, { origin: SUB, fn: fn.toString(), arg })
      const shot = async (name) => { await captureById(app, mainId, shotFile(name)); shots.push(shotFile(name)) }
      const shotFile = (name) => path.join(SHOTS, `unit-shared-${name}.png`)
      const clickShared = async (id) => { await openPanel(); await win.click(`${UNITS} [data-unit-shared][data-unit-id="${id}"]`) }
      const toLocalTunnel = () => app.evaluate(({ BrowserWindow }, p) => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
        w.webContents.send('window:mainAction', 'unit-route', p)
      }, JSON.stringify({ kind: 'unit', id: UID_ON, name: '书桌 mini', via: 'tunnel' }))
      const pageLoaded = () => until(() => guest(() => ({ ok: !document.body.innerText.includes('unauthorized') && !document.body.innerText.includes('UNIT_') && document.querySelectorAll('script').length > 0 })).then((r) => (r && r.ok ? r : undefined)), 20000)

      // SH1 面板
      await openPanel()
      const rows = await readShared()
      const secs = rows.filter((r) => r.sec).map((r) => r.sec)
      const sh = rows.filter((r) => r.id)
      const byId = (id) => sh.find((r) => r.id === id)
      R.check('SH0 名册带 ?shared=1 去要(新版 Extend 透传参数)', cloud.state.rosterQueries.some((q) => q.includes('shared=1')), cloud.state.rosterQueries)
      R.check('SH1 「我的设备」之后有一组「星河工作室」,三行都在组里', secs.indexOf('我的设备') >= 0 && secs.indexOf('星河工作室') > secs.indexOf('我的设备') && sh.length === 3, rows)
      R.check('SH1 行尾灰字 = 管理员;睡着的那台带「休眠中」', byId(UID_SH)?.state === '管理员 · 休眠中' && byId(UID_SH_NONE)?.state === '管理员' && byId(UID_SH_INERT)?.state === '管理员', sh)
      R.check('SH1 能进 / 能开 Space 的是按钮,插件没装的那行不是按钮(点不动)', byId(UID_SH)?.tag === 'BUTTON' && byId(UID_SH_NONE)?.tag === 'BUTTON' && byId(UID_SH_INERT)?.tag === 'DIV', sh)
      await shot('panel-light')
      // 右键:能进的只有「切换到这台」;开 Space 的、点不动的都没有菜单
      await win.click(`${UNITS} [data-unit-shared][data-unit-id="${UID_SH}"]`, { button: 'right' })
      await sleep(400)
      const ctxItems = await win.evaluate(() => Array.from(document.querySelectorAll('.ap-unit-ctx [role="menuitem"]')).map((b) => b.textContent.trim()))
      await win.keyboard.press('Escape'); await sleep(300)
      await win.click(`${UNITS} [data-unit-shared][data-unit-id="${UID_SH_NONE}"]`, { button: 'right' })
      await sleep(400)
      const ctxNone = await win.locator('.ap-unit-ctx').count()
      await win.click(`${UNITS} [data-unit-shared][data-unit-id="${UID_SH_INERT}"]`, { button: 'right' })
      await sleep(400)
      const ctxInert = await win.locator('.ap-unit-ctx').count()
      R.check('SH1 右键能进的行:只有「切换到这台」(没有新窗口 / 桌面 / 改名 / 改图标)', JSON.stringify(ctxItems) === JSON.stringify(['切换到这台']), ctxItems)
      R.check('SH1 右键开 Space 的行 / 点不动的行:没有菜单', ctxNone === 0 && ctxInert === 0, { ctxNone, ctxInert })
      // 悬停不冒「在新窗口打开」
      await win.hover(`${UNITS} [data-unit-shared][data-unit-id="${UID_SH}"]`)
      R.check('SH1 共享行没有悬停的「在新窗口打开」', (await win.locator(`${UNITS} .ap-unit-wrap [data-unit-shared]`).count()) === 0 && (await win.locator(`${UNITS} [data-unit-shared] ~ .ap-unit-newwin`).count()) === 0)
      // SH8b 点不动的行:点了什么都不发生
      await win.click(`${UNITS} [data-unit-shared][data-unit-id="${UID_SH_INERT}"]`)
      await sleep(500)
      const inertAfter = { panel: await win.locator('.account-pop').count(), remote: await remote() }
      R.check('SH8 点不动的行:点了面板还开着、没切到哪', inertAfter.panel === 1 && !inertAfter.remote.active, inertAfter)

      // SH2 点能进的行 → 整窗切过去
      const subMark = sub.state.reqs.length
      await win.click(`${UNITS} [data-unit-shared][data-unit-id="${UID_SH}"]`)
      await until(async () => { const r = await remote(); return r.active && (r.web || '').startsWith(SUB) ? r : undefined }, 15000)
      const loaded = await pageLoaded()
      const r2 = await remote()
      R.check('SH2 点能进的行 → 整窗切过去,页面地址是名册给的子域 webUrl(主进程给的)', r2.active && r2.web === WEB && !!loaded, { r2, loaded })
      R.check('SH2 胶囊 = 名字 · 组标题(没有「我的设备」)', r2.pill.startsWith('工作室 Unit星河工作室') && !r2.pill.includes('我的设备'), r2.pill)
      const docReqs = sub.state.reqs.slice(subMark).filter((r) => r.host === UID_SH && r.path.startsWith(`/api/units/${UID_SH}/proxy/`))
      R.check('SH3 子域上这台路径下的请求都带登录头(只有一份)', docReqs.length > 0 && docReqs.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}` && r.n === 1), { n: docReqs.length, bad: docReqs.filter((r) => r.auth !== `Bearer ${FIXTURE_TOKEN}` || r.n !== 1).slice(0, 5) })
      await openPanel()
      const cur = await readShared()
      R.check('SH2 面板里那一行选中(打勾),「这台电脑」不勾', cur.find((r) => r.id === UID_SH)?.current === true && cur.find((r) => r.id === UID_SH)?.check === true && !(await win.evaluate(() => document.querySelector('[data-unit-local]')?.getAttribute('aria-current') === 'true')), cur)
      await closePanel()
      await shot('frame')

      // SH3 页面自己带的占位 Authorization(小写)被换掉;发去云端名册 / 云端中转 / 别台子域的不带
      const probes = [
        [`/api/units/${UID_SH}/proxy/probe`, 'own-placeholder', { authorization: 'Bearer tunnel' }],
        [`${cloud.url}/api/units`, 'cloud-roster', {}],
        [`${cloud.url}/api/units/${UID_SH}/proxy/`, 'cloud-proxy', {}],
      ]
      const fired = await guest((ps) => Promise.all(ps.map(([u, tag, h]) => fetch(u + '?probe=sh-' + tag, { headers: h, mode: u.startsWith('/') ? 'same-origin' : 'no-cors' }).then((r) => r.status, (e) => String(e)))), probes)
      await sleep(600)
      const seen = (tag) => [...cloud.state.reqs, ...sub.state.reqs].filter((r) => r.probe === `sh-${tag}`)
      const own = seen('own-placeholder')
      R.check('SH3 页面自带 `authorization: Bearer tunnel` 打自己的子域 → 收到的是登录头、只有一份', own.length > 0 && own.every((r) => r.auth === `Bearer ${FIXTURE_TOKEN}` && r.n === 1), { fired, own })
      // 别台子域:从这台子域上的素页发(真 Unit 页面的 CSP 不放行 http 的别台子域)
      const loadInGuest = (url) => app.evaluate(async ({ webContents, BrowserWindow }, { origin, url }) => {
        const main = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
        const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === main.webContents && w.getURL().startsWith(origin)).pop()
        if (!wc) return 'no-webview'
        try { await wc.loadURL(url) } catch (e) { return String(e) }
        return 'ok'
      }, { origin: SUB, url })
      const pp = await loadInGuest(`${SUB}/api/units/${UID_SH}/proxy/probe-page`)
      const firedOther = await guest((u) => fetch(u, { mode: 'no-cors' }).then((r) => r.status, (e) => String(e)), `http://${UID_SH_NONE}.localhost:${sub.port}/api/units/${UID_SH_NONE}/proxy/web/?probe=sh-other-sub`)
      await sleep(400)
      for (const tag of ['cloud-roster', 'cloud-proxy', 'other-sub']) {
        const got = seen(tag)
        R.check(`SH3 页面脚本打 ${tag} → 收到了、不带登录头`, got.length > 0 && got.every((r) => !r.auth), { fired, pp, firedOther, got })
      }
      // SH4b 宿主把它导航到别台的子域(主框架)→ 不带
      const navOther = await loadInGuest(`http://${UID_SH_NONE}.localhost:${sub.port}/api/units/${UID_SH_NONE}/proxy/web/?probe=sh-nav-other`)
      await sleep(400)
      const navOtherReqs = seen('nav-other')
      R.check('SH4 已绑定的共享页被导航到别台的子域(主框架)→ 不带登录头', navOther === 'ok' && navOtherReqs.length > 0 && navOtherReqs.every((r) => !r.auth), { navOther, navOtherReqs })
      await app.evaluate(async ({ webContents, BrowserWindow }, { origin, url }) => {
        const main = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
        const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === main.webContents && w.getURL().startsWith(origin)).pop()
        if (wc) await wc.loadURL(url).catch(() => {})
      }, { origin: `http://${UID_SH_NONE}.localhost`, url: WEB })
      await pageLoaded()
      // SH4 宿主直接把这张已绑定的 webview 导航到云端中转(主框架、Sec-Fetch-Site: none)→ 不带;再导航回来
      const nav = await app.evaluate(async ({ webContents, BrowserWindow }, { origin, url }) => {
        const main = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
        const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === main.webContents && w.getURL().startsWith(origin)).pop()
        if (!wc) return 'no-webview'
        try { await wc.loadURL(url) } catch (e) { return String(e) }
        return 'ok'
      }, { origin: SUB, url: `${cloud.url}/api/units/${UID_SH}/proxy/?probe=sh-nav-cloud` })
      await sleep(500)
      const navReqs = seen('nav-cloud')
      R.check('SH4 已绑定的共享页被导航到云端中转(主框架)→ 不带登录头(共享绑定没有云端中转前缀)', nav === 'ok' && navReqs.length > 0 && navReqs.every((r) => !r.auth), { nav, navReqs })
      await app.evaluate(async ({ webContents, BrowserWindow }, { origin, url }) => {
        const main = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
        const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === main.webContents && w.getURL().startsWith(origin)).pop()
        if (wc) await wc.loadURL(url).catch(() => {})
      }, { origin: cloud.url, url: WEB })

      // SH5 enter = none 的行绑不上;共享行开不了窗、加不了桌面
      const bindNone = await win.evaluate(async (id) => {
        const el = document.querySelector('.unitrs-web')
        return window.tangu.unitsBindFrame({ webContentsId: el.getWebContentsId(), unitId: id })
      }, UID_SH_NONE)
      R.check('SH5 enter = none 的行(名册给了合格地址也一样)→ 绑不上(not_enterable)', bindNone?.ok === false && bindNone?.code === 'not_enterable', bindNone)
      const deskSh = await win.evaluate((id) => window.tangu.unitsAddToDesktop({ id }), UID_SH)
      R.check('SH5 units:addToDesktop 对共享行 → not_found(只按自己名下的名册核)', deskSh?.ok === false && deskSh?.code === 'not_found', deskSh)
      // SH5b 共享页自己 window.open:自己子域下的地址 → 新开的内置浏览器标签带头;云端源 / 别台子域 → 不带
      const pops = [
        [`${SUB}/api/units/${UID_SH}/proxy/probe?probe=sh-pop-own`, 'pop-own', true],
        [`${cloud.url}/api/units/${UID_SH}/proxy/?probe=sh-pop-cloud`, 'pop-cloud', false],
        [`http://${UID_SH_NONE}.localhost:${sub.port}/api/units/${UID_SH_NONE}/proxy/web/?probe=sh-pop-other`, 'pop-other', false],
      ]
      for (const [url, tag, expectAuth] of pops) {
        const opened = await guest((u) => { window.open(u, '_blank'); return 'ok' }, url)
        const got = await until(async () => { const g = seen(tag); return g.length ? g : undefined }, 10000)
        R.check(`SH5 共享页 window.open ${tag} → 新页${expectAuth ? '带登录头(一枚)' : '不带登录头'}`,
          opened === 'ok' && !!got && got.every((r) => (expectAuth ? r.auth === `Bearer ${FIXTURE_TOKEN}` && r.n === 1 : !r.auth)), { opened, got })
      }
      // 弹出来的几张内置浏览器页换成空白页,免得后面按子域挑 webview 挑中它们
      await app.evaluate(async ({ webContents }) => {
        for (const w of webContents.getAllWebContents()) if (!w.isDestroyed() && w.getType() === 'webview' && /[?&]probe=sh-pop-/.test(w.getURL())) await w.loadURL('about:blank').catch(() => {})
      })
      await win.evaluate(() => document.querySelector('.unitfr-back')?.click()) // 内置浏览器标签开在本机,回到共享页再往下
      await sleep(300)
      await clickShared(UID_SH)
      await pageLoaded()

      // SH6 唤醒中:先去别的设备再回来(新一张 webview、新一次加载),前两次 503 UNIT_WAKING
      const reenter = async () => {
        await toLocalTunnel()
        await until(async () => ((await remote()).web || '').startsWith(cloud.url) || undefined, 10000)
        await sleep(800)
        await clickShared(UID_SH)
      }
      sub.state.wakeLeft = 2
      const wakeMark = sub.state.reqs.length
      await reenter()
      const waking = await until(async () => { const r = await remote(); return r.fail === 'waking' ? r : undefined }, 15000)
      R.check('SH6 503 UNIT_WAKING →「正在唤醒…」(盖着,服务端那段 JSON 不露),没有重试按钮', !!waking && /正在唤醒/.test(waking.failText) && !waking.failText.includes('UNIT_WAKING') && !waking.retry, waking)
      await shot('waking')
      // 唤醒中先回到这台电脑、再点同一行回来(同一张 webview、不重新导航):自动重试不能就此停掉
      await win.evaluate(() => document.querySelector('.unitfr-back')?.click())
      await sleep(400)
      const leftWhileWaking = !(await remote()).active
      await clickShared(UID_SH)
      await sleep(300)
      const woke = await until(async () => { const r = await remote(); return !r.fail && r.active ? r : undefined }, 25000)
      const wakeDocs = sub.state.reqs.slice(wakeMark).filter((r) => r.host === UID_SH && r.path === `/api/units/${UID_SH}/proxy/web/`)
      R.check('SH6 按间隔自动重试到成功(3 次文档请求:503、503、200),页面露出;中途回本机再点回来也不停', leftWhileWaking && !!woke && wakeDocs.length === 3 && !!(await pageLoaded()), { leftWhileWaking, woke, docs: wakeDocs.length })
      // SH6b 一直唤醒不过来:台架把间隔 / 封顶调短(产品里是常量),到点 →「没能唤醒」+ 重试 + 回到这台电脑
      await win.evaluate(() => { window.__forsionUnitWakeTiming = { retryMs: 300, deadlineMs: 1500 } })
      sub.state.wakeLeft = 1000
      await reenter()
      const gaveUp = await until(async () => { const r = await remote(); return r.fail === 'wakeFailed' ? r : undefined }, 15000)
      const gaveUpBtns = await win.evaluate(() => Array.from(document.querySelectorAll('.unitfr-fail .btn')).map((b) => b.textContent.trim()))
      R.check('SH6 一直 503 → 到点变「没能唤醒这台 Unit」,两个按钮:重试 / 回到这台电脑', !!gaveUp && /没能唤醒这台 Unit/.test(gaveUp.failText) && JSON.stringify(gaveUpBtns) === JSON.stringify(['重试', '回到这台电脑']), { gaveUp, gaveUpBtns })
      await shot('wake-failed')
      sub.state.wakeLeft = 0
      await win.evaluate(() => { delete window.__forsionUnitWakeTiming })
      // 403
      sub.state.mode = 'forbidden'
      await reenter()
      const forb = await until(async () => { const r = await remote(); return r.fail === 'forbidden' ? r : undefined }, 15000)
      R.check('SH6 403 →「你现在不能进入这台 Unit」+「回到这台电脑」,没有重试', !!forb && /你现在不能进入这台 Unit/.test(forb.failText) && /回到这台电脑/.test(forb.failText) && !forb.retry && !forb.failText.includes('UNIT_PATH'), forb)
      await shot('forbidden')
      sub.state.mode = 'ok'

      // SH7 人在里面时被撤:名册里这一行改成 enter = none,窗口重新拿到焦点 → 退回并说一句
      await reenter()
      await pageLoaded()
      const inBefore = await remote()
      shRows.frameEnter = 'none'
      const rq = cloud.state.rosterQueries.length
      // 先只走主进程那条(browser-window-focus → window:focused);等不来再补一次宿主页自己的 focus 事件,并如实记下是哪条起的作用
      // 另开一扇窗拿走焦点,再切回主窗(主进程的 browser-window-focus)
      await app.evaluate(async ({ BrowserWindow }) => {
        const other = new BrowserWindow({ width: 200, height: 120, show: true })
        await other.loadURL('data:text/html,<title>focus-thief</title>')
        other.focus()
        await new Promise((r) => setTimeout(r, 600))
        globalThis.__focusThief = other.id
      })
      await app.evaluate(({ BrowserWindow }, id) => { const w = BrowserWindow.fromId(id); w.show(); w.focus() }, mainId)
      let via = 'main'
      let out = await until(async () => { const r = await remote(); return !r.active ? r : undefined }, 5000)
      if (!out) {
        via = 'dom-focus'
        await win.evaluate(() => window.dispatchEvent(new Event('focus')))
        out = await until(async () => { const r = await remote(); return !r.active ? r : undefined }, 8000)
      }
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.fromId(globalThis.__focusThief); if (w && !w.isDestroyed()) w.destroy() })
      R.note(`SH7 起作用的复核时机:${via === 'main' ? '主进程转告的窗口重新拿到焦点' : '宿主页自己的 focus 事件(主进程那条在台架里没触发)'}`)
      const toast = await until(() => win.evaluate(() => document.body.innerText.includes('你已不能进入「工作室 Unit」') || undefined), 5000)
      R.check('SH7 名册里那台变成不能进 → 退回这台电脑、页面卸掉、说一句', inBefore.active && !!out && out.web === null && !!toast, { via, inBefore: inBefore.active, out, toast: !!toast, rosterReads: cloud.state.rosterQueries.length - rq })
      shRows.frameEnter = 'frame'

      // SH8 enter = none 的行 → 切到假插件的 Space(商店身份 market-<UUID>,按 manifest id 对上)
      await clickShared(UID_SH_NONE)
      const space = await until(() => win.evaluate(() => { const el = document.querySelector('.shared-probe-full'); return el && el.getBoundingClientRect().width > 0 ? el.textContent : undefined }), 10000)
      R.check('SH8 enter = none 的行 → 打开假插件的主 Space、面板收起', space === 'Shared probe space' && (await win.locator('.account-pop').count()) === 0, { space })

      // SH9 拿共享行的 id 开 Unit 窗:IPC 一次、forsion://unit/<id>?window=standalone 链接一次 → 不在当前账号名下、没有 webview、不发带头的请求
      const sh9Mark = { cloud: cloud.state.reqs.length, sub: sub.state.reqs.length }
      const authed = () => [...cloud.state.reqs.slice(sh9Mark.cloud), ...sub.state.reqs.slice(sh9Mark.sub)].filter((r) => r.auth && (r.path || '').includes(UID_SH))
      const unitWinState = async () => {
        const p = await unitPage(app, UID_SH)
        if (!p) return null
        await p.waitForSelector('[data-unit-window-state]', { timeout: 15_000 }).catch(() => {})
        await sleep(800)
        return p.evaluate(() => ({ state: document.querySelector('[data-unit-window-state]')?.getAttribute('data-unit-window-state') ?? null, text: document.querySelector('.unitfr-fail-title')?.textContent ?? null, web: document.querySelectorAll('.unitrs-web, webview').length }))
      }
      const viaIpc = await win.evaluate((id) => window.tangu.unitsOpenWindow(id), UID_SH)
      const s9a = await unitWinState()
      R.check('SH9 IPC 拿共享行的 id 开 Unit 窗 →「这台设备不在当前账号名下」、没有 webview、没有带头的请求',
        viaIpc?.ok === true && s9a?.state === 'missing' && s9a.text === '这台设备不在当前账号名下' && s9a.web === 0 && authed().length === 0, { viaIpc, s9a, authed: authed() })
      await closeUnitWindows(app)
      await until(async () => (await unitWins(app, UID_SH)).length === 0 || undefined, 10000)
      const second = await secondInstance(L, LINK(UID_SH))
      const s9b = await unitWinState()
      R.check('SH9 forsion://unit/<共享 id>?window=standalone →「这台设备不在当前账号名下」、没有 webview、没有带头的请求',
        second.code === 0 && s9b?.state === 'missing' && s9b.web === 0 && authed().length === 0, { second, s9b, authed: authed() })
      await closeUnitWindows(app)
      await sleep(800)

      // 截图:暗色面板(带休眠行、点不动的行)
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark') })
      await win.reload({ waitUntil: 'domcontentloaded' })
      await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
      await sleep(2500)
      await openPanel()
      await shot('panel-dark')
      await closePanel()
    } finally {
      sub.close()
    }
  }
}

/** 共享过来的那台「自己的子域」:http://<id>.localhost:<端口>(Chromium 把 *.localhost 解析到回环)。
 *  只认夹具账号的登录头(没带 / 带错 = 401);`/api/units/<id>/proxy/<rest>` 转给同一台真 Unit 的 `/<rest>`(webUrl 带 /web/),
 *  其余路径(页面的绝对路径资源)原样转;别台的子域只记账回 200。mode:ok / forbidden;wakeLeft = 还要回几次 503 UNIT_WAKING。
 *  reqs 如实记下收到的 Authorization(多值时原样记成数组),补头范围的断言看它。 */
function startSubdomain(unit) {
  const state = { mode: 'ok', wakeLeft: 0, reqs: [] }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    const host = String(req.headers.host || '')
    const auths = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'authorization') auths.push(req.rawHeaders[i + 1])
    state.reqs.push({ host: host.split('.')[0], method: req.method, path: p, probe: u.searchParams.get('probe'), auth: auths.length ? auths.join(' | ') : null, n: auths.length })
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (!host.startsWith(`${UID_SH}.localhost`)) return send(200, { other: true })
    const prefix = `/api/units/${UID_SH}/proxy/`
    const fwd = (to) => {
      const up = http.request({ host: '127.0.0.1', port: unit.port, method: req.method, path: to, headers: { ...req.headers, host: `127.0.0.1:${unit.port}`, authorization: `Bearer ${unit.token}` } }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res) })
      up.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(up)
    }
    if (p.startsWith(prefix)) {
      if (req.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) return send(401, { detail: 'unauthorized' })
      if (state.mode === 'forbidden') return send(403, { code: 'UNIT_PATH_FORBIDDEN', detail: 'forbidden' })
      if (state.wakeLeft > 0 && p === `${prefix}web/`) { state.wakeLeft--; return send(503, { code: 'UNIT_WAKING', detail: 'waking up' }) }
      // 不带 CSP 的素页(真 Unit 页面的 CSP 只放行 https: 与回环 IP,挡掉了台架里 http 的别台子域,与补头无关)
      if (p.startsWith(`${prefix}probe-page`)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>probe</title><p>probe</p>') }
      if (p.startsWith(`${prefix}probe`)) return send(200, { ok: true })
      return fwd(`/${p.slice(prefix.length)}${u.search}`)
    }
    return fwd(`${p}${u.search}`)
  })
  // 不写 host:双栈监听(*.localhost 可能先解析到 ::1)
  return new Promise((r) => srv.listen(0, () => r({ port: srv.address().port, state, close: () => srv.close() })))
}

/** 隔离实例里装一份带共享名册透传的 Extend(版本抬高,免得被随包那份覆盖;签名用本机的 Extend 签名钥)。只动临时 home。 */
async function installSharedExtend(home) {
  const { createPrivateKey } = require('crypto')
  const { pathToFileURL } = require('url')
  const dir = path.join(home, 'plugins/forsion-extend')
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  const files = ['package.json', 'manifest.json', 'dist/main.js', 'dist/desktop.mjs']
  for (const f of files) fs.copyFileSync(path.join(EXTEND_SHARED, f), path.join(dir, f))
  for (const f of ['package.json', 'manifest.json']) { const p = path.join(dir, f), data = JSON.parse(fs.readFileSync(p)); data.version = '99.0.0-e2e'; fs.writeFileSync(p, JSON.stringify(data)) }
  const key = process.env.EXTEND_SIGNING_KEY || fs.readFileSync(path.join(os.homedir(), '.forsion-dev/secrets/forsion-extend-signing/key.pem'), 'utf8')
  const { signFiles } = await import(pathToFileURL(path.join(EXTEND_SHARED, 'scripts/signature.mjs')).href)
  fs.writeFileSync(path.join(dir, 'SIGNATURE'), JSON.stringify(await signFiles(dir, files, createPrivateKey(key))))
}

/** 假插件:商店身份目录(market-<UUID>),manifest id = shared-probe,带一个 Space(主区一个视图)。 */
function installSharedPlugin(home) {
  const dir = path.join(home, 'plugins', SHARED_PLUGIN_DIR)
  fs.mkdirSync(path.join(dir, 'spaces', 'shared-probe'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'shared-probe', name: 'Shared probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(dir, 'main.js'), `ctx.registerView({ id: 'full', title: 'Shared probe', mount(el) { const d = document.createElement('div'); d.className = 'shared-probe-full'; d.textContent = 'Shared probe space'; el.append(d); return () => d.remove() } })`)
  fs.writeFileSync(path.join(dir, 'spaces', 'shared-probe', 'space.json'), JSON.stringify({ id: 'shared-probe', name: { zh: '共享探针', en: 'Shared probe' }, layout: { main: [{ type: 'plugin:shared-probe:full' }] } }))
}

main().catch((e) => { console.error(e); process.exit(1) })
