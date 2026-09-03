/**
 * Forsion Unit 切换器(Ribbon head)DOM/开合/两态契约(真 Chromium + 真 Ribbon + 真组件,
 * harness.html?ribbon&unit;host 面是 stub —— 真隧道在 server relay.test.ts,真配对/反代在
 * electron/unitWeb.test.ts)。v2 = B 端渲染:设备行动作是「打开对方页面」,不再换本机 cfg。
 *
 * 判据:
 *   1 head 区出现胶囊(折叠钮之后,不进上/下两区的拖拽序)
 *   2 展开态显示当前面(本地/云端,跟 vaultSide);点开列表 = 本地/云端/设备行/「通过地址连接…」,
 *     离线设备灰显,emoji 图标生效,当前项带勾选
 *   3 一台设备按通路拆行(直连/P2P/中转):直连行仅探针通了才出现,P2P 行 = 在线且本端有桥,
 *     中转行恒在(离线灰显);P2P 打洞失败**出声回落中转**;点行 = **整个主区切过去**
 *     (远程面 .unitrs 携 webview 指向该通路地址,胶囊改显设备名,点中的那行带勾;选「本地」切回,
 *     远程面 visibility 隐藏保活)。右键菜单两项 —— 改图标/「在系统浏览器打开」(→ openExternal
 *     /open 引导页,唯一走外链的路)
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
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 720 } })
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
    // 探针桩异步回来才长出「MacBook Air 直连」行:等到 7 行(直连/P2P/中转三通路)再断言构成。
    await page.waitForFunction(() => document.querySelectorAll('.unitsw-menu .unitsw-row').length >= 7, null, { timeout: 5000 })
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).map((r) => ({
      title: r.querySelector('.unitsw-title')?.textContent?.trim() ?? '',
      off: r.classList.contains('off'),
      emoji: r.querySelector('.unitsw-emoji')?.textContent ?? '',
      on: r.classList.contains('on'),
    })))
    check('列表 = 本地/云端/设备按通路拆行(直连/P2P/中转)/通过地址连接',
      rows.length === 7 && rows[0].title === '本地' && rows[1].title === '云端'
        && rows[2].title === 'MacBook Air直连' && rows[3].title === 'MacBook AirP2P' && rows[4].title === 'MacBook Air中转'
        && rows[5].title.startsWith('书房 PC中转') && rows[6].title.includes('地址'),
      JSON.stringify(rows.map((r) => r.title)))
    check('当前项带勾选态(本地)', !!rows[0]?.on)
    check('离线设备只剩中转行且灰显(无直连/P2P 行)', rows[5].off && !rows.some((r) => r.title === '书房 PC直连' || r.title === '书房 PCP2P'))
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

    // 探针通了直连行才在(上面 6 行等待已覆盖);描述文案带「局域网」
    const lanDesc = await page.evaluate(() => Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row'))
      .some((r) => r.textContent.includes('MacBook Air直连') && r.textContent.includes('局域网')))
    check('直连行显局域网描述', lanDesc)

    // 直连行 = 整个主区切过去:远程面 .unitrs 携 webview 指向直连地址,不开浏览器标签/外链
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook Air直连'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => !document.querySelector('.unitsw-menu'), null, { timeout: 5000 })
    await page.waitForSelector('.unitrs', { timeout: 5000 })
    const surf = await page.evaluate(() => ({
      src: document.querySelector('.unitrs-web')?.getAttribute('src') ?? '',
      visible: getComputedStyle(document.querySelector('.unitrs')).visibility === 'visible',
      external: window.__unitOpened.length,
      pill: document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '',
    }))
    check('点直连行 → 远程面指向直连地址(尾斜杠),不开外链', surf.visible && surf.src === 'http://192.168.1.20:8791/' && surf.external === 0, JSON.stringify(surf))
    check('远程面激活时胶囊显示设备名(回来的路)', surf.pill === 'MacBook Air', surf.pill)
    // 交付截图:远程面激活态(harness 里 webview 不渲染内容,看的是覆盖几何 + 胶囊改显设备)
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-remote-surface.png') })

    // 勾选态落在点中的那条通路行;同设备另一条通路行不带勾
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    const mbaOn = await page.evaluate(() => {
      const find = (t) => Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes(t))
      return { lanOn: find('MacBook Air直连').classList.contains('on'), tunnelOn: find('MacBook Air中转').classList.contains('on'), localOn: document.querySelector('.unitsw-menu .unitsw-row').classList.contains('on') }
    })
    check('勾选态只落在点中的通路行(直连√ 中转× 本地×)', mbaOn.lanOn && !mbaOn.tunnelOn && !mbaOn.localOn, JSON.stringify(mbaOn))
    const rightClickMba = () => page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook Air'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }))
    })
    // P2P 行:第一次点(桩)打洞失败 → **出声回落中转**(远程面落在隧道页,勾选态归中转行)
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook AirP2P'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => document.querySelector('.unitrs-web')?.getAttribute('src') === 'https://cloud.test/api/units/u-mba/proxy/', null, { timeout: 5000 })
    check('P2P 打洞失败 → 回落中转(远程面=隧道页)', true)
    // 第二次点:桩放行 → 远程面切到本机 P2P 代理地址,勾选态落在 P2P 行
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook AirP2P'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => document.querySelector('.unitrs-web')?.getAttribute('src') === 'http://127.0.0.1:47123/', null, { timeout: 5000 })
    check('P2P 打洞成功 → 远程面=本机代理地址', true)
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    const p2pOn = await page.evaluate(() => {
      const find = (label) => Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes(label))
      return { p2p: find('MacBook AirP2P').classList.contains('on'), lan: find('MacBook Air直连').classList.contains('on') }
    })
    check('P2P 连上后勾选态落在 P2P 行', p2pOn.p2p && !p2pOn.lan, JSON.stringify(p2pOn))

    // 中转是一等行:点「MacBook Air 中转」→ 远程面换隧道页(尾斜杠)
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('MacBook Air中转'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => document.querySelector('.unitrs-web')?.getAttribute('src') === 'https://cloud.test/api/units/u-mba/proxy/', null, { timeout: 5000 })
    check('点中转行 → 远程面换隧道页(尾斜杠)', true)

    // 右键菜单两项:改图标 / 在系统浏览器打开(/open 引导页,唯一走外链的路)
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    await rightClickMba()
    await page.waitForSelector('.unitsw-ctx', { timeout: 5000 })
    const ctxTitles = await page.evaluate(() => Array.from(document.querySelectorAll('.unitsw-ctx .unitsw-title')).map((n) => n.textContent))
    check('右键菜单两项(图标/浏览器,中转已升一等行)', ctxTitles.length === 2 && ctxTitles.some((t) => t.includes('图标')) && ctxTitles.some((t) => t.includes('浏览器')), JSON.stringify(ctxTitles))
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.unitsw-ctx .unitsw-row')).find((r) => r.textContent.includes('浏览器'))
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => window.__unitOpened.length === 1, null, { timeout: 5000 })
    const viaBrowser = await page.evaluate(() => window.__unitOpened[0])
    check('「在系统浏览器打开」→ /open 引导页(唯一走外链的路)', viaBrowser === 'https://cloud.test/api/units/u-mba/open', viaBrowser)

    // 离线设备点了不切面
    await page.click('.unitsw-pill')
    await page.waitForSelector('.unitsw-menu', { timeout: 5000 })
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.unitsw-menu .unitsw-row')).find((r) => r.textContent.includes('书房 PC'))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForTimeout(150)
    const afterOffline = await page.evaluate(() => ({
      src: document.querySelector('.unitrs-web')?.getAttribute('src') ?? '',
      external: window.__unitOpened.length,
    }))
    check('离线设备不切面(就地提示,远程面目标不变)', afterOffline.src === 'https://cloud.test/api/units/u-mba/proxy/' && afterOffline.external === 1, JSON.stringify(afterOffline))

    // 选「本地」= 切回本机:远程面 visibility 隐藏(webview 保活),胶囊回「本地」
    await page.evaluate(() => {
      document.querySelector('.unitsw-menu .unitsw-row').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => !document.querySelector('.unitsw-menu'), null, { timeout: 5000 })
    const backLocal = await page.evaluate(() => ({
      hidden: getComputedStyle(document.querySelector('.unitrs')).visibility === 'hidden',
      alive: !!document.querySelector('.unitrs-web'), // 保活:webview 还挂着,切回去免重载
      pill: document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '',
    }))
    check('选「本地」切回:远程面隐藏但保活,胶囊回「本地」', backLocal.hidden && backLocal.alive && backLocal.pill === '本地', JSON.stringify(backLocal))

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
