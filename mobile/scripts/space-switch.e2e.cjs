/**
 * 手机上换 Space 的过渡 e2e —— `npm run e2e:spaceswitch`(mobile 目录,先 npm run build)。
 *
 * 桌面那半在 desktop 的 scripts/space-switch.electron.cjs。手机这半验:从左抽屉底部的 Space 条点下一个 / 上一个,
 * 内容区(.mb-body)横着推(next 往左走),Space 条自己单独成组不动;换完抽屉还开着;过渡中途再点条上别的 Space 点得动
 * (过渡期间命中一律落在 <html>,靠 spaceTransition 跳过 + 转发)。--shot 存 0 / 80 / 160ms 三帧。
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

    const tap = (id) => page.locator(`.mb-spacebar .mb-tab[data-space="${id}"]`).tap({ force: true })
    const waitVT = () => page.evaluate(async () => {
      const end = performance.now() + 2000
      while (performance.now() < end) {
        const a = document.getAnimations().filter((x) => x.effect?.pseudoElement?.startsWith('::view-transition'))
        if (a.some((x) => x.effect.pseudoElement.includes('space-work'))) {
          return {
            motion: document.documentElement.dataset.spaceSwitch, axis: document.documentElement.dataset.spaceSwitchAxis,
            work: a.filter((x) => x.effect.pseudoElement.includes('space-work')).map((x) => x.animationName).sort(),
            bar: a.filter((x) => x.effect.pseudoElement.includes('space-bar')).length,
          }
        }
        await new Promise((r) => requestAnimationFrame(r))
      }
      return null
    })
    const pauseAt = (ms) => page.evaluate((t) => { for (const a of document.getAnimations()) if (a.effect?.pseudoElement?.startsWith('::view-transition')) { a.pause(); a.currentTime = t } }, ms)
    const finish = () => page.evaluate(() => { for (const a of document.getAnimations()) if (a.effect?.pseudoElement?.startsWith('::view-transition')) a.finish() })
    const settle = async () => { await finish(); await page.waitForTimeout(400); return state() }
    const shots = SHOT ? fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mobile-spaceswitch-')) : null

    // ── 往右点 = next,横着推 ──
    await tap(next)
    let t = await waitVT()
    ok('2 往右点 = next、横轴', t?.motion === 'next' && t?.axis === 'x', JSON.stringify(t))
    ok('3 内容区跑横推关键帧', !!t && ['lcl-space-fade-in', 'lcl-space-fade-out', 'lcl-space-push-in-x', 'lcl-space-push-out-x'].every((n) => t.work.includes(n)), t?.work.join(' '))
    ok('4 Space 条不动画', t?.bar === 0, `bar 动画 ${t?.bar}`)
    if (shots) for (const ms of [0, 80, 160]) { await pauseAt(ms); await page.screenshot({ path: path.join(shots, `next-${ms}.png`) }) }
    s = await settle()
    ok('5 换过去了、抽屉还开着、属性收掉', s.space === next && s.drawer && !s.attr, JSON.stringify(s))

    // ── 往左点 = prev ──
    await tap(s.tabs[s.tabs.indexOf(next) - 1])
    t = await waitVT()
    ok('6 往左点 = prev', t?.motion === 'prev', JSON.stringify(t))
    s = await settle()

    // ── 过渡中途再点条上别的 Space ──
    await tap(next)
    await waitVT()
    await pauseAt(80)
    await tap(next2)
    await page.waitForTimeout(150)
    s = await settle()
    await page.waitForTimeout(300)
    s = await settle()
    ok('7 过渡中途点条上别的 Space 点得动', s.space === next2 && !s.attr, JSON.stringify(s))
    if (shots) console.log('截图 →', shots)
  } catch (e) {
    fails.push(String((e && e.stack) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    preview.kill()
  }
  if (fails.length) { console.error('❌ e2e:spaceswitch\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:spaceswitch —— 手机上换 Space 横着推,Space 条不动,过渡中途点得动')
}

main()
