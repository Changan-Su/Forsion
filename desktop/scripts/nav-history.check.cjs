/**
 * 左上角前进/后退的 per-tab 契约(真 Chromium + 真 Dockview + 真 navStore,harness.html?dock)。
 *
 * 用户实报(2026-08-17):「前进后退控制的是当前 focus 的 view 的切换记录,A→B→C 回退到 B 再前进
 * 可以到 C,和其他 tabs 的 view 无关。现在有时候会失效,有时候会控制别的 tabs。」
 *
 * 这条只可能在 DOM 接线层看见:栈本身是 per-leaf 的(navStore 单测已绿),病在**箭头打谁**。
 * 2026-10-30 用户实报:分栏后每组左上角都重复一套前进后退 + 左栏折叠钮。现在全窗只有最左上那组有
 * 一套,作用于当前聚焦的主区 tab;右组的历史靠它走,所以这里钉「点这一套,动的是聚焦的那组」。
 *
 * 跑:npm run check:nav   (5173 没起会自起 vite,跑完自收;CHROMIUM_EXE 可覆盖)
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

/** 组内当前页(读 DOM,不信 store 自证)。主区组认标签栏上的 ＋,箭头现在只有一组有。 */
const shown = (page) => page.$$eval('.dv-groupview', (gs) => gs
  .filter((g) => g.querySelector('.dv-new-tab'))
  .map((g) => [...g.querySelectorAll('.navv')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.dataset.label).join(',')))

/** 每个主区组各自的「箭头 / 折叠钮」数,按屏幕从左到右排。 */
const prefixes = (page) => page.$$eval('.dv-groupview', (gs) => gs
  .filter((g) => g.querySelector('.dv-new-tab'))
  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  .map((g) => [g.querySelectorAll('.dv-nav-btn').length, g.querySelectorAll('.dv-edge-toggle').length]))

/** 点全窗那一套后退/前进。按钮是灰的(disabled)本身就是一种失败症状 —— 返回 false
 *  让断言去报,别在这儿 30s 超时把后面的断言全带走。 */
async function arrow(page, dir) {
  const btns = await page.$$('.dv-nav-btn')
  const btn = btns[dir === 'back' ? 0 : 1]
  if (!btn || await btn.isDisabled()) return false
  await btn.click()
  await page.waitForTimeout(250)
  return true
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
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
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
    await arrow(page, 'back')
    let labels = await page.evaluate(() => window.__dock.nav.labels())
    check(
      '2 在 B 里后退 → B 回到 B1,A 纹丝不动(仍 A3)',
      labels[tabB] === 'B1' && labels[tabA] === 'A3',
      JSON.stringify({ A: labels[tabA], B: labels[tabB] }),
    )

    // ── 切到 A:后退走 A 自己的栈,前进能回 A3 ───────────────────────────────
    await page.evaluate((id) => window.__dock.nav.activate(id), tabA)
    await page.waitForTimeout(200)
    await arrow(page, 'back')
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check('3 切到 A 后退 → A 到 A2(B 仍 B1)', labels[tabA] === 'A2' && labels[tabB] === 'B1', JSON.stringify({ A: labels[tabA], B: labels[tabB] }))
    await arrow(page, 'forward')
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check('4 再前进 → A 回到 A3(A→B→C 退到 B 还能前进到 C)', labels[tabA] === 'A3', JSON.stringify({ A: labels[tabA] }))

    // ── 分屏:全窗一套箭头,只在最左上那组,作用于聚焦的那组 ────────────────────
    const tabC = await page.evaluate(async () => {
      const d = window.__dock
      const id = d.nav.split()
      for (const l of ['C1', 'C2']) { d.nav.visit(id, l); await new Promise((r) => setTimeout(r, 80)) }
      return id
    })
    await page.waitForTimeout(300)
    const groupsSeen = await shown(page)
    check('5 分屏成两个主区组(左 A / 右 C)', groupsSeen.length === 2, JSON.stringify(groupsSeen))
    const twoGroups = JSON.stringify([[2, 1], [0, 0]])
    check('⚠️5b 分屏后只有最左组有前进后退和折叠钮(修复前:每组各一套)', JSON.stringify(await prefixes(page)) === twoGroups, JSON.stringify(await prefixes(page)))

    // 焦点此刻在右组(刚分出来的):点这一套 → 动右组的 C,左组的 A 不动。点击本身不许把焦点抢到左组。
    const hit6 = await arrow(page, 'back')
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check(
      '⚠️6 聚焦右组时点箭头 → 动右组的 tab(C→C1),左组不受影响(仍 A3)',
      hit6 && labels[tabC] === 'C1' && labels[tabA] === 'A3',
      JSON.stringify({ A: labels[tabA], C: labels[tabC], 按钮可点: hit6 }),
    )
    await page.evaluate((id) => window.__dock.nav.activate(id), tabA)
    await page.waitForTimeout(200)
    const hit7 = await arrow(page, 'back')
    labels = await page.evaluate(() => window.__dock.nav.labels())
    check(
      '⚠️7 聚焦左组时点箭头 → 动左组的 tab(A→A2),右组不受影响(仍 C1)',
      hit7 && labels[tabA] === 'A2' && labels[tabC] === 'C1',
      JSON.stringify({ A: labels[tabA], C: labels[tabC], 按钮可点: hit7 }),
    )

    // 组被拖到另一边:tab 集合没变,前缀也得跟着换到新的最左组。
    await page.evaluate(([from, to]) => window.__dock.nav.moveGroupRightOf(from, to), [tabA, tabC])
    await page.waitForTimeout(300)
    check('⚠️7b 左右两组对调 → 那一套跟到新的最左组', JSON.stringify(await prefixes(page)) === twoGroups, JSON.stringify(await prefixes(page)))

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

    const bad = results.filter((r) => !r.ok)
    console.log(`\n${results.length - bad.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
