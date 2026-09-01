/**
 * 互联设备入口位置仪器:入口必须住**左抽屉底部常驻行(设置钮左侧)**,且「⋯」菜单里不再出现
 * (mobileFoot 标志的两半:提升 + 滤除,漏一半就是重复入口或幽灵入口)。
 * 背景:入口原在「⋯」菜单,用户实报太隐蔽(2026-08-30);挪家是行为变化,typecheck/boot 都抓不到。
 *
 * 跑法:npm run build && npm run e2e:unitsentry。机制照抄 mobile-boot.e2e.cjs(假 token 过登录闸,
 * /api/** 全 abort —— unitsList 桥存在即可上架,名册拉不到只影响弹层内容不影响入口)。
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

const PORT = 5281 // 与 boot(5279) 错开,免得两台仪器串行残留互踩
const URL = `http://localhost:${PORT}/`

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

/** 入口的可见名(aria-label=label(tooltip)):i18n 两语都认,别只钉一种。 */
const UNIT_LABELS = ['Forsion Unit 切换', 'Switch Forsion Unit']

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => {
    try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } }
  }

  let browser = null
  const fails = []
  const pass = (name, extra) => console.log(`PASS  ${name}${extra ? `  | ${extra}` : ''}`)
  const fail = (name, extra) => { fails.push(name); console.log(`FAIL  ${name}${extra ? `  | ${extra}` : ''}`) }
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800) || '(无 stderr)'}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await ctx.addInitScript(() => { try { localStorage.setItem('forsion_token', 'e2e-units-entry') } catch { /* ignore */ } })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    // ⚠️ body 有 zoom:1.15(移动全局放大),Playwright 的 click 可点性判定在 zoom 下判「视口外」——
    // 套件口径(note-open 同款):CDP 触摸事件直接打 boundingBox 坐标,绕开 actionability。
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

    // ① 开左抽屉 → 底部常驻行必须有入口,且排在设置钮**前面**(=左边;同 flex 行 DOM 序即视觉序)
    await tap(page.locator('.mb-topbar [aria-label="left panel"]'))
    await page.waitForTimeout(600)
    const foot = await page.evaluate((labels) => {
      const row = document.querySelector('.mb-drawer--left.open .mb-foot-row')
      if (!row) return { row: false }
      const btns = [...row.querySelectorAll('.mb-icon-btn')].map((b) => b.getAttribute('aria-label') || '')
      return { row: true, btns, unitIdx: btns.findIndex((l) => labels.includes(l)), settingsIdx: btns.indexOf('settings') }
    }, UNIT_LABELS)
    if (!foot.row) fail('左抽屉底部常驻行在', JSON.stringify(foot))
    else if (foot.unitIdx < 0) fail('互联设备入口在底部行', JSON.stringify(foot.btns))
    else if (foot.settingsIdx >= 0 && foot.unitIdx > foot.settingsIdx) fail('入口在设置钮左边', JSON.stringify(foot.btns))
    else pass('入口住左抽屉底部行,设置钮左边', JSON.stringify(foot.btns))

    // 截图给人眼(观感类改动交付纪律):抽屉开着、底部行入镜
    const shot = path.join(os.tmpdir(), 'forsion-units-entry.png')
    await page.screenshot({ path: shot })
    console.log(`screenshot → ${shot}`)

    // ② 点入口 → 设备弹层打开(名册拉不到也得开壳:/api 全 abort 时显示空态/未登录文案)
    if (foot.unitIdx >= 0) {
      await tap(page.locator(`.mb-foot-row .mb-icon-btn[aria-label="${(foot.btns || [])[foot.unitIdx]}"]`))
      const sheetOn = await page.evaluate((labels) => {
        const strongs = [...document.querySelectorAll('strong')]
        return strongs.some((s) => labels.includes((s.textContent || '').trim()))
      }, UNIT_LABELS)
      if (sheetOn) pass('点入口打开设备弹层')
      else fail('点入口打开设备弹层')
      // 关掉弹层(点遮罩),别让它盖住下一步的顶栏
      await tapBox({ x: 195, y: 60, width: 0, height: 0 })
    }

    // ③ 「⋯」菜单里必须**没有**这一项(mobileFoot 的滤除半边;有 = 重复入口回归)
    await tap(page.locator('.mb-topbar [aria-label="more"]'))
    const inMore = await page.evaluate((labels) => {
      const rows = [...document.querySelectorAll('.mb-sheet .mb-sheet-row')]
      return rows.some((r) => labels.some((l) => (r.textContent || '').includes(l)))
    }, UNIT_LABELS)
    if (inMore) fail('「⋯」菜单已滤掉入口')
    else pass('「⋯」菜单已滤掉入口')
  } catch (e) {
    fails.push(String(e && e.message || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) {
    console.error(`\n✗ e2e:unitsentry ${fails.length} 项失败:\n- ${fails.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\n✅ e2e:unitsentry —— 入口位置 / 弹层开合 / ⋯菜单滤除')
}

main().catch((e) => { console.error(e); process.exit(1) })
