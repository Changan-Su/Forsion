/**
 * UnitsSheet「在哪运行」浏览器台架(P1-K8)—— 手机形态(375×812、触屏),web 路径(mobileShim 非原生分支)。
 *
 * 钉的东西:
 *  - 名册里的手机不出现、kind 缺席的老桌面照样出现(按电脑);每台电脑一行、状态文案按 deviceStatus 口径;
 *  - web 路径没有原生身份:弹层一开就挂「仅在 Forsion 安卓 App 中可用」横幅;点电脑也只得到这条,**一个 /proxy/ 请求都不发**;
 *  - 中继面上的请求在 web 路径同样失败关闭:页面里直接 fetch 远端引擎 → 503 CALLER_UNSUPPORTED,网络上零请求;
 *  - 「打开设备界面」缺省折叠,展开后是 P0 那几行(不含手机);「本机」段在 web 路径显示「仅安卓 App」。
 *  - 出三张真实截图(中文亮 / 中文暗 / 英文亮)给人眼看(DESIGN §8)。
 *
 * 跑法:npm run build && npm run e2e:runon。SHOT_DIR 指定截图目录(缺省系统临时目录)。
 * 机制照抄 units-entry.e2e.cjs(假 token 过登录闸,/api/** 缺省 abort,名册由 page.route 供给)。
 * ⚠️ 浏览器台架钉语言必须用 newContext({ locale })(chromium 的 --lang 无效,CLAUDE.md)。
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const PORT = Number(process.env.PORT_RUNON || 5286)
const URL = `http://localhost:${PORT}/`
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
const UNIT_LABELS = ['Forsion Unit 切换', 'Switch Forsion Unit']

const READY = '0f8fad5b-d9cb-469f-a165-70867728950e'
const STOPPED = '1f8fad5b-d9cb-469f-a165-70867728950e'
const OFF = '2f8fad5b-d9cb-469f-a165-70867728950e'
const OLD = '3f8fad5b-d9cb-469f-a165-70867728950e'
const PHONE = '4f8fad5b-d9cb-469f-a165-70867728950e'
const ROSTER = {
  units: [
    { id: READY, name: 'MacBook Pro', platform: 'darwin', icon: null, online: true, kind: 'desktop', capsLive: true, caps: { engine: 'ready', tools: [] }, lanUrl: 'http://10.0.0.9:8791' },
    { id: STOPPED, name: 'Studio PC', platform: 'win32', icon: null, online: true, kind: 'desktop', capsLive: true, caps: { engine: 'stopped', tools: [] } },
    { id: OFF, name: 'Old iMac', platform: 'darwin', icon: null, online: false, kind: 'desktop', capsLive: false, caps: null },
    { id: OLD, name: 'Legacy laptop', platform: 'linux', icon: null, online: true }, // 老名册:没有 kind / caps
    { id: PHONE, name: 'Pixel 9', platform: 'android', icon: null, online: false, kind: 'phone' },
  ],
}

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const roots = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
    for (const d of dirs.reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const exe = path.join(root, d, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

function ping() {
  return new Promise((res) => {
    const req = http.get(URL, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const fails = []
const pass = (name, extra) => console.log(`PASS  ${name}${extra ? `  | ${extra}` : ''}`)
const fail = (name, extra) => { fails.push(name); console.log(`FAIL  ${name}${extra ? `  | ${extra}` : ''}`) }
const expect = (cond, name, extra) => (cond ? pass(name) : fail(name, extra))

async function scenario(browser, { lang, mode, shot, full }) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, locale: lang === 'zh' ? 'zh-CN' : 'en-US', colorScheme: mode })
  await ctx.addInitScript(({ lang, mode }) => {
    try {
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('forsion_token', 'e2e-runon')
      localStorage.setItem('tangu_locale', lang)
      localStorage.setItem('forsion_theme_pref', mode)
    } catch { /* ignore */ }
  }, { lang, mode })
  const page = await ctx.newPage()
  const proxyHits = []
  page.on('request', (r) => { if (/\/units\/[^/]+\/proxy\//.test(r.url())) proxyHits.push(r.url()) })
  page.on('pageerror', (e) => fail(`[${lang}/${mode}] 未捕获异常`, e.message))
  await page.route('**/api/**', (r) => r.abort())
  await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"u1","username":"e2e"}' }))
  await page.route('**/api/units', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROSTER) }))
  const cdp = await ctx.newCDPSession(page)
  const tapBox = async (b) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
    await new Promise((r) => setTimeout(r, 60))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(400)
  }
  const tap = async (locator) => {
    const b = await locator.boundingBox()
    if (!b) throw new Error(`目标不可见: ${locator}`)
    await tapBox(b)
  }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(4000)

  // 开左抽屉 → 底部行的互联入口 → 弹层
  await tap(page.locator('.mb-topbar [aria-label="left panel"]'))
  await page.waitForTimeout(600)
  const entry = page.locator('.mb-drawer--left.open .mb-foot-row .mb-icon-btn').filter({ has: page.locator('svg') })
  let opened = false
  for (const label of UNIT_LABELS) {
    const btn = page.locator(`.mb-drawer--left.open .mb-foot-row [aria-label="${label}"]`)
    if (await btn.count()) { await tap(btn.first()); opened = true; break }
  }
  if (!opened && (await entry.count())) await tap(entry.first())
  await page.waitForSelector('[data-units-sheet]', { timeout: 5000 }).catch(() => null)
  await page.waitForTimeout(800)
  const sheet = await page.evaluate(() => {
    const root = document.querySelector('[data-units-sheet]')
    if (!root) return null
    const rows = [...root.querySelectorAll('[data-run-on] [data-run-row]')].map((b) => ({
      id: b.getAttribute('data-run-row'), status: b.getAttribute('data-status'), pressed: b.getAttribute('aria-pressed'),
      sub: b.querySelector('.us-row-sub')?.textContent?.trim() || '',
    }))
    return {
      rows,
      issue: root.querySelector('[data-phone-issue]')?.getAttribute('data-phone-issue') || null,
      issueText: root.querySelector('[data-phone-issue]')?.textContent?.trim() || '',
      phone: root.querySelector('[data-this-phone] .us-self-text')?.textContent?.trim() || '',
      devicesOpen: root.querySelector('[data-open-screen] .us-section-toggle')?.getAttribute('aria-expanded'),
    }
  })
  const tag = `[${lang}/${mode}]`
  if (!sheet) { fail(`${tag} 弹层打开`); await ctx.close(); return }
  pass(`${tag} 弹层打开`)

  if (full) {
    const ids = sheet.rows.map((r) => r.id)
    expect(JSON.stringify(ids) === JSON.stringify(['home', READY, STOPPED, OFF, OLD]), `${tag} 在哪运行:云端 + 4 台电脑;手机不出现、没 kind 的老桌面出现`, JSON.stringify(ids))
    const st = Object.fromEntries(sheet.rows.map((r) => [r.id, r]))
    expect(st.home.pressed === 'true', `${tag} 当前 = 云端(K6-S2 接上之前如实不变)`, JSON.stringify(st.home))
    expect(st[READY].status === 'checking' && /可用|Available/.test(st[READY].sub), `${tag} 自报 ready、还没探过 → 「可用」`, JSON.stringify(st[READY]))
    expect(st[STOPPED].status === 'engineStopped' && /引擎没有运行|isn't running/.test(st[STOPPED].sub), `${tag} caps stopped → 引擎没运行`, JSON.stringify(st[STOPPED]))
    expect(st[OFF].status === 'offline', `${tag} 离线`, JSON.stringify(st[OFF]))
    expect(st[OLD].status === 'checking' && /状态未知|Status unknown/.test(st[OLD].sub), `${tag} 老桌面没报 caps → 状态未知`, JSON.stringify(st[OLD]))
    expect(sheet.issue === 'nativeOnly', `${tag} web 路径:一开就挂「仅安卓 App」横幅`, JSON.stringify(sheet))
    expect(/安卓|Android/.test(sheet.phone), `${tag} 本机段:web 路径显示仅安卓 App`, sheet.phone)
    expect(sheet.devicesOpen === 'false', `${tag} 打开设备界面缺省折叠`)

    // 点一台可用的电脑:web 路径只得到横幅,一个 /proxy/ 请求都不发
    await tap(page.locator(`[data-run-row="${READY}"]`))
    await page.waitForTimeout(800)
    const after = await page.evaluate(() => document.querySelector('[data-phone-issue]')?.getAttribute('data-phone-issue') || null)
    expect(after === 'nativeOnly' && proxyHits.length === 0, `${tag} 点电脑 → 仍是 nativeOnly、零 /proxy/ 请求`, JSON.stringify({ after, proxyHits }))

    // 中继面在 web 路径同样失败关闭:直接 fetch 远端引擎 → 合成 503 CALLER_UNSUPPORTED,网络上零请求
    const direct = await page.evaluate(async (id) => {
      const r = await fetch(`${location.origin}/api/units/${id}/proxy/engine/agent/sessions`)
      return { status: r.status, body: await r.json().catch(() => null) }
    }, READY)
    expect(direct.status === 503 && direct.body?.code === 'CALLER_UNSUPPORTED' && proxyHits.length === 0, `${tag} web 路径 fetch 远端引擎 → 503 CALLER_UNSUPPORTED,零网络请求`, JSON.stringify({ direct, proxyHits }))
    const bad = await page.evaluate(async (id) => { try { await fetch(`${location.origin}/api/units/${id}/proxy/engine/../unit/mcp`); return 'sent' } catch (e) { return e.name } }, READY)
    expect(bad === 'TypeError' && proxyHits.length === 0, `${tag} 语法不过的中继面 URL → TypeError,零网络请求`, JSON.stringify({ bad, proxyHits }))
  }

  const shotPath = path.join(SHOT_DIR, shot)
  await page.screenshot({ path: shotPath })
  console.log(`screenshot → ${shotPath}`)

  if (full) {
    await tap(page.locator('[data-open-screen] .us-section-toggle'))
    await page.waitForTimeout(300)
    const dev = await page.evaluate(() => [...document.querySelectorAll('[data-open-screen] .us-row .us-row-name')].map((n) => n.textContent))
    expect(dev.length === 5 && !dev.includes('Pixel 9'), `${tag} 展开打开设备界面:4 台电脑 5 行(MacBook 直连 + 中转),没有手机`, JSON.stringify(dev))
    const shot2 = path.join(SHOT_DIR, shot.replace('.png', '-devices.png'))
    await page.screenshot({ path: shot2 })
    console.log(`screenshot → ${shot2}`)
    // 滚到底:「本机」段(web 路径 = 仅安卓 App)
    await page.evaluate(() => { const b = document.querySelector('[data-units-sheet] .us-body'); if (b) b.scrollTop = b.scrollHeight })
    await page.waitForTimeout(200)
    const shot3 = path.join(SHOT_DIR, shot.replace('.png', '-bottom.png'))
    await page.screenshot({ path: shot3 })
    console.log(`screenshot → ${shot3}`)
  }
  await ctx.close()
}

/**
 * 模拟原生桥:把 window.tangu 的三件身份方法与中继面 fetch 换成按原生契约回话的替身(web 路径里没有原生插件)。
 * 只为走通 UnitsSheet 的界面流程(等待确认 → 受信 → 探针 → 生效 / 本机已登记 → 移除),不证原生本身 —— 那由
 * unit-relay-emu.cjs(模拟器)与 JVM 单测负责。先断言垫片真的导出了这三件,再覆盖(防「仪器自己把桥补出来」的假绿)。
 */
async function simScenario(browser) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, locale: 'zh-CN', colorScheme: 'light' })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('forsion_token', 'e2e-runon')
      localStorage.setItem('tangu_locale', 'zh')
      localStorage.setItem('forsion_theme_pref', 'light')
    } catch { /* ignore */ }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => fail('[sim] 未捕获异常', e.message))
  await page.route('**/api/**', (r) => r.abort())
  await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"u1","username":"e2e"}' }))
  await page.route('**/api/units', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROSTER) }))
  const cdp = await ctx.newCDPSession(page)
  const tap = async (locator) => {
    const b = await locator.boundingBox()
    if (!b) throw new Error(`目标不可见: ${locator}`)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
    await new Promise((r) => setTimeout(r, 60))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(400)
  }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(4000)
  const real = await page.evaluate(() => ['unitSelf', 'unitEnsureSelf', 'unitForgetSelf'].every((k) => typeof window.tangu?.[k] === 'function') && !('unitCallerHeaders' in (window.tangu || {})))
  expect(real, '[sim] 垫片真的导出了 unitSelf / unitEnsureSelf / unitForgetSelf,且没有 unitCallerHeaders(R-05 中继模式)')
  await page.evaluate(() => {
    const sim = { reg: false, i: 0, access: ['unconfirmed', 'pending', 'pending', 'trusted'], calls: [] }
    window.__sim = sim
    const t = window.tangu
    t.unitSelf = async () => ({ registered: sim.reg, unitId: sim.reg ? 'self-1' : null, name: sim.reg ? 'Pixel 9' : null, relay: 'ready' })
    t.unitEnsureSelf = async () => { sim.reg = true; return { ok: true, unitId: 'self-1', name: 'Pixel 9' } }
    t.unitForgetSelf = async () => { sim.reg = false; sim.forgot = true; return { ok: true } }
    const orig = window.fetch
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
    window.fetch = async (u, init) => {
      const m = String(u).match(/\/units\/([^/]+)\/proxy(\/.*)$/)
      if (!m) return orig(u, init)
      sim.calls.push(`${(init && init.method) || 'GET'} ${m[2]}`)
      if (m[2] === '/unit/remote-access') return json({ remoteSessions: true, principal: 'unit', caller: sim.access[Math.min(sim.i++, sim.access.length - 1)], maxApprovalMode: 'auto-edit' })
      if (m[2] === '/unit/remote-access/request') return json({ remoteSessions: true, principal: 'unit', caller: 'pending', maxApprovalMode: 'auto-edit' })
      if (m[2] === '/engine/agent/sessions') return json({ sessions: [] })
      return json({ detail: 'not found' }, 404)
    }
  })
  await tap(page.locator('.mb-topbar [aria-label="left panel"]'))
  await page.waitForTimeout(600)
  for (const label of UNIT_LABELS) {
    const btn = page.locator(`.mb-drawer--left.open .mb-foot-row [aria-label="${label}"]`)
    if (await btn.count()) { await tap(btn.first()); break }
  }
  await page.waitForSelector('[data-units-sheet]', { timeout: 5000 })
  await page.waitForTimeout(600)
  const pre = await page.evaluate(() => ({ issue: document.querySelector('[data-phone-issue]') ? 1 : 0, phone: document.querySelector('[data-this-phone] .us-self-text')?.textContent || '' }))
  expect(pre.issue === 0 && /尚未登记/.test(pre.phone), '[sim] 中继可用:没有横幅;本机「尚未登记」(懒登记)', JSON.stringify(pre))
  await tap(page.locator(`[data-run-row="${READY}"]`))
  await page.waitForTimeout(700)
  const pending = await page.evaluate((id) => document.querySelector(`[data-run-row="${id}"] .us-row-sub`)?.textContent || '', READY)
  expect(/请在「MacBook Pro」上允许这台手机/.test(pending), '[sim] 等待确认:行内「请在「MacBook Pro」上允许这台手机」', pending)
  await page.screenshot({ path: path.join(SHOT_DIR, 'units-runon-sim-pending.png') })
  console.log(`screenshot → ${path.join(SHOT_DIR, 'units-runon-sim-pending.png')}`)
  await page.waitForTimeout(6000)
  const done = await page.evaluate((id) => ({
    calls: window.__sim.calls,
    sub: document.querySelector(`[data-run-row="${id}"] .us-row-sub`)?.textContent || '',
    pressed: document.querySelector(`[data-run-row="${id}"]`)?.getAttribute('aria-pressed'),
    home: document.querySelector('[data-run-row="home"]')?.getAttribute('aria-pressed'),
    phone: document.querySelector('[data-this-phone] .us-self-text')?.textContent || '',
  }), READY)
  const seq = done.calls.join(' → ')
  expect(/^GET \/unit\/remote-access → POST \/unit\/remote-access\/request → (GET \/unit\/remote-access → )+GET \/engine\/agent\/sessions$/.test(seq), '[sim] 流程:问信任 → 发起确认 → 每 2s 轮询 → 受信 → 探引擎', seq)
  expect(/可用/.test(done.sub) && done.pressed === 'false' && done.home === 'true', '[sim] 探针通过后「可用」;生效是空操作(TODO K6-S2),当前仍如实是云端', JSON.stringify(done))
  expect(/已登记为「Pixel 9」/.test(done.phone), '[sim] 首次选电脑后本机段刷新为「已登记为「Pixel 9」」', done.phone)
  await page.evaluate(() => { const b = document.querySelector('[data-units-sheet] .us-body'); if (b) b.scrollTop = b.scrollHeight })
  await tap(page.locator('[data-this-phone] .us-btn.danger'))
  await page.evaluate(() => { const b = document.querySelector('[data-units-sheet] .us-body'); if (b) b.scrollTop = b.scrollHeight })
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(SHOT_DIR, 'units-runon-sim-forget.png') })
  console.log(`screenshot → ${path.join(SHOT_DIR, 'units-runon-sim-forget.png')}`)
  const confirmShown = await page.evaluate(() => /授权都会失效/.test(document.querySelector('[data-this-phone] .us-confirm')?.textContent || ''))
  expect(confirmShown, '[sim] 移除本机登记要二次确认')
  await tap(page.locator('[data-this-phone] .us-confirm .us-btn.danger'))
  await page.waitForTimeout(500)
  const gone = await page.evaluate(() => ({ forgot: !!window.__sim.forgot, phone: document.querySelector('[data-this-phone] .us-self-text')?.textContent || '' }))
  expect(gone.forgot && /尚未登记/.test(gone.phone), '[sim] 确认移除 → unitForgetSelf 被调、本机回「尚未登记」', JSON.stringify(gone))
  await ctx.close()
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } } }
  let browser = null
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800) || '(无 stderr)'}`)
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    await scenario(browser, { lang: 'zh', mode: 'light', shot: 'units-runon-zh-light.png', full: true })
    await scenario(browser, { lang: 'zh', mode: 'dark', shot: 'units-runon-zh-dark.png', full: false })
    await scenario(browser, { lang: 'en', mode: 'light', shot: 'units-runon-en-light.png', full: true })
    await simScenario(browser)
  } catch (e) {
    fail('harness', e.message)
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
}
main()
