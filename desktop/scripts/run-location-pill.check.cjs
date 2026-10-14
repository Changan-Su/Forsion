/**
 * 桌面新对话的「运行位置」胶囊 —— 真组件 + 真 store + 生产 CSS,Chromium 里点一遍(桩 window.tangu;中转口与本机引擎由路由桩应答)。
 * 不起 Electron、不占界面测试锁:看的是观感(深浅色、zh/en、100% / 110%、没登录、账号下没有别的电脑)和下拉的几何。
 * 主进程中转口那半(凭据、换号、真 Electron 缩放)在 scripts/run-location.e2e.cjs。
 * 截图落 $TMPDIR/forsion-run-location-pill/*.png(交付前自己看)。
 * Run: node scripts/e2e-editor.cjs --check=run-location-pill   (worktree 里加 HARNESS_URL=http://localhost:<port>/harness.html)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const file = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(file)) return file
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const baseUrl = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
baseUrl.pathname = '/run-location-harness.html'
const base = baseUrl.toString()
const out = process.env.RUNLOC_SHOT_DIR || path.join(os.tmpdir(), 'forsion-run-location-pill')
fs.mkdirSync(out, { recursive: true })
const MINI = '7f0e8a52-0000-4000-8000-00000000000a'
let pass = 0, fail = 0
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, JSON.stringify(detail)) } }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1180, height: 620 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // 「那台电脑」的状态:unconfirmed → (请求后)pending → trusted
  const mini = { caller: 'unconfirmed' }
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
  await page.route('http://127.0.0.1:41234/**', (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } })
    const p = new URL(req.url()).pathname.replace(`/units/${MINI}/proxy`, '')
    if (p === '/unit/remote-access') return json(route, 200, { remoteSessions: true, caller: mini.caller })
    if (p === '/unit/remote-access/request') { if (mini.caller === 'unconfirmed') mini.caller = 'pending'; return json(route, 200, { remoteSessions: true, caller: mini.caller }) }
    if (p === '/unit/config') return json(route, 200, { config: { homeDir: '/Users/mini', defaultWorkspaceDir: '/Users/mini/Forsion' } })
    if (p === '/engine/agent/sessions') return json(route, 200, { sessions: [
      { id: 'mini-1', title: '整理 webapp 的路由', project_path: '/Users/mini/code/webapp', project_name: 'webapp', created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-12T08:00:00Z' },
      { id: 'mini-2', title: '读论文', project_path: '/Users/mini/papers', project_name: 'papers', created_at: '2026-10-11T08:00:00Z', updated_at: '2026-10-11T08:00:00Z' },
    ] })
    if (p === '/engine/agent/models') return json(route, 200, { models: [{ id: 'm1', name: 'Mini 模型', provider: 'stub' }] })
    return json(route, 200, {})
  })
  await page.route('http://127.0.0.1:41000/**', (route) => json(route, 200, {}))

  const pill = page.locator('[data-run-location-picker] .project-pill')
  const menu = page.locator('.runloc-menu')
  /** keep = 留着上一次选的运行位置(它记在 localStorage 里);缺省清掉,每个形态都从「这台电脑」起。 */
  const open = async (query = '', keep = false) => {
    if (!keep) mini.caller = 'unconfirmed'
    await page.goto(`${base}?${query}`)
    if (!keep) { await page.evaluate(() => localStorage.clear()); await page.reload() }
    await pill.waitFor({ timeout: 20_000 })
    await page.waitForTimeout(350)
  }
  const shot = (name, target = page.locator('[data-harness-anchor]')) => target.screenshot({ path: path.join(out, name) })
  const pageShot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, name) }) } // 等下拉 0.16s 的弹出动画落定
  const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })
  /** 下拉的几何 + 纪律:整块在视口里、没有虚线边框(DESIGN §6)、行高不被文字撑破。 */
  const menuOk = async (label) => {
    const g = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const dashed = [el, ...el.querySelectorAll('*')].filter((n) => /dashed|dotted/.test(getComputedStyle(n).borderStyle)).length
      const rows = [...el.querySelectorAll('.menu-item')]
      const clipped = rows.filter((n) => n.scrollWidth > n.clientWidth + 1).length
      // 菜单行是一行字:比最矮的那行高出一截 = 文案折行了(10-14 截图里「登录 Forsion 以选择其他电脑」折出一个孤字)
      const low = Math.min(...rows.map((n) => n.getBoundingClientRect().height))
      const wrapped = rows.filter((n) => n.getBoundingClientRect().height > low * 1.4).map((n) => n.textContent)
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight, dashed, clipped, wrapped }
    })
    check(`${label}:下拉整块在视口里`, g.left >= 0 && g.top >= 0 && g.right <= g.vw && g.bottom <= g.vh, g)
    check(`${label}:下拉里没有虚线边框、没有被撑破或折行的菜单行`, g.dashed === 0 && g.clipped === 0 && g.wrapped.length === 0, g)
  }

  // ── 浅色 · zh · 100% ──
  await open()
  check('缺省写「这台电脑」', (await pill.innerText()).trim() === '这台电脑', await pill.innerText())
  const [p, c] = [await box(pill), await box(page.locator('[data-harness-card]'))]
  check('胶囊左缘与输入卡左缘同一条线', Math.abs(p.left - c.left) <= 1, { pill: p.left, card: c.left })
  await shot('1-closed-light.png')
  await pill.click()
  await menu.locator(`[data-run-row="${MINI}"]`).waitFor({ timeout: 10_000 })
  await menuOk('浅色 100%')
  await pageShot('2-menu-light.png')
  // 选「Mac mini」:那台还没允许 → 菜单里说去那台点允许
  await menu.locator(`[data-run-row="${MINI}"]`).click()
  const notice = menu.locator('[data-run-notice]')
  await notice.waitFor({ timeout: 10_000 })
  check('等那台允许时菜单里有一句说明', /Mac mini/.test(await notice.innerText()), await notice.innerText())
  await pageShot('3-waiting-light.png')
  // 那台点了允许 → 生效:胶囊写那台的名字,项目胶囊列那台的项目
  mini.caller = 'trusted'
  await page.waitForFunction(() => document.querySelector('[data-run-location-picker]')?.getAttribute('data-run-location') !== 'home', null, { timeout: 15_000 })
  await page.waitForTimeout(500)
  check('生效后胶囊写「Mac mini」', /Mac mini/.test(await pill.innerText()), await pill.innerText())
  await shot('4-on-mini-light.png')
  const projectPill = page.locator('.project-selector:not(.runloc) > .project-pill')
  await projectPill.click()
  await page.waitForTimeout(300)
  const projects = await page.locator('.project-selector:not(.runloc) .project-menu').innerText().catch(() => '')
  check('项目胶囊列那台的项目、不给「添加本地项目」', /webapp/.test(projects) && !/添加本地项目/.test(projects), projects)
  await pageShot('5-mini-projects-light.png')
  await page.keyboard.press('Escape')
  await pill.click()
  await menu.waitFor()
  await pageShot('6-menu-on-mini-light.png')
  // 记住上次选的:重新打开(那台仍在线)还在 Mac mini;深色顺带看一眼选中行
  await open('dark', true)
  check('重新打开后新对话仍在「Mac mini」(记住了上次选的)', /Mac mini/.test(await pill.innerText()), await pill.innerText())
  await pill.click()
  await menu.waitFor({ timeout: 10_000 })
  await pageShot('6b-menu-on-mini-dark.png')

  // ── 其余形态:只看观感 + 下拉几何 ──
  for (const [name, query, label] of [
    ['7-menu-dark.png', 'dark', '深色'],
    ['8-menu-110.png', 'zoom=1.1', '110%'],
    ['9-menu-en.png', 'lang=en', 'en'],
    ['10-menu-solo.png', 'solo', '账号下没有别的电脑'],
    ['11-menu-signedout.png', 'signedout', '没登录'],
    ['12-menu-signedout-en.png', 'signedout&lang=en', '没登录 en'],
    ['13-menu-solo-en-110.png', 'solo&lang=en&zoom=1.1', '没有别的电脑 en 110%'],
    ['14-menu-long.png', 'long', '名字很长的电脑'],
  ]) {
    await open(query)
    await pill.click()
    await menu.waitFor({ timeout: 10_000 })
    await page.waitForTimeout(400)
    await menuOk(label)
    await pageShot(name)
  }
  // Esc 关闭并把焦点还给胶囊
  await page.keyboard.press('Escape')
  check('Esc 关闭下拉、焦点回到胶囊', await menu.count() === 0 && await pill.evaluate((el) => document.activeElement === el))

  check('页面没有未捕获的错误', errors.length === 0, errors.slice(0, 3))
  await browser.close()
  console.log(`\n${pass} passed, ${fail} failed · 截图:${out}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
