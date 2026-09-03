/**
 * UI 模式自动切换实测(index.html 里那段 boot 脚本的仪器)。
 *
 * 病症(2026-08-13 用户实报):在 Chrome DevTools 里切成移动端设备,页面不变成移动端 UI。
 * 真因两条:①`desktop/frontend/index.html` 压根没有自动切换脚本;②`web/index.html` 那份的运行时
 * 分支是坏的 —— 它只挂了 `(pointer:coarse) and (max-width:820px)` 的 mq.change,而 Chrome 打开
 * 触摸模拟时这个 change 实测不派发,于是 `lcl.uiMode` 始终为 null、页面纹丝不动。
 *
 * 手机 UI **不是响应式断点**,是另一套外壳(SingleColumnHost),由 UI_MODE 在模块加载时定格 ——
 * 所以「切视口」必须靠这段脚本写键 + reload 才能生效,纯 CSS 断点做不到。
 *
 * 跑:npm run check:uimode          (需 desktop 的 `npm run web` 起在 5173)
 *    UIMODE_ORIGIN=http://localhost:5273 npm run check:uimode   (切到 tangu-web 验同一份脚本)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of [
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}

const ORIGIN = process.env.UIMODE_ORIGIN || 'http://localhost:5173'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 当前挂的是哪套壳 + 键的状态。 */
const probe = (page) => page.evaluate(() => ({
  shell: document.querySelector('.mb-shell') ? 'mobile' : document.querySelector('.dv-react-part, .rb, .sc-frame') ? 'desktop' : '?',
  key: (() => { try { return localStorage.getItem('lcl.uiMode') } catch { return 'n/a' } })(),
  mark: (() => { try { return localStorage.getItem('lcl.uiMode.auto') } catch { return 'n/a' } })(),
  coarse: matchMedia('(pointer: coarse)').matches,
  w: window.innerWidth,
}))

/** 等壳换过来(自动切换会 location.reload,给足重挂时间);超时就返回当前值让断言去报错。 */
async function settle(page, want, ms = 9000) {
  const t0 = Date.now()
  for (;;) {
    let s = null
    try { s = await probe(page) } catch { /* reload 中途 evaluate 会被打断,重试 */ }
    if (s && s.shell === want) return s
    if (Date.now() - t0 > ms) return s || { shell: '?', key: '?', mark: '?', coarse: false, w: 0 }
    await page.waitForTimeout(250)
  }
}

async function open(browser, { seed, ua } = {}) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, ...(ua ? { userAgent: ua } : {}) })
  await ctx.addInitScript((sd) => {
    try {
      localStorage.setItem('forsion_token', 'uimode-check')
      if (sd) for (const [k, v] of sd) localStorage.setItem(k, v)
    } catch { /* ignore */ }
  }, seed || null)
  const page = await ctx.newPage({ locale: 'zh-CN' })
  await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"c"}' }))
  return { ctx, page }
}

/** 模拟 DevTools「设备工具栏」。先改尺寸再开触摸 —— 这是旧脚本失效的那个顺序,专挑难的验。 */
async function toPhone(ctx, page, { width = 390, height = 844 } = {}) {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  return cdp
}
async function toDesktop(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }) // 关的时候不许传 maxTouchPoints(必须 1..16)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  console.log(`origin = ${ORIGIN}\n`)

  // 1+2+3:干净 storage → 桌面;切设备模拟 → 自动进移动壳;切回来 → 自动回桌面。
  {
    const { ctx, page } = await open(browser)
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const a = await probe(page)
    check('1 干净 storage + 桌面视口 → 桌面壳', a.shell === 'desktop', JSON.stringify(a))

    const cdp = await toPhone(ctx, page)
    const b = await settle(page, 'mobile')
    check('2 ⚠️ DevTools 切成移动设备 → 自动换成移动壳(本次修的就是这条)', b.shell === 'mobile' && b.key === 'mobile' && b.mark === '1', JSON.stringify(b))

    await toDesktop(cdp)
    const c = await settle(page, 'desktop')
    check('3 切回桌面设备 → 自动换回桌面壳(旧脚本只会单向写 mobile,回不来)', c.shell === 'desktop' && c.key === 'desktop', JSON.stringify(c))
    await ctx.close()
  }

  // 4:?ui= 逐窗定死,不被自动判定推翻。
  {
    const { ctx, page } = await open(browser)
    await page.goto(`${ORIGIN}/?ui=mobile`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const a = await probe(page)
    check('4 桌面视口 + ?ui=mobile → 移动壳(手机框预览),且不写键', a.shell === 'mobile' && a.key === null, JSON.stringify(a))
    await ctx.close()
  }

  // 5:用户经命令面板显式选过(有键、无 .auto 标记)→ 一律尊重,不自动跳。
  {
    const { ctx, page } = await open(browser, { seed: [['lcl.uiMode', 'desktop']] })
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    // 注:老版本写的键不带标记,boot 脚本首帧会认领为「自动值」(那时唯一写入者就是自动)。
    // 要模拟「用户显式选过」,得在认领之后把标记摘掉 —— setUiMode 正是这么做的。
    await page.evaluate(() => localStorage.removeItem('lcl.uiMode.auto'))
    const cdp = await toPhone(ctx, page)
    await page.waitForTimeout(3000)
    const b = await probe(page)
    check('5 用户显式选过桌面 → 切设备模拟也不跳(尊重手动选择)', b.shell === 'desktop' && b.key === 'desktop', JSON.stringify(b))
    await toDesktop(cdp)
    await ctx.close()
  }

  // 6:真机横屏(仍是触屏,但宽度超 820)→ 已在移动壳就别踢回桌面。
  {
    const { ctx, page } = await open(browser)
    const cdp = await toPhone(ctx, page)
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
    const a = await settle(page, 'mobile')
    check('6a 触屏窄视口首次加载 → 移动壳', a.shell === 'mobile', JSON.stringify(a))
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 3, mobile: true })
    await page.waitForTimeout(3000)
    const b = await probe(page)
    check('6b ⚠️ 手机横屏(宽 932 但仍触屏)→ 不被踢回桌面壳', b.shell === 'mobile' && b.coarse === true, JSON.stringify(b))
    await ctx.close()
  }

  // 7:Electron 桌面应用不参与(触屏本/平板模式不该把桌面版换成手机壳)。
  {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Forsion/2.7.9 Chrome/130.0.0.0 Electron/32.0.0 Safari/537.36'
    const { ctx, page } = await open(browser, { ua })
    const cdp = await toPhone(ctx, page)
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3500)
    const a = await probe(page)
    check('7 Electron UA + 触屏窄视口 → 不自动切(桌面应用不该变手机壳)', a.shell === 'desktop' && a.key === null, JSON.stringify(a))
    await toDesktop(cdp)
    await ctx.close()
  }

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
