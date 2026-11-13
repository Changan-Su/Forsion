/**
 * 手机首次引导(方案 A)的浏览器台架 —— `npm run e2e:phoneguide`(mobile 目录;不用 build,自己起 vite dev)。
 *
 * 两种载具:
 *   - 整个手机包(index.html)跑在 Chromium 里:window.tangu.mobile 为真、没有原生插件。后端由 phone-stage.cjs 的夹具答,
 *     名册(GET /api/units)由本脚本按场景答(一台在线的电脑 / 空 / 500 / 永远不答)。看「在哪运行」、外观、主页建议、返回键、续做。
 *   - /settings-harness.html?pg=…:同一批真组件(PermsScreen / PermissionsPanel / SignInWelcome)配假原生能力
 *     (mobile/src/settingsHarness.tsx 的 mountPhoneGuideHarness),看浏览器里出不来的「想让它做哪些事」与登录前那屏。
 *
 *   OUT=<dir>       截图与 results.json 放哪(缺省 outputs/phone-guide)
 *   ONLY=s1,s8      只跑这几段(s1 … s15,见下面 SCEN 的键)
 *   E2E_PORT=<n>    固定 dev 端口(缺省系统分配)
 *
 * ⚠️ 手机包上向导先画 data-step="pending" 的底子(最多 2.5 秒等名册),等真的 data-step 或 [data-ob-primary]。
 * ⚠️ 语言用 newPage 的 locale 钉(chromium --lang 无效);/auth/region 一律拒掉,不让 IP 区域在一秒后把语言翻过去。
 * 失败的断言原样留着、不放宽:台架红 = 产品或台架有一处不对,看 results.json 里的 detail 和截图。
 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const lib = require('./phone-stage.cjs')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 借 desktop 的 */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const ROOT = path.resolve(__dirname, '..')
const OUT = path.resolve(ROOT, process.env.OUT || 'outputs/phone-guide')
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const PHONE = { width: 411, height: 914 }
const STATUS = 51.8, NAV = 24.2
const KEYS = {
  done: 'forsion_tangu_onboarding_done', version: 'forsion_tangu_onboarding_version', rev: 'forsion_phone_guide_rev',
  step: 'forsion_phone_guide_step', suggest: 'forsion_phone_guide_suggest',
}
const MAC = { id: "0a1b2c3d-1111-4222-8333-444455556666", name: 'MacBook Pro', kind: 'desktop', platform: 'darwin', online: true, capsLive: true, caps: { engine: 'ready' }, lastSeenAt: new Date().toISOString() }

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const e = path.join(root, d, rel); if (fs.existsSync(e)) return e
      }
  }
  throw new Error('no chromium; set CHROMIUM_EXE')
}

// ── dev server:自己起、认准是自己的(stdout 报了这个端口)、按进程组 PID 收 ─────────────────────
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)) }) })
const get = (url) => new Promise((res) => {
  const req = http.get(url, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (d) => { b += d }); r.on('end', () => res(r.statusCode === 200 ? b : null)); r.on('error', () => res(null)) })
  req.on('error', () => res(null)); req.setTimeout(3000, () => { req.destroy(); res(null) })
})
async function startDev() {
  const port = Number(process.env.E2E_PORT) || await freePort()
  const url = `http://localhost:${port}/`
  const child = spawn('npx', ['vite'], { cwd: ROOT, env: { ...process.env, PORT: String(port), BACKEND_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = '', err = '', gone = null
  child.stdout.on('data', (d) => { out += String(d) })
  child.stderr.on('data', (d) => { err += String(d) })
  child.on('exit', (code, sig) => { gone = sig || `code=${code}` })
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (gone) throw new Error(`vite dev exited (${gone})\n${err.slice(-800)}`)
    if (out.replace(/\x1b\[[0-9;]*m/g, '').includes(`:${port}/`) && (await get(url))?.includes('id="root"')) {
      console.log(`vite dev (pid ${child.pid}) → ${url}`)
      return { url, port, pid: child.pid, kill }
    }
  }
  kill()
  throw new Error(`vite dev did not come up on ${port}\n${out.slice(-400)}\n${err.slice(-400)}`)
}

// ── 结果 ────────────────────────────────────────────────────────────────────────
const results = []
let cur = ''
function ok(name, cond, detail, evidence) {
  const row = { scenario: cur, check: name, pass: !!cond, detail: detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail), evidence: evidence || '' }
  results.push(row)
  console.log(`${cond ? 'PASS' : 'FAIL'}  [${cur}] ${name}${row.detail ? '  | ' + row.detail.slice(0, 400) : ''}`)
  return !!cond
}
function notRun(name, why) {
  results.push({ scenario: cur, check: name, pass: null, detail: `NOT RUN: ${why}`, evidence: '' })
  console.log(`SKIP  [${cur}] ${name}  | ${why}`)
}
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`)
  await page.waitForTimeout(450)
  await page.screenshot({ path: file })
  console.log(`  shot ${file}`)
  return file
}

// ── 页面 ────────────────────────────────────────────────────────────────────────
let browser = null
let DEV = null

/**
 * 开一个干净的会话。seed 只在这个标签页第一次加载时写(刷新不重写:续做 / 刷新后的断言要看到上一轮写下的记号)。
 * units: 'ok' | 'empty' | '500' | 'hang';可以中途改 page.__net.units。
 */
async function openPage({ path: p = '', seed = {}, units = 'ok', locale = 'zh-CN', viewport = PHONE, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale, colorScheme: dark ? 'dark' : 'light' })
  await ctx.addInitScript(([s, isDark]) => {
    try {
      localStorage.setItem('forsion_token', 'stage')
      localStorage.setItem('amadeus_vault_mode', 'local')
      if (!sessionStorage.getItem('e2e-seeded')) {
        sessionStorage.setItem('e2e-seeded', '1')
        for (const [k, v] of Object.entries(s)) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) }
        if (isDark) localStorage.setItem('forsion_theme', 'dark')
      }
    } catch { /* private mode */ }
    // 向导外壳的 data-step 变化时间线(pending 一闪就过,轮询抓不到)
    window.__steps = []
    const note = () => { const el = document.querySelector('.ob3'); const st = el ? el.getAttribute('data-step') : null; const last = window.__steps[window.__steps.length - 1]; if (!last || last.step !== st) window.__steps.push({ step: st, t: performance.now() }) }
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-step'] })
    // 主页建议块出现 / 消失的时间线(「放不下就收」是挂上那一刻量一次,收掉后 DOM 里就没有了)
    window.__suggest = []
    new MutationObserver((recs) => {
      for (const r of recs) {
        for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches?.('.hp-suggest') || n.querySelector?.('.hp-suggest'))) {
          const s = document.querySelector('.hp-stack')?.getBoundingClientRect(), p = document.querySelector('.hp-pill')?.getBoundingClientRect()
          window.__suggest.push({ ev: 'added', t: Math.round(performance.now()), connected: !!document.querySelector('.hp-suggest'), stackBottom: s?.bottom, pillBottom: p?.bottom, vh: innerHeight, chrome: document.querySelector('.mb-shell')?.hasAttribute('data-native-chrome') ?? null })
        }
        for (const n of r.removedNodes) if (n.nodeType === 1 && (n.matches?.('.hp-suggest') || n.querySelector?.('.hp-suggest'))) window.__suggest.push({ ev: 'removed', t: Math.round(performance.now()) })
      }
    }).observe(document, { subtree: true, childList: true })
    // 台架专有的前进后退条(.lcl-viewnav-fallback,真机原生外壳里没有;shoot.cjs 拍方案图时也藏它)从一开始就藏掉:
    // 它占的那 2 dp 会让主页的「放不下就收」在台架上收掉建议块,真机上没有这一条
    if (!location.pathname.includes('settings-harness')) {
      const hide = () => { const st = document.createElement('style'); st.textContent = '.lcl-viewnav-fallback{display:none!important}'; (document.head || document.documentElement).appendChild(st) }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hide); else hide()
    }
    // 返回键送达计数(同 home-back.e2e.cjs):__backProbe 置位时这一下在第一环被吞掉,只探路
    window.__backSeen = 0
    window.__backProbe = false
    window.addEventListener('forsion:mobile-back', (e) => { window.__backSeen++; if (window.__backProbe) { window.__backProbe = false; e.preventDefault() } })
  }, [seed, dark])
  let page = await ctx.newPage()
  if (!(await page.evaluate(() => navigator.maxTouchPoints))) { const first = page; page = await ctx.newPage(); await first.close() }
  const net = { units, unitsGets: 0, hung: [], writes: [], errors: [], unknown: new Set() }
  page.__net = net
  await lib.stubApi(page, net.unknown)
  // phone-stage 的 stubApi 只放行它自己端口(5296)上的源文件请求:本台架的端口是临时分配的,自己的源文件在这里先放行
  const origin = new URL(DEV.url).origin
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (u.origin === origin && !/^\/(api|auth|account|shared|oauth|shop|pay|legal)(\/|$)/.test(u.pathname)) return route.continue()
    return route.fallback()
  })
  await page.route('**/api/units', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    net.unitsGets++
    net.unitsAt = [...(net.unitsAt || []), Date.now()]
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
    if (net.units === 'hang') { net.hung.push(route); return undefined }
    if (net.units === '500') return json(500, { error: 'stage' })
    return json(200, { units: net.units === 'empty' ? [] : [MAC] })
  })
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (/\.(tsx?|jsx?)$/.test(u.pathname)) lib.loaded.set(u.pathname, u.pathname + u.search)
    if (r.method() !== 'GET' && r.method() !== 'OPTIONS' && /^\/(api|auth)\//.test(u.pathname)) net.writes.push(`${r.method()} ${u.pathname}`)
  })
  page.on('pageerror', (e) => { if (!/not implemented on web/i.test(e.message)) net.errors.push(e.message) })
  await page.goto(new URL(p, DEV.url).href, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  return { ctx, page }
}

const stepOf = (page) => page.evaluate(() => document.querySelector('.ob3:not([data-exit-ghost])')?.getAttribute('data-step') ?? null)
/** 等向导画出真的一屏(不是 pending 底子)。 */
async function waitWizard(page, timeout = 180_000) {
  await page.waitForFunction(() => { const el = document.querySelector('.ob3'); return !!el && el.getAttribute('data-step') !== 'pending' && !!el.querySelector('[data-ob-primary]') }, null, { timeout })
  await page.waitForTimeout(500) // 换屏动效
  return stepOf(page)
}
async function waitStep(page, step, timeout = 10_000) {
  await page.waitForFunction((s) => document.querySelector('.ob3')?.getAttribute('data-step') === s, step, { timeout })
  await page.waitForTimeout(600)
}
const primaryText = (page) => page.evaluate(() => document.querySelector('.ob3 [data-ob-primary]')?.textContent.trim() ?? null)
const keys = (page) => page.evaluate((K) => Object.fromEntries(Object.entries(K).map(([n, k]) => [n, localStorage.getItem(k)])), KEYS)
const rect = (page, sel, nth = 0) => page.evaluate(([q, i]) => { const el = document.querySelectorAll(q)[i]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom, right: r.right } }, [sel, nth])
const tap = async (page, sel) => { await page.locator(sel).first().tap(); await page.waitForTimeout(350) }
const clickPrimary = (page) => tap(page, '.ob3 [data-ob-primary]')

/** 替身原生栏(同 phone-stage 的 installChrome,但版面按当前视口算:360 宽 / 矮屏的 Dock 位置不一样)。 */
async function installChrome(page) {
  const vp = page.viewportSize()
  const layout = {
    floating: true, status: STATUS, top: STATUS + 58, bottom: NAV + 80,
    plates: [
      { id: 'left', x: 12, y: STATUS + 6, w: 168, h: 46 },
      { id: 'right', x: vp.width - 12 - 98, y: STATUS + 6, w: 98, h: 46 },
      { id: 'dock', x: 12, y: vp.height - NAV - 6 - 68, w: vp.width - 24, h: 68 },
    ],
  }
  await page.waitForSelector('.mb-shell', { timeout: 60_000 })
  await page.evaluate(async ({ engineUrl, hostUrl, layout }) => {
    const engine = await import(/* @vite-ignore */ engineUrl)
    const host = await import(/* @vite-ignore */ hostUrl)
    const stage = (window.__stage = { engine, state: null, renders: 0 })
    const plain = { floating: false, status: layout.status, top: 0, bottom: 0, plates: [] }
    const detail = { ...layout, bottom: 0, plates: layout.plates.filter((p) => p.id !== 'dock') }
    engine.installNativeChromeHost({ spaces: true, render(state) { stage.state = state; stage.renders++; host.applyChromeLayout(state.mode !== 'shell' ? plain : state.leftBack ? detail : layout) } })
    host.applyChromeLayout(layout)
  }, { engineUrl: lib.moduleUrl('../lcl/engine/nativeChrome.ts'), hostUrl: lib.moduleUrl('src/nativeChrome.ts'), layout })
  await page.waitForFunction(() => document.querySelector('.mb-shell')?.hasAttribute('data-native-chrome') && !!window.__stage?.state, null, { timeout: 10_000 })
  await page.addStyleTag({ content: '.nc-plate { background: color-mix(in srgb, var(--surface, #fff) 55%, transparent); outline: 1px solid var(--border, rgba(0,0,0,.1)); }' })
  return layout.plates.find((p) => p.id === 'dock').y
}

/** 横向溢出:整页不出横向滚动,向导(不含壁纸那层)里没有比视口宽、或伸出视口的元素。 */
const overflow = (page, scope = '.ob3') => page.evaluate((q) => {
  const vw = window.innerWidth
  const bad = []
  const root = document.querySelector(q)
  for (const el of root ? root.querySelectorAll('*') : []) {
    if (el.closest('.ob3-paper, .hp-wallpaper-art, [data-exit-ghost]')) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    if (r.width > vw + 0.5 || r.right > vw + 0.5 || r.left < -0.5) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} [${Math.round(r.left)}..${Math.round(r.right)}]`)
  }
  return { scrollW: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 8), nBad: bad.length }
}, scope)
async function checkOverflow(page, label, scope) {
  const sizes = [{ width: 360, height: 740 }, PHONE]
  const before = page.viewportSize()
  for (const s of sizes) {
    await page.setViewportSize(s)
    await page.waitForTimeout(500)
    const o = await overflow(page, scope)
    ok(`${label} @${s.width}x${s.height}: no horizontal overflow`, o.scrollW <= o.vw && o.nBad === 0, o)
  }
  await page.setViewportSize(before)
  await page.waitForTimeout(400)
}

/** 换主题色 + 背景色:必须走 app 自己那份 theme/loader 的 applyTheme(只改 data-skin 不生效;同 shoot.cjs)。 */
async function applySkin(page, skin) {
  const loader = [...lib.loaded.entries()].find(([k]) => k.endsWith('/theme/loader.ts'))
  if (!loader) throw new Error('theme/loader.ts was not loaded by the page')
  return page.evaluate(async ([u, k]) => {
    const before = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const m = await import(/* @vite-ignore */ u)
    const root = document.documentElement
    m.applyTheme(root.dataset.theme, k, k, root.dataset.mode === 'dark' ? 'dark' : 'light')
    await new Promise((r) => setTimeout(r, 300))
    return { skin: root.dataset.skin, before, accent: getComputedStyle(root).getPropertyValue('--accent').trim() }
  }, [loader[1], skin])
}

/** 系统返回键:Capacitor web 插件的 notifyListeners 打进 MobileRoot 的真监听;返回「这一下送达了」(同 home-back.e2e.cjs)。 */
async function back(page, probe = false) {
  const n0 = await page.evaluate((p) => { window.__backProbe = p; return window.__backSeen }, probe)
  await page.evaluate(() => { window.Capacitor?.Plugins?.App?.notifyListeners?.('backButton', { canGoBack: false }) })
  await page.waitForTimeout(900)
  return page.evaluate((n) => { window.__backProbe = false; return window.__backSeen > n }, n0)
}

/** 「在哪运行」那屏为什么出 / 不出:名册请求次数、共享名册、两道闸(从 app 自己那份模块读)。 */
async function rosterDiag(page) {
  const d = await page.evaluate(async ([storeUrl, rtUrl, tgUrl]) => {
    const out = { hasUnitsList: !!window.tangu?.unitsList, unitPage: !!window.tangu?.unitPage }
    try { const { useDeviceSessions } = await import(/* @vite-ignore */ storeUrl); out.units = useDeviceSessions.getState().units } catch (e) { out.storeErr = String(e) }
    try { const rt = await import(/* @vite-ignore */ rtUrl); out.rosterAvailable = rt.rosterAvailable(); out.runLocationsAvailable = rt.runLocationsAvailable() } catch (e) { out.rtErr = String(e) }
    try { const tg = await import(/* @vite-ignore */ tgUrl); out.remoteTargetsSupported = tg.remoteTargetsSupported() } catch (e) { out.tgErr = String(e) }
    return out
  }, [lib.moduleUrl('../desktop/frontend/src/stores/deviceSessionsStore.ts'), lib.moduleUrl('../desktop/frontend/src/features/runtime.ts'), lib.moduleUrl('../desktop/frontend/src/services/engine/targets.ts')])
  return { unitsGets: page.__net.unitsGets, ...d }
}

const wizardGone = (page) => page.evaluate(() => !document.querySelector('.ob3'))
const FRESH = { [KEYS.done]: null, [KEYS.version]: null, [KEYS.rev]: null, [KEYS.step]: null, [KEYS.suggest]: null }
const OLD_DONE = { [KEYS.done]: '1', [KEYS.version]: '2.13.8', [KEYS.rev]: '1' }

// ── 场景 ────────────────────────────────────────────────────────────────────────
/** 主页建议块的几何:块在卡片上面、输入条在最后一张卡下面、在 Dock 上面。 */
async function homeGeometry(page, dockTop) {
  // 建议块的几道门(从 app 自己那份模块读),出不来时看是哪一道
  const gate = await page.evaluate(async ([achUrl, pgUrl, appUrl, k]) => {
    const out = { key: localStorage.getItem(k) }
    try { out.chatSend = (await import(/* @vite-ignore */ achUrl)).useAchievements.getState().counters['chat.send'] ?? 0 } catch (e) { out.achErr = String(e).slice(0, 80) }
    try { out.phoneApp = (await import(/* @vite-ignore */ pgUrl)).phoneGuide() !== null } catch (e) { out.pgErr = String(e).slice(0, 80) }
    try { out.onboarding = (await import(/* @vite-ignore */ appUrl)).useApp.getState().onboarding } catch (e) { out.appErr = String(e).slice(0, 80) }
    out.composerFocused = !!document.querySelector('.hp-root.hp-composer-focused')
    out.hpPhone = !!document.querySelector('.hp-root.hp-phone')
    const st = document.querySelector('.hp-stack')?.getBoundingClientRect()
    out.stackBottom = st ? st.bottom : null
    out.timeline = (window.__suggest || []).slice(0, 6)
    return out
  }, [lib.moduleUrl('../desktop/frontend/src/achievements/store.ts'), lib.moduleUrl('../desktop/frontend/src/components/onboarding/phoneGuide.ts'), lib.moduleUrl('../desktop/frontend/src/stores/appStore.ts'), KEYS.suggest])
  const geo = await page.evaluate((dock) => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.height ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height } : null }
    const H = document.querySelector('.mb-view[data-view="homepage"]') || document
    const cards = [...H.querySelectorAll('.hp-card')].map(box).filter(Boolean)
    const sug = box(H.querySelector('.hp-suggest'))
    // 只数画出来的:放不下时产品把后两条建议 / 第三行卡片 / 整块用 CSS 收掉,节点还在
    const chips = [...H.querySelectorAll('.hp-suggest-chip')].filter((e) => e.getBoundingClientRect().height > 0)
    return {
      suggest: sug, chips: chips.length,
      chipText: chips.map((e) => e.textContent.trim()),
      fit: (H.querySelector('.hp-root') || document.querySelector('.hp-root'))?.getAttribute('data-suggest-fit') ?? null,
      cards: cards.length, cardsDom: H.querySelectorAll('.hp-card').length,
      cardIds: [...H.querySelectorAll('.hp-card')].map((e) => (e.dataset.spaceId ? `space:${e.dataset.spaceId}` : e.dataset.fixedId)),
      cardsTop: cards.length ? Math.min(...cards.map((c) => c.top)) : null,
      lastCardBottom: cards.length ? Math.max(...cards.map((c) => c.bottom)) : null,
      pill: box(H.querySelector('.hp-pill')), dock,
    }
  }, dockTop)
  return { ...geo, gate }
}

/**
 * 诊断(不是断言):产品把建议块收掉时,照产品的类名在卡片前面摆一块同样的,量一下放上去之后输入条超出主页底边多少,拍一张,再拿掉。
 * 只用来说明「放不下」差多少,不代表产品画出来的样子。
 */
async function suggestReplica(page, name) {
  const m = await page.evaluate(() => {
    const cards = document.querySelector('.mb-view[data-view="homepage"] .hp-cards') || document.querySelector('.hp-cards')
    if (!cards) return null
    const sec = document.createElement('section'); sec.className = 'hp-suggest'; sec.setAttribute('data-e2e-replica', '')
    sec.innerHTML = '<div class="hp-suggest-title">试试这些 · 点了只填进输入框，不会直接发</div><div class="hp-suggest-grid">' +
      ['理一理今天要做的事', '明早 8 点提醒我开会', '总结我粘贴的文章', '你能帮我做什么？'].map((t) => `<button type="button" class="hp-suggest-chip"><span class="hp-suggest-text">${t}</span></button>`).join('') + '</div>'
    cards.before(sec)
    const r = (q) => document.querySelector(q)?.getBoundingClientRect()
    return { block: r('[data-e2e-replica]')?.height, blockDisplay: getComputedStyle(sec).display, pillBottom: r('.hp-pill')?.bottom, stackBottom: r('.hp-stack')?.bottom, greetBottom: r('.hp-greet')?.bottom, cardsTop: r('.hp-cards')?.top }
  })
  if (m) {
    await shot(page, name)
    // 台架专有的前进后退条(真机原生外壳里没有)藏掉再量一次:看 2 dp 的差是不是它造成的
    m.withoutStageNav = await page.evaluate(async () => {
      const bars = [...document.querySelectorAll('.lcl-viewnav-fallback')]
      bars.forEach((b) => { b.dataset.e2eHid = b.style.display; b.style.display = 'none' })
      await new Promise((r) => setTimeout(r, 300))
      const r = (q) => document.querySelector(q)?.getBoundingClientRect()
      const out = { bars: bars.length, pillBottom: r('.hp-pill')?.bottom, stackBottom: r('.hp-stack')?.bottom }
      bars.forEach((b) => { b.style.display = b.dataset.e2eHid || '' })
      return out
    })
    await page.evaluate(() => document.querySelector('[data-e2e-replica]')?.remove())
  }
  return m
}

async function finishToHome(page) {
  // 主按钮一路按到底(外观是最后一屏)
  for (let i = 0; i < 4 && !(await wizardGone(page)); i++) { await clickPrimary(page); await page.waitForTimeout(900) }
}

const SCEN = {
  // 0:台架原有的几种模式照旧能挂(本次给 settingsHarness.tsx 加了 ?pg,入口分了支)
  async s0() {
    for (const [q, sel] of [['', '.settings-page, .settings-modal, [role="dialog"]'], ['?onboarding', '.ob3 [data-ob-primary]'], ['?parts', '.settings-page'], ['?phone', '.settings-page, .settings-modal, [role="dialog"]']]) {
      const { ctx, page } = await openPage({ path: `settings-harness.html${q}` })
      try {
        const found = await page.waitForSelector(sel, { timeout: 60_000, state: 'attached' }).then(() => true, () => false)
        await page.waitForTimeout(800)
        ok(`settings-harness${q || ' (default)'} still renders`, found && page.__net.errors.length === 0, { found, errors: page.__net.errors.slice(0, 3) })
      } finally { await ctx.close() }
    }
  },

  // 1 + 2 + 13(中文浅色的溢出)
  async s1() {
    const { ctx, page } = await openPage({ seed: FRESH })
    try {
      const first = await waitWizard(page)
      const steps = await page.evaluate(() => window.__steps.map((s) => s.step))
      ok('PENDING shell shown before the first real step', steps[0] === 'pending' || steps.includes('pending'), steps)
      ok('first step is where', first === 'where', { first, ...(await rosterDiag(page)) })
      const where = await page.evaluate(() => {
        const q = (s) => document.querySelector(s)
        return {
          home: q('.ob3 [data-run-row="home"]')?.getAttribute('aria-checked'),
          mac: q('.ob3 [data-run-row]:not([data-run-row="home"])')?.textContent.trim() ?? null,
          macEm: q('.ob3 [data-run-row]:not([data-run-row="home"]) .pg-where-em')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
          dots: document.querySelectorAll('.ob3 .ob3-dots button').length,
          skip: q('.ob3 .ob-skip')?.textContent.trim() ?? null,
          noStyles: !q('.ob3 .ob3-styles'),
        }
      })
      ok('WHERE: cloud card selected', where.home === 'true', where)
      ok('WHERE: computer card with name and the sheet\'s status word (可用)', !!where.macEm && where.macEm.includes('MacBook Pro') && where.macEm.includes('可用'), where.macEm)
      ok('WHERE: dots = number of steps (where, theme → 2 in the stand-in)', where.dots === 2, where.dots)
      ok('WHERE: "跳过引导" present', where.skip === '跳过引导', where.skip)
      const fWhere = await shot(page, 'WHERE-zh-light')
      await checkOverflow(page, 'WHERE zh')

      // 点电脑:浏览器里手机自己连不出去 → 安静的一行说明,选中留在云端
      await tap(page, '.ob3 [data-run-row]:not([data-run-row="home"])')
      await page.waitForFunction(() => !!document.querySelector('.ob3 [data-phone-issue]'), null, { timeout: 8000 }).catch(() => {})
      const issue = await page.evaluate(() => ({
        line: document.querySelector('.ob3 [data-phone-issue]')?.textContent.trim() ?? null,
        kind: document.querySelector('.ob3 [data-phone-issue]')?.getAttribute('data-phone-issue') ?? null,
        home: document.querySelector('.ob3 [data-run-row="home"]')?.getAttribute('aria-checked'),
        mac: document.querySelector('.ob3 [data-run-row]:not([data-run-row="home"])')?.getAttribute('aria-checked'),
      }))
      ok('WHERE-issue: quiet issue line appears after tapping the computer', !!issue.line, issue)
      ok('WHERE-issue: selection stays on cloud', issue.home === 'true' && issue.mac === 'false', issue)
      await shot(page, 'WHERE-issue')

      await clickPrimary(page)
      await waitStep(page, 'theme')
      const theme = await page.evaluate(() => ({ styles: !!document.querySelector('.ob3 .ob3-styles'), preview: !!document.querySelector('.ob3 .ob3-preview'), phone: !!document.querySelector('.ob3 .ob3-theme.phone'), primary: document.querySelector('.ob3 [data-ob-primary]')?.textContent.trim() }))
      ok('THEME: phone variant (no .ob3-styles, no .ob3-preview)', !theme.styles && !theme.preview && theme.phone, theme)
      await shot(page, 'THEME')
      await checkOverflow(page, 'THEME zh')

      const mode0 = await page.evaluate(() => document.documentElement.dataset.mode)
      const darkBtn = page.locator('.ob3 [data-ob-mode] button', { hasText: '深色' }).first()
      if (await darkBtn.count()) await darkBtn.tap(); else await page.locator('.ob3 [data-ob-mode] [role="radio"]').nth(1).tap()
      await page.waitForTimeout(300)
      const mode1 = await page.evaluate(() => document.documentElement.dataset.mode)
      ok('THEME: choosing dark flips html[data-mode] right away', mode0 !== 'dark' && mode1 === 'dark', { mode0, mode1 })

      // Dock 替身先装好再关向导:主页的「放不下就收」只量一次
      const dockTop = await installChrome(page)
      await finishToHome(page)
      ok('finish closes the wizard', await wizardGone(page))
      const k = await keys(page)
      ok('keys written: done 1, version set, rev 1, suggest 1, step removed', k.done === '1' && !!k.version && k.rev === '1' && k.suggest === '1' && k.step === null, k)
      await lib.stage.space(page, 'home').catch(() => {})
      await page.waitForSelector('.hp-suggest', { timeout: 8000 }).catch(() => {})
      const g = await homeGeometry(page, dockTop)
      ok('HOME: 4 suggestions', g.chips === 4, { chips: g.chipText, gate: g.gate })
      ok('HOME: suggestion block sits above the cards', !!g.suggest && g.cardsTop !== null && g.suggest.bottom <= g.cardsTop + 0.5, { suggest: g.suggest, cardsTop: g.cardsTop })
      ok('HOME: pill below the last card and above the dock', !!g.pill && g.pill.top >= g.lastCardBottom - 0.5 && g.pill.bottom <= dockTop, { pill: g.pill, lastCardBottom: g.lastCardBottom, dockTop })
      await shot(page, 'HOME-suggest')
      if (!g.chips) console.log('  diag replica:', JSON.stringify(await suggestReplica(page, 'DIAG-replica-after-wizard-411x914')))
      ok('no uncaught page errors', page.__net.errors.length === 0, page.__net.errors.slice(0, 5))
      void fWhere
    } finally { await ctx.close() }
  },

  // 2:点建议 = 只填不发;有自己的字先问;发出第一条后收起。
  // 种「走完了完整手机引导」的记号进主页。411x914 上产品若把建议块收掉(放不下),换 411x1000 再跑这段,并照实记下。
  async s2() {
    let o = null
    for (const vp of [PHONE, { width: 411, height: 1000 }]) {
      const t = await openPage({ seed: { ...OLD_DONE, [KEYS.suggest]: '1' }, viewport: vp })
      await t.page.waitForSelector('.mb-shell', { timeout: 180_000 }); await t.page.waitForTimeout(1200)
      t.dockTop = await installChrome(t.page)
      await lib.stage.space(t.page, 'home').catch(() => {})
      // 替身原生栏是挂上之后才到的:主页的「放不下就收」在那之前量过一次,换个 Space 再回来不一定重量 —— 刷新不行(替身随页面没了),只能等
      await t.page.waitForTimeout(1200)
      const g = await homeGeometry(t.page, t.dockTop)
      if (g.chips === 4) {
        o = t; o.vp = vp; ok(`all four suggestions visible at ${vp.width}x${vp.height}`, true, { fit: g.fit })
        ok(`real block at ${vp.width}x${vp.height}: above the cards, pill below the last card and above the dock`, !!g.suggest && g.suggest.bottom <= g.cardsTop + 0.5 && g.pill.top >= g.lastCardBottom - 0.5 && g.pill.bottom <= t.dockTop, { suggest: g.suggest, cardsTop: g.cardsTop, pill: g.pill, dockTop: t.dockTop })
        await shot(t.page, `HOME-suggest-real-${vp.width}x${vp.height}`)
        break
      }
      ok(`all four suggestions visible at ${vp.width}x${vp.height}`, false, { fit: g.fit, chips: g.chips, gate: g.gate })
      await t.ctx.close()
    }
    if (!o) { notRun('tap fills / type-over / send clears', 'the product never showed the suggestion block (411x914 and 411x1000)'); return }
    const { ctx, page } = o
    try {
      const writes0 = page.__net.writes.length
      await tap(page, '.hp-suggest-chip[data-suggest="today"]')
      await page.waitForTimeout(400)
      const filled = await page.evaluate(() => { const ta = document.querySelector('.hp-composer .t2c-ta'); return { focused: !!document.querySelector('.hp-root.hp-composer-focused'), value: ta?.value ?? null, active: document.activeElement === ta } })
      ok('tap a suggestion → composer opens with exactly that text, focused', filled.focused && filled.value === '理一理今天要做的事' && filled.active, filled)
      ok('tap a suggestion → no write request (nothing sent)', page.__net.writes.length === writes0, page.__net.writes.slice(writes0))
      await shot(page, 'HOME-suggest-filled')

      // 用户自己的字:清空、打字,然后收起输入区
      const ta = page.locator('.hp-composer .t2c-ta')
      await ta.fill('')
      await ta.type('我自己写的一句话')
      // 收起输入区 = 在输入区外面按一下(主页根上的 pointerdown,HomepageView)
      const collapse = async () => {
        await page.locator('.hp-greet').first().tap()
        await page.waitForTimeout(400)
        return page.evaluate(() => !document.querySelector('.hp-root.hp-composer-focused'))
      }
      const collapsed = await collapse()
      ok('composer collapses (tap outside) so the block comes back', collapsed && await page.evaluate(() => !!document.querySelector('.hp-suggest')))
      if (collapsed) {
        let dialogs = []
        const dismissOnce = (d) => { dialogs.push(d.message()); return d.dismiss() }
        page.once('dialog', dismissOnce)
        await tap(page, '.hp-suggest-chip[data-suggest="remind"]')
        await page.waitForTimeout(600)
        const kept = await page.evaluate(() => document.querySelector('.hp-composer .t2c-ta')?.value ?? null)
        ok('type-over: a confirm is asked before replacing the user\'s text', dialogs.length === 1, dialogs)
        ok('type-over: dismiss keeps the user\'s text', kept === '我自己写的一句话', kept)
        await collapse()
        page.once('dialog', (d) => { dialogs.push(d.message()); return d.accept() })
        await tap(page, '.hp-suggest-chip[data-suggest="remind"]')
        await page.waitForTimeout(600)
        const replaced = await page.evaluate(() => document.querySelector('.hp-composer .t2c-ta')?.value ?? null)
        ok('type-over: accept replaces with the suggestion', dialogs.length === 2 && replaced === '明早 8 点提醒我开会', { dialogs, replaced })
      }

      // 发一条(真的按发送;POST 被台架拒掉,但 sendNow 第一行就记了 chat.send)→ 回主页后建议收起、记号清掉
      if (!(await page.evaluate(() => !!document.querySelector('.hp-root.hp-composer-focused')))) await tap(page, '.hp-pill')
      const sendBtn = page.locator('.hp-composer button.t2c-send, .hp-composer [data-act="send"], .hp-composer button[aria-label="发送"]').first()
      const hasSend = await sendBtn.count()
      if (hasSend) await sendBtn.tap(); else await page.locator('.hp-composer .t2c-ta').press('Enter')
      await page.waitForTimeout(1500)
      if ((await lib.stage.nav(page).catch(() => '')) === 'detail') await lib.stage.action(page, 'left').catch(() => {})
      await lib.stage.space(page, 'home').catch(() => {})
      await page.waitForTimeout(800)
      const after = await page.evaluate((k) => ({ block: !!document.querySelector('.hp-suggest'), key: localStorage.getItem(k) }), KEYS.suggest)
      ok(`after a real send (${hasSend ? 'send button' : 'Enter'}) the block is gone and the suggest key removed`, !after.block && after.key === null, { ...after, writes: page.__net.writes.slice(writes0) })
      await shot(page, 'HOME-after-send')
      ok('no uncaught page errors', page.__net.errors.length === 0, page.__net.errors.slice(0, 5))
    } finally { await ctx.close() }
    // 英文的四条(两行的建议)在同一高度上长什么样
    cur = 's2-en'
    const vp = o.vp
    const e = await openPage({ seed: { ...OLD_DONE, [KEYS.suggest]: '1' }, viewport: vp, locale: 'en-US' })
    try {
      await e.page.waitForSelector('.mb-shell', { timeout: 180_000 }); await e.page.waitForTimeout(1200)
      const dockTop = await installChrome(e.page)
      await lib.stage.space(e.page, 'home').catch(() => {}); await e.page.waitForTimeout(1200)
      const g = await homeGeometry(e.page, dockTop)
      ok(`English block at ${vp.width}x${vp.height}: 4 English chips`, g.chips === 4 && g.chipText.every((x) => !/[\u4e00-\u9fff]/.test(x)), { chips: g.chipText, gate: g.gate })
      ok(`English block at ${vp.width}x${vp.height}: pill above the dock`, !!g.pill && g.pill.bottom <= dockTop, { pill: g.pill, dockTop })
      await shot(e.page, `HOME-suggest-real-${vp.width}x${vp.height}-en`)
    } finally { await e.ctx.close() }
  },

  // 3:空名册 → 只有外观一屏,没有进度点、没有跳过
  async s3() {
    const { ctx, page } = await openPage({ seed: FRESH, units: 'empty' })
    try {
      const first = await waitWizard(page)
      const s = await page.evaluate(() => ({ dots: document.querySelectorAll('.ob3 .ob3-dots button').length, skip: !!document.querySelector('.ob3 .ob-skip'), where: !!document.querySelector('.ob3 [data-run-row]') }))
      ok('empty roster: no where screen, the only step is theme', first === 'theme' && !s.where, { first, ...s })
      ok('empty roster: single screen, no dots, no skip', s.dots === 0 && !s.skip, s)
      await shot(page, 'THEME-only')
    } finally { await ctx.close() }
  },

  // 4:名册 500 / 永远不答
  async s4() {
    for (const mode of ['500', 'hang']) {
      cur = `s4-${mode}`
      const { ctx, page } = await openPage({ seed: FRESH, units: mode })
      try {
        await page.waitForSelector('.ob3', { timeout: 180_000 })
        const first = await waitWizard(page)
        const tl = await page.evaluate(() => window.__steps)
        const p0 = tl.find((s) => s.step === 'pending'), p1 = tl.find((s) => s.step && s.step !== 'pending')
        const waited = p0 && p1 ? Math.round(p1.t - p0.t) : null
        ok('wizard shows a real step within ~3 s of the pending shell', waited !== null && waited <= 3200, { waited, tl })
        const s = await page.evaluate(() => ({
          home: document.querySelector('.ob3 [data-run-row="home"]')?.getAttribute('aria-checked'),
          line: document.querySelector('.ob3 [data-roster-unknown]')?.textContent.trim() ?? null,
          retry: !!document.querySelector('.ob3 [data-roster-unknown] button'),
          computers: document.querySelectorAll('.ob3 [data-run-row]:not([data-run-row="home"])').length,
        }))
        ok('WHERE shown (never treated as "no computers")', first === 'where', first)
        ok('WHERE: cloud selected + "没读到你的电脑" with "重试"', s.home === 'true' && !!s.line && s.line.includes('没读到你的电脑') && s.line.includes('重试') && s.retry, s)
        if (mode === '500') await shot(page, 'WHERE-unknown')
        else await shot(page, 'WHERE-unknown-hang')
        page.__net.units = 'ok'
        // 重试按钮在转圈时是禁的(hang:prepare 那次还挂着,最多转 8 秒)
        await page.waitForFunction(() => { const b = document.querySelector('.ob3 [data-roster-unknown] button'); return b && !b.disabled }, null, { timeout: 12_000 }).catch(() => {})
        const gets0 = page.__net.unitsGets
        const tapAt = Date.now()
        await tap(page, '.ob3 [data-roster-unknown] button')
        await page.waitForFunction(() => !!document.querySelector('.ob3 [data-run-row]:not([data-run-row="home"])'), null, { timeout: 10_000 }).catch(() => {})
        const r = await page.evaluate(() => ({ mac: !!document.querySelector('.ob3 [data-run-row]:not([data-run-row="home"])'), line: !!document.querySelector('.ob3 [data-roster-unknown]') }))
        ok('retry after the route recovers: computer card appears and the line goes away', r.mac && !r.line, { ...r, unitsGetsBefore: gets0, unitsGetsAfter: page.__net.unitsGets })
        const after = (page.__net.unitsAt || []).filter((t) => t >= tapAt).map((t) => t - tapAt)
        ok('the retry tap itself issued a new GET /units (within 2 s of the tap)', after.some((d) => d <= 2000), { getsBeforeTap: gets0, msAfterTap: after })
        if (!r.mac) await shot(page, `WHERE-retry-${mode}-fail`)
      } finally { for (const h of page.__net.hung) h.abort().catch(() => {}); await ctx.close() }
    }
  },

  // 5:在外观那屏刷新 → 回到外观,第一个点能点
  async s5() {
    const { ctx, page } = await openPage({ seed: FRESH })
    try {
      await waitWizard(page)
      await clickPrimary(page)
      await waitStep(page, 'theme')
      const k = await keys(page)
      ok('step key noted while on theme', k.step === 'theme', k)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const st = await waitWizard(page)
      const dot = await page.evaluate(() => { const b = document.querySelectorAll('.ob3 .ob3-dots button'); return { n: b.length, firstDisabled: b[0]?.disabled ?? null, current: [...b].findIndex((x) => x.getAttribute('aria-current') === 'step') } })
      ok('resume: comes back on theme', st === 'theme', st)
      ok('resume: first dot clickable', dot.n === 2 && dot.firstDisabled === false && dot.current === 1, dot)
      if (dot.firstDisabled === false) {
        await tap(page, '.ob3 .ob3-dots button:first-child')
        await page.waitForTimeout(700)
        ok('resume: tapping the first dot goes to where', (await stepOf(page)) === 'where', await stepOf(page))
      }
    } finally { await ctx.close() }
  },

  // 6:系统返回键
  async s6() {
    let s = null
    for (let i = 1; i <= 8 && !s; i++) {
      const o = await openPage({ seed: FRESH })
      try { await waitWizard(o.page) } catch (e) { await o.ctx.close(); throw e }
      if (await back(o.page, true)) s = o
      else { console.log(`  (load ${i}: back did not reach MobileRoot — Capacitor web plugin race, new session)`); await o.ctx.close() }
    }
    if (!s) { notRun('back on step 1 / step 2', 'back never reached MobileRoot in 8 loads (Capacitor web plugin race)'); return }
    const { ctx, page } = s
    try {
      ok('step 1: back delivered', await back(page))
      ok('step 1: back → wizard still open on where', (await stepOf(page)) === 'where', await stepOf(page))
      await clickPrimary(page)
      await waitStep(page, 'theme')
      const delivered = await back(page)
      await page.waitForTimeout(600)
      ok('step 2: back delivered', delivered)
      ok('step 2: back → step 1 (where)', (await stepOf(page)) === 'where', await stepOf(page))
      ok('wizard never closed by back', !(await wizardGone(page)))
    } finally { await ctx.close() }
  },

  // 7:老用户在台架里
  async s7() {
    for (const [name, seed] of [['done + version', { [KEYS.done]: '1', [KEYS.version]: '2.13.8' }], ['done only', { [KEYS.done]: '1' }]]) {
      const { ctx, page } = await openPage({ seed })
      try {
        await page.waitForSelector('.mb-shell', { timeout: 180_000 })
        await page.waitForTimeout(4500)
        ok(`existing user (${name}): no wizard`, await wizardGone(page), await page.evaluate(() => window.__steps))
      } finally { await ctx.close() }
    }
  },

  // 8:台架,假能力,新账号:「想让它做哪些事」
  async s8() {
    const { ctx, page } = await openPage({ path: 'settings-harness.html?pg=wizard&user=fresh&step=perms' })
    try {
      const st = await waitWizard(page)
      ok('harness fresh resumes on perms', st === 'perms', st)
      await page.waitForFunction(() => document.querySelector('.ob3 [data-ob-primary]')?.textContent.trim() === '跳过', null, { timeout: 5000 }).catch(() => {})
      ok('PERMS all off → primary "跳过"', (await primaryText(page)) === '跳过', await primaryText(page))
      const sw = await page.evaluate(() => [...document.querySelectorAll('.ob3 [data-cap]')].map((r) => ({ cap: r.getAttribute('data-cap'), checked: r.querySelector('[role="switch"]')?.getAttribute('aria-checked') })))
      ok('PERMS: three rows notify, control, voice, all off', JSON.stringify(sw.map((x) => x.cap)) === '["notify","control","voice"]' && sw.every((x) => x.checked === 'false'), sw)
      await shot(page, 'PERMS-none')
      await checkOverflow(page, 'PERMS zh')
      await tap(page, '.ob3 [data-cap="notify"] [role="switch"]')
      ok('tick one → "开启 1 项"', (await primaryText(page)) === '开启 1 项', await primaryText(page))
      await shot(page, 'PERMS-one')
      await tap(page, '.ob3 [data-cap="control"] [role="switch"]')
      await tap(page, '.ob3 [data-cap="voice"] [role="switch"]')
      ok('tick all three → "开启 3 项"', (await primaryText(page)) === '开启 3 项', await primaryText(page))
      ok('ticking calls nothing', (await page.evaluate(() => window.__pg.log)).length === 0, await page.evaluate(() => window.__pg.log))
      await clickPrimary(page)
      await page.waitForSelector('[data-harness-finished]', { timeout: 8000 }).catch(() => {})
      const pg = await page.evaluate(() => window.__pg)
      ok('asks in order notify, control, voice', JSON.stringify(pg.log) === '["ask:notify","ask:control","ask:voice"]', pg.log)
      ok('all granted → wizard finishes (onFinish called once)', pg.finished === 1 && await page.evaluate(() => !!document.querySelector('[data-harness-finished]')), pg)
      const k = await keys(page)
      ok('full run finish writes rev 1 + suggest 1, clears step', k.rev === '1' && k.suggest === '1' && k.step === null, k)
    } finally { await ctx.close() }
  },

  // 9:有一项被拒;已开的点不动
  async s9() {
    const { ctx, page } = await openPage({ path: 'settings-harness.html?pg=wizard&user=fresh&step=perms&notify=off,on&control=off,off&voice=on' })
    try {
      await waitWizard(page)
      await page.waitForTimeout(400)
      const v = await page.evaluate(() => { const s = document.querySelector('.ob3 [data-cap="voice"] [role="switch"]'); return { checked: s?.getAttribute('aria-checked'), disabled: s?.disabled ?? s?.getAttribute('aria-disabled') } })
      ok('already-on capability renders on and disabled', v.checked === 'true' && (v.disabled === true || v.disabled === 'true'), v)
      await page.locator('.ob3 [data-cap="voice"] [role="switch"]').tap({ force: true }).catch(() => {})
      await page.waitForTimeout(300)
      const v2 = await page.evaluate(() => document.querySelector('.ob3 [data-cap="voice"] [role="switch"]')?.getAttribute('aria-checked'))
      ok('already-on capability cannot be toggled', v2 === 'true', v2)
      ok('with nothing ticked (one already on) primary is not "跳过"', (await primaryText(page)) !== '跳过', await primaryText(page))
      await tap(page, '.ob3 [data-cap="notify"] [role="switch"]')
      await tap(page, '.ob3 [data-cap="control"] [role="switch"]')
      ok('tick two → "开启 2 项"', (await primaryText(page)) === '开启 2 项', await primaryText(page))
      await clickPrimary(page)
      await page.waitForFunction(() => !!document.querySelector('.ob3 .ob3-perms-result'), null, { timeout: 8000 }).catch(() => {})
      const r = await page.evaluate(() => ({
        step: document.querySelector('.ob3')?.getAttribute('data-step'),
        result: document.querySelector('.ob3 .ob3-perms-result')?.textContent.trim() ?? null,
        control: document.querySelector('.ob3 [data-cap="control"] [role="switch"]')?.getAttribute('aria-checked'),
        notify: document.querySelector('.ob3 [data-cap="notify"] [role="switch"]')?.getAttribute('aria-checked'),
        log: window.__pg.log, finished: window.__pg.finished,
      }))
      ok('refusal: stays on the screen', r.step === 'perms' && r.finished === 0, r)
      ok('refusal: refused switch back to off, granted one on', r.control === 'false' && r.notify === 'true', r)
      ok('refusal: result line exact copy (已开 2 项，还有 1 项没开，可在 设置 里补开)', r.result === '已开 2 项，还有 1 项没开，可在 设置 里补开', r.result)
      ok('refusal: only the ticked ones were asked (notify, control)', JSON.stringify(r.log) === '["ask:notify","ask:control"]', r.log)
      ok('refusal: primary back to the shell default (开始使用)', (await primaryText(page)) === '开始使用', await primaryText(page))
      await shot(page, 'PERMS-result')
    } finally { await ctx.close() }
  },

  // 10:老用户补看
  async s10() {
    const { ctx, page } = await openPage({ path: 'settings-harness.html?pg=wizard&user=existing' })
    try {
      const st = await waitWizard(page)
      await page.waitForTimeout(300)
      const s = await page.evaluate(() => ({ dots: document.querySelectorAll('.ob3 .ob3-dots button').length, skip: !!document.querySelector('.ob3 .ob-skip'), phone: document.querySelector('.ob3')?.getAttribute('data-phone'), plan: window.__pg.plan }))
      ok('existing user: single perms screen, no dots, no skip', st === 'perms' && s.dots === 0 && !s.skip && s.phone === 'update', { st, ...s })
      await shot(page, 'PERMS-update')
      await clickPrimary(page)
      await page.waitForSelector('[data-harness-finished]', { timeout: 6000 }).catch(() => {})
      const k = await keys(page)
      ok('update finish writes rev 1 and NOT the suggest key', k.rev === '1' && k.suggest === null, k)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-harness-nowizard], .ob3', { timeout: 30_000, state: 'attached' })
      await page.waitForTimeout(800)
      ok('reload → no wizard (harness mirrors appStore with phoneGuidePlan; not the real appStore branch)', await page.evaluate(() => !!document.querySelector('[data-harness-nowizard]') && !document.querySelector('.ob3')), await page.evaluate(() => window.__pg.plan))
    } finally { await ctx.close() }
  },

  // 11:设置 › 设备权限
  async s11() {
    const { ctx, page } = await openPage({ path: 'settings-harness.html?pg=panel&notify=off,on&voice=blocked' })
    try {
      await page.waitForSelector('[data-harness-panel] .settings-panel', { timeout: 60_000 })
      await page.waitForTimeout(800)
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-harness-panel] .settings-panel > *')].map((r) => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)))
      ok('panel lists three rows', rows.length === 3, rows)
      const notifyRow = page.locator('[data-harness-panel] .settings-panel > *').filter({ hasText: '提醒我' })
      const sw0 = await notifyRow.locator('[role="switch"]').getAttribute('aria-checked').catch(() => null)
      await notifyRow.locator('[role="switch"]').tap()
      await page.waitForTimeout(600)
      const sw1 = await notifyRow.locator('[role="switch"]').getAttribute('aria-checked').catch(() => null)
      ok('off row: tap asks then shows on', sw0 === 'false' && sw1 === 'true' && (await page.evaluate(() => window.__pg.log)).includes('ask:notify'), { sw0, sw1, log: await page.evaluate(() => window.__pg.log) })
      const open = page.locator('[data-harness-panel] [data-cap-open="voice"]')
      ok('blocked row shows "去系统设置"', (await open.count()) === 1 && (await open.textContent()).trim() === '去系统设置', await open.count())
      await shot(page, 'SETTINGS-panel')
      if (await open.count()) { await open.tap(); await page.waitForTimeout(400) }
      ok('"去系统设置" calls openSettings', (await page.evaluate(() => window.__pg.log)).includes('openSettings:voice'), await page.evaluate(() => window.__pg.log))
    } finally { await ctx.close() }
  },

  // 12:登录前那屏
  async s12() {
    for (const [name, q, dark] of [['WELCOME-zh-light', '', false], ['WELCOME-zh-dark', '', true], ['WELCOME-returning', '&returning=1', false]]) {
      const { ctx, page } = await openPage({ path: `settings-harness.html?pg=welcome${q}${dark ? '&dark' : ''}`, dark })
      try {
        await page.waitForSelector('.ob3[data-step="signin"] [data-ob-primary]', { timeout: 60_000 })
        await page.waitForTimeout(900)
        const s = await page.evaluate(() => ({ mode: document.documentElement.dataset.mode, h1: document.querySelector('.ob3 h1')?.textContent.trim(), card: !!document.querySelector('.ob3-signin-todo'), rows: document.querySelectorAll('.ob3-signin-todo .ob3-muse-h').length, primary: document.querySelector('[data-ob-primary]')?.textContent.trim(), disabled: document.querySelector('[data-ob-primary]')?.disabled }))
        ok(`${name}: html data-mode ${dark ? 'dark' : 'light'}`, s.mode === (dark ? 'dark' : 'light'), s)
        if (q) ok(`${name}: compact (no card), title + 登录, starts locked`, !s.card && s.h1 === '登录 Forsion，接着用' && s.primary === '登录' && s.disabled === true, s)
        else ok(`${name}: title, card with 3 rows, "登录并开始"`, s.card && s.rows === 3 && s.h1 === '你好，这里是 Forsion' && s.primary === '登录并开始', s)
        await shot(page, name)
        if (!q && !dark) {
          await checkOverflow(page, 'WELCOME zh')
          await page.locator('[data-ob-primary]').dblclick()
          await page.waitForTimeout(500)
          ok('double tap → onSignIn once', (await page.evaluate(() => window.__pg.signIn)) === 1, await page.evaluate(() => window.__pg.signIn))
          await page.waitForFunction(() => !document.querySelector('[data-ob-primary]').disabled, null, { timeout: 6000 }).catch(() => {})
          await page.locator('[data-ob-primary]').tap()
          await page.waitForTimeout(400)
          ok('re-arms (≤4 s) → second tap calls onSignIn again', (await page.evaluate(() => window.__pg.signIn)) === 2, await page.evaluate(() => window.__pg.signIn))
        }
      } finally { await ctx.close() }
    }
  },

  // 13:深色 / 换配色 / 英文
  async s13() {
    // 深色 WHERE + 苔绿 WHERE(整个 app)
    {
      cur = 's13-where-dark'
      const { ctx, page } = await openPage({ seed: FRESH, dark: true })
      try {
        await waitWizard(page)
        ok('WHERE dark: html data-mode dark', (await page.evaluate(() => document.documentElement.dataset.mode)) === 'dark')
        await shot(page, 'WHERE-dark')
        const sk = await applySkin(page, 'sage')
        ok('WHERE sage: accent changed through applyTheme', sk.accent !== sk.before && sk.skin === 'sage', sk)
        await shot(page, 'WHERE-dark-sage')
      } finally { await ctx.close() }
    }
    {
      cur = 's13-where-sage'
      const { ctx, page } = await openPage({ seed: FRESH })
      try {
        await waitWizard(page)
        const sk = await applySkin(page, 'sage')
        ok('WHERE sage (light): accent changed', sk.accent !== sk.before, sk)
        await shot(page, 'WHERE-sage')
      } finally { await ctx.close() }
    }
    for (const [name, q, dark] of [['PERMS-dark', '&dark', true], ['PERMS-sage', '&skin=sage', false]]) {
      cur = `s13-${name}`
      const { ctx, page } = await openPage({ path: `settings-harness.html?pg=wizard&user=fresh&step=perms${q}&notify=off&control=on`, dark })
      try {
        await waitWizard(page)
        await tap(page, '.ob3 [data-cap="notify"] [role="switch"]')
        const m = await page.evaluate(() => ({ mode: document.documentElement.dataset.mode, skin: document.documentElement.dataset.skin }))
        ok(`${name}: theme applied`, dark ? m.mode === 'dark' : m.skin === 'sage', m)
        await shot(page, name)
      } finally { await ctx.close() }
    }
    // 英文:整个 app 的 WHERE / THEME / HOME-suggest
    {
      cur = 's13-en-app'
      const { ctx, page } = await openPage({ seed: FRESH, locale: 'en-US' })
      try {
        await waitWizard(page)
        const h = await page.evaluate(() => ({ h1: document.querySelector('.ob3 h1')?.textContent.trim(), skip: document.querySelector('.ob3 .ob-skip')?.textContent.trim(), em: document.querySelector('.ob3 [data-run-row]:not([data-run-row="home"]) .pg-where-em')?.textContent.replace(/\s+/g, ' ').trim() }))
        ok('WHERE en: English copy', h.h1 === 'Where should it run?' && !/[一-鿿]/.test(await page.evaluate(() => document.querySelector('.ob3')?.innerText || '')), h)
        await shot(page, 'WHERE-en')
        await checkOverflow(page, 'WHERE en')
        await clickPrimary(page)
        await waitStep(page, 'theme')
        ok('THEME en: no Han characters', !/[一-鿿]/.test(await page.evaluate(() => document.querySelector('.ob3')?.innerText || '')), await page.evaluate(() => (document.querySelector('.ob3')?.innerText || '').match(/[一-鿿]+/g)))
        await shot(page, 'THEME-en')
        await checkOverflow(page, 'THEME en')
        const dockTop = await installChrome(page)
        await finishToHome(page)
        await lib.stage.space(page, 'home').catch(() => {})
        await page.waitForSelector('.hp-suggest', { timeout: 8000 }).catch(() => {})
        const g = await homeGeometry(page, dockTop)
        ok('HOME-suggest en: 4 English chips', g.chips === 4 && g.chipText.every((t) => !/[一-鿿]/.test(t)), g.chipText)
        ok('HOME-suggest en: pill above the dock', !!g.pill && g.pill.bottom <= dockTop, { pill: g.pill, dockTop, suggest: g.suggest })
        await shot(page, 'HOME-suggest-en')
      } finally { await ctx.close() }
    }
    for (const [name, p] of [['PERMS-en', 'settings-harness.html?pg=wizard&user=fresh&step=perms'], ['WELCOME-en', 'settings-harness.html?pg=welcome']]) {
      cur = `s13-${name}`
      const { ctx, page } = await openPage({ path: p, locale: 'en-US' })
      try {
        await page.waitForSelector('.ob3 [data-ob-primary]', { timeout: 60_000 })
        await page.waitForTimeout(900)
        const txt = await page.evaluate(() => document.querySelector('.ob3')?.innerText || '')
        ok(`${name}: no Han characters`, !/[一-鿿]/.test(txt), txt.match(/[一-鿿]+/g))
        await shot(page, name)
        await checkOverflow(page, name)
      } finally { await ctx.close() }
    }
  },

  // 14:平板横屏
  async s14() {
    const TAB = { width: 1280, height: 800 }
    const measure = (page) => page.evaluate(() => {
      const col = document.querySelector('.ob3 .ob3-main .ob3-col')?.getBoundingClientRect()
      const foot = document.querySelector('.ob3 .ob3-foot-in')?.getBoundingClientRect()
      const cards = [...document.querySelectorAll('.ob3 .ob3-main .ob3-card')].map((c) => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width) } })
      return { col: col && { l: Math.round(col.left), w: Math.round(col.width) }, foot: foot && { l: Math.round(foot.left), w: Math.round(foot.width) }, cards }
    })
    {
      cur = 's14-where'
      const { ctx, page } = await openPage({ seed: FRESH, viewport: TAB })
      try {
        await waitWizard(page)
        const m = await measure(page)
        const oneCol = m.cards.length > 0 && m.cards.every((c) => c.l === m.cards[0].l)
        ok('WHERE tablet: one column ≤ 600, footer the same width', !!m.col && m.col.w <= 600 && oneCol && !!m.foot && Math.abs(m.foot.w - m.col.w) <= 2 && Math.abs(m.foot.l - m.col.l) <= 2, m)
        await shot(page, 'WHERE-tablet')
      } finally { await ctx.close() }
    }
    {
      cur = 's14-perms'
      const { ctx, page } = await openPage({ path: 'settings-harness.html?pg=wizard&user=fresh&step=perms', viewport: TAB })
      try {
        await waitWizard(page)
        const m = await measure(page)
        ok('PERMS tablet: one column ≤ 600, footer the same width', !!m.col && m.col.w <= 600 && !!m.foot && Math.abs(m.foot.w - m.col.w) <= 2 && Math.abs(m.foot.l - m.col.l) <= 2, m)
        await shot(page, 'PERMS-tablet')
      } finally { await ctx.close() }
    }
  },

  // 15:主页建议在各种屏高上怎么摆 —— 放不下时逐级让(四条 + 全部卡片 → 四条 + 两行卡片 → 两条 + 两行卡片 → 不出),每次从头判。
  async s15() {
    const home = async (opts) => {
      const t = await openPage(opts)
      await t.page.waitForSelector('.mb-shell', { timeout: 180_000 }); await t.page.waitForTimeout(1200)
      t.dockTop = await installChrome(t.page)
      await lib.stage.space(t.page, 'home').catch(() => {}); await t.page.waitForTimeout(1200)
      return t
    }
    const MARK = { ...OLD_DONE, [KEYS.suggest]: '1' }
    // 缺省五张卡片是哪几张;再从架子上另找一个 Space 凑成六张(三整行)
    let five = [], six = null
    {
      cur = 's15-baseline'
      const t = await home({ seed: OLD_DONE, viewport: { width: 360, height: 800 } })
      try {
        const g = await homeGeometry(t.page, t.dockTop)
        five = g.cardIds
        ok('no marker: no fit attribute, every card drawn (same as before this change)', g.fit === null && g.suggest === null && g.cards === g.cardsDom && g.cards > 0, { fit: g.fit, cards: g.cards, cardsDom: g.cardsDom, ids: g.cardIds })
        const extra = await t.page.evaluate((have) => (window.__stage?.state?.spaces || []).map((sp) => `space:${sp.id}`).find((id) => !have.includes(id) && id !== 'space:home') ?? null, five)
        if (extra && five.length === 5) six = [...five, extra]
      } finally { await t.ctx.close() }
    }
    if (!six) notRun('six-card cases', `could not build a six-card set (default cards: ${JSON.stringify(five)})`)

    // 常见手机 + 一台横放的平板:建议块必须出现(至少两条),输入条在最后一张画出来的卡下面、Dock 上面
    const SIZES = [{ width: 360, height: 780 }, { width: 360, height: 800 }, { width: 393, height: 851 }, { width: 412, height: 915 }, { width: 1280, height: 768 }]
    for (const vp of SIZES) for (const locale of ['zh-CN', 'en-US']) for (const set of six ? [null, six] : [null]) {
      const n = set ? 6 : 5
      cur = `s15-${vp.width}x${vp.height}-${locale.slice(0, 2)}-${n}`
      const t = await home({ seed: { ...MARK, ...(set ? { forsion_home_cards_v1: JSON.stringify(set) } : {}) }, viewport: vp, locale })
      try {
        const g = await homeGeometry(t.page, t.dockTop)
        ok(`${n} cards in the list`, g.cardsDom === n, { cardsDom: g.cardsDom, ids: g.cardIds })
        ok('suggestion block is shown with at least two suggestions', !!g.suggest && g.chips >= 2 && ['all', 'rows', 'two'].includes(g.fit), { fit: g.fit, chips: g.chips, suggest: g.suggest, gate: g.gate })
        ok('fit level matches what is drawn', (g.fit === 'all' && g.chips === 4 && g.cards === n) || (g.fit === 'rows' && g.chips === 4 && g.cards === Math.min(n, 4)) || (g.fit === 'two' && g.chips === 2 && g.cards === Math.min(n, 4)), { fit: g.fit, chips: g.chips, cards: g.cards })
        ok('block above the cards, pill below the last drawn card and above the dock', !!g.suggest && !!g.pill && g.suggest.bottom <= g.cardsTop + 0.5 && g.pill.top >= g.lastCardBottom - 0.5 && g.pill.bottom <= t.dockTop + 0.5, { suggest: g.suggest, cardsTop: g.cardsTop, lastCardBottom: g.lastCardBottom, pill: g.pill, dockTop: t.dockTop })
        console.log(`  fit ${vp.width}x${vp.height} ${locale} ${n} cards → ${g.fit}, chips ${g.chips}, cards drawn ${g.cards}`)
        await shot(t.page, `HOME-fit-${vp.width}x${vp.height}-${locale.slice(0, 2)}-${n}`)
      } finally { await t.ctx.close() }
    }

    // 变矮再变回来:档位跟着降、再跟着回(不是只收不放)
    {
      cur = 's15-recover'
      const big = { width: 412, height: 915 }
      const t = await home({ seed: MARK, viewport: big })
      try {
        const a = await homeGeometry(t.page, t.dockTop)
        await t.page.setViewportSize({ width: 412, height: 700 }); await t.page.waitForTimeout(500)
        const b = await homeGeometry(t.page, t.dockTop)
        await t.page.setViewportSize(big); await t.page.waitForTimeout(500)
        const c = await homeGeometry(t.page, t.dockTop)
        const rank = (f) => ['all', 'rows', 'two', 'none'].indexOf(f)
        ok('shorter window steps the fit down', rank(b.fit) > rank(a.fit), { tall: a.fit, short: b.fit })
        ok('back to the tall window brings the same fit back', c.fit === a.fit && c.chips === a.chips && c.cards === a.cards, { before: { fit: a.fit, chips: a.chips, cards: a.cards }, after: { fit: c.fit, chips: c.chips, cards: c.cards } })
      } finally { await t.ctx.close() }
    }

    // 很矮的屏(没有建议时卡片自己就放不下):建议块不出,卡片一张不少,输入条的位置和没有记号时一样 —— 这次改动不添乱
    {
      const vp = { width: 360, height: 640 }
      cur = 's15-360x640'
      const base = await home({ seed: OLD_DONE, viewport: vp })
      let basePill = null
      try {
        const g = await homeGeometry(base.page, base.dockTop)
        basePill = g.pill
        console.log(`  360x640 without the marker: pill bottom ${g.pill?.bottom}, dock top ${base.dockTop} (${g.pill && g.pill.bottom <= base.dockTop ? 'above' : 'BELOW'} the dock; this is the page as it is on main)`)
        await shot(base.page, 'HOME-360x640-control-nokey')
      } finally { await base.ctx.close() }
      const t = await home({ seed: MARK, viewport: vp })
      try {
        const g = await homeGeometry(t.page, t.dockTop)
        ok('too short for any level: block not drawn, fit none', g.suggest === null && g.fit === 'none', { fit: g.fit, suggest: g.suggest })
        ok('too short: every card still drawn', g.cards === g.cardsDom, { cards: g.cards, cardsDom: g.cardsDom })
        ok('too short: pill exactly where it is without the marker', !!g.pill && !!basePill && Math.abs(g.pill.bottom - basePill.bottom) <= 0.5 && Math.abs(g.pill.top - basePill.top) <= 0.5, { pill: g.pill, basePill })
        await shot(t.page, 'HOME-360x640')
      } finally { await t.ctx.close() }
    }
  },
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  let stopped = false
  const stop = () => { if (!stopped && DEV) { stopped = true; DEV.kill() } }
  process.on('SIGINT', () => { stop(); process.exit(130) })
  process.on('SIGTERM', () => { stop(); process.exit(143) })
  const t0 = Date.now()
  try {
    DEV = await startDev()
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    for (const [name, run] of Object.entries(SCEN)) {
      if (ONLY.length && !ONLY.includes(name)) continue
      cur = name
      const ts = Date.now()
      console.log(`\n── ${name}`)
      try { await run() } catch (e) { ok('scenario ran to the end', false, String(e && e.stack || e).slice(0, 900)) }
      console.log(`   (${Math.round((Date.now() - ts) / 1000)} s)`)
    }
  } catch (e) {
    cur = 'setup'
    ok('setup', false, String(e && e.stack || e))
  } finally {
    await browser?.close().catch(() => {})
    stop()
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const fails = results.filter((r) => r.pass === false)
  const skips = results.filter((r) => r.pass === null)
  console.log(`\n${results.length - fails.length - skips.length} passed, ${fails.length} failed, ${skips.length} not run (${Math.round((Date.now() - t0) / 1000)} s) → ${path.join(OUT, 'results.json')}`)
  for (const f of fails) console.log(`FAIL [${f.scenario}] ${f.check} | ${f.detail.slice(0, 300)}`)
  process.exit(fails.length ? 1 : 0)
}
main()
