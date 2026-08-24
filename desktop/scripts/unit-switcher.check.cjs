/**
 * Forsion Unit 切换器(Ribbon head)DOM/开合/两态契约(真 Chromium + 真 Ribbon + 真组件,
 * harness.html?ribbon&unit;host 面是 stub —— 真隧道在 server relay.test.ts,真配对/反代在
 * electron/unitWeb.test.ts)。v2 = B 端渲染:设备行动作是「打开对方页面」,不再换本机 cfg。
 *
 * 判据:
 *   1 head 区出现胶囊(折叠钮之后,不进上/下两区的拖拽序)
 *   2 展开态显示当前面(本地/云端,跟 vaultSide);点开列表 = 本地/云端/两台设备/「通过地址连接…」,
 *     离线设备灰显,emoji 图标生效,当前项带勾选
 *   3 LAN 优先自动择路(v2.1):探针通的设备行显「局域网直连」描述,点击打开 lanUrl;
 *     右键菜单三项 —— 改图标/「经云端中转打开」(→ 隧道页 …/proxy/ 尾斜杠)/「在系统浏览器打开」(→ /open 引导页)
 *   4 菜单脚部:开「允许其他设备连接本机」→ 显示本机直连地址 + 已配对设备可回收
 *   5 折叠态只显图标;菜单整体在视口内
 * 顺带产两张真实截图(交付纪律):unit-switcher-expanded.png / unit-switcher-collapsed.png
 *
 * 跑:npm run check:unitswitcher   (5173 没起会自起 vite,跑完自收;CHROMIUM_EXE 可覆盖)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  try {
    const p = chromium.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch { /* fallthrough */ }
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const URL = `${BASE}?ribbon&unit`
const SHOT_DIR = process.env.UNITSW_SHOT_DIR || '/tmp'

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.addInitScript(() => localStorage.clear())
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.rb-head .unitsw-pill', { timeout: 20000 })

    await page.evaluate(() => { window.__rb.setState({ expanded: true }) })
    await page.waitForTimeout(120)

    const inHead = await page.evaluate(() => !!document.querySelector('.rb-head .unitsw-pill'))
    check('胶囊住在 rb-head(不进两区拖拽序)', inHead)

    const label = await page.evaluate(() => document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '')
    check('展开态显示当前面(缺省=本地)', label === '本地', `label=${label}`)

    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    await page.waitForFunction(() => document.querySelectorAll('.unitsw-menu .unitsw-row').length >= 5, null, { timeout: 5000 })
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).map((r) => ({
      title: r.querySelector('.unitsw-title')?.textContent?.trim() ?? '',
      off: r.classList.contains('off'),
      emoji: r.querySelector('.unitsw-emoji')?.textContent ?? '',
      on: r.classList.contains('on'),
    })))
    check('列表 = 本地/云端/两台设备/通过地址连接', rows.length === 5 && rows[0].title === '本地' && rows[1].title === '云端' && rows[4].title.includes('地址'), JSON.stringify(rows.map((r) => r.title)))
    check('当前项带勾选态(本地)', !!rows[0]?.on)
    check('离线设备灰显', rows.some((r) => r.title.startsWith('书房 PC') && r.off))
    check('设备自定义 emoji 生效', rows.some((r) => r.emoji === '🦊'))

    const geo = await page.evaluate(() => {
      const m = document.querySelector('.unitsw-menu').getBoundingClientRect()
      return { l: m.left, t: m.top, r: m.right, b: m.bottom, iw: innerWidth, ih: innerHeight }
    })
    check('菜单整体在视口内', geo.l >= 0 && geo.t >= 0 && geo.r <= geo.iw && geo.b <= geo.ih, JSON.stringify(geo))

    // 脚部:开互联 → 直连地址 + 已配对回收面(先截「开着互联」那张全家福)
    await page.evaluate(() => {
      const btn = document.querySelector('.unitsw-hosttoggle')
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForSelector('.unitsw-foot-hint', { timeout: 5000 })
    await page.waitForSelector('.unitsw-paired-row', { timeout: 5000 })
    const foot = await page.evaluate(() => ({
      hint: document.querySelector('.unitsw-foot-hint')?.textContent ?? '',
      paired: Array.from(document.querySelectorAll('.unitsw-paired-name')).map((n) => n.textContent),
      removable: !!document.querySelector('.unitsw-paired-x'),
    }))
    check('脚部显示本机直连地址', foot.hint.includes('192.168.1.5:8791'), foot.hint)
    check('已配对设备列表 + 可回收', foot.paired.includes('客厅 iPad') && foot.removable, JSON.stringify(foot.paired))

    await page.waitForTimeout(350) // 开关 background/transform 有 150ms 过渡,别把起始帧截进交付图
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-switcher-expanded.png') })

    // LAN 优先自动择路:探针桩对 MacBook Air 的 lanUrl 回 meta → 行描述换「局域网直连」
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row'))
      .some((r) => r.textContent.includes('MacBook Air') && r.textContent.includes('局域网')), null, { timeout: 5000 })
    check('LAN 探通设备行显「局域网直连」描述', true)

    // 设备行 = 打开对方页面(openBrowser 无浏览器视图 → openExternal 回落,stub 记账):LAN 通 → 直连地址
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook Air'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => !document.querySelector('.unitsw-menu'), null, { timeout: 5000 })
    const opened = await page.evaluate(() => window.__unitOpened)
    check('点 LAN 可达设备 → 直连地址(尾斜杠)', opened.length === 1 && opened[0] === 'http://192.168.1.20:8791/', JSON.stringify(opened))

    // 右键菜单:改图标 / 经云端中转(逃生口 → 隧道页) / 在系统浏览器打开(/open 引导页)
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    const rightClickMba = () => page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook Air'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }))
    })
    await rightClickMba()
    await page.waitForSelector('.unitsw-ctx', { timeout: 5000 })
    const ctxTitles = await page.evaluate(() => Array.from(document.querySelectorAll('.unitsw-ctx .unitsw-title')).map((n) => n.textContent))
    check('右键菜单三项(图标/中转/浏览器)', ctxTitles.length === 3 && ctxTitles.some((t) => t.includes('中转')) && ctxTitles.some((t) => t.includes('浏览器')), JSON.stringify(ctxTitles))
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.unitsw-ctx .unitsw-row')).find((r) => r.textContent.includes('中转'))
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => window.__unitOpened.length === 2, null, { timeout: 5000 })
    const viaTunnel = await page.evaluate(() => window.__unitOpened[1])
    check('「经云端中转」逃生口 → 隧道页(尾斜杠)', viaTunnel === 'https://cloud.test/api/units/u-mba/proxy/', viaTunnel)
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    await rightClickMba()
    await page.waitForSelector('.unitsw-ctx', { timeout: 5000 })
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.unitsw-ctx .unitsw-row')).find((r) => r.textContent.includes('浏览器'))
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => window.__unitOpened.length === 3, null, { timeout: 5000 })
    const viaBrowser = await page.evaluate(() => window.__unitOpened[2])
    check('「在系统浏览器打开」→ /open 引导页', viaBrowser === 'https://cloud.test/api/units/u-mba/open', viaBrowser)

    // 离线设备点了不开页
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('书房 PC'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForTimeout(150)
    const openedAfterOffline = await page.evaluate(() => window.__unitOpened.length)
    check('离线设备不打开页面(就地提示)', openedAfterOffline === 3)
    await page.keyboard.press('Escape')
    await page.evaluate(() => { document.querySelector('.unitsw-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })

    // 折叠态只显图标
    await page.evaluate(() => { window.__rb.setState({ expanded: false }) })
    await page.waitForTimeout(120)
    const collapsed = await page.evaluate(() => ({
      name: !!document.querySelector('.unitsw-pill .unitsw-name'),
      icon: !!document.querySelector('.unitsw-pill .unitsw-ic svg'),
    }))
    check('折叠态只显图标', !collapsed.name && collapsed.icon, JSON.stringify(collapsed))
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-switcher-collapsed.png') })
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  const fails = results.filter((r) => !r.ok).length
  console.log(fails ? `\n❌ ${fails} 条未过` : '\n✅ 全部通过')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
