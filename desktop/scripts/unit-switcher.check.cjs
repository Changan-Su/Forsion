/**
 * Forsion Unit 切换器(Ribbon 命令区)DOM/开合/两态契约(真 Chromium + 真 Ribbon + 真组件,
 * harness.html?ribbon&unit;host 面是 stub —— 真隧道在 server relay.test.ts,真配对/反代在
 * electron/unitWeb.test.ts)。v2 = B 端渲染:设备行动作是「打开对方页面」,不再换本机 cfg。
 *
 * 判据:
 * 10-17 起点胶囊 = 打开 设置 › 设备(原弹出菜单整页搬进设置,harness 无浮窗 = 窗内设置,只挂那一页);下面
 * 「列表」「脚部」指设置页上半 / 下半。来访设备缺省折起。
 *   1 胶囊住在命令区(.rb-bottom;10-02 起从 head 挪下来,缺省排在明暗切换与命令面板之间 ——
 *     那条排序是 bootstrapEngine 的一次性迁移,本台架没有 rb-mode,只验它进了命令区)
 *   2 展开态显示当前面(本地/云端,跟 vaultSide);点开列表 = 本地/云端/设备行/「通过地址连接…」,
 *     离线设备缺省折起(一条可点通路都没有才算离线,直连探通的留在外面;点开灰显),emoji 图标生效,当前项带勾选
 *   3 一台设备按通路拆行(直连/P2P/中转):直连行仅探针通了才出现,P2P 行 = 在线且本端有桥,
 *     中转行恒在(离线灰显);P2P 打洞失败**出声回落中转**;点行 = **整个主区切过去**
 *     (远程面 .unitrs 携 webview 指向该通路地址,胶囊改显设备名,点中的那行带勾;选「本地」切回,
 *     远程面 visibility 隐藏保活)。右键菜单两项 —— 改图标/「在系统浏览器打开」(→ openExternal
 *     /open 引导页,唯一走外链的路)
 *   4 菜单脚部:开「允许其他设备连接本机」→ 显示本机直连地址 + 已配对设备可回收
 *   5 折叠态只显图标;菜单整体在视口内
 * 顺带产三张真实截图(交付纪律):unit-switcher-folded.png(离线折起的缺省态)/ unit-switcher-expanded.png / unit-switcher-collapsed.png
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
    await page.waitForSelector('.rb-bottom .unitsw-pill', { timeout: 20000 })

    await page.evaluate(() => { window.__rb.setState({ expanded: true }) })
    await page.waitForTimeout(120)

    const inBottom = await page.evaluate(() => !!document.querySelector('.rb-bottom .unitsw-pill'))
    check('胶囊住在命令区 .rb-bottom', inBottom)

    const label = await page.evaluate(() => document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '')
    check('展开态显示当前面(缺省=本地)', label === '本地', `label=${label}`)

    const openPage = async () => {
      await page.click('.unitsw-pill')
      await page.waitForSelector('.unitset-page', { timeout: 5000 })
    }
    await openPage()
    const tab0 = await page.evaluate(() => ({ tab: window.__forsionStore?.getState().settingsTab ?? null, menu: !!document.querySelector('.unitsw-menu') }))
    check('点胶囊 → 打开 设置 › 设备(不再弹菜单)', tab0.tab === 'units' && !tab0.menu, JSON.stringify(tab0))
    const LIST = '.unitset-list .unitsw-row'
    // 探针桩异步回来才长出「MacBook Air 直连」「客厅 mini 直连」两行:等到 9 行(含折叠开关)再断言构成。
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length >= 9, LIST, { timeout: 5000 })
    const readRows = () => page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((r) => ({
      title: r.querySelector('.unitsw-title')?.textContent?.trim() ?? '',
      off: r.classList.contains('off'),
      fold: r.classList.contains('unitsw-fold'),
      expanded: r.getAttribute('aria-expanded'),
      emoji: r.querySelector('.unitsw-emoji')?.textContent ?? '',
      on: r.classList.contains('on'),
    })), LIST)
    const clickRow = (text) => page.evaluate(([sel, t]) => {
      const row = Array.from(document.querySelectorAll(sel)).find((r) => r.textContent.includes(t))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, [LIST, text])
    let rows = await readRows()
    check('列表 = 本地/云端/在线设备按通路拆行(直连/P2P/中转)/离线设备折叠/通过地址连接',
      rows.length === 9 && rows[0].title === '本地' && rows[1].title === '云端'
        && rows[2].title === 'MacBook Air直连' && rows[3].title === 'MacBook AirP2P' && rows[4].title === 'MacBook Air中转'
        && rows[5].title === '客厅 mini直连' && rows[6].title.startsWith('客厅 mini中转')
        && rows[7].fold && rows[8].title.includes('地址'),
      JSON.stringify(rows.map((r) => r.title)))
    check('当前项带勾选态(本地)', !!rows[0]?.on)
    check('离线设备缺省折起(开关显 1 台,书房 PC 不在列表里)',
      rows[7].fold && rows[7].expanded === 'false' && rows[7].title === '离线设备1' && !rows.some((r) => r.title.includes('书房 PC')),
      JSON.stringify(rows[7]))
    check('隧道离线但直连探通的设备留在外面(直连行可点、中转行灰显)', !rows[5].off && rows[6].off, JSON.stringify(rows.slice(5, 7)))
    await page.mouse.move(1000, 700)
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-switcher-folded.png') })
    await page.evaluate(() => document.querySelector('.unitset-list .unitsw-fold').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await page.waitForTimeout(80)
    rows = await readRows()
    check('点开折叠 → 离线设备只剩中转行且灰显(无直连/P2P 行)',
      rows.length === 10 && rows[7].expanded === 'true' && rows[8].title.startsWith('书房 PC中转') && rows[8].off
        && !rows.some((r) => r.title === '书房 PC直连' || r.title === '书房 PCP2P'),
      JSON.stringify(rows.map((r) => r.title)))
    check('手机(kind=phone)不出现在设备行里', !rows.some((r) => r.title.includes('口袋 Pixel')), JSON.stringify(rows.map((r) => r.title)))
    check('设备自定义 emoji 生效', rows.some((r) => r.emoji === '🦊'))

    check('互联关着:设置页没取远程会话视图', (await page.evaluate(() => window.__rsGets)) === 0, await page.evaluate(() => window.__rsGets))
    // 互联:开 → 直连地址 + 来访设备(缺省折起,点开可回收)
    await page.click('[data-setting-anchor="units-host"] .settings-switch')
    await page.waitForFunction(() => (document.querySelector('.unitset-hint')?.textContent ?? '').includes('192.168.1.5:8791'), null, { timeout: 5000 }).catch(() => {})
    await page.waitForSelector('.unitset-paired .unitsw-fold', { timeout: 5000 })
    const paired0 = await page.evaluate(() => ({
      hint: document.querySelector('.unitset-hint')?.textContent ?? '',
      fold: document.querySelector('.unitset-paired .unitsw-fold')?.getAttribute('aria-expanded'),
      title: document.querySelector('.unitset-paired .unitsw-title')?.textContent?.trim() ?? '',
      rows: document.querySelectorAll('.unitset-paired .unitsw-paired-row').length,
    }))
    check('开互联 → 显示本机直连地址', paired0.hint.includes('192.168.1.5:8791'), paired0.hint)
    check('来访设备缺省折起(开关带台数,名单不展开)', paired0.fold === 'false' && /^来访设备\d+$/.test(paired0.title) && paired0.rows === 0, JSON.stringify(paired0))
    await page.click('.unitset-paired .unitsw-fold')
    const foot = await page.evaluate(() => ({
      paired: Array.from(document.querySelectorAll('.unitsw-paired-name')).map((n) => n.textContent),
      removable: !!document.querySelector('.unitsw-paired-x'),
    }))
    check('点开 → 来访设备列表 + 可回收', foot.paired.includes('客厅 iPad') && foot.removable, JSON.stringify(foot.paired))

    // P1-K4:「允许远程会话」子开关 + 「设置 ›」深链
    await page.waitForSelector('[data-setting-anchor="units-remote"] [role=switch]', { timeout: 5000 })
    check('互联一开:重取一次视图(拿到真 permitted)', (await page.evaluate(() => window.__rsGets)) >= 1, await page.evaluate(() => window.__rsGets))
    const SUB = '[data-setting-anchor="units-remote"] [role=switch]'
    const subOn = () => page.evaluate((s) => document.querySelector(s)?.getAttribute('aria-checked'), SUB)
    check('子开关:文案「允许远程会话」、缺省开', (await subOn()) === 'true'
      && (await page.evaluate(() => document.querySelector('[data-setting-anchor="units-remote"] strong')?.textContent)) === '允许远程会话')
    await page.click(SUB)
    await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-checked') === 'false', SUB, { timeout: 3000 })
    await page.click(SUB)
    await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-checked') === 'true', SUB, { timeout: 3000 })
    check('点子开关 → 关 / 再点 → 开(走 remoteSessions.setEnabled)', true)
    await page.mouse.move(1000, 700)
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-switcher-expanded.png') })

    const lanDesc = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel))
      .some((r) => r.textContent.includes('MacBook Air直连') && r.textContent.includes('局域网')), LIST)
    check('直连行显局域网描述', lanDesc)

    // 隧道离线但直连探通的那台:点直连行 → 远程面指向它的直连地址,设置页收起
    await clickRow('客厅 mini直连')
    await page.waitForFunction(() => document.querySelector('.unitrs-web')?.getAttribute('src') === 'http://192.168.1.30:8791/', null, { timeout: 5000 }).catch(() => {})
    const miniSurf = await page.evaluate(() => ({
      src: document.querySelector('.unitrs-web')?.getAttribute('src') ?? '',
      pill: document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '',
      page: !!document.querySelector('.unitset-page'),
    }))
    check('点直连行 → 远程面指向它的直连地址、胶囊显设备名、设置收起', miniSurf.src === 'http://192.168.1.30:8791/' && miniSurf.pill === '客厅 mini' && !miniSurf.page, JSON.stringify(miniSurf))

    await openPage()
    await page.waitForFunction((sel) => Array.from(document.querySelectorAll(sel)).some((r) => r.textContent.includes('MacBook Air直连')), LIST, { timeout: 5000 })
    await clickRow('MacBook Air直连')
    await page.waitForSelector('.unitrs', { timeout: 5000 })
    const surf = await page.evaluate(() => ({
      src: document.querySelector('.unitrs-web')?.getAttribute('src') ?? '',
      visible: getComputedStyle(document.querySelector('.unitrs')).visibility === 'visible',
      external: window.__unitOpened.length,
      pill: document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '',
    }))
    check('点直连行 → 远程面指向直连地址(尾斜杠),不开外链', surf.visible && surf.src === 'http://192.168.1.20:8791/' && surf.external === 0, JSON.stringify(surf))
    check('远程面激活时胶囊显示设备名(回来的路)', surf.pill === 'MacBook Air', surf.pill)
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-remote-surface.png') })
    // 点胶囊不许把远程面踢掉(它是回来的路,点开的是设置)
    await openPage()
    check('远程面激活时点胶囊:远程面仍在、设置页打开', await page.evaluate(() => getComputedStyle(document.querySelector('.unitrs')).visibility === 'visible'))

    // P2P 行:第一次点(桩)打洞失败 → 出声回落中转;第二次成功 → 本机代理地址
    await clickRow('MacBook AirP2P')
    await page.waitForFunction(() => document.querySelector('.unitrs-web')?.getAttribute('src') === 'https://cloud.test/api/units/u-mba/proxy/', null, { timeout: 5000 })
    check('P2P 打洞失败 → 回落中转(远程面=隧道页)', true)
    await openPage()
    await clickRow('MacBook AirP2P')
    await page.waitForFunction(() => document.querySelector('.unitrs-web')?.getAttribute('src') === 'http://127.0.0.1:47123/', null, { timeout: 5000 })
    check('P2P 打洞成功 → 远程面=本机代理地址', true)

    await openPage()
    await clickRow('MacBook Air中转')
    await page.waitForFunction(() => document.querySelector('.unitrs-web')?.getAttribute('src') === 'https://cloud.test/api/units/u-mba/proxy/', null, { timeout: 5000 })
    check('点中转行 → 远程面换隧道页(尾斜杠)', true)

    // 右键菜单两项:改图标 / 在系统浏览器打开
    await openPage()
    await page.evaluate((sel) => {
      const row = Array.from(document.querySelectorAll(sel)).find((r) => r.textContent.includes('MacBook Air'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 200 }))
    }, LIST)
    await page.waitForSelector('.unitsw-ctx', { timeout: 5000 })
    const ctxTitles = await page.evaluate(() => Array.from(document.querySelectorAll('.unitsw-ctx .unitsw-title')).map((n) => n.textContent))
    check('右键菜单两项(图标/浏览器)', ctxTitles.length === 2 && ctxTitles.some((t) => t.includes('图标')) && ctxTitles.some((t) => t.includes('浏览器')), JSON.stringify(ctxTitles))
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.unitsw-ctx .unitsw-row')).find((r) => r.textContent.includes('浏览器'))
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(() => window.__unitOpened.length === 1, null, { timeout: 5000 })
    const viaBrowser = await page.evaluate(() => window.__unitOpened[0])
    check('「在系统浏览器打开」→ /open 引导页', viaBrowser === 'https://cloud.test/api/units/u-mba/open', viaBrowser)

    // 离线设备点了不切面、设置页不收
    await page.evaluate(() => document.querySelector('.unitset-list .unitsw-fold').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await clickRow('书房 PC')
    await page.waitForTimeout(150)
    const afterOffline = await page.evaluate(() => ({
      src: document.querySelector('.unitrs-web')?.getAttribute('src') ?? '',
      page: !!document.querySelector('.unitset-page'),
      note: document.querySelector('.unitset-note')?.textContent ?? '',
    }))
    check('离线设备不切面(远程面目标不变、设置页留着、页内说明不在线)', afterOffline.src === 'https://cloud.test/api/units/u-mba/proxy/' && afterOffline.page && afterOffline.note.includes('书房 PC'), JSON.stringify(afterOffline))

    // 选「本地」= 切回本机:远程面 visibility 隐藏(webview 保活),胶囊回「本地」
    await clickRow('本地')
    await page.waitForFunction(() => !document.querySelector('.unitset-page'), null, { timeout: 5000 })
    const backLocal = await page.evaluate(() => ({
      hidden: getComputedStyle(document.querySelector('.unitrs')).visibility === 'hidden',
      alive: !!document.querySelector('.unitrs-web'),
      pill: document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim() ?? '',
    }))
    check('选「本地」切回:远程面隐藏但保活,胶囊回「本地」', backLocal.hidden && backLocal.alive && backLocal.pill === '本地', JSON.stringify(backLocal))

    await page.evaluate(() => { window.__rb.setState({ expanded: false }) })
    await page.waitForTimeout(120)
    const collapsed = await page.evaluate(() => ({
      name: !!document.querySelector('.unitsw-pill .unitsw-name'),
      icon: !!document.querySelector('.unitsw-pill .unitsw-ic svg'),
    }))
    check('折叠态只显图标', !collapsed.name && collapsed.icon, JSON.stringify(collapsed))
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-switcher-collapsed.png') })

    // 「设置 ›」深链到 设置 › 远程会话
    await page.evaluate(() => { window.__rb.setState({ expanded: true }) })
    await openPage()
    await page.waitForSelector('[data-unitsw-remote-settings]', { timeout: 5000 })
    await page.click('[data-unitsw-remote-settings]')
    const tab = await page.evaluate(() => window.__forsionStore?.getState().settingsTab ?? null)
    check('「设置 ›」→ 打开 设置 › 远程会话', tab === 'remote-sessions', String(tab))

    // 设备凭据没加密(K5 plaintext)→ K5 提示在子开关之上,子开关置灰
    await page.goto(`${URL}&secrets=plaintext`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.rb-bottom .unitsw-pill', { timeout: 20000 })
    await page.evaluate(() => { window.__rb.setState({ expanded: true }) })
    await openPage()
    await page.click('[data-setting-anchor="units-host"] .settings-switch')
    await page.waitForSelector('[data-setting-anchor="units-remote"] [role=switch]', { timeout: 5000 })
    await page.waitForSelector('[data-setting-anchor="units-host"] .secnotice', { timeout: 5000 })
    const locked = await page.evaluate(() => {
      const sec = document.querySelector('[data-setting-anchor="units-host"] .secnotice')
      const row = document.querySelector('[data-setting-anchor="units-remote"]')
      const sw = row.querySelector('[role=switch]')
      return { secBefore: !!(sec.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING), disabled: sw.disabled, on: sw.getAttribute('aria-checked') }
    })
    check('设备凭据未加密:K5 提示 → 子开关(置灰、显示关)', locked.secBefore && locked.disabled && locked.on === 'false', JSON.stringify(locked))
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-switcher-remote-locked.png') })
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  const fails = results.filter((r) => !r.ok).length
  console.log(fails ? `\n❌ ${fails} 条未过` : '\n✅ 全部通过')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
