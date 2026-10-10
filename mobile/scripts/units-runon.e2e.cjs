/**
 * UnitsSheet「在哪运行」浏览器台架(P1-K8)—— 手机形态(375×812、触屏),web 路径(mobileShim 非原生分支)。
 *
 * 钉的东西:
 *  - 名册里的手机不出现、kind 缺席的老桌面照样出现(按电脑);每台电脑一行、状态文案按 deviceStatus 口径;
 *  - web 路径没有原生身份:弹层一开就挂「仅在 Forsion 安卓 App 中可用」横幅;点电脑也只得到这条,**一个 /proxy/ 请求都不发**;
 *  - web 路径**不装中继**(K8 §3.4;评审 P2):页面里直接 fetch 远端引擎照旧走原 fetch(同 Genesis web,账号级未识别调用方),
 *    不合成 503、也不带任何调用方票头 —— 否则 K6-S2 的 check:enginetarget(驱动 mobile dev 构建打 unit 目标)全红;
 *  - 「打开设备界面」缺省折叠,展开后是 P0 那几行(不含手机);「本机」段在 web 路径显示「仅安卓 App」。
 *  - 出三张真实截图(中文亮 / 中文暗 / 英文亮)给人眼看(DESIGN §8)。
 *  - P1-KF 拒绝矩阵(zh / en):K4 拒绝体的每种 reason / state 在行上的状态、文案、状态点;带 reason 的不发起确认、不出「请允许」、
 *    不转圈、不切位置;denied(用户点了「不允许」)才说 10 分钟;轮询中才知道的名册缺失 / 弹框收了立刻停。另出几张拒绝态截图。
 *    矩阵在同一页面上顺序跑(行上的表不清):先留下一条「连不上」(网络错 / 发起确认 500),下一例那台电脑的真回答
 *    (reason / 轮询中的「请允许」)必须照出 —— 评审 P2:旧探针曾盖住后来的一切拒绝。
 *  - 端口:经 lib/preview.cjs —— 缺省系统分配空闲端口,E2E_PORT 可指定;只认本检出的 dist,端口被占就报错退出。
 *
 * 跑法:npm run build && npm run e2e:runon。SHOT_DIR 指定截图目录(缺省系统临时目录)。
 * 机制照抄 units-entry.e2e.cjs(假 token 过登录闸,/api/** 缺省 abort,名册由 page.route 供给)。
 * ⚠️ 浏览器台架钉语言必须用 newContext({ locale })(chromium 的 --lang 无效,CLAUDE.md)。
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const { startPreview } = require('./lib/preview.cjs')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

let URL = '' // main() 里由 startPreview 给:系统分配的空闲端口,E2E_PORT 可指定(见 lib/preview.cjs)
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
  const proxyHeaders = []
  page.on('request', (r) => { if (/\/units\/[^/]+\/proxy\//.test(r.url())) { proxyHits.push(r.url()); proxyHeaders.push(r.headers()) } })
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
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {}) // 弹层会滚:折叠线以下的行,坐标触摸打不到
    await page.waitForTimeout(150)
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

    // web 路径不装中继:直接 fetch 远端引擎 → 交给原 fetch 真发出去(本台架 /api/** 缺省 abort → TypeError),不合成 503、不带票头
    const direct = await page.evaluate(async (id) => {
      try { const r = await fetch(`${location.origin}/api/units/${id}/proxy/engine/agent/sessions`); return { status: r.status, body: await r.text().catch(() => null) } } catch (e) { return { threw: e.name } }
    }, READY)
    const sent = proxyHits.filter((u) => u.endsWith('/proxy/engine/agent/sessions'))
    const ticketHeaders = proxyHeaders.filter((h) => Object.keys(h).some((k) => /^x-forsion-caller$/i.test(k)))
    expect(direct.threw === 'TypeError' && sent.length === 1 && ticketHeaders.length === 0,
      `${tag} web 路径不装中继:fetch 远端引擎交给原 fetch(真发出去、不合成 503、不带调用方票头)`, JSON.stringify({ direct, proxyHits, ticketHeaders }))
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
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {}) // 弹层会滚:折叠线以下的行,坐标触摸打不到
    await page.waitForTimeout(150)
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
  // 探引擎之后是 setFocusTarget 整端切过去的连接流量(/unit/config、/engine/health …),只钉到探引擎为止的前缀
  expect(/^GET \/unit\/remote-access → POST \/unit\/remote-access\/request → (GET \/unit\/remote-access → )+GET \/engine\/agent\/sessions( → |$)/.test(seq), '[sim] 流程:问信任 → 发起确认 → 每 2s 轮询 → 受信 → 探引擎', seq)
  // 集成后(K8 × K6-S2,de16ecb4)生效 = setFocusTarget:当前位置真的切到那台电脑(原断言「空操作、仍是云端」是 K8 单包时的实情)
  expect(/可用/.test(done.sub) && done.pressed === 'true' && done.home === 'false', '[sim] 探针通过后「可用」,整端切到那台电脑(当前 = MacBook Pro)', JSON.stringify(done))
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

  // 评审 P1:失败按原因分横幅 —— 登记途中断网 → 「连不上」(不是「无法证明身份」);中继合成的 401 → 「登录已失效」
  await page.evaluate(() => { window.tangu.unitEnsureSelf = async () => ({ ok: false, code: 'network' }) })
  await page.evaluate(() => { const b = document.querySelector('[data-units-sheet] .us-body'); if (b) b.scrollTop = 0 })
  await tap(page.locator(`[data-run-row="${READY}"]`))
  await page.waitForTimeout(500)
  const net = await page.evaluate(() => ({ issue: document.querySelector('[data-phone-issue]')?.getAttribute('data-phone-issue') || null, text: document.querySelector('[data-phone-issue]')?.textContent || '' }))
  expect(net.issue === 'network' && /连不上 Forsion/.test(net.text), '[sim] 登记途中断网 → 横幅「暂时连不上 Forsion」,不是「无法证明身份」', JSON.stringify(net))
  await page.screenshot({ path: path.join(SHOT_DIR, 'units-runon-sim-network.png') })
  console.log(`screenshot → ${path.join(SHOT_DIR, 'units-runon-sim-network.png')}`)
  await page.evaluate(() => {
    window.tangu.unitEnsureSelf = async () => ({ ok: true, unitId: 'self-1', name: 'Pixel 9' })
    const orig = window.fetch
    window.fetch = async (u, init) => (/\/proxy\/unit\/remote-access$/.test(String(u))
      ? new Response(JSON.stringify({ detail: 'Invalid or expired token' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      : orig(u, init))
  })
  await tap(page.locator(`[data-run-row="${READY}"]`))
  await page.waitForTimeout(500)
  const auth = await page.evaluate((id) => ({
    issue: document.querySelector('[data-phone-issue]')?.getAttribute('data-phone-issue') || null,
    text: document.querySelector('[data-phone-issue]')?.textContent || '',
    row: document.querySelector(`[data-run-row="${id}"]`)?.getAttribute('data-status') || '',
  }), READY)
  expect(auth.issue === 'signedOut' && /登录已失效/.test(auth.text), '[sim] 中继合成的 401 → 横幅「登录已失效」,不记到这台电脑头上', JSON.stringify(auth))
  await page.screenshot({ path: path.join(SHOT_DIR, 'units-runon-sim-signedout.png') })
  console.log(`screenshot → ${path.join(SHOT_DIR, 'units-runon-sim-signedout.png')}`)
  await ctx.close()
}

/**
 * P1-KF · 拒绝矩阵(真页面 × 真 UnitsSheet × 真 runOn × 真 setFocusTarget;只有原生桥与中继面被替身):
 * 每种 K4 拒绝体(reason 先于 state)在行上的状态 / 文案 / 状态点;带 reason 的一律不发起确认、不出「请在 X 上允许」、不转圈、
 * 不切位置;没有 reason 的 denied 才说「10 分钟后可以再次请求」;轮询中才知道的名册缺失 / 弹框收了立刻停。zh / en 各跑一遍。
 */
const EXPECT = {
  zh: {
    pending: '请在「MacBook Pro」上允许这台手机',
    unreachable: '暂时连不上，稍后重试',
    denied: '「MacBook Pro」拒绝了这台手机，10 分钟后可以再次请求',
    notAsked: '「MacBook Pro」还没有允许这台手机，点按再次请求',
    remoteOff: '请在「MacBook Pro」上开启「允许远程会话」',
    strict: '「MacBook Pro」只允许这类连接查看，不会再询问；请在那台电脑的「设置 › 远程会话」中允许',
    'never-prompts': '「MacBook Pro」不会为这类连接弹框询问；请在那台电脑的「设置 › 远程会话」中允许',
    'not-signed-in': '「MacBook Pro」没有登录 Forsion，请先在那台电脑上登录',
    'roster-miss': '「MacBook Pro」的账号里找不到这台手机，请确认两台设备登录的是同一个账号',
    'roster-unreachable': '「MacBook Pro」暂时无法核对这台手机，请稍后再试',
    'no-answer': '「MacBook Pro」上没有人回应确认，请稍后再试',
    busy: '「MacBook Pro」上待确认的请求太多，请稍后再试',
  },
  en: {
    pending: 'Allow this phone on "MacBook Pro"',
    unreachable: "Can't reach it right now. Try again shortly",
    denied: '"MacBook Pro" declined this phone. You can ask again in 10 minutes',
    notAsked: '"MacBook Pro" hasn\'t allowed this phone yet. Tap to ask again',
    remoteOff: 'Turn on "Allow remote sessions" on "MacBook Pro"',
    strict: '"MacBook Pro" only lets connections like this one view sessions and won\'t ask again. Allow it in Settings › Remote sessions there',
    'never-prompts': '"MacBook Pro" doesn\'t ask for connections like this one. Allow it in Settings › Remote sessions there',
    'not-signed-in': '"MacBook Pro" isn\'t signed in to Forsion. Sign in there first',
    'roster-miss': '"MacBook Pro" can\'t find this phone in its account. Make sure both devices use the same account',
    'roster-unreachable': '"MacBook Pro" can\'t check this phone right now. Try again shortly',
    'no-answer': 'No one answered on "MacBook Pro". Try again in a minute',
    busy: '"MacBook Pro" has too many requests waiting. Try again shortly',
  },
}
const st = (caller, extra = {}) => ({ remoteSessions: true, principal: 'unit', caller, maxApprovalMode: 'auto-edit', ...extra })
/** get:第 i 次 GET /unit/remote-access 的回包(越界取最后一个);post:POST …/request 的回包。 */
const CASES = [
  { name: 'denied(用户点了不允许)', get: [st('denied')], status: 'denied', text: 'denied', tone: 'err', calls: ['GET /unit/remote-access'] },
  { name: 'strict', get: [st('denied', { reason: 'strict' })], status: 'callerBlocked', reason: 'strict', text: 'strict', tone: 'err', calls: ['GET /unit/remote-access'] },
  { name: 'roster-miss', get: [st('denied', { reason: 'roster-miss' })], status: 'callerBlocked', reason: 'roster-miss', text: 'roster-miss', tone: 'err', calls: ['GET /unit/remote-access'] },
  { name: 'not-signed-in', get: [st('unconfirmed', { reason: 'not-signed-in' })], status: 'callerBlocked', reason: 'not-signed-in', text: 'not-signed-in', tone: 'err', calls: ['GET /unit/remote-access'] },
  { name: 'never-prompts', get: [st('unconfirmed', { reason: 'never-prompts' })], status: 'callerBlocked', reason: 'never-prompts', text: 'never-prompts', tone: 'err', calls: ['GET /unit/remote-access'] },
  { name: 'roster-unreachable', get: [st('unconfirmed', { reason: 'roster-unreachable' })], status: 'callerBlocked', reason: 'roster-unreachable', text: 'roster-unreachable', tone: 'warn', calls: ['GET /unit/remote-access'] },
  { name: 'no-answer(冷却中)', get: [st('unconfirmed', { reason: 'no-answer' })], status: 'callerBlocked', reason: 'no-answer', text: 'no-answer', tone: 'warn', calls: ['GET /unit/remote-access'] },
  { name: 'busy(发起那拍才知道)', get: [st('unconfirmed')], post: st('unconfirmed', { reason: 'busy' }), status: 'callerBlocked', reason: 'busy', text: 'busy', tone: 'warn', calls: ['GET /unit/remote-access', 'POST /unit/remote-access/request'] },
  { name: 'remote off', get: [st('unconfirmed', { remoteSessions: false })], status: 'remoteOff', text: 'remoteOff', tone: 'warn', calls: ['GET /unit/remote-access'] },
  // 评审 P2:同一行上先留一条「连不上」,紧接着那台电脑的真回答必须照出(旧探针不许盖住 reason / 「请允许」)
  { name: '网络错(留下一条连不上)', get: ['throw'], status: 'unreachable', text: 'unreachable', tone: 'err', calls: ['GET /unit/remote-access'] },
  { name: '连不上之后 → roster-miss', shot: 'after-blip-roster-miss', get: [st('denied', { reason: 'roster-miss' })], status: 'callerBlocked', reason: 'roster-miss', text: 'roster-miss', tone: 'err', calls: ['GET /unit/remote-access'] },
  { name: '发起确认 500(留下一条连不上)', get: [st('unconfirmed')], post: { __status: 500, body: { detail: 'boom' } }, status: 'unreachable', text: 'unreachable', tone: 'err', calls: ['GET /unit/remote-access', 'POST /unit/remote-access/request'] },
  { name: '轮询中查完名册 → roster-miss', get: [st('unconfirmed'), st('denied', { reason: 'roster-miss' })], post: st('pending'), status: 'callerBlocked', reason: 'roster-miss', text: 'roster-miss', tone: 'err', sawPending: true, calls: ['GET /unit/remote-access', 'POST /unit/remote-access/request', 'GET /unit/remote-access'] },
  { name: '轮询中弹框收了没回答 → 还没问过', get: [st('unconfirmed'), st('unconfirmed')], post: st('pending'), status: 'awaitingConfirm', text: 'notAsked', tone: 'warn', sawPending: true, calls: ['GET /unit/remote-access', 'POST /unit/remote-access/request', 'GET /unit/remote-access'] },
]

async function refusalMatrix(browser, lang) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, locale: lang === 'zh' ? 'zh-CN' : 'en-US', colorScheme: 'light' })
  await ctx.addInitScript((lang) => {
    try {
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('forsion_token', 'e2e-runon')
      localStorage.setItem('tangu_locale', lang)
      localStorage.setItem('forsion_theme_pref', 'light')
    } catch { /* ignore */ }
  }, lang)
  const page = await ctx.newPage()
  const tag = `[kf/${lang}]`
  page.on('pageerror', (e) => fail(`${tag} 未捕获异常`, e.message))
  await page.route('**/api/**', (r) => r.abort())
  await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"u1","username":"e2e"}' }))
  await page.route('**/api/units', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROSTER) }))
  const cdp = await ctx.newCDPSession(page)
  const tap = async (locator) => {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {}) // 弹层会滚:折叠线以下的行,坐标触摸打不到
    await page.waitForTimeout(150)
    const b = await locator.boundingBox()
    if (!b) throw new Error(`目标不可见: ${locator}`)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
    await new Promise((r) => setTimeout(r, 60))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(300)
  }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(4000)
  await page.evaluate(() => {
    const sim = { calls: [], gets: [], post: null, i: 0, seen: [] }
    window.__sim = sim
    const t = window.tangu
    t.unitSelf = async () => ({ registered: true, unitId: 'self-1', name: 'Pixel 9', relay: 'ready' })
    t.unitEnsureSelf = async () => ({ ok: true, unitId: 'self-1', name: 'Pixel 9' })
    const orig = window.fetch
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
    window.fetch = async (u, init) => {
      const m = String(u).match(/\/units\/([^/]+)\/proxy(\/[^?]*)/)
      if (!m) return orig(u, init)
      const key = `${(init && init.method) || 'GET'} ${m[2]}`
      sim.calls.push(key)
      // 'throw' = 网络错(fetch 抛 TypeError);{__status, body} = 非 200 回包
      const answer = (v) => { if (v === 'throw') throw new TypeError('Failed to fetch'); return v && v.__status ? json(v.body, v.__status) : json(v) }
      if (key === 'GET /unit/remote-access') return answer(sim.gets[Math.min(sim.i++, sim.gets.length - 1)])
      if (key === 'POST /unit/remote-access/request') return answer(sim.post || { remoteSessions: true, principal: 'unit', caller: 'pending', maxApprovalMode: 'auto-edit' })
      if (key === 'GET /engine/agent/sessions') return json({ sessions: [] })
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
  await page.waitForTimeout(500)
  // 记下 READY 这一行出现过的每一句状态(抓「请允许」一闪而过)
  await page.evaluate((id) => {
    const seen = window.__sim.seen
    const read = () => { const t = document.querySelector(`[data-run-row="${id}"] .us-row-sub`)?.textContent?.trim(); if (t && seen[seen.length - 1] !== t) seen.push(t) }
    new MutationObserver(read).observe(document.querySelector('[data-units-sheet]'), { subtree: true, childList: true, characterData: true, attributes: true })
    read()
  }, READY)

  const E = EXPECT[lang]
  for (const c of CASES) {
    await page.evaluate((c) => { Object.assign(window.__sim, { calls: [], gets: c.get, post: c.post || null, i: 0 }); window.__sim.seen.length = 0 }, c)
    const t0 = Date.now()
    await tap(page.locator(`[data-run-row="${READY}"]`))
    // 等这一轮收工(aria-busy 消失),封顶 15s —— 带 reason 的本该一拍就停,不许空转 120s
    for (let i = 0; i < 75; i++) {
      if (!(await page.evaluate((id) => document.querySelector(`[data-run-row="${id}"]`)?.getAttribute('aria-busy') === 'true', READY))) break
      await page.waitForTimeout(200)
    }
    const took = Date.now() - t0
    const row = await page.evaluate((id) => {
      const b = document.querySelector(`[data-run-row="${id}"]`)
      return {
        status: b?.getAttribute('data-status'), reason: b?.getAttribute('data-reason'), busy: b?.getAttribute('aria-busy'),
        pressed: b?.getAttribute('aria-pressed'), home: document.querySelector('[data-run-row="home"]')?.getAttribute('aria-pressed'),
        sub: b?.querySelector('.us-row-sub')?.textContent?.trim() || '', dot: b?.querySelector('.settings-status-dot')?.className || '',
        calls: window.__sim.calls.slice(), seen: window.__sim.seen.slice(),
      }
    }, READY)
    const want = E[c.text]
    const okState = row.status === c.status && (row.reason || null) === (c.reason || null)
    const okText = row.sub === want
    const okIdle = row.busy !== 'true' && row.pressed === 'false' && row.home === 'true'
    const okDot = row.dot.split(/\s+/).includes(c.tone)
    const okCalls = JSON.stringify(row.calls) === JSON.stringify(c.calls)
    const sawPending = row.seen.includes(E.pending)
    const okPending = c.sawPending ? sawPending : !sawPending
    const no10 = c.reason === 'strict' || c.reason === 'roster-miss' ? !/10\s*分钟|10 minutes/.test(row.sub) : true
    expect(okState && okText && okIdle && okDot && okCalls && okPending && no10 && took < 12_000,
      `${tag} ${c.name}:${c.status}${c.reason ? `/${c.reason}` : ''} · 「${want}」· 点 ${c.tone} · 不切位置、不转圈${c.sawPending ? '' : '、从未出现「请允许」'}(${took}ms)`,
      JSON.stringify({ row, took }))
    if (lang === 'zh' ? ['strict', 'roster-miss', 'denied(用户点了不允许)', 'busy(发起那拍才知道)', '连不上之后 → roster-miss'].includes(c.name) : c.name === 'strict') {
      const shot = path.join(SHOT_DIR, `units-runon-kf-${lang}-${c.shot || c.name.replace(/[^a-z-]/gi, '') || 'case'}.png`)
      await page.screenshot({ path: shot })
      console.log(`screenshot → ${shot}`)
    }
  }
  await ctx.close()
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = await startPreview(root)
  URL = preview.url
  let browser = null
  try {
    await preview.ready()
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    await scenario(browser, { lang: 'zh', mode: 'light', shot: 'units-runon-zh-light.png', full: true })
    await scenario(browser, { lang: 'zh', mode: 'dark', shot: 'units-runon-zh-dark.png', full: false })
    await scenario(browser, { lang: 'en', mode: 'light', shot: 'units-runon-en-light.png', full: true })
    await simScenario(browser)
    await refusalMatrix(browser, 'zh')
    await refusalMatrix(browser, 'en')
  } catch (e) {
    fail('harness', e.message)
  } finally {
    if (browser) await browser.close().catch(() => {})
    preview.kill()
  }
  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
}
main()
