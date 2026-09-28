/**
 * 「手机形态页」台架件(P1 · K9):check:remotechain 与 check:streamrenew 共用。
 *
 * 页面 = mobile 的 dev 风味构建(VITE_API_ORIGIN=http://phone-hub.test,带 __forsionStore / __forsionEngineTargets),
 * 由假 hub 出静态页;Playwright 以 HTTP 代理把 http://phone-hub.test 指到假 hub(页面与 API 同源,不占固定端口)。
 * Capacitor 走「安卓 App」分支:window.CapacitorCustomPlatform + PluginHeaders + nativePromise / nativeCallback(@capacitor/core
 * 自带的自定义平台钩子)—— mobileShim 因此装原生中继;ForsionUnit 插件经 exposeBinding 落到 Node 替身(fake-phone-native.cjs)。
 * 其余插件(Preferences / App / Browser / Filesystem)按 Capacitor 的规矩回落各自的 web 实现;LiveIsland / SpaceShortcuts 空实现。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require('playwright-core')
const { GENESIS } = require('./remote-world.cjs')

const MOBILE = path.join(GENESIS, 'mobile')
const PHONE_ORIGIN = 'http://phone-hub.test'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const e = path.join(root, d, rel)
        if (fs.existsSync(e)) return e
      }
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}

/** dir 已有构建(且 forsion-native.json 的 apiBase 对得上)就复用,否则现构建(约 1–2 分钟)。 */
function buildPhoneDist(dir) {
  const native = path.join(dir, 'forsion-native.json')
  if (fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(native)) {
    try { if (JSON.parse(fs.readFileSync(native, 'utf8')).apiBase === `${PHONE_ORIGIN}/api`) return dir } catch { /* 重建 */ }
  }
  console.log(`… 构建 mobile(dev 风味、VITE_API_ORIGIN=${PHONE_ORIGIN})→ ${dir}`)
  const r = spawnSync('npx', ['vite', 'build', '--mode', 'development', '--outDir', dir, '--emptyOutDir'], {
    cwd: MOBILE, env: { ...process.env, NODE_ENV: 'development', VITE_API_ORIGIN: PHONE_ORIGIN }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`mobile 构建失败:\n${String(r.stderr).slice(-1500)}`)
  return dir
}

/** 页面 init script(在任何页面脚本之前跑)。 */
function capacitorInit({ token }) {
  try {
    localStorage.setItem('CapacitorStorage.forsion_token', token) // @capacitor/preferences web 实现的键前缀(group 'CapacitorStorage')
    localStorage.setItem('forsion_tangu_onboarding_done', '1')
    localStorage.setItem('forsion_tangu_onboarding_dismissed', '1')
    localStorage.setItem('tangu-locale', 'zh')
  } catch { /* ignore */ }
  const cbs = new Map()
  let n = 0
  const P = (name) => ({ name, rtype: 'promise' })
  const C = (name) => ({ name, rtype: 'callback' })
  window.CapacitorCustomPlatform = { name: 'android', plugins: {} }
  window.Capacitor = {
    PluginHeaders: [
      { name: 'ForsionUnit', methods: [P('attach'), P('status'), P('ensureRegistered'), P('forget'), C('request'), P('cancel'), C('addListener'), P('removeListener')] },
      { name: 'LiveIsland', methods: [P('show'), P('reset'), C('addListener'), P('removeListener')] },
      { name: 'SpaceShortcuts', methods: [P('setSpaces'), P('pin'), C('addListener'), P('removeListener')] },
    ],
    nativePromise: (plugin, method, options) => window.__k9Native({ plugin, method, options: options ?? {}, cbId: null }),
    nativeCallback: (plugin, method, options, cb) => {
      const id = `k9cb${++n}`
      cbs.set(id, cb)
      window.__k9Native({ plugin, method, options: options ?? {}, cbId: id }).catch((e) => { try { cb(null, e) } catch { /* ignore */ } })
      return id
    },
  }
  window.__k9Deliver = (id, msg, err) => { const cb = cbs.get(id); if (cb) cb(msg, err) }
}

/**
 * 起浏览器、装原生桥、打开手机页、等 connState ok。
 * @returns {{ browser, ctx, page, tap, pageErrors }}
 */
async function openPhonePage({ world, native, locale = 'zh-CN' }) {
  const browser = await chromium.launch({
    executablePath: findChromium(), headless: true,
    proxy: { server: `http://127.0.0.1:${world.hub.port}` },
    args: ['--no-sandbox', `--unsafely-treat-insecure-origin-as-secure=${PHONE_ORIGIN}`],
  })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // 原生桥:页面 → Node 替身。request 的回调按序送回(每条一次 evaluate,SSE 分块逐条到达)
  await page.exposeBinding('__k9Native', async (_src, { plugin, method, options, cbId }) => {
    if (plugin !== 'ForsionUnit') return {}
    if (method === 'request') {
      let chain = Promise.resolve()
      const deliver = (msg) => { chain = chain.then(() => page.evaluate(([id, m]) => window.__k9Deliver(id, m), [cbId, msg]).catch(() => {})) }
      void native.request(options, deliver)
      return cbId
    }
    if (method === 'addListener' || method === 'removeListener') return cbId || {}
    if (typeof native[method] !== 'function') throw new Error(`ForsionUnit.${method} not implemented`)
    return native[method](options)
  })
  await ctx.addInitScript(capacitorInit, { token: world.PHONE_TOKEN })
  await page.goto(`${PHONE_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector('.mb-shell', { timeout: 60_000 })
  await page.waitForFunction(() => window.__forsionStore?.getState().connState === 'ok', null, { timeout: 30_000 })
  const cdp = await ctx.newCDPSession(page)
  const tap = async (locator) => {
    const b = await locator.boundingBox()
    if (!b) throw new Error(`目标不可见: ${locator}`)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
    await sleep(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(350)
  }
  return { browser, ctx, page, tap, pageErrors }
}

/** 左抽屉 → 互联入口 → UnitsSheet;点那台电脑的「在哪运行」行。onAwaiting():确认框弹出、手机显示等确认时调(可截图),返回后台架才让确认框答。 */
async function pickComputer({ page, tap, unitId }) {
  for (let i = 0; i < 6 && !(await page.locator('.mb-drawer--left.open').count()); i++) {
    await tap(page.locator('.mb-topbar [aria-label="left panel"]'))
    await sleep(700)
  }
  const entry = page.locator('.mb-drawer--left.open .mb-foot-row [aria-label="Forsion Unit 切换"], .mb-drawer--left.open .mb-foot-row [aria-label="Switch Forsion Unit"]')
  await tap(entry.first())
  await page.waitForSelector(`[data-units-sheet] [data-run-row="${unitId}"]`, { timeout: 10_000 })
  await tap(page.locator(`[data-run-row="${unitId}"]`))
}

/** 收起弹层与抽屉(推开式抽屉的遮罩会拦住输入区)。 */
async function closeOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.evaluate(() => { const s = document.querySelector('[data-units-sheet]'); if (s) s.click() })
  await sleep(600)
  for (let i = 0; i < 4 && (await page.locator('.mb-push-dim.on').count()); i++) {
    const dim = page.locator('.mb-push-dim.on').first()
    const b = await dim.boundingBox()
    if (b) await dim.click({ position: { x: Math.max(1, b.width - 12), y: b.height / 2 }, force: true }).catch(() => {})
    await sleep(500)
  }
}

/** 等输入框可用后打字回车发出(可选先经「添加 › 文件」挂附件)。 */
async function compose(page, text, attach) {
  const ta = page.locator('.t2c-ta').first()
  await ta.waitFor({ timeout: 20_000 })
  for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await sleep(250)
  if (attach) {
    await page.locator('.add-pill-btn').first().click()
    await sleep(300)
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      page.locator('.composer-menu--add .menu-item').filter({ hasText: /文件|Files/ }).first().click(),
    ])
    await chooser.setFiles(attach)
    await sleep(500)
  }
  await ta.click()
  await ta.fill(text)
}

module.exports = { PHONE_ORIGIN, findChromium, buildPhoneDist, capacitorInit, openPhonePage, pickComputer, closeOverlays, compose }
