/** Per-View navigation wiring: real Chromium + Dockview + navStore.
 * Each group owns arrows in its tab strip, bound to its active View; only the first group has a sidebar toggle.
 * Run npm run check:nav. HARNESS_URL may target an isolated Vite server.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const URL = `${BASE}?dock`

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

/** 开一个 navv 标签并依次「访问」若干页。 */
const openTab = (page, labels) => page.evaluate(async (ls) => {
  const d = window.__dock
  const id = d.open('navv', { label: ls[0] }, true)
  for (const l of ls) { d.nav.visit(id, l); await new Promise((r) => setTimeout(r, 80)) }
  return id
}, labels)

/** Dockview portals content outside group DOM; match visible View rectangles to group columns. */
const shown = (page) => page.$$eval('.navv', els => els.filter(el => el.getBoundingClientRect().width > 0).map(el => el.dataset.label))
const prefixes = (page) => page.$$eval('.dv-groupview', gs => gs
  .filter(g => g.querySelector('.dv-new-tab'))
  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  .map(g => {
    return [g.querySelectorAll('.dv-prefix .lcl-viewnav > button').length, g.querySelectorAll('.dv-edge-toggle').length]
  }))

async function arrow(page, dir, id) {
  const btn = page.locator(`[data-view-nav="${id}"] [data-press="${dir}"]`)
  if (!await btn.count() || await btn.isDisabled()) return false
  await btn.click()
  await page.waitForTimeout(250)
  return true
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend', '--port', new global.URL(BASE).port || '5173', '--strictPort'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
    page.on('pageerror', e => console.error('PAGEERROR', e.message))
    page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE', m.text()) })
    await page.goto(URL)
    await page.waitForSelector('.dockh-body[data-tag="main"]', { timeout: 20000 })
    await page.waitForTimeout(500)

    // ── 同一组两个 tab:各自一份栈 ──────────────────────────────────────────
    const tabA = await openTab(page, ['A1', 'A2', 'A3'])
    const tabB = await openTab(page, ['B1', 'B2'])
    const stacks = await page.evaluate(([a, b]) => ({ a: window.__dock.nav.stack(a), b: window.__dock.nav.stack(b) }), [tabA, tabB])
    check(
      '1 每个 tab 一份独立栈(A 三页 / B 两页,互不串)',
      stacks.a.keys.join('>') === 'p:A1>p:A2>p:A3' && stacks.b.keys.join('>') === 'p:B1>p:B2',
      JSON.stringify(stacks),
    )

    // ── 在 B 里后退:只动 B ────────────────────────────────────────────────
    await arrow(page, 'back', tabB)
    let labels = await page.evaluate(() => window.__dock.nav.labels())
    check(
      '2 在 B 里后退 → B 回到 B1,A 纹丝不动(仍 A3)',
      labels[tabB] === 'B1' && labels[tabA] === 'A3',
      JSON.stringify({ A: labels[tabA], B: labels[tabB] }),
    )

    // ── 切到 A:后退走 A 自己的栈,前进能回 A3 ───────────────────────────────
    await page.evaluate((id) => window.__dock.nav.activate(id), tabA)
    await page.waitForTimeout(200)
    await arrow(page, 'back', tabA)
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check('3 切到 A 后退 → A 到 A2(B 仍 B1)', labels[tabA] === 'A2' && labels[tabB] === 'B1', JSON.stringify({ A: labels[tabA], B: labels[tabB] }))
    await arrow(page, 'forward', tabA)
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check('4 再前进 → A 回到 A3(A→B→C 退到 B 还能前进到 C)', labels[tabA] === 'A3', JSON.stringify({ A: labels[tabA] }))

    // ── 分屏:每个 View 都有自己的箭头 ──────────────────────────────────
    const tabC = await page.evaluate(async () => {
      const d = window.__dock
      const id = d.nav.split()
      for (const l of ['C1', 'C2']) { d.nav.visit(id, l); await new Promise((r) => setTimeout(r, 80)) }
      return id
    })
    await page.waitForTimeout(300)
    const groupsSeen = await shown(page)
    check('5 分屏成两个主区组(左 A / 右 C)', groupsSeen.length === 2, JSON.stringify(groupsSeen))
    const twoGroups = JSON.stringify([[2, 1], [2, 0]])
    check('5b 两个 View 各有箭头，左栏折叠钮仍只有一份', JSON.stringify(await prefixes(page)) === twoGroups, JSON.stringify(await prefixes(page)))

    // 焦点此刻在右组(刚分出来的):点这一套 → 动右组的 C,左组的 A 不动。点击本身不许把焦点抢到左组。
    await page.evaluate((id) => window.__dock.nav.activate(id), tabA)
    const hit6 = await arrow(page, 'back', tabC)
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check(
      '6 左侧有焦点时点击右 View 后退，只改变右侧',
      hit6 && labels[tabC] === 'C1' && labels[tabA] === 'A3',
      JSON.stringify({ A: labels[tabA], C: labels[tabC], 按钮可点: hit6 }),
    )
    await page.evaluate((id) => window.__dock.nav.activate(id), tabA)
    await page.waitForTimeout(200)
    await page.evaluate((id) => window.__dock.nav.activate(id), tabC)
    const hit7 = await arrow(page, 'back', tabA)
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check(
      '7 右侧有焦点时点击左 View 后退，只改变左侧',
      hit7 && labels[tabA] === 'A2' && labels[tabC] === 'C1',
      JSON.stringify({ A: labels[tabA], C: labels[tabC], 按钮可点: hit7 }),
    )

    // 组被拖到另一边:tab 集合没变,前缀也得跟着换到新的最左组。
    await page.evaluate(([from, to]) => window.__dock.nav.moveGroupRightOf(from, to), [tabA, tabC])
    await page.waitForTimeout(300)
    check('7b 对调两组后，箭头仍归各自 View，折叠钮在最左', JSON.stringify(await prefixes(page)) === twoGroups, JSON.stringify(await prefixes(page)))

    // ── 8:同一个 tab 里**就地**换文件(pdfPath a→b)必须惊动 mainTabs ──────────────────
    //    导航历史与「最近使用」两条订阅都只在 mainTabs 引用变化时才回头看当前面板;此前
    //    refreshTabs 的比对只认 notePath/path,就地换 PDF/多维表/图片一律看不见 → 用户实报
    //    「同一个 View 里发生页面跳转,前进后退无法识别」。
    const inplace = await page.evaluate(async () => {
      const d = window.__dock
      const id = d.open('navv', { label: 'F1', pdfPath: 'a.pdf' }, true)
      let n = 0
      const un = d.nav.onTabs(() => { n++ })
      d.nav.setParams(id, { pdfPath: 'b.pdf' })
      await new Promise((r) => setTimeout(r, 150))
      const fired = n
      d.nav.setParams(id, { page: 3 }) // 非身份参数:不该再惊动一次
      await new Promise((r) => setTimeout(r, 150))
      un()
      return { fired, afterNoise: n }
    })
    check(
      '⚠️8 就地换文件(a.pdf→b.pdf)惊动 mainTabs;无关参数不惊动',
      inplace.fired >= 1 && inplace.afterNoise === inplace.fired,
      JSON.stringify(inplace) + '(修复前:fired=0 → 历史一条都记不上)',
    )

    check('9 正文内没有历史箭头或兜底行', await page.locator('.wb-view .lcl-viewnav, .wb-view .lcl-viewnav-fallback').count() === 0)
    for (const custom of [false, true]) {
      const id = await page.evaluate(custom => {
        const d = window.__dock
        const id = d.open('nav-headed', { custom, label: 'Head 1' }, true)
        d.nav.visit(id, 'Head 1'); d.nav.visit(id, 'Head 2')
        return id
      }, custom)
      await page.waitForTimeout(100)
      const nav = page.locator(`[data-view-nav="${id}"]`)
      check(`10 ${custom ? '自有头行模式胶囊' : 'ViewHead'}仅在标签栏出现一套箭头`, await nav.count() === 1 && await nav.evaluate(el => !!el.closest('.dv-prefix') && !el.closest('.wb-view')))
      check(`11 ${custom ? '自有头行' : 'ViewHead'}后退可用`, await arrow(page, 'back', id))
    }

    const empty = await page.evaluate(() => window.__dock.open('nav-empty-head', {}, true))
    await page.waitForTimeout(100)
    check('12 空 ViewHead 不制造额外空行', await page.locator('.nav-empty-head .lcl-viewhead, .wb-view .lcl-viewnav-fallback').count() === 0)
    check('13 新标签无历史时禁用前后退', await page.locator(`[data-view-nav="${empty}"] button:disabled`).count() === 2)
    await page.evaluate(id => window.__dock.nav.activate(id), tabC)
    await page.waitForTimeout(100)
    check('14 切回旧标签后绑定其历史', await page.locator(`[data-view-nav="${tabC}"] [data-press="back"]`).isDisabled() && !await page.locator(`[data-view-nav="${tabC}"] [data-press="forward"]`).isDisabled())
    for (const width of [760, 1400]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      check(`15 ${width}px 分屏导航仍位于标签栏且未进正文`, JSON.stringify(await prefixes(page)) === twoGroups && await page.locator('.wb-view .lcl-viewnav').count() === 0)
    }

    if (process.env.NAV_SHOT) await page.screenshot({ path: process.env.NAV_SHOT })
    const bad = results.filter((r) => !r.ok)
    console.log(`\n${results.length - bad.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
