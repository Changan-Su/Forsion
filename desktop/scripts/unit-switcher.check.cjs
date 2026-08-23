/**
 * Forsion Unit 切换器(Ribbon head)DOM/开合/两态契约(真 Chromium + 真 Ribbon + 真组件,
 * harness.html?ribbon&unit;host 面是 stub —— 真隧道那半由 server/microserver/unit-hub/relay.test.ts 钉)。
 *
 * 判据:
 *   1 head 区出现胶囊(折叠钮之后,不进上/下两区的拖拽序)
 *   2 展开态显示当前 Unit 名(缺省=本地);点开出列表:本地/云端/两台设备,离线设备灰显,emoji 图标生效
 *   3 点在线设备 → 菜单收起,胶囊名变为该设备(mode='unit' 生效路径)
 *   4 折叠态只显图标(无名字文本)
 *   5 菜单几何:整体落在视口内(OverlayAt 钳制)
 * 顺带产两张真实截图(交付纪律:观感类改动必须自查截图):
 *   /tmp/unit-switcher-expanded.png(展开+菜单开)/ /tmp/unit-switcher-collapsed.png
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

    // 展开 ribbon(head 组件拿到 expanded=true)
    await page.evaluate(() => { window.__rb.setState({ expanded: true }) })
    await page.waitForTimeout(120)

    // 1 head 区胶囊
    const inHead = await page.evaluate(() => !!document.querySelector('.rb-head .unitsw-pill'))
    check('胶囊住在 rb-head(不进两区拖拽序)', inHead)

    // 2 展开态当前名 + 菜单内容
    const label = await page.evaluate(() => document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '')
    check('展开态显示当前 Unit 名(缺省=本地)', label === '本地', `label=${label}`)
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    await page.waitForFunction(() => document.querySelectorAll('.unitsw-menu .unitsw-row').length >= 4, null, { timeout: 5000 })
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).map((r) => ({
      title: r.querySelector('.unitsw-title')?.textContent?.trim() ?? '',
      off: r.classList.contains('off'),
      emoji: r.querySelector('.unitsw-emoji')?.textContent ?? '',
      on: r.classList.contains('on'),
    })))
    check('列表含 本地/云端/两台设备', rows.length === 4 && rows[0].title === '本地' && rows[1].title === '云端', JSON.stringify(rows.map((r) => r.title)))
    check('当前项带勾选态(本地)', !!rows[0]?.on)
    check('离线设备灰显', rows.some((r) => r.title.startsWith('书房 PC') && r.off))
    check('设备自定义 emoji 生效', rows.some((r) => r.emoji === '🦊'))

    // 5 菜单落在视口内
    const geo = await page.evaluate(() => {
      const m = document.querySelector('.unitsw-menu').getBoundingClientRect()
      return { l: m.left, t: m.top, r: m.right, b: m.bottom, iw: innerWidth, ih: innerHeight }
    })
    check('菜单整体在视口内', geo.l >= 0 && geo.t >= 0 && geo.r <= geo.iw && geo.b <= geo.ih, JSON.stringify(geo))

    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-switcher-expanded.png') })

    // 3 点在线设备 → 收起 + 胶囊改名
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook Air'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => !document.querySelector('.unitsw-menu'), null, { timeout: 5000 })
    await page.waitForFunction(() => (document.querySelector('.unitsw-pill .unitsw-name')?.textContent ?? '').includes('MacBook Air'), null, { timeout: 5000 })
    check('选中在线设备后胶囊改名(mode=unit 生效)', true)

    // 4 折叠态只显图标
    await page.evaluate(() => { window.__rb.setState({ expanded: false }) })
    await page.waitForTimeout(120)
    const collapsed = await page.evaluate(() => ({
      name: !!document.querySelector('.unitsw-pill .unitsw-name'),
      icon: !!document.querySelector('.unitsw-pill .unitsw-ic'),
      emoji: document.querySelector('.unitsw-pill .unitsw-emoji')?.textContent ?? '',
    }))
    check('折叠态只显图标(设备 emoji 顶上)', !collapsed.name && collapsed.icon && collapsed.emoji === '🦊', JSON.stringify(collapsed))
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
