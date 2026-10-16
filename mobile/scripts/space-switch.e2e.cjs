/**
 * 手机上换 Space 的过渡 e2e —— `npm run e2e:spaceswitch`(mobile 目录,先 npm run build)。
 *
 * 桌面那半在 desktop 的 scripts/space-switch.electron.cjs。手机这半验:10-16 用户定手机先不播推移过渡(等真机量过再开,
 * 开关在 lcl/engine/spaceTransition.ts)—— 从左抽屉底部的 Space 条点下一个 / 上一个,直接换过去、没有 View Transition、
 * <html data-space-switch> 不挂;换完抽屉还开着;连点两下落在第二个;点了别的又立刻点回当前 = 留在当前。
 * (横推那版的断言 —— 方向、Space 条不动、过渡中途点得动 —— 在 git 历史里,开回来时一起恢复。)
 * 原生底栏(安卓壳)在 WebView 外,不经过这里;它点下去走同一个 enterSpace → switchSpace。
 *
 * 骨架照抄 space-trap.e2e.cjs(vite preview + 假 token + /api abort)。
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const { startPreview } = require('./lib/preview.cjs')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 借 desktop 的 */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()
const { findChromium } = require(path.resolve(__dirname, '../../desktop/scripts/lib/find-chromium.cjs'))

const SHOT = process.argv.includes('--shot')

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) { console.error('✗ 没有 dist/,先跑 npm run build'); process.exit(1) }
  const preview = await startPreview(root)
  let browser = null
  const fails = []
  const ok = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
    if (!cond) fails.push(name)
  }
  try {
    await preview.ready()
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_token', 'e2e-spaceswitch')
        localStorage.setItem('forsion_tangu_active_space', 'tangu')
        localStorage.setItem('forsion_home_slot_space', 'tangu')
      } catch { /* ignore */ }
    })
    await ctx.newPage() // 第一张页有时没有触屏模拟(memory:mobile_e2e_first_page_no_touch),用第二张
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    const state = () => page.evaluate(() => ({
      space: localStorage.getItem('forsion_tangu_active_space'),
      drawer: !!document.querySelector('.mb-drawer--left.open'),
      tabs: [...document.querySelectorAll('.mb-spacebar .mb-tab')].map((t) => t.dataset.space),
      attr: document.documentElement.dataset.spaceSwitch ?? null,
    }))
    let s = await state()
    if (!s.drawer) { await page.locator('.mb-topbar .mb-icon-btn').first().click({ force: true }); await page.waitForTimeout(900); s = await state() }
    ok('1 抽屉开着、底部有 Space 条', s.drawer && s.tabs.length >= 3, JSON.stringify(s))
    const i = s.tabs.indexOf(s.space)
    const next = s.tabs[i + 1], next2 = s.tabs[i + 2]

    const shots = SHOT ? fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mobile-spaceswitch-')) : null
    const tap = (id) => page.locator(`.mb-spacebar .mb-tab[data-space="${id}"]`).tap({ force: true })
    // 点下去之后 600ms 里:有没有出现过 View Transition 的动画 / <html data-space-switch>,Space 在第几毫秒换过去的
    const watch = (want) => page.evaluate(async (want) => {
      const t0 = performance.now(); let vt = 0, attr = 0, at = null
      while (performance.now() - t0 < 600) {
        vt += document.getAnimations().filter((x) => x.effect?.pseudoElement?.startsWith('::view-transition')).length
        if (document.documentElement.dataset.spaceSwitch) attr++
        if (at == null && localStorage.getItem('forsion_tangu_active_space') === want) at = Math.round(performance.now() - t0)
        await new Promise((r) => requestAnimationFrame(r))
      }
      return { vt, attr, at }
    }, want)

    // ── 10-16 用户定:手机先不播过渡(等真机量过再开),点下去直接换 ──
    let w = await Promise.all([watch(next), tap(next)]).then(([x]) => x)
    s = await state()
    ok('2 往右点:直接换过去,没有过渡', s.space === next && w.vt === 0 && w.attr === 0 && w.at != null, JSON.stringify(w))
    ok('3 抽屉还开着、属性没挂', s.drawer && !s.attr, JSON.stringify(s))
    const prev = s.tabs[s.tabs.indexOf(next) - 1]
    w = await Promise.all([watch(prev), tap(prev)]).then(([x]) => x)
    s = await state()
    ok('4 往左点:同样直接换', s.space === prev && w.vt === 0 && w.attr === 0, JSON.stringify(w))

    // ── 连点两下:落在第二个 ──
    await page.evaluate(([a, b]) => { document.querySelector(`.mb-spacebar .mb-tab[data-space="${a}"]`).click(); document.querySelector(`.mb-spacebar .mb-tab[data-space="${b}"]`).click() }, [next, next2])
    await page.waitForTimeout(400)
    s = await state()
    ok('5 连点两下落在第二个', s.space === next2 && s.drawer, JSON.stringify(s))

    // ── 点了别的又立刻点回当前这个:留在当前 ──
    const cur = s.space
    await page.evaluate(([a, b]) => { document.querySelector(`.mb-spacebar .mb-tab[data-space="${a}"]`).click(); document.querySelector(`.mb-spacebar .mb-tab[data-space="${b}"]`).click() }, [s.tabs[s.tabs.indexOf(cur) - 1], cur])
    await page.waitForTimeout(600)
    s = await state()
    ok('6 点了别的又点回当前 = 留在当前', s.space === cur && !s.attr, JSON.stringify(s))
    if (shots) for (const id of [next, cur]) { await tap(id); await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, `after-${id}.png`) }) }
    if (shots) console.log('截图 →', shots)
  } catch (e) {
    fails.push(String((e && e.stack) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    preview.kill()
  }
  if (fails.length) { console.error('❌ e2e:spaceswitch\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:spaceswitch —— 手机上换 Space 直接换(不播过渡),抽屉还开着,连点 / 点回当前都对')
}

main()
