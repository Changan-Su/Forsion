/**
 * 设备页的框(UnitSwitcher 整窗形态,UNIT_SURFACE_WHOLE)真 Electron 实机断言 + 截图。
 * 本机 = 隔离实例(桩引擎 + 本机假云端,夹具登录,不碰真账号);远端 = 真 Unit 网页
 * (UNIT_DIST,缺省 <仓根>/.worktrees/biz-unit-host/unit/dist,local 模式;找不到就明确跳过)。
 * 远端裸 Unit 没装账号提供方就不画账号卡 → 对客页 webContents 用 debugger 注入 tangu.account 夹具(只为画出账号卡)。
 *
 * 判据:
 *   1 整窗后窗口里只有一条 Ribbon(远端的):本机 Ribbon 被盖住(命中测试落在远程面里),远端 Ribbon 在窗口左缘
 *   2 远端账号卡不可见(insertCSS);宿主头像与本机折叠态账号槽、与远端账号卡的位置差 ≤ 1px(缩放 1 / 1.1)
 *   3 标题条是拖窗区,胶囊 / 「回到这台电脑」是 no-drag;mac 上远端 Ribbon 顶上的按钮不在红绿灯那一条里
 *   4 打开账号面板 → 真鼠标点 webview → 面板关闭(宿主只收到 window blur)
 *   5 指到连不上的地址 → 失败态出现,真鼠标点「回到这台电脑」→ 回本机
 * 截图(SHOT_DIR,缺省系统临时目录):浅色 / 深色 / 青绿 / 英文 / 缩放 110% / 远端 Ribbon 展开。
 *
 * 跑:node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run e2e:unitframe(量的是 out/,先 npm run build)
 */
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net'), os = require('os')
const { spawn, execFileSync } = require('child_process')
const { launch, boot, sleep, captureWindow, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const DESK = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DESK, '../../..') // .worktrees/<名>/desktop → 仓根;主检出时是 Forsion-Genesis/desktop → 仓根
const UNIT_DIST = process.env.UNIT_DIST || [path.join(REPO_ROOT, '.worktrees/biz-unit-host/unit/dist'), path.join(path.resolve(DESK, '../..'), '.worktrees/biz-unit-host/unit/dist')].find((p) => fs.existsSync(path.join(p, 'main.mjs')))
const SHOTS = shotDir('unitframe')
const R = makeReporter()
const log = (...a) => console.log('[unitframe]', ...a)

function startCloud() {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (p === '/api/brain/users/me') return send(200, { username: 'linyi', nickname: '林一', membershipTier: 'plus' })
    if (p === '/api/units') return send(200, { units: [] })
    if (p === '/api/token-quota/my') return send(200, { dailyLimit: 100, dailyUsed: 28, dailyRemaining: 72, dailyPercent: 28, weeklyLimit: 500, weeklyUsed: 140, weeklyRemaining: 360, weeklyPercent: 28, weeklyResetAt: '2026-11-16', resetCards: 1 })
    send(404, { detail: 'not in fixture' })
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })))
}
const portFree = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))) })
async function freePort(from) { let p = from; while (!(await portFree(p))) p++; return p }
async function startUnit() {
  const port = await freePort(Number(process.env.UNIT_PORT || 3260))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unitframe-unit-'))
  const dir = path.join(work, 'unit')
  execFileSync(process.execPath, [`${UNIT_DIST}/main.mjs`, 'init', dir, '--mode', 'local', '--port', String(port), '--base', '/web/'], { stdio: 'ignore' })
  const child = spawn(process.execPath, [`${UNIT_DIST}/main.mjs`, 'run', `${dir}/unit.json`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const web = `http://127.0.0.1:${port}/web/`
  for (let i = 0; i < 150; i++) { try { if ((await fetch(web)).status < 500 && fs.existsSync(path.join(dir, 'data/owner-token'))) break } catch { /* 未起 */ } await sleep(200) }
  const token = fs.readFileSync(path.join(dir, 'data/owner-token'), 'utf8').trim()
  log('unit up', web, 'pid', child.pid)
  // 只按自己起的 PID 收
  return { web, port, token, close: () => { try { child.kill() } catch { /* */ } try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* */ } } }
}

// 客页夹具:tangu.account(只为让 Unit 网页画出账号卡)+ 明暗 / 语言跟宿主这一轮的设置走(global.__ufGuest 由下面 setGuest 改)
const SHIM = (guest) => `(() => { let v; try { localStorage.setItem('forsion_theme_pref', ${JSON.stringify(guest.mode)}); localStorage.setItem('tangu_locale', ${JSON.stringify(guest.locale)}) } catch {}
  Object.defineProperty(window, 'tangu', { configurable: true, get() { return v }, set(x) {
    if (x && !x.account) x.account = { status: async () => ({ loggedIn: true, userId: 'linyi', username: 'linyi', nickname: '林一', cloudUrl: location.origin + '/api' }), login: async () => {}, logout: async () => {}, request: (p, init) => fetch('/api' + p, init), subscribe: () => () => {} }
    v = x } }) })()`

async function main() {
  if (!UNIT_DIST) {
    console.log('SKIP  找不到真的 Unit 网页(.worktrees/biz-unit-host/unit/dist/main.mjs);设 UNIT_DIST 指过去再跑。本次未做实机断言。')
    process.exit(0)
  }
  const cloud = await startCloud()
  const unit = await startUnit()
  let L = null
  const shots = []
  try {
    L = await launch({ tag: 'unitframe', fixtures: { agents: [{ slug: 'xyra', name: 'Xyra', description: '', createdBy: 'user' }], sessions: [] },
      beforeLaunch: ({ home }) => { fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud.url, token: 'unitframe-fixture-token' }), { mode: 0o600 }) } })
    const { app, win } = L
    await boot(app, win, { space: null, width: 1280, height: 820 })
    await sleep(2000)
    const origin = `http://127.0.0.1:${unit.port}`
    const guest = (fn, arg) => app.evaluate(async ({ webContents }, { src, arg, origin }) => {
      const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(origin)).pop()
      if (!wc) return { __err: 'no-webview' }
      try { return await wc.executeJavaScript(`(${src})(${JSON.stringify(arg)})`, true) } catch (e) { return { __err: String(e) } }
    }, { src: fn.toString(), arg: arg ?? null, origin })
    const guestReload = () => app.evaluate(({ webContents }, origin) => { const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(origin)).pop(); wc?.reload() }, origin)
    const route = (payload) => app.evaluate(({ BrowserWindow }, p) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !/[?&]window=/.test(x.webContents.getURL()))
      w.webContents.send('window:mainAction', 'unit-route', p)
    }, JSON.stringify(payload))
    await app.evaluate(({ app }, src) => {
      global.__ufShim = src
      app.on('web-contents-created', (_e, wc) => {
        if (wc.getType() !== 'webview') return
        try { wc.debugger.attach('1.3'); void wc.debugger.sendCommand('Page.enable').then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: global.__ufShim })) } catch { /* */ }
      })
    }, SHIM({ mode: 'light', locale: 'zh' }))
    const setGuest = (g) => app.evaluate((_e, src) => { global.__ufShim = src }, SHIM(g))
    const reloadHost = async ({ zoom = 1, mode = 'light', skin = null, locale = 'zh' } = {}) => {
      await win.evaluate(({ zoom, mode, skin, locale }) => {
        localStorage.setItem('forsion_ui_zoom', String(zoom))
        localStorage.setItem('forsion_tangu_ribbon_expanded', '0')
        localStorage.setItem('forsion_theme_pref', mode)
        localStorage.setItem('tangu_locale', locale)
        if (skin) { localStorage.setItem('forsion_theme_skin', skin); localStorage.setItem('forsion_theme_bg', skin) } else { localStorage.removeItem('forsion_theme_skin'); localStorage.removeItem('forsion_theme_bg') }
      }, { zoom, mode, skin, locale })
      await setGuest({ mode, locale })
      await win.reload({ waitUntil: 'domcontentloaded' })
      await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
      await sleep(3000)
    }
    const waitGuestShell = async (ms = 25_000) => { const end = Date.now() + ms; while (Date.now() < end) { const g = await guest(() => !!document.querySelector('.rb .ribbon-account, .rb .account-card')); if (g === true) return true; await sleep(400) } return false }
    const connect = async () => {
      await route({ kind: 'addr', url: `${unit.web}#unit-owner=${unit.token}` })
      await win.waitForSelector('.unitrs:not(.unitrs-hidden)', { timeout: 10_000 })
      const ok = await waitGuestShell()
      await sleep(2500)
      return ok
    }
    const back = async () => { await win.evaluate(() => document.querySelector('.unitfr-back')?.click()); await sleep(500) }
    const shot = async (name) => { const f = path.join(SHOTS, `unit-frame-${name}.png`); await captureWindow(app, f); shots.push(f); return f }
    /** 几何(窗口 px):宿主头像、本机账号槽(盖在底下)、远端账号卡(客页坐标 × 宿主缩放 + webview 偏移)、标题条、命中测试。 */
    const geo = async () => {
      const h = await win.evaluate(() => {
        const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
        const rb = r('.shell .rb')
        const hit = rb ? document.elementFromPoint(rb.x + rb.w / 2, rb.y + rb.h / 2) : null
        const bar = document.querySelector('.unitfr-bar'), pill = document.querySelector('.unitfr-pill'), backBtn = document.querySelector('.unitfr-back')
        const region = (e) => e ? (getComputedStyle(e).getPropertyValue('-webkit-app-region') || getComputedStyle(e).webkitAppRegion) : null
        return { zoom: document.body.currentCSSZoom || 1, avatar: r('.unitfr-avatar'), localAcct: r('.shell .rb .ribbon-account'), web: r('.unitrs-web'), bar: r('.unitfr-bar'), rbCovered: !!hit?.closest('.unitrs'), regions: { bar: region(bar), pill: region(pill), back: region(backBtn) }, platform: document.documentElement.dataset.platform }
      })
      const g = await guest(() => {
        const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
        const acct = document.querySelector('.rb .ribbon-account, .rb .account-card')
        const btn = document.querySelector('.rb .rb-btn')
        return { rb: r('.rb'), acct: r('.rb .ribbon-account') || r('.rb .account-card'), acctVisibility: acct ? getComputedStyle(acct).visibility : null, topBtn: btn ? (() => { const b = btn.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })() : null }
      })
      const toWin = (a) => (a && h.web) ? { x: h.web.x + a.x * h.zoom, y: h.web.y + a.y * h.zoom, w: a.w * h.zoom, h: a.h * h.zoom } : null
      const lights = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !/[?&]window=/.test(x.webContents.getURL())); return w.getWindowButtonPosition?.() ?? null })
      return { h, g, remoteAcctWin: toWin(g.acct), remoteRbWin: toWin(g.rb), remoteTopBtnWin: toWin(g.topBtn), lights }
    }
    const near = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
    const fmt = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v))

    // ══ 浅色 · 缩放 1 · 本机折叠 ══
    await reloadHost({ zoom: 1 })
    const up = await connect()
    R.check('远端 Unit 网页起来了、整窗远程面出现', up)
    let G = await geo()
    R.check('1 整窗后只剩一条 Ribbon:本机 Ribbon 被远程面盖住,远端 Ribbon 在窗口左缘', G.h.rbCovered && !!G.remoteRbWin && G.remoteRbWin.x <= 0.5, fmt({ covered: G.h.rbCovered, remoteRb: G.remoteRbWin }))
    R.check('2 远端自己的账号卡不可见(insertCSS)', G.g.acctVisibility === 'hidden', String(G.g.acctVisibility))
    R.check('2 宿主头像 ≈ 本机折叠态账号槽(≤1px,缩放 1)', near(G.h.avatar, G.h.localAcct), fmt({ avatar: G.h.avatar, local: G.h.localAcct }))
    R.check('2 宿主头像 ≈ 远端账号卡的位置(≤1px,缩放 1)', near(G.h.avatar, G.remoteAcctWin), fmt({ avatar: G.h.avatar, remote: G.remoteAcctWin }))
    R.check('3 标题条是拖窗区,胶囊 / 「回到这台电脑」no-drag', G.h.regions.bar === 'drag' && G.h.regions.pill === 'no-drag' && G.h.regions.back === 'no-drag', fmt(G.h.regions))
    if (G.h.platform === 'mac') {
      const barBottom = G.h.bar ? G.h.bar.y + G.h.bar.h : 0
      R.check('3 mac:远端 Ribbon 顶上的按钮在标题条(红绿灯那一条)下面', !!G.remoteTopBtnWin && G.remoteTopBtnWin.y >= barBottom - 0.5 && (!G.lights || G.remoteTopBtnWin.y > G.lights.y + 12), fmt({ topBtn: G.remoteTopBtnWin, barBottom, lights: G.lights }))
    } else R.note('3 非 mac,红绿灯那条跳过', G.h.platform)
    const pillText = await win.evaluate(() => document.querySelector('.unitfr-pill')?.textContent ?? '')
    R.check('胶囊 = 主机地址 + 回到这台电脑,不带 #unit-owner 主人密钥', pillText === `127.0.0.1:${unit.port}/web回到这台电脑`, pillText)
    await sleep(2500) // 给本机上手提示一个出来的机会(它每秒判一次)
    const tips = { host: await win.evaluate(() => !!document.querySelector('.guide-spot-act')), guest: await guest(() => !!document.querySelector('.guide-spot-act')) }
    R.check('6 看着别的设备时本机的上手提示不浮在对面页面上(宿主 DOM 里没有提示卡)', tips.host === false, fmt(tips))
    await shot('light')
    // 4 面板开着点 webview
    const av = G.h.avatar
    if (!av) throw new Error('没有宿主头像(.unitfr-avatar):整窗的框没画出来')
    await win.mouse.click(av.x + av.w / 2, av.y + av.h / 2)
    await sleep(900)
    const opened = await win.evaluate(() => ({ pop: !!document.querySelector('.account-pop'), checked: Array.from(document.querySelectorAll('[data-testid="account-units"] [aria-current="true"] .ap-unit-name')).map((n) => n.textContent.trim()) }))
    R.check('4 点宿主头像 → 本机账号面板打开,打勾的是那台(不是「这台电脑」)', opened.pop && opened.checked.length === 1 && opened.checked[0] !== '这台电脑', fmt(opened))
    await shot('light-panel')
    await win.mouse.click(Math.round(G.h.web.x + G.h.web.w * 0.6), Math.round(G.h.web.y + G.h.web.h * 0.45))
    await sleep(1000)
    R.check('4 真鼠标点 webview → 面板关闭', !(await win.evaluate(() => !!document.querySelector('.account-pop'))))

    if (process.env.UF_QUICK) R.note('UF_QUICK:只跑浅色 · 缩放 1 那一段(负对照用)')
    else {
    // ══ 远端 Ribbon 展开 ══
    await guest(() => localStorage.setItem('forsion_tangu_ribbon_expanded', '1'))
    await guestReload(); await sleep(1500); await waitGuestShell(); await sleep(2500)
    G = await geo()
    R.check('2 远端 Ribbon 展开:远端账号卡照样藏着(每次 dom-ready 重新注入)', G.g.acctVisibility === 'hidden', String(G.g.acctVisibility))
    await shot('remote-expanded')
    await guest(() => localStorage.setItem('forsion_tangu_ribbon_expanded', '0'))
    await back()

    // ══ 缩放 110% ══
    await reloadHost({ zoom: 1.1 })
    await connect()
    G = await geo()
    R.check('2 宿主头像 ≈ 本机折叠态账号槽(≤1px,缩放 1.1)', near(G.h.avatar, G.h.localAcct), fmt({ avatar: G.h.avatar, local: G.h.localAcct, zoom: G.h.zoom }))
    R.check('2 宿主头像 ≈ 远端账号卡的位置(≤1px,缩放 1.1)', near(G.h.avatar, G.remoteAcctWin), fmt({ avatar: G.h.avatar, remote: G.remoteAcctWin }))
    await shot('zoom110')
    await back()

    // ══ 深色 / 青绿 / 英文 截图 ══
    for (const [name, o] of [['dark', { mode: 'dark' }], ['teal', { skin: 'teal' }], ['en', { locale: 'en' }]]) {
      await reloadHost({ zoom: 1, ...o })
      await connect()
      await guestReload(); await sleep(1500); await waitGuestShell(); await sleep(2000) // 远程面保活不重载:让对面也按这一轮的明暗 / 语言重画
      if (name === 'en') {
        const t = await win.evaluate(() => document.querySelector('.unitfr-pill')?.textContent ?? '')
        R.check('英文:胶囊写「Back to this computer」', t.includes('Back to this computer'), t)
      }
      await shot(name)
      await back()
    }

    // ══ 5 连不上的地址 ══
    await reloadHost({ zoom: 1 })
    const dead = await freePort(39000)
    await route({ kind: 'addr', url: `http://127.0.0.1:${dead}/` })
    await win.waitForSelector('.unitfr-fail', { timeout: 15_000 }).catch(() => {})
    const fail = await win.evaluate(() => ({ text: document.querySelector('.unitfr-fail-title')?.textContent ?? null, avatar: !!document.querySelector('.unitfr-avatar') }))
    R.check('5 连不上 → 宿主画的失败态', fail.text === '连不上这台设备', fmt(fail))
    await shot('fail')
    const b = await win.evaluate(() => { const e = document.querySelector('.unitfr-fail .btn:not(.primary)'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    if (b) await win.mouse.click(b.x, b.y)
    await sleep(600)
    R.check('5 失败态里真鼠标点「回到这台电脑」→ 回本机', !!b && (await win.evaluate(() => !!document.querySelector('.unitrs-hidden'))))
    }
  } finally {
    if (L) await L.close()
    unit.close(); cloud.close()
  }
  console.log('截图:\n' + shots.join('\n'))
  process.exit(R.summary() ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
